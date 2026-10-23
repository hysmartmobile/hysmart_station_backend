-- HySmart Station v0.5.0: operational fuel assets, delivery, meter readings and collections.
-- Apply after 0001-0003 in staging first. This migration is additive and safe to re-run.
create extension if not exists pgcrypto;

create table if not exists public.fuel_products (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 name text not null check(length(trim(name)) between 2 and 80), code text not null check(length(trim(code)) between 1 and 24),
 default_price_per_litre numeric(14,2) not null check(default_price_per_litre >= 0), status text not null default 'active' check(status in ('active','inactive')),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id, code), unique(company_id,id)
);
create table if not exists public.station_tanks (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 product_id uuid not null references public.fuel_products(id), name text not null check(length(trim(name)) between 2 and 80),
 capacity_litres numeric(14,2) not null check(capacity_litres > 0), opening_stock_litres numeric(14,2) not null default 0 check(opening_stock_litres >= 0),
 status text not null default 'active' check(status in ('active','inactive')), created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(station_id,name), unique(station_id,id)
);
create table if not exists public.station_pumps (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 name text not null check(length(trim(name)) between 1 and 80), status text not null default 'active' check(status in ('active','inactive')),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), unique(station_id,name), unique(station_id,id)
);
create table if not exists public.pump_nozzles (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 pump_id uuid not null, tank_id uuid not null, product_id uuid not null references public.fuel_products(id),
 name text not null check(length(trim(name)) between 1 and 80), last_meter_litres numeric(16,3) not null default 0 check(last_meter_litres >= 0),
 status text not null default 'active' check(status in ('active','inactive')), created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 unique(pump_id,name), unique(station_id,id), foreign key(station_id,pump_id) references public.station_pumps(station_id,id), foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);
create table if not exists public.tank_deliveries (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, supplier_name text not null check(length(trim(supplier_name)) between 2 and 160), delivery_reference text not null check(length(trim(delivery_reference)) between 1 and 100),
 quantity_litres numeric(14,2) not null check(quantity_litres > 0), unit_cost_per_litre numeric(14,2) not null check(unit_cost_per_litre >= 0), delivered_at timestamptz not null default now(),
 entered_by uuid not null references auth.users(id), notes text, created_at timestamptz not null default now(), unique(station_id,delivery_reference),
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);
create table if not exists public.nozzle_meter_readings (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade, nozzle_id uuid not null,
 previous_meter_litres numeric(16,3) not null check(previous_meter_litres >= 0), current_meter_litres numeric(16,3) not null check(current_meter_litres >= previous_meter_litres),
 litres_sold numeric(16,3) generated always as (current_meter_litres-previous_meter_litres) stored,
 price_per_litre numeric(14,2) not null check(price_per_litre >= 0), expected_amount numeric(16,2) generated always as ((current_meter_litres-previous_meter_litres)*price_per_litre) stored,
 recorded_by uuid not null references auth.users(id), recorded_at timestamptz not null default now(), shift_date date not null default current_date, notes text,
 foreign key(station_id,nozzle_id) references public.pump_nozzles(station_id,id), unique(station_id,id)
);
create table if not exists public.sales_collections (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 reading_id uuid not null, amount numeric(16,2) not null check(amount >= 0),
 payment_method text not null check(payment_method in ('cash','pos','bank_transfer','other')), reference text, collected_by uuid not null references auth.users(id), collected_at timestamptz not null default now(), notes text, foreign key(station_id,reading_id) references public.nozzle_meter_readings(station_id,id)
);
create table if not exists public.shift_reconciliations (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade, shift_date date not null,
 expected_amount numeric(16,2) not null, collected_amount numeric(16,2) not null, variance_amount numeric(16,2) not null,
 status text not null check(status in ('balanced','short','over')), notes text, reconciled_by uuid not null references auth.users(id), reconciled_at timestamptz not null default now(),
 unique(station_id,shift_date)
);
create index if not exists fuel_products_company_idx on public.fuel_products(company_id,status);
create index if not exists tanks_station_idx on public.station_tanks(station_id,status);
create index if not exists pumps_station_idx on public.station_pumps(station_id,status);
create index if not exists nozzles_station_idx on public.pump_nozzles(station_id,status);
create index if not exists deliveries_station_time_idx on public.tank_deliveries(station_id,delivered_at desc);
create index if not exists readings_station_date_idx on public.nozzle_meter_readings(station_id,shift_date desc);
create index if not exists collections_station_time_idx on public.sales_collections(station_id,collected_at desc);
create index if not exists reconciliations_station_date_idx on public.shift_reconciliations(station_id,shift_date desc);

-- Tables are accessed through the authenticated API using the server-only service key;
-- the API validates the caller's JWT and role before each read/write.
alter table public.fuel_products enable row level security;
alter table public.station_tanks enable row level security;
alter table public.station_pumps enable row level security;
alter table public.pump_nozzles enable row level security;
alter table public.tank_deliveries enable row level security;
alter table public.nozzle_meter_readings enable row level security;
alter table public.sales_collections enable row level security;
alter table public.shift_reconciliations enable row level security;

-- Serialize concurrent meter submissions for the same nozzle. The API checks the
-- authenticated caller's station role before calling this server-side function.
create or replace function public.record_nozzle_meter_reading(
 p_station_id uuid, p_nozzle_id uuid, p_current_meter_litres numeric, p_price_per_litre numeric,
 p_recorded_by uuid, p_shift_date date, p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_nozzle public.pump_nozzles%rowtype; v_reading public.nozzle_meter_readings%rowtype;
begin
 if p_current_meter_litres < 0 or p_price_per_litre < 0 then raise exception 'Meter reading and price must not be negative'; end if;
 select * into v_nozzle from public.pump_nozzles where id=p_nozzle_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'Active nozzle not found at this station'; end if;
 if p_current_meter_litres < v_nozzle.last_meter_litres then raise exception 'METER_ROLLBACK: current reading is below the last saved reading'; end if;
 insert into public.nozzle_meter_readings(station_id,nozzle_id,previous_meter_litres,current_meter_litres,price_per_litre,recorded_by,shift_date,notes)
 values(p_station_id,p_nozzle_id,v_nozzle.last_meter_litres,p_current_meter_litres,p_price_per_litre,p_recorded_by,coalesce(p_shift_date,current_date),p_notes)
 returning * into v_reading;
 update public.pump_nozzles set last_meter_litres=p_current_meter_litres where id=p_nozzle_id and station_id=p_station_id;
 return to_jsonb(v_reading);
end $$;
revoke all on function public.record_nozzle_meter_reading(uuid,uuid,numeric,numeric,uuid,date,text) from public;
grant execute on function public.record_nozzle_meter_reading(uuid,uuid,numeric,numeric,uuid,date,text) to service_role;

DO $$ BEGIN
 if not exists (select 1 from pg_constraint where conname='station_tanks_opening_stock_capacity_check') then
  alter table public.station_tanks add constraint station_tanks_opening_stock_capacity_check check(opening_stock_litres <= capacity_litres);
 end if;
END $$;
