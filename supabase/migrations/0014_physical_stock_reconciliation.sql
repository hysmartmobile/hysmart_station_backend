-- HySmart Station v1.5.0: auditable physical tank stock checks.
-- Apply after migrations 0001-0013. Existing records are retained.
create table if not exists public.tank_stock_checks (
 id uuid primary key default gen_random_uuid(),
 station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null,
 book_stock_litres numeric(14,2) not null,
 measured_stock_litres numeric(14,2) not null check (measured_stock_litres >= 0),
 variance_litres numeric(14,2) generated always as (measured_stock_litres-book_stock_litres) stored,
 measurement_method text not null check (measurement_method in ('dip_stick','electronic_gauge','manual_estimate')),
 measured_by uuid not null references auth.users(id), measured_at timestamptz not null default now(),
 notes text,
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);
create index if not exists tank_stock_checks_station_time_idx on public.tank_stock_checks(station_id,measured_at desc);
create index if not exists tank_stock_checks_tank_time_idx on public.tank_stock_checks(tank_id,measured_at desc);
alter table public.tank_stock_checks enable row level security;

-- Server calculates book stock from the ledger; clients cannot submit a fabricated book balance.
create or replace function public.record_tank_stock_check(
 p_station_id uuid, p_tank_id uuid, p_measured_stock_litres numeric,
 p_measured_by uuid, p_measurement_method text default 'dip_stick', p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tank public.station_tanks%rowtype; v_book numeric(14,2); v_result public.tank_stock_checks%rowtype;
begin
 if p_measured_stock_litres is null or p_measured_stock_litres < 0 then raise exception 'INVALID_MEASURED_STOCK'; end if;
 if p_measurement_method not in ('dip_stick','electronic_gauge','manual_estimate') then raise exception 'INVALID_MEASUREMENT_METHOD'; end if;
 select * into v_tank from public.station_tanks where id=p_tank_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'ACTIVE_TANK_NOT_FOUND'; end if;
 if p_measured_stock_litres > v_tank.capacity_litres then raise exception 'MEASURED_STOCK_EXCEEDS_CAPACITY'; end if;
 select round(v_tank.opening_stock_litres
   + coalesce((select sum(d.quantity_litres) from public.tank_deliveries d where d.station_id=p_station_id and d.tank_id=p_tank_id),0)
   - coalesce((select sum(r.litres_sold) from public.nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where r.station_id=p_station_id and n.tank_id=p_tank_id),0)
   + coalesce((select sum(case when m.movement_type='adjustment_in' then m.quantity_litres else -m.quantity_litres end) from public.tank_stock_movements m where m.station_id=p_station_id and m.tank_id=p_tank_id),0),2)
 into v_book;
 if v_book < 0 then raise exception 'BOOK_STOCK_NEGATIVE'; end if;
 insert into public.tank_stock_checks(station_id,tank_id,book_stock_litres,measured_stock_litres,measurement_method,measured_by,notes)
 values(p_station_id,p_tank_id,v_book,p_measured_stock_litres,p_measurement_method,p_measured_by,left(p_notes,1000)) returning * into v_result;
 return to_jsonb(v_result);
end $$;
revoke all on function public.record_tank_stock_check(uuid,uuid,numeric,uuid,text,text) from public;
grant execute on function public.record_tank_stock_check(uuid,uuid,numeric,uuid,text,text) to service_role;
