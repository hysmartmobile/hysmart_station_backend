-- HySmart Station v1.7.0: complete kilogram sales, collection, stock-check and reconciliation flow.
-- Apply after 0015_unit_aware_inventory.sql. All kg records remain separate from litre-only legacy tables.
create table if not exists public.kg_nozzle_meter_readings (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 nozzle_id uuid not null, previous_meter_kg numeric(16,3) not null check(previous_meter_kg>=0),
 current_meter_kg numeric(16,3) not null check(current_meter_kg>=previous_meter_kg),
 kg_sold numeric(16,3) generated always as (current_meter_kg-previous_meter_kg) stored,
 price_per_kg numeric(14,2) not null check(price_per_kg>=0),
 expected_amount numeric(16,2) generated always as ((current_meter_kg-previous_meter_kg)*price_per_kg) stored,
 recorded_by uuid not null references auth.users(id), recorded_at timestamptz not null default now(),
 shift_date date not null default current_date, cash_shift_id uuid not null references public.station_cash_shifts(id),
 idempotency_key uuid, notes text, foreign key(station_id,nozzle_id) references public.pump_nozzles(station_id,id), unique(station_id,id)
);
create unique index if not exists kg_meter_readings_idempotency_uq on public.kg_nozzle_meter_readings(station_id,idempotency_key) where idempotency_key is not null;
create index if not exists kg_meter_readings_station_date_idx on public.kg_nozzle_meter_readings(station_id,shift_date desc);
create index if not exists kg_meter_readings_shift_idx on public.kg_nozzle_meter_readings(cash_shift_id,recorded_at desc);

create table if not exists public.kg_sales_collections (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 reading_id uuid not null, amount numeric(16,2) not null check(amount>=0),
 payment_method text not null check(payment_method in ('cash','pos','bank_transfer','other')),
 reference text, collected_by uuid not null references auth.users(id), collected_at timestamptz not null default now(),
 notes text, cash_shift_id uuid not null references public.station_cash_shifts(id), idempotency_key uuid,
 foreign key(station_id,reading_id) references public.kg_nozzle_meter_readings(station_id,id)
);
create unique index if not exists kg_sales_collections_idempotency_uq on public.kg_sales_collections(station_id,idempotency_key) where idempotency_key is not null;
create index if not exists kg_sales_collections_shift_idx on public.kg_sales_collections(cash_shift_id,collected_at desc);
create index if not exists kg_sales_collections_station_time_idx on public.kg_sales_collections(station_id,collected_at desc);

create table if not exists public.kg_tank_stock_checks (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, book_stock_kg numeric(14,2) not null, measured_stock_kg numeric(14,2) not null check(measured_stock_kg>=0),
 variance_kg numeric(14,2) generated always as (measured_stock_kg-book_stock_kg) stored,
 measurement_method text not null default 'manual_estimate' check(measurement_method in ('manual_estimate','weigh_scale','electronic_gauge')),
 measured_by uuid not null references auth.users(id), measured_at timestamptz not null default now(), notes text,
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);
create index if not exists kg_tank_stock_checks_station_time_idx on public.kg_tank_stock_checks(station_id,measured_at desc);
create index if not exists kg_tank_stock_checks_tank_time_idx on public.kg_tank_stock_checks(tank_id,measured_at desc);

alter table public.kg_nozzle_meter_readings enable row level security;
alter table public.kg_sales_collections enable row level security;
alter table public.kg_tank_stock_checks enable row level security;

create or replace function public.validate_kg_meter_reading_unit() returns trigger language plpgsql as $$
declare v_unit text;
begin
 select p.unit_of_measure into v_unit from public.pump_nozzles n join public.fuel_products p on p.id=n.product_id where n.id=new.nozzle_id and n.station_id=new.station_id;
 if v_unit is distinct from 'kg' then raise exception 'FUEL_UNIT_MISMATCH_USE_LITRE_WORKFLOW'; end if;
 return new;
end $$;
drop trigger if exists kg_meter_readings_validate_unit on public.kg_nozzle_meter_readings;
create trigger kg_meter_readings_validate_unit before insert or update of nozzle_id,station_id on public.kg_nozzle_meter_readings for each row execute function public.validate_kg_meter_reading_unit();

create or replace function public.record_shift_kg_meter_reading(
 p_station_id uuid,p_nozzle_id uuid,p_current_meter_kg numeric,p_price_per_kg numeric,p_recorded_by uuid,
 p_shift_id uuid,p_shift_date date,p_notes text default null,p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_nozzle public.pump_nozzles%rowtype; v_shift public.station_cash_shifts%rowtype; v_reading public.kg_nozzle_meter_readings%rowtype;
begin
 if p_current_meter_kg<0 or p_price_per_kg<0 then raise exception 'INVALID_METER_VALUE'; end if;
 if p_idempotency_key is not null then
  select * into v_reading from public.kg_nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key;
  if found then if v_reading.recorded_by<>p_recorded_by or v_reading.cash_shift_id<>p_shift_id or v_reading.nozzle_id<>p_nozzle_id or v_reading.current_meter_kg<>round(p_current_meter_kg,3) or v_reading.price_per_kg<>round(p_price_per_kg,2) or v_reading.shift_date<>coalesce(p_shift_date,current_date) then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if; return to_jsonb(v_reading); end if;
 end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and cashier_user_id=p_recorded_by and status='open' for update;
 if not found then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 select * into v_nozzle from public.pump_nozzles where id=p_nozzle_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'ACTIVE_NOZZLE_NOT_FOUND'; end if;
 if p_current_meter_kg<v_nozzle.last_meter_kg then raise exception 'METER_ROLLBACK'; end if;
 insert into public.kg_nozzle_meter_readings(station_id,nozzle_id,previous_meter_kg,current_meter_kg,price_per_kg,recorded_by,shift_date,cash_shift_id,notes,idempotency_key)
 values(p_station_id,p_nozzle_id,v_nozzle.last_meter_kg,p_current_meter_kg,p_price_per_kg,p_recorded_by,coalesce(p_shift_date,current_date),p_shift_id,left(p_notes,1000),p_idempotency_key) returning * into v_reading;
 update public.pump_nozzles set last_meter_kg=p_current_meter_kg where id=p_nozzle_id and station_id=p_station_id;
 return to_jsonb(v_reading);
exception when unique_violation then
 if p_idempotency_key is not null then select * into v_reading from public.kg_nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key; if found and v_reading.recorded_by=p_recorded_by and v_reading.cash_shift_id=p_shift_id and v_reading.nozzle_id=p_nozzle_id and v_reading.current_meter_kg=round(p_current_meter_kg,3) and v_reading.price_per_kg=round(p_price_per_kg,2) and v_reading.shift_date=coalesce(p_shift_date,current_date) then return to_jsonb(v_reading); end if; end if; raise;
end $$;
revoke all on function public.record_shift_kg_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.record_shift_kg_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) to service_role;

create or replace function public.record_kg_sales_collection(
 p_station_id uuid,p_reading_id uuid,p_shift_id uuid,p_amount numeric,p_payment_method text,p_reference text,
 p_collected_by uuid,p_notes text default null,p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_reading public.kg_nozzle_meter_readings%rowtype; v_collection public.kg_sales_collections%rowtype;
begin
 if p_amount<0 then raise exception 'INVALID_COLLECTION_AMOUNT'; end if;
 if p_payment_method not in ('cash','pos','bank_transfer','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
 if p_idempotency_key is not null then select * into v_collection from public.kg_sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key; if found then if v_collection.collected_by<>p_collected_by or v_collection.cash_shift_id<>p_shift_id or v_collection.reading_id<>p_reading_id or v_collection.amount<>round(p_amount,2) or v_collection.payment_method<>p_payment_method or v_collection.reference is distinct from left(p_reference,100) then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if; return to_jsonb(v_collection); end if; end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and cashier_user_id=p_collected_by and status='open' for update;
 if not found then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 select * into v_reading from public.kg_nozzle_meter_readings where id=p_reading_id and station_id=p_station_id and cash_shift_id=p_shift_id;
 if not found then raise exception 'READING_NOT_IN_CASH_SHIFT'; end if;
 insert into public.kg_sales_collections(station_id,reading_id,amount,payment_method,reference,collected_by,notes,cash_shift_id,idempotency_key)
 values(p_station_id,p_reading_id,p_amount,left(p_payment_method,20),left(p_reference,100),p_collected_by,left(p_notes,1000),p_shift_id,p_idempotency_key) returning * into v_collection;
 return to_jsonb(v_collection);
exception when unique_violation then
 if p_idempotency_key is not null then select * into v_collection from public.kg_sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key; if found and v_collection.collected_by=p_collected_by and v_collection.cash_shift_id=p_shift_id and v_collection.reading_id=p_reading_id and v_collection.amount=round(p_amount,2) and v_collection.payment_method=p_payment_method and v_collection.reference is not distinct from left(p_reference,100) then return to_jsonb(v_collection); end if; end if; raise;
end $$;
revoke all on function public.record_kg_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_kg_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) to service_role;

create or replace function public.record_kg_tank_stock_check(p_station_id uuid,p_tank_id uuid,p_measured_stock_kg numeric,p_measured_by uuid,p_measurement_method text default 'manual_estimate',p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tank public.station_tanks%rowtype; v_book numeric(14,2); v_row public.kg_tank_stock_checks%rowtype;
begin
 if p_measured_stock_kg<0 then raise exception 'INVALID_MEASURED_STOCK'; end if;
 if p_measurement_method not in ('manual_estimate','weigh_scale','electronic_gauge') then raise exception 'INVALID_MEASUREMENT_METHOD'; end if;
 select * into v_tank from public.station_tanks where id=p_tank_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'ACTIVE_TANK_NOT_FOUND'; end if;
 if v_tank.unit_of_measure is distinct from 'kg' then raise exception 'FUEL_UNIT_MISMATCH_USE_LITRE_WORKFLOW'; end if;
 if p_measured_stock_kg>v_tank.capacity_units then raise exception 'MEASURED_STOCK_EXCEEDS_CAPACITY'; end if;
 select v_tank.opening_stock_units+coalesce((select sum(quantity_units) from public.tank_deliveries where tank_id=v_tank.id and station_id=p_station_id),0)-coalesce((select sum(r.kg_sold) from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=v_tank.id and r.station_id=p_station_id),0)
 into v_book;
 insert into public.kg_tank_stock_checks(station_id,tank_id,book_stock_kg,measured_stock_kg,measurement_method,measured_by,notes) values(p_station_id,p_tank_id,v_book,p_measured_stock_kg,p_measurement_method,p_measured_by,left(p_notes,1000)) returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.record_kg_tank_stock_check(uuid,uuid,numeric,uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_kg_tank_stock_check(uuid,uuid,numeric,uuid,text,text) to service_role;

-- Cash totals and reconciliations include both unit-specific ledgers, without combining their physical quantities.
create or replace function public.close_station_cash_shift(p_shift_id uuid,p_closed_by uuid,p_counted_cash numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_cash numeric(14,2); v_expected numeric(14,2);
begin
 if p_counted_cash<0 then raise exception 'INVALID_CASH_COUNT'; end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id for update;
 if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
 if v_shift.status<>'open' then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
 select coalesce((select sum(amount) from public.sales_collections where cash_shift_id=v_shift.id and payment_method='cash'),0)+coalesce((select sum(amount) from public.kg_sales_collections where cash_shift_id=v_shift.id and payment_method='cash'),0) into v_cash;
 v_expected:=v_shift.opening_float+v_cash;
 update public.station_cash_shifts set status='closed',closed_by=p_closed_by,closed_at=now(),cash_collections=v_cash,expected_cash=v_expected,counted_cash=p_counted_cash,variance=round(p_counted_cash-v_expected,2),close_notes=left(coalesce(p_note,''),1000) where id=p_shift_id returning * into v_shift;
 return to_jsonb(v_shift);
end $$;
revoke all on function public.close_station_cash_shift(uuid,uuid,numeric,text) from public,anon,authenticated;
grant execute on function public.close_station_cash_shift(uuid,uuid,numeric,text) to service_role;

create or replace function public.reconcile_station_cash_shift(p_station_id uuid,p_shift_id uuid,p_reconciled_by uuid,p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_expected numeric(16,2); v_cash numeric(16,2); v_pos numeric(16,2); v_bank numeric(16,2); v_other numeric(16,2); v_total numeric(16,2); v_var numeric(16,2); v_row public.station_shift_reconciliations%rowtype;
begin
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and status='closed' for update;
 if not found then raise exception 'CLOSED_CASH_SHIFT_REQUIRED'; end if;
 select coalesce((select sum(expected_amount) from public.nozzle_meter_readings where cash_shift_id=p_shift_id),0)+coalesce((select sum(expected_amount) from public.kg_nozzle_meter_readings where cash_shift_id=p_shift_id),0) into v_expected;
 select coalesce((select sum(amount) from public.sales_collections where cash_shift_id=p_shift_id and payment_method='cash'),0)+coalesce((select sum(amount) from public.kg_sales_collections where cash_shift_id=p_shift_id and payment_method='cash'),0),
 coalesce((select sum(amount) from public.sales_collections where cash_shift_id=p_shift_id and payment_method='pos'),0)+coalesce((select sum(amount) from public.kg_sales_collections where cash_shift_id=p_shift_id and payment_method='pos'),0),
 coalesce((select sum(amount) from public.sales_collections where cash_shift_id=p_shift_id and payment_method='bank_transfer'),0)+coalesce((select sum(amount) from public.kg_sales_collections where cash_shift_id=p_shift_id and payment_method='bank_transfer'),0),
 coalesce((select sum(amount) from public.sales_collections where cash_shift_id=p_shift_id and payment_method='other'),0)+coalesce((select sum(amount) from public.kg_sales_collections where cash_shift_id=p_shift_id and payment_method='other'),0)
 into v_cash,v_pos,v_bank,v_other;
 v_total:=v_cash+v_pos+v_bank+v_other; v_var:=round(v_total-v_expected,2);
 insert into public.station_shift_reconciliations(station_id,cash_shift_id,expected_sales,collected_total,cash_collected,pos_collected,bank_transfer_collected,other_collected,sales_variance,status,notes,reconciled_by,reconciled_at)
 values(p_station_id,p_shift_id,v_expected,v_total,v_cash,v_pos,v_bank,v_other,v_var,case when abs(v_var)<0.01 then 'balanced' when v_var<0 then 'short' else 'over' end,left(coalesce(p_notes,''),1000),p_reconciled_by,now())
 on conflict(cash_shift_id) do update set expected_sales=excluded.expected_sales,collected_total=excluded.collected_total,cash_collected=excluded.cash_collected,pos_collected=excluded.pos_collected,bank_transfer_collected=excluded.bank_transfer_collected,other_collected=excluded.other_collected,sales_variance=excluded.sales_variance,status=excluded.status,notes=excluded.notes,reconciled_by=excluded.reconciled_by,reconciled_at=excluded.reconciled_at returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) to service_role;


-- Capacity check now subtracts recorded kg sales, so refills after dispensing are not falsely rejected.
create or replace function public.guard_unit_aware_tank_delivery_capacity() returns trigger language plpgsql as $$
declare v_capacity numeric; v_opening numeric; v_unit text; v_prior_deliveries numeric; v_kg_sold numeric; v_book numeric;
begin
 select capacity_units,opening_stock_units,unit_of_measure into v_capacity,v_opening,v_unit from public.station_tanks where id=new.tank_id and station_id=new.station_id for update;
 if v_unit='kg' then
  select coalesce(sum(quantity_units),0) into v_prior_deliveries from public.tank_deliveries where tank_id=new.tank_id and station_id=new.station_id and id is distinct from new.id;
  select coalesce(sum(kg_sold),0) into v_kg_sold from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=new.tank_id and r.station_id=new.station_id;
  v_book:=coalesce(v_opening,0)+v_prior_deliveries-v_kg_sold;
  if v_book+new.quantity_units>v_capacity then raise exception 'TANK_CAPACITY_EXCEEDED'; end if;
  if v_book<0 then raise exception 'NEGATIVE_BOOK_STOCK_REQUIRES_RECONCILIATION'; end if;
 end if;
 return new;
end $$;

-- Refresh company-owner totals so money totals include kg sales/collections while physical units stay separate.
-- HySmart Station v1.4.0: net collection reporting after approved reversals.
-- Apply after migrations 0001-0012.
-- HySmart Station v1.3.0: company-owner dashboard net collection accounting.
-- This function returns calculated totals from operational records; it does not store dashboard figures.
create or replace function public.get_company_dashboard_summary(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid;
  v_result jsonb;
begin
  select cm.company_id into v_company_id
  from public.company_members cm
  where cm.user_id = p_user_id
    and cm.role = 'COMPANY_OWNER'
    and cm.status = 'active'
  order by cm.created_at asc
  limit 1;

  if v_company_id is null then
    raise exception 'COMPANY_OWNER_REQUIRED';
  end if;

  select jsonb_build_object(
    'companyId', v_company_id,
    'asOf', now(),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'address', s.address,
        'status', s.status,
        'managerCount', coalesce((select count(*) from public.station_members sm where sm.station_id=s.id and sm.role='STATION_MANAGER' and sm.status='active'),0),
        'attendantCount', coalesce((select count(*) from public.station_members sm where sm.station_id=s.id and sm.role='ATTENDANT' and sm.status='active'),0),
        'attendanceToday', coalesce((select count(*) from public.attendance_records ar where ar.station_id=s.id and ar.clock_in_at >= date_trunc('day', now()) and ar.clock_in_at < date_trunc('day', now()) + interval '1 day'),0),
        'openShifts', coalesce((select count(*) from public.attendance_records ar where ar.station_id=s.id and ar.clock_out_at is null),0),
        'salesToday', coalesce((select sum(nmr.expected_amount) from public.nozzle_meter_readings nmr where nmr.station_id=s.id and nmr.recorded_at >= date_trunc('day', now()) and nmr.recorded_at < date_trunc('day', now()) + interval '1 day'),0) + coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.recorded_at >= date_trunc('day', now()) and kg.recorded_at < date_trunc('day', now()) + interval '1 day'),0),
        'salesAllTime', coalesce((select sum(nmr.expected_amount) from public.nozzle_meter_readings nmr where nmr.station_id=s.id),0) + coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id),0),
        'kgSalesToday', coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.recorded_at >= date_trunc('day', now()) and kg.recorded_at < date_trunc('day', now()) + interval '1 day'),0),
        'kgSalesAllTime', coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id),0),
        'collectionsToday', coalesce((select sum(sc.amount - coalesce(rv.reversed_amount,0)) from public.sales_collections sc left join (select collection_id,sum(amount) as reversed_amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=sc.id where sc.station_id=s.id and sc.collected_at >= date_trunc('day', now()) and sc.collected_at < date_trunc('day', now()) + interval '1 day'),0) + coalesce((select sum(kc.amount) from public.kg_sales_collections kc where kc.station_id=s.id and kc.collected_at >= date_trunc('day', now()) and kc.collected_at < date_trunc('day', now()) + interval '1 day'),0),
        'kgCollectionsToday', coalesce((select sum(kc.amount) from public.kg_sales_collections kc where kc.station_id=s.id and kc.collected_at >= date_trunc('day', now()) and kc.collected_at < date_trunc('day', now()) + interval '1 day'),0),
        'collectionsReversedToday', coalesce((select sum(rv.amount) from public.sales_collection_reversals rv join public.sales_collections sc on sc.id=rv.collection_id where sc.station_id=s.id and sc.collected_at >= date_trunc('day', now()) and sc.collected_at < date_trunc('day', now()) + interval '1 day'),0),
        'collectionsAllTime', coalesce((select sum(sc.amount - coalesce(rv.reversed_amount,0)) from public.sales_collections sc left join (select collection_id,sum(amount) as reversed_amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=sc.id where sc.station_id=s.id),0) + coalesce((select sum(kc.amount) from public.kg_sales_collections kc where kc.station_id=s.id),0),
        'kgCollectionsAllTime', coalesce((select sum(kc.amount) from public.kg_sales_collections kc where kc.station_id=s.id),0),
        'collectionsReversedAllTime', coalesce((select sum(rv.amount) from public.sales_collection_reversals rv where rv.station_id=s.id),0),
        'tankCount', coalesce((select count(*) from public.station_tanks st where st.station_id=s.id and st.status='active'),0),
        'pumpCount', coalesce((select count(*) from public.station_pumps sp where sp.station_id=s.id and sp.status='active'),0),
        'deliveryVolumeAllTime', coalesce((select sum(td.quantity_litres) from public.tank_deliveries td where td.station_id=s.id),0),
        'kgDeliveryVolumeAllTime', coalesce((select sum(td.quantity_units) from public.tank_deliveries td where td.station_id=s.id and td.unit_of_measure='kg'),0),
        'latestReconciliation', (select jsonb_build_object('date',sr.shift_date,'status',sr.status,'variance',sr.variance_amount) from public.shift_reconciliations sr where sr.station_id=s.id order by sr.shift_date desc limit 1)
      ) order by s.name)
      from public.stations s where s.company_id=v_company_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.get_company_dashboard_summary(uuid) from public, anon, authenticated;
grant execute on function public.get_company_dashboard_summary(uuid) to service_role;
