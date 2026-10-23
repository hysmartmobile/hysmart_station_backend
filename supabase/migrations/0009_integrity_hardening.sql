-- HySmart Station v1.1.0: database-enforced stock integrity and idempotency payload checks.
-- Apply after 0001-0008 in staging first. No historical records are rewritten.

create or replace function public.calculate_tank_book_stock(p_tank_id uuid)
returns numeric(16,2)
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tank public.station_tanks%rowtype; v_delivered numeric(16,2); v_sold numeric(16,2); v_adjustments numeric(16,2);
begin
 select * into v_tank from public.station_tanks where id=p_tank_id;
 if not found then raise exception 'TANK_NOT_FOUND'; end if;
 select coalesce(sum(quantity_litres),0) into v_delivered from public.tank_deliveries where tank_id=p_tank_id;
 select coalesce(sum(r.litres_sold),0) into v_sold from public.nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=p_tank_id and r.station_id=v_tank.station_id;
 select coalesce(sum(case when movement_type='adjustment_in' then quantity_litres else -quantity_litres end),0) into v_adjustments from public.tank_stock_movements where tank_id=p_tank_id;
 return round(v_tank.opening_stock_litres+v_delivered-v_sold+v_adjustments,2);
end $$;
revoke all on function public.calculate_tank_book_stock(uuid) from public, anon, authenticated;
grant execute on function public.calculate_tank_book_stock(uuid) to service_role;

-- Fail safely if legacy rows already violate the relationships that the new guards enforce.
DO $$
BEGIN
 IF EXISTS (
   SELECT 1 FROM public.station_tanks t
   JOIN public.stations s ON s.id=t.station_id
   JOIN public.fuel_products p ON p.id=t.product_id
   WHERE s.company_id<>p.company_id
 ) THEN RAISE EXCEPTION 'V110_TANK_PRODUCT_COMPANY_MISMATCH: review existing tank/product company assignments before migration'; END IF;
 IF EXISTS (
   SELECT 1 FROM public.pump_nozzles n
   LEFT JOIN public.station_pumps p ON p.id=n.pump_id AND p.station_id=n.station_id
   LEFT JOIN public.station_tanks t ON t.id=n.tank_id AND t.station_id=n.station_id
   LEFT JOIN public.fuel_products fp ON fp.id=n.product_id
   JOIN public.stations s ON s.id=n.station_id
   WHERE p.id IS NULL OR t.id IS NULL OR t.product_id<>n.product_id OR fp.id IS NULL OR fp.company_id<>s.company_id
 ) THEN RAISE EXCEPTION 'V110_NOZZLE_ASSET_MISMATCH: review existing pump/nozzle/tank/product assignments before migration'; END IF;
END $$;

-- Database-level cross-tenant and asset consistency, even if an API validation is missed.
create or replace function public.validate_station_tank_product_company()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_station_company uuid; v_product_company uuid;
begin
 select company_id into v_station_company from public.stations where id=new.station_id;
 select company_id into v_product_company from public.fuel_products where id=new.product_id;
 if v_station_company is null or v_product_company is null or v_station_company<>v_product_company then
   raise exception 'TANK_PRODUCT_COMPANY_MISMATCH';
 end if;
 if new.opening_stock_litres>new.capacity_litres then raise exception 'STOCK_EXCEEDS_CAPACITY'; end if;
 if TG_OP='UPDATE' and new.product_id is distinct from old.product_id and (
   exists(select 1 from public.tank_deliveries d where d.tank_id=old.id) or
   exists(select 1 from public.pump_nozzles n where n.tank_id=old.id) or
   exists(select 1 from public.tank_stock_movements m where m.tank_id=old.id)
 ) then raise exception 'TANK_PRODUCT_HAS_HISTORY'; end if;
 if TG_OP='UPDATE' and new.capacity_litres is distinct from old.capacity_litres and public.calculate_tank_book_stock(old.id)>new.capacity_litres then raise exception 'TANK_CAPACITY_BELOW_BOOK_STOCK'; end if;
 if exists(select 1 from public.pump_nozzles n where n.tank_id=new.id and n.product_id<>new.product_id) then raise exception 'TANK_PRODUCT_IN_USE'; end if;
 return new;
end $$;
drop trigger if exists station_tank_product_company_guard on public.station_tanks;
create trigger station_tank_product_company_guard before insert or update of station_id,product_id,opening_stock_litres,capacity_litres on public.station_tanks
for each row execute function public.validate_station_tank_product_company();

create or replace function public.validate_nozzle_asset_consistency()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_tank_product uuid; v_product_company uuid; v_station_company uuid; v_pump_station uuid;
begin
 select station_id into v_pump_station from public.station_pumps where id=new.pump_id;
 select product_id into v_tank_product from public.station_tanks where id=new.tank_id and station_id=new.station_id;
 select company_id into v_station_company from public.stations where id=new.station_id;
 select company_id into v_product_company from public.fuel_products where id=new.product_id;
 if v_pump_station is null or v_pump_station<>new.station_id or v_tank_product is null or v_tank_product<>new.product_id or v_station_company is null or v_product_company is null or v_station_company<>v_product_company then
   raise exception 'NOZZLE_ASSET_MISMATCH';
 end if;
 if TG_OP='UPDATE' and (new.tank_id is distinct from old.tank_id or new.product_id is distinct from old.product_id) and exists(select 1 from public.nozzle_meter_readings r where r.nozzle_id=old.id) then raise exception 'NOZZLE_ASSET_HAS_HISTORY'; end if;
 return new;
end $$;
drop trigger if exists nozzle_asset_consistency_guard on public.pump_nozzles;
create trigger nozzle_asset_consistency_guard before insert or update of station_id,pump_id,tank_id,product_id on public.pump_nozzles
for each row execute function public.validate_nozzle_asset_consistency();

-- Lock the tank row during delivery inserts so two simultaneous deliveries cannot both pass
-- a stale application-side capacity check.
create or replace function public.guard_tank_delivery_capacity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tank public.station_tanks%rowtype; v_book numeric(16,2);
begin
 select * into v_tank from public.station_tanks where id=new.tank_id and station_id=new.station_id for update;
 if not found then raise exception 'TANK_NOT_FOUND'; end if;
 v_book:=public.calculate_tank_book_stock(new.tank_id);
 if v_book+new.quantity_litres>v_tank.capacity_litres then raise exception 'TANK_CAPACITY_EXCEEDED'; end if;
 return new;
end $$;
drop trigger if exists tank_delivery_capacity_guard on public.tank_deliveries;
create trigger tank_delivery_capacity_guard before insert on public.tank_deliveries
for each row execute function public.guard_tank_delivery_capacity();

-- Replace the idempotent meter RPC with full payload equality checks. Same key + same request
-- returns the original row; same key + changed payload fails closed.
create or replace function public.record_shift_meter_reading(
 p_station_id uuid,p_nozzle_id uuid,p_current_meter_litres numeric,p_price_per_litre numeric,
 p_recorded_by uuid,p_shift_id uuid,p_shift_date date,p_notes text default null,p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_nozzle public.pump_nozzles%rowtype; v_shift public.station_cash_shifts%rowtype; v_reading public.nozzle_meter_readings%rowtype; v_date date; v_meter numeric(16,3); v_price numeric(14,2);
begin
 if p_current_meter_litres is null or p_price_per_litre is null or p_current_meter_litres<0 or p_price_per_litre<0 then raise exception 'INVALID_METER_VALUE'; end if;
 v_meter:=round(p_current_meter_litres,3); v_price:=round(p_price_per_litre,2);
 v_date:=coalesce(p_shift_date,current_date);
 if p_idempotency_key is not null then
   select * into v_reading from public.nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found then
     if v_reading.recorded_by is distinct from p_recorded_by or v_reading.cash_shift_id is distinct from p_shift_id or v_reading.nozzle_id is distinct from p_nozzle_id or v_reading.current_meter_litres is distinct from v_meter or v_reading.price_per_litre is distinct from v_price or v_reading.shift_date is distinct from v_date or v_reading.notes is distinct from p_notes then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
     return to_jsonb(v_reading);
   end if;
 end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and cashier_user_id=p_recorded_by and status='open' for update;
 if not found then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 select * into v_nozzle from public.pump_nozzles where id=p_nozzle_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'ACTIVE_NOZZLE_NOT_FOUND'; end if;
 if v_meter<v_nozzle.last_meter_litres then raise exception 'METER_ROLLBACK'; end if;
 insert into public.nozzle_meter_readings(station_id,nozzle_id,previous_meter_litres,current_meter_litres,price_per_litre,recorded_by,shift_date,notes,cash_shift_id,idempotency_key)
 values(p_station_id,p_nozzle_id,v_nozzle.last_meter_litres,v_meter,v_price,p_recorded_by,v_date,p_notes,p_shift_id,p_idempotency_key) returning * into v_reading;
 update public.pump_nozzles set last_meter_litres=v_meter where id=p_nozzle_id and station_id=p_station_id;
 return to_jsonb(v_reading);
exception when unique_violation then
 if p_idempotency_key is not null then
   select * into v_reading from public.nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found and v_reading.recorded_by=p_recorded_by and v_reading.cash_shift_id=p_shift_id and v_reading.nozzle_id=p_nozzle_id and v_reading.current_meter_litres=round(p_current_meter_litres,3) and v_reading.price_per_litre=round(p_price_per_litre,2) and v_reading.shift_date=coalesce(p_shift_date,current_date) and v_reading.notes is not distinct from p_notes then return to_jsonb(v_reading); end if;
   raise exception 'IDEMPOTENCY_KEY_REUSED';
 end if;
 raise;
end $$;
revoke all on function public.record_shift_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.record_shift_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) to service_role;

-- Serialize collections per reading and reject net collections exceeding the meter-derived sale.
create or replace function public.record_shift_sales_collection(
 p_station_id uuid,p_reading_id uuid,p_shift_id uuid,p_amount numeric,p_payment_method text,
 p_reference text,p_collected_by uuid,p_notes text default null,p_idempotency_key uuid default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_reading public.nozzle_meter_readings%rowtype; v_collection public.sales_collections%rowtype; v_collected numeric(16,2); v_reversed numeric(16,2); v_amount numeric(16,2);
begin
 if p_amount is null or p_amount<=0 then raise exception 'INVALID_COLLECTION_AMOUNT'; end if;
 v_amount:=round(p_amount,2); if v_amount<=0 then raise exception 'INVALID_COLLECTION_AMOUNT'; end if;
 if p_payment_method not in ('cash','pos','bank_transfer','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
 if p_idempotency_key is not null then
   select * into v_collection from public.sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found then
     if v_collection.collected_by is distinct from p_collected_by or v_collection.cash_shift_id is distinct from p_shift_id or v_collection.reading_id is distinct from p_reading_id or v_collection.amount is distinct from v_amount or v_collection.payment_method is distinct from p_payment_method or v_collection.reference is distinct from left(p_reference,100) or v_collection.notes is distinct from left(p_notes,1000) then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
     return to_jsonb(v_collection);
   end if;
 end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and cashier_user_id=p_collected_by and status='open' for update;
 if not found then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 select * into v_reading from public.nozzle_meter_readings where id=p_reading_id and station_id=p_station_id and cash_shift_id=p_shift_id for update;
 if not found then raise exception 'READING_NOT_IN_CASH_SHIFT'; end if;
 select coalesce(sum(amount),0) into v_collected from public.sales_collections where reading_id=v_reading.id;
 select coalesce(sum(rv.amount),0) into v_reversed from public.sales_collection_reversals rv join public.sales_collections c on c.id=rv.collection_id where c.reading_id=v_reading.id;
 if v_collected-v_reversed+v_amount>v_reading.expected_amount then raise exception 'COLLECTION_EXCEEDS_READING_AMOUNT'; end if;
 insert into public.sales_collections(station_id,reading_id,amount,payment_method,reference,collected_by,notes,cash_shift_id,idempotency_key)
 values(p_station_id,p_reading_id,v_amount,p_payment_method,left(p_reference,100),p_collected_by,left(p_notes,1000),p_shift_id,p_idempotency_key) returning * into v_collection;
 return to_jsonb(v_collection);
exception when unique_violation then
 if p_idempotency_key is not null then
   select * into v_collection from public.sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found and v_collection.collected_by=p_collected_by and v_collection.cash_shift_id=p_shift_id and v_collection.reading_id=p_reading_id and v_collection.amount=round(p_amount,2) and v_collection.payment_method=p_payment_method and v_collection.reference is not distinct from left(p_reference,100) and v_collection.notes is not distinct from left(p_notes,1000) then return to_jsonb(v_collection); end if;
   raise exception 'IDEMPOTENCY_KEY_REUSED';
 end if;
 raise;
end $$;
revoke all on function public.record_shift_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_shift_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) to service_role;


-- Reversal approvals also lock the reading row, serializing them against collection RPCs.
create or replace function public.review_sales_collection_reversal(p_request_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_req public.sales_collection_reversal_requests%rowtype; v_collection public.sales_collections%rowtype; v_reading public.nozzle_meter_readings%rowtype; v_already numeric(16,2); v_row public.sales_collection_reversals%rowtype;
begin
 select * into v_req from public.sales_collection_reversal_requests where id=p_request_id for update;
 if not found then raise exception 'REVERSAL_REQUEST_NOT_FOUND'; end if;
 if v_req.status<>'pending' then raise exception 'REVERSAL_ALREADY_REVIEWED'; end if;
 if v_req.requested_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 select * into v_collection from public.sales_collections where id=v_req.collection_id and station_id=v_req.station_id for update;
 if not found then raise exception 'COLLECTION_NOT_FOUND'; end if;
 select * into v_reading from public.nozzle_meter_readings where id=v_collection.reading_id and station_id=v_collection.station_id for update;
 if not found then raise exception 'READING_NOT_FOUND'; end if;
 if not p_approve then
   update public.sales_collection_reversal_requests set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
   return jsonb_build_object('request',to_jsonb(v_req),'reversal',null);
 end if;
 select coalesce(sum(amount),0) into v_already from public.sales_collection_reversals where collection_id=v_collection.id;
 if v_req.requested_amount>v_collection.amount-v_already then raise exception 'REVERSAL_EXCEEDS_REMAINING_AMOUNT'; end if;
 insert into public.sales_collection_reversals(station_id,collection_id,request_id,amount,payment_method,reference,reason,created_by)
 values(v_req.station_id,v_collection.id,v_req.id,v_req.requested_amount,v_collection.payment_method,v_req.reference,v_req.reason,p_reviewer) returning * into v_row;
 update public.sales_collection_reversal_requests set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
 return jsonb_build_object('request',to_jsonb(v_req),'reversal',to_jsonb(v_row));
end $$;
revoke all on function public.review_sales_collection_reversal(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_sales_collection_reversal(uuid,uuid,boolean,text) to service_role;

-- Tighten the legacy daily reconciliation to net approved reversals. The API still calculates
-- this view for legacy reporting; shift-level reconciliation remains the preferred accounting unit.
