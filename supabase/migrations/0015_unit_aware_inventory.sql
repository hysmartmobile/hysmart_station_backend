-- HySmart Station v1.6.0: explicit units for fuel inventory.
-- Existing fuels are migrated as litres except products coded/named LPG or GAS, which use kg.
-- This adds unit-aware fields without deleting legacy litre columns used by existing reports.
alter table public.fuel_products alter column default_price_per_litre drop not null;
alter table public.station_tanks alter column capacity_litres drop not null;
alter table public.station_tanks alter column opening_stock_litres drop not null;
alter table public.tank_deliveries alter column quantity_litres drop not null;
alter table public.tank_deliveries alter column unit_cost_per_litre drop not null;

alter table public.fuel_products add column if not exists unit_of_measure text not null default 'litre';
alter table public.fuel_products add column if not exists default_price_per_unit numeric(14,2);
update public.fuel_products set unit_of_measure = case when upper(code) in ('LPG','LPG-GAS') or upper(name) like '%LPG%' or upper(name) in ('GAS','COOKING GAS','LIQUEFIED PETROLEUM GAS') then 'kg' else 'litre' end where default_price_per_unit is null;
update public.fuel_products set default_price_per_unit = coalesce(default_price_per_unit, default_price_per_litre, 0);
alter table public.fuel_products alter column default_price_per_unit set not null;

alter table public.station_tanks add column if not exists unit_of_measure text not null default 'litre';
alter table public.station_tanks add column if not exists capacity_units numeric(14,2);
alter table public.station_tanks add column if not exists opening_stock_units numeric(14,2);
update public.station_tanks t set unit_of_measure=p.unit_of_measure, capacity_units=coalesce(t.capacity_units,t.capacity_litres), opening_stock_units=coalesce(t.opening_stock_units,t.opening_stock_litres,0) from public.fuel_products p where p.id=t.product_id;
alter table public.station_tanks alter column capacity_units set not null;
alter table public.station_tanks alter column opening_stock_units set not null;

alter table public.pump_nozzles add column if not exists last_meter_kg numeric(16,3) not null default 0;
update public.pump_nozzles n set last_meter_kg=0 where last_meter_kg is null;

alter table public.tank_deliveries add column if not exists unit_of_measure text not null default 'litre';
alter table public.tank_deliveries add column if not exists quantity_units numeric(14,2);
alter table public.tank_deliveries add column if not exists unit_cost_per_unit numeric(14,2);
update public.tank_deliveries d set unit_of_measure=t.unit_of_measure, quantity_units=coalesce(d.quantity_units,d.quantity_litres), unit_cost_per_unit=coalesce(d.unit_cost_per_unit,d.unit_cost_per_litre,0) from public.station_tanks t where t.id=d.tank_id;
alter table public.tank_deliveries alter column quantity_units set not null;
alter table public.tank_deliveries alter column unit_cost_per_unit set not null;

do $$ begin
 if not exists(select 1 from pg_constraint where conname='fuel_products_unit_of_measure_check') then alter table public.fuel_products add constraint fuel_products_unit_of_measure_check check(unit_of_measure in ('litre','kg')); end if;
 if not exists(select 1 from pg_constraint where conname='fuel_products_default_price_per_unit_check') then alter table public.fuel_products add constraint fuel_products_default_price_per_unit_check check(default_price_per_unit >= 0); end if;
 if not exists(select 1 from pg_constraint where conname='station_tanks_unit_of_measure_check') then alter table public.station_tanks add constraint station_tanks_unit_of_measure_check check(unit_of_measure in ('litre','kg')); end if;
 if not exists(select 1 from pg_constraint where conname='station_tanks_capacity_units_check') then alter table public.station_tanks add constraint station_tanks_capacity_units_check check(capacity_units > 0 and opening_stock_units >= 0 and opening_stock_units <= capacity_units); end if;
 if not exists(select 1 from pg_constraint where conname='tank_deliveries_unit_of_measure_check') then alter table public.tank_deliveries add constraint tank_deliveries_unit_of_measure_check check(unit_of_measure in ('litre','kg')); end if;
 if not exists(select 1 from pg_constraint where conname='tank_deliveries_quantity_units_check') then alter table public.tank_deliveries add constraint tank_deliveries_quantity_units_check check(quantity_units > 0 and unit_cost_per_unit >= 0); end if;
end $$;

create or replace function public.validate_unit_aware_fuel_asset() returns trigger language plpgsql as $$
declare v_product_unit text;
begin
 if tg_table_name='station_tanks' then
  select unit_of_measure into v_product_unit from public.fuel_products where id=new.product_id;
  if v_product_unit is null or new.unit_of_measure <> v_product_unit then raise exception 'FUEL_UNIT_MISMATCH'; end if;
 elsif tg_table_name='tank_deliveries' then
  select unit_of_measure into v_product_unit from public.station_tanks where id=new.tank_id and station_id=new.station_id;
  if v_product_unit is null or new.unit_of_measure <> v_product_unit then raise exception 'FUEL_UNIT_MISMATCH'; end if;
 end if;
 return new;
end $$;
drop trigger if exists station_tanks_validate_unit on public.station_tanks;
create trigger station_tanks_validate_unit before insert or update of product_id,unit_of_measure on public.station_tanks for each row execute function public.validate_unit_aware_fuel_asset();
drop trigger if exists tank_deliveries_validate_unit on public.tank_deliveries;
create trigger tank_deliveries_validate_unit before insert or update of tank_id,station_id,unit_of_measure on public.tank_deliveries for each row execute function public.validate_unit_aware_fuel_asset();

-- Enforce unit boundaries at the database layer, including calls made outside the API.
create or replace function public.validate_litre_meter_reading_unit() returns trigger language plpgsql as $$
declare v_unit text;
begin
 select p.unit_of_measure into v_unit
 from public.pump_nozzles n join public.fuel_products p on p.id=n.product_id
 where n.id=new.nozzle_id and n.station_id=new.station_id;
 if v_unit is distinct from 'litre' then raise exception 'FUEL_UNIT_MISMATCH_USE_KG_WORKFLOW'; end if;
 return new;
end $$;
drop trigger if exists nozzle_meter_readings_validate_unit on public.nozzle_meter_readings;
create trigger nozzle_meter_readings_validate_unit before insert or update of nozzle_id,station_id on public.nozzle_meter_readings for each row execute function public.validate_litre_meter_reading_unit();

-- Physical stock check table is still litre-based; block direct kg writes until its kg counterpart exists.
create or replace function public.validate_litre_tank_stock_check_unit() returns trigger language plpgsql as $$
declare v_unit text;
begin
 select unit_of_measure into v_unit from public.station_tanks where id=new.tank_id and station_id=new.station_id;
 if v_unit is distinct from 'litre' then raise exception 'FUEL_UNIT_MISMATCH_USE_KG_WORKFLOW'; end if;
 return new;
end $$;
drop trigger if exists tank_stock_checks_validate_unit on public.tank_stock_checks;
create trigger tank_stock_checks_validate_unit before insert or update of tank_id,station_id on public.tank_stock_checks for each row execute function public.validate_litre_tank_stock_check_unit();

-- Capacity guard for kg deliveries. Since kg dispensing is not yet enabled, no assumed kg sales are deducted.
create or replace function public.guard_unit_aware_tank_delivery_capacity() returns trigger language plpgsql as $$
declare v_capacity numeric; v_opening numeric; v_unit text; v_prior_deliveries numeric;
begin
 select capacity_units,opening_stock_units,unit_of_measure into v_capacity,v_opening,v_unit from public.station_tanks where id=new.tank_id and station_id=new.station_id for update;
 if v_unit='kg' then
  select coalesce(sum(quantity_units),0) into v_prior_deliveries from public.tank_deliveries where tank_id=new.tank_id and station_id=new.station_id and id is distinct from new.id;
  if coalesce(v_opening,0)+v_prior_deliveries+new.quantity_units>v_capacity then raise exception 'TANK_CAPACITY_EXCEEDED'; end if;
 end if;
 return new;
end $$;
drop trigger if exists tank_deliveries_guard_unit_capacity on public.tank_deliveries;
create trigger tank_deliveries_guard_unit_capacity before insert or update of tank_id,station_id,quantity_units on public.tank_deliveries for each row execute function public.guard_unit_aware_tank_delivery_capacity();

-- Prevent silent unit changes after tanks/nozzles have been configured.
create or replace function public.prevent_fuel_product_unit_reassignment() returns trigger language plpgsql as $$
begin
 if new.unit_of_measure is distinct from old.unit_of_measure and (
   exists(select 1 from public.station_tanks where product_id=old.id) or
   exists(select 1 from public.pump_nozzles where product_id=old.id)
 ) then raise exception 'FUEL_UNIT_IN_USE'; end if;
 return new;
end $$;
drop trigger if exists fuel_products_prevent_unit_reassignment on public.fuel_products;
create trigger fuel_products_prevent_unit_reassignment before update of unit_of_measure on public.fuel_products for each row execute function public.prevent_fuel_product_unit_reassignment();
