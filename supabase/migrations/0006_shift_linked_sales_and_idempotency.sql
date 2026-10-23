-- HySmart Station v0.7.0: shift-linked sales, duplicate-submit protection and reconciliation.
-- Apply only after migrations 0001-0005 have succeeded in a staging environment.
create extension if not exists pgcrypto;

alter table public.nozzle_meter_readings
  add column if not exists cash_shift_id uuid references public.station_cash_shifts(id),
  add column if not exists idempotency_key uuid;
alter table public.sales_collections
  add column if not exists cash_shift_id uuid references public.station_cash_shifts(id),
  add column if not exists idempotency_key uuid;
create unique index if not exists meter_readings_idempotency_uq
  on public.nozzle_meter_readings(station_id,idempotency_key) where idempotency_key is not null;
create unique index if not exists sales_collections_idempotency_uq
  on public.sales_collections(station_id,idempotency_key) where idempotency_key is not null;
create index if not exists meter_readings_cash_shift_idx on public.nozzle_meter_readings(cash_shift_id,recorded_at desc);
create index if not exists sales_collections_cash_shift_idx on public.sales_collections(cash_shift_id,collected_at desc);

create table if not exists public.station_shift_reconciliations (
 id uuid primary key default gen_random_uuid(),
 station_id uuid not null references public.stations(id) on delete cascade,
 cash_shift_id uuid not null unique references public.station_cash_shifts(id),
 expected_sales numeric(16,2) not null default 0,
 collected_total numeric(16,2) not null default 0,
 cash_collected numeric(16,2) not null default 0,
 pos_collected numeric(16,2) not null default 0,
 bank_transfer_collected numeric(16,2) not null default 0,
 other_collected numeric(16,2) not null default 0,
 sales_variance numeric(16,2) not null default 0,
 status text not null check(status in ('balanced','short','over')),
 notes text,
 reconciled_by uuid not null references auth.users(id),
 reconciled_at timestamptz not null default now()
);
create index if not exists shift_reconciliations_station_time_idx on public.station_shift_reconciliations(station_id,reconciled_at desc);
alter table public.station_shift_reconciliations enable row level security;

-- Atomic meter update. The nozzle lock serializes meter submissions; the open shift must belong
-- to the actor. Repeating the same idempotency key returns the original saved reading.
create or replace function public.record_shift_meter_reading(
 p_station_id uuid, p_nozzle_id uuid, p_current_meter_litres numeric,
 p_price_per_litre numeric, p_recorded_by uuid, p_shift_id uuid,
 p_shift_date date, p_notes text default null, p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_nozzle public.pump_nozzles%rowtype; v_shift public.station_cash_shifts%rowtype;
        v_reading public.nozzle_meter_readings%rowtype;
begin
 if p_current_meter_litres < 0 or p_price_per_litre < 0 then raise exception 'INVALID_METER_VALUE'; end if;
 if p_idempotency_key is not null then
   select * into v_reading from public.nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found then
     if v_reading.recorded_by <> p_recorded_by or v_reading.cash_shift_id <> p_shift_id then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
     return to_jsonb(v_reading);
   end if;
 end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id
   and cashier_user_id=p_recorded_by and status='open' for update;
 if not found then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 select * into v_nozzle from public.pump_nozzles where id=p_nozzle_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'ACTIVE_NOZZLE_NOT_FOUND'; end if;
 if p_current_meter_litres < v_nozzle.last_meter_litres then raise exception 'METER_ROLLBACK'; end if;
 insert into public.nozzle_meter_readings(station_id,nozzle_id,previous_meter_litres,current_meter_litres,price_per_litre,recorded_by,shift_date,notes,cash_shift_id,idempotency_key)
 values(p_station_id,p_nozzle_id,v_nozzle.last_meter_litres,p_current_meter_litres,p_price_per_litre,p_recorded_by,coalesce(p_shift_date,current_date),p_notes,p_shift_id,p_idempotency_key)
 returning * into v_reading;
 update public.pump_nozzles set last_meter_litres=p_current_meter_litres where id=p_nozzle_id and station_id=p_station_id;
 return to_jsonb(v_reading);
exception when unique_violation then
 if p_idempotency_key is not null then
   select * into v_reading from public.nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found and v_reading.recorded_by=p_recorded_by and v_reading.cash_shift_id=p_shift_id then return to_jsonb(v_reading); end if;
 end if;
 raise;
end $$;
revoke all on function public.record_shift_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) from public;
grant execute on function public.record_shift_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) to service_role;

-- Collection is bound to the same cashier shift as its reading. Duplicate request keys cannot
-- create duplicate payments; distinct partial payments remain supported for split tender.
create or replace function public.record_shift_sales_collection(
 p_station_id uuid,p_reading_id uuid,p_shift_id uuid,p_amount numeric,p_payment_method text,
 p_reference text,p_collected_by uuid,p_notes text default null,p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_reading public.nozzle_meter_readings%rowtype;
        v_collection public.sales_collections%rowtype;
begin
 if p_amount < 0 then raise exception 'INVALID_COLLECTION_AMOUNT'; end if;
 if p_payment_method not in ('cash','pos','bank_transfer','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
 if p_idempotency_key is not null then
   select * into v_collection from public.sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found then
     if v_collection.collected_by <> p_collected_by or v_collection.cash_shift_id <> p_shift_id then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
     return to_jsonb(v_collection);
   end if;
 end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id
   and cashier_user_id=p_collected_by and status='open' for update;
 if not found then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 select * into v_reading from public.nozzle_meter_readings where id=p_reading_id and station_id=p_station_id and cash_shift_id=p_shift_id;
 if not found then raise exception 'READING_NOT_IN_CASH_SHIFT'; end if;
 insert into public.sales_collections(station_id,reading_id,amount,payment_method,reference,collected_by,notes,cash_shift_id,idempotency_key)
 values(p_station_id,p_reading_id,p_amount,p_payment_method,left(p_reference,100),p_collected_by,left(p_notes,1000),p_shift_id,p_idempotency_key)
 returning * into v_collection;
 return to_jsonb(v_collection);
exception when unique_violation then
 if p_idempotency_key is not null then
   select * into v_collection from public.sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found and v_collection.collected_by=p_collected_by and v_collection.cash_shift_id=p_shift_id then return to_jsonb(v_collection); end if;
 end if;
 raise;
end $$;
revoke all on function public.record_shift_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) from public;
grant execute on function public.record_shift_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) to service_role;

-- Reconcile all payment methods against meter-derived expected sales for exactly one closed shift.
create or replace function public.reconcile_station_cash_shift(
 p_station_id uuid,p_shift_id uuid,p_reconciled_by uuid,p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_expected numeric(16,2); v_cash numeric(16,2);
 v_pos numeric(16,2); v_bank numeric(16,2); v_other numeric(16,2); v_total numeric(16,2); v_var numeric(16,2); v_row public.station_shift_reconciliations%rowtype;
begin
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and status='closed' for update;
 if not found then raise exception 'CLOSED_CASH_SHIFT_REQUIRED'; end if;
 select coalesce(sum(expected_amount),0) into v_expected from public.nozzle_meter_readings where cash_shift_id=p_shift_id;
 select coalesce(sum(amount) filter(where payment_method='cash'),0),
        coalesce(sum(amount) filter(where payment_method='pos'),0),
        coalesce(sum(amount) filter(where payment_method='bank_transfer'),0),
        coalesce(sum(amount) filter(where payment_method='other'),0)
 into v_cash,v_pos,v_bank,v_other from public.sales_collections where cash_shift_id=p_shift_id;
 v_total:=v_cash+v_pos+v_bank+v_other; v_var:=round(v_total-v_expected,2);
 insert into public.station_shift_reconciliations(station_id,cash_shift_id,expected_sales,collected_total,cash_collected,pos_collected,bank_transfer_collected,other_collected,sales_variance,status,notes,reconciled_by,reconciled_at)
 values(p_station_id,p_shift_id,v_expected,v_total,v_cash,v_pos,v_bank,v_other,v_var,case when abs(v_var)<0.01 then 'balanced' when v_var<0 then 'short' else 'over' end,left(coalesce(p_notes,''),1000),p_reconciled_by,now())
 on conflict(cash_shift_id) do update set expected_sales=excluded.expected_sales,collected_total=excluded.collected_total,cash_collected=excluded.cash_collected,pos_collected=excluded.pos_collected,bank_transfer_collected=excluded.bank_transfer_collected,other_collected=excluded.other_collected,sales_variance=excluded.sales_variance,status=excluded.status,notes=excluded.notes,reconciled_by=excluded.reconciled_by,reconciled_at=excluded.reconciled_at
 returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) from public;
grant execute on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) to service_role;

-- Cash shift closure uses explicitly linked payments when available; legacy unlinked rows are excluded
-- from shift-specific reconciliation because time-window inference is ambiguous.
create or replace function public.close_station_cash_shift(p_shift_id uuid,p_closed_by uuid,p_counted_cash numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_cash numeric(14,2); v_expected numeric(14,2);
begin
 if p_counted_cash < 0 then raise exception 'INVALID_CASH_COUNT'; end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id for update;
 if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
 if v_shift.status <> 'open' then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
 select coalesce(sum(amount),0) into v_cash from public.sales_collections where cash_shift_id=v_shift.id and payment_method='cash';
 v_expected:=v_shift.opening_float+v_cash;
 update public.station_cash_shifts set status='closed',closed_by=p_closed_by,closed_at=now(),cash_collections=v_cash,expected_cash=v_expected,counted_cash=p_counted_cash,variance=round(p_counted_cash-v_expected,2),close_notes=left(coalesce(p_note,''),1000) where id=p_shift_id returning * into v_shift;
 return to_jsonb(v_shift);
end $$;
revoke all on function public.close_station_cash_shift(uuid,uuid,numeric,text) from public;
grant execute on function public.close_station_cash_shift(uuid,uuid,numeric,text) to service_role;
