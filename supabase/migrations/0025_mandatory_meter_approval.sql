-- HySmart Station v2.9.0: mandatory meter approval gates official sales.
-- Apply after migrations 0001-0024 in staging first. Pending readings are not official.
alter table public.nozzle_meter_readings add column if not exists status text not null default 'approved' check(status in ('pending','approved','rejected'));
alter table public.nozzle_meter_readings add column if not exists reviewed_by uuid references auth.users(id);
alter table public.nozzle_meter_readings add column if not exists reviewed_at timestamptz;
alter table public.nozzle_meter_readings add column if not exists review_note text;
alter table public.kg_nozzle_meter_readings add column if not exists status text not null default 'approved' check(status in ('pending','approved','rejected'));
alter table public.kg_nozzle_meter_readings add column if not exists reviewed_by uuid references auth.users(id);
alter table public.kg_nozzle_meter_readings add column if not exists reviewed_at timestamptz;
alter table public.kg_nozzle_meter_readings add column if not exists review_note text;
-- Existing history remains approved; only new submissions are pending.
create index if not exists nozzle_meter_pending_idx on public.nozzle_meter_readings(station_id,status,recorded_at desc);
create index if not exists kg_meter_pending_idx on public.kg_nozzle_meter_readings(station_id,status,recorded_at desc);
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
 if exists(select 1 from public.nozzle_meter_readings where nozzle_id=p_nozzle_id and status='pending') then raise exception 'METER_APPROVAL_PENDING'; end if;
 if p_current_meter_litres < v_nozzle.last_meter_litres then raise exception 'METER_ROLLBACK'; end if;
 insert into public.nozzle_meter_readings(station_id,nozzle_id,previous_meter_litres,current_meter_litres,price_per_litre,recorded_by,shift_date,notes,cash_shift_id,idempotency_key,status)
 values(p_station_id,p_nozzle_id,v_nozzle.last_meter_litres,p_current_meter_litres,p_price_per_litre,p_recorded_by,coalesce(p_shift_date,current_date),p_notes,p_shift_id,p_idempotency_key,'pending')
 returning * into v_reading;
 -- Meter baseline advances only after manager approval.
 return to_jsonb(v_reading);
exception when unique_violation then
 if p_idempotency_key is not null then
   select * into v_reading from public.nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key;
   if found and v_reading.recorded_by=p_recorded_by and v_reading.cash_shift_id=p_shift_id then return to_jsonb(v_reading); end if;
 end if;
 raise;
end $$;

revoke all on function public.record_shift_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.record_shift_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) to service_role;
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
 if exists(select 1 from public.kg_nozzle_meter_readings where nozzle_id=p_nozzle_id and status='pending') then raise exception 'METER_APPROVAL_PENDING'; end if;
 if p_current_meter_kg<v_nozzle.last_meter_kg then raise exception 'METER_ROLLBACK'; end if;
 insert into public.kg_nozzle_meter_readings(station_id,nozzle_id,previous_meter_kg,current_meter_kg,price_per_kg,recorded_by,shift_date,cash_shift_id,notes,idempotency_key,status)
 values(p_station_id,p_nozzle_id,v_nozzle.last_meter_kg,p_current_meter_kg,p_price_per_kg,p_recorded_by,coalesce(p_shift_date,current_date),p_shift_id,left(p_notes,1000),p_idempotency_key,'pending') returning * into v_reading;
 -- Meter baseline advances only after manager approval.
 return to_jsonb(v_reading);
exception when unique_violation then
 if p_idempotency_key is not null then select * into v_reading from public.kg_nozzle_meter_readings where station_id=p_station_id and idempotency_key=p_idempotency_key; if found and v_reading.recorded_by=p_recorded_by and v_reading.cash_shift_id=p_shift_id and v_reading.nozzle_id=p_nozzle_id and v_reading.current_meter_kg=round(p_current_meter_kg,3) and v_reading.price_per_kg=round(p_price_per_kg,2) and v_reading.shift_date=coalesce(p_shift_date,current_date) then return to_jsonb(v_reading); end if; end if; raise;
end $$;

revoke all on function public.record_shift_kg_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.record_shift_kg_meter_reading(uuid,uuid,numeric,numeric,uuid,uuid,date,text,uuid) to service_role;
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
 if v_reading.status <> 'approved' then raise exception 'METER_APPROVAL_REQUIRED'; end if;
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

revoke all on function public.record_shift_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_shift_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) to service_role;
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
 if v_reading.status <> 'approved' then raise exception 'METER_APPROVAL_REQUIRED'; end if;
 insert into public.kg_sales_collections(station_id,reading_id,amount,payment_method,reference,collected_by,notes,cash_shift_id,idempotency_key)
 values(p_station_id,p_reading_id,p_amount,left(p_payment_method,20),left(p_reference,100),p_collected_by,left(p_notes,1000),p_shift_id,p_idempotency_key) returning * into v_collection;
 return to_jsonb(v_collection);
exception when unique_violation then
 if p_idempotency_key is not null then select * into v_collection from public.kg_sales_collections where station_id=p_station_id and idempotency_key=p_idempotency_key; if found and v_collection.collected_by=p_collected_by and v_collection.cash_shift_id=p_shift_id and v_collection.reading_id=p_reading_id and v_collection.amount=round(p_amount,2) and v_collection.payment_method=p_payment_method and v_collection.reference is not distinct from left(p_reference,100) then return to_jsonb(v_collection); end if; end if; raise;
end $$;

revoke all on function public.record_kg_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.record_kg_sales_collection(uuid,uuid,uuid,numeric,text,text,uuid,text,uuid) to service_role;

create or replace function public.review_meter_reading(p_reading_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.nozzle_meter_readings%rowtype;
begin
 select * into v from public.nozzle_meter_readings where id=p_reading_id for update;
 if not found then raise exception 'READING_NOT_FOUND'; end if;
 if v.status <> 'pending' then raise exception 'READING_ALREADY_REVIEWED'; end if;
 if v.recorded_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 if p_approve then
   update public.pump_nozzles set last_meter_litres=v.current_meter_litres where id=v.nozzle_id and station_id=v.station_id;
   update public.nozzle_meter_readings set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_reading_id returning * into v;
 else update public.nozzle_meter_readings set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_reading_id returning * into v; end if;
 return to_jsonb(v);
end $$;
revoke all on function public.review_meter_reading(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_meter_reading(uuid,uuid,boolean,text) to service_role;

create or replace function public.review_kg_meter_reading(p_reading_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.kg_nozzle_meter_readings%rowtype;
begin
 select * into v from public.kg_nozzle_meter_readings where id=p_reading_id for update;
 if not found then raise exception 'READING_NOT_FOUND'; end if;
 if v.status <> 'pending' then raise exception 'READING_ALREADY_REVIEWED'; end if;
 if v.recorded_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 if p_approve then update public.pump_nozzles set last_meter_kg=v.current_meter_kg where id=v.nozzle_id and station_id=v.station_id;
   update public.kg_nozzle_meter_readings set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_reading_id returning * into v;
 else update public.kg_nozzle_meter_readings set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_reading_id returning * into v; end if;
 return to_jsonb(v);
end $$;
revoke all on function public.review_kg_meter_reading(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_kg_meter_reading(uuid,uuid,boolean,text) to service_role;
