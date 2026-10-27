-- HySmart Station v0.6.0: physical tank checks, controlled stock adjustments and cashier shifts.
-- Additive migration. Apply after 0001-0004 in a staging database first.
create extension if not exists pgcrypto;

create table if not exists public.tank_dip_readings (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, measured_stock_litres numeric(14,2) not null check(measured_stock_litres >= 0),
 book_stock_litres numeric(14,2) not null, variance_litres numeric(14,2) not null,
 measurement_method text not null default 'dip_stick' check(measurement_method in ('dip_stick','electronic_gauge','manual_estimate')),
 measured_by uuid not null references auth.users(id), measured_at timestamptz not null default now(), notes text,
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);
create index if not exists tank_dips_station_time_idx on public.tank_dip_readings(station_id,measured_at desc);

create table if not exists public.stock_adjustment_requests (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, quantity_delta_litres numeric(14,2) not null check(quantity_delta_litres <> 0),
 reason text not null check(length(trim(reason)) between 5 and 500), reference text,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_by uuid not null references auth.users(id), requested_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id), reviewed_at timestamptz, review_note text,
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id),
 check(reviewed_by is null or reviewed_by <> requested_by)
);
create index if not exists stock_adjustments_station_status_idx on public.stock_adjustment_requests(station_id,status,requested_at desc);

create table if not exists public.tank_stock_movements (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, movement_type text not null check(movement_type in ('adjustment_in','adjustment_out')),
 quantity_litres numeric(14,2) not null check(quantity_litres > 0), adjustment_request_id uuid not null unique references public.stock_adjustment_requests(id),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);

create table if not exists public.station_cash_shifts (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 cashier_user_id uuid not null references auth.users(id), opened_by uuid not null references auth.users(id),
 opening_float numeric(14,2) not null check(opening_float >= 0), opened_at timestamptz not null default now(),
 status text not null default 'open' check(status in ('open','closed')),
 closed_by uuid references auth.users(id), closed_at timestamptz, cash_collections numeric(14,2), expected_cash numeric(14,2),
 counted_cash numeric(14,2), variance numeric(14,2), close_notes text,
 check((status='open' and closed_at is null and closed_by is null) or (status='closed' and closed_at is not null and closed_by is not null and counted_cash is not null and expected_cash is not null and variance is not null))
);
create unique index if not exists one_open_cash_shift_per_cashier_station on public.station_cash_shifts(station_id,cashier_user_id) where status='open';
create index if not exists cash_shifts_station_opened_idx on public.station_cash_shifts(station_id,opened_at desc);

alter table public.tank_dip_readings enable row level security;
alter table public.stock_adjustment_requests enable row level security;
alter table public.tank_stock_movements enable row level security;
alter table public.station_cash_shifts enable row level security;

-- Approval is atomic, cannot be self-approved, checks stock/capacity, and records a movement.
create or replace function public.review_stock_adjustment(p_request_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_req public.stock_adjustment_requests%rowtype; v_tank public.station_tanks%rowtype; v_book numeric(14,2); v_next numeric(14,2);
begin
 select * into v_req from public.stock_adjustment_requests where id=p_request_id for update;
 if not found then raise exception 'ADJUSTMENT_NOT_FOUND'; end if;
 if v_req.status <> 'pending' then raise exception 'ADJUSTMENT_ALREADY_REVIEWED'; end if;
 if v_req.requested_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 if not p_approve then
  update public.stock_adjustment_requests set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
  return to_jsonb(v_req);
 end if;
 select * into v_tank from public.station_tanks where id=v_req.tank_id and station_id=v_req.station_id for update;
 if not found then raise exception 'TANK_NOT_FOUND'; end if;
 select v_tank.opening_stock_litres + coalesce((select sum(quantity_litres) from public.tank_deliveries where tank_id=v_tank.id),0)
  - coalesce((select sum(r.litres_sold) from public.nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=v_tank.id and r.station_id=v_req.station_id),0)
  + coalesce((select sum(case when movement_type='adjustment_in' then quantity_litres else -quantity_litres end) from public.tank_stock_movements where tank_id=v_tank.id),0)
 into v_book;
 v_next:=v_book+v_req.quantity_delta_litres;
 if v_next < 0 then raise exception 'ADJUSTMENT_NEGATIVE_STOCK'; end if;
 if v_next > v_tank.capacity_litres then raise exception 'ADJUSTMENT_EXCEEDS_CAPACITY'; end if;
 insert into public.tank_stock_movements(station_id,tank_id,movement_type,quantity_litres,adjustment_request_id,created_by)
 values(v_req.station_id,v_req.tank_id,case when v_req.quantity_delta_litres>0 then 'adjustment_in' else 'adjustment_out' end,abs(v_req.quantity_delta_litres),v_req.id,p_reviewer);
 update public.stock_adjustment_requests set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
 return to_jsonb(v_req);
end $$;
revoke all on function public.review_stock_adjustment(uuid,uuid,boolean,text) from public;
grant execute on function public.review_stock_adjustment(uuid,uuid,boolean,text) to service_role;

-- Close once only; the unique/open constraints and row lock prevent double-closing.
create or replace function public.close_station_cash_shift(p_shift_id uuid,p_closed_by uuid,p_counted_cash numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_cash numeric(14,2); v_expected numeric(14,2);
begin
 if p_counted_cash < 0 then raise exception 'INVALID_CASH_COUNT'; end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id for update;
 if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
 if v_shift.status <> 'open' then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
 select coalesce(sum(amount),0) into v_cash from public.sales_collections where station_id=v_shift.station_id and collected_by=v_shift.cashier_user_id and payment_method='cash' and collected_at>=v_shift.opened_at and collected_at<=now();
 v_expected:=v_shift.opening_float+v_cash;
 update public.station_cash_shifts set status='closed',closed_by=p_closed_by,closed_at=now(),cash_collections=v_cash,expected_cash=v_expected,counted_cash=p_counted_cash,variance=round(p_counted_cash-v_expected,2),close_notes=left(coalesce(p_note,''),1000) where id=p_shift_id returning * into v_shift;
 return to_jsonb(v_shift);
end $$;
revoke all on function public.close_station_cash_shift(uuid,uuid,numeric,text) from public;
grant execute on function public.close_station_cash_shift(uuid,uuid,numeric,text) to service_role;
