-- HySmart Station v2.25.0: verifiable deliveries, shop POS, anomaly cases and integration registry.
-- Apply after migrations 0001-0044. Review on staging before production.
create extension if not exists pgcrypto;

-- Append-only audit history. Existing application code may insert audit events, but cannot rewrite history.
create or replace function public.prevent_audit_event_mutation()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin if pg_trigger_depth() > 1 then if TG_OP='DELETE' then return old; else return new; end if; end if; raise exception 'AUDIT_LOG_APPEND_ONLY'; end $$;
drop trigger if exists audit_events_no_update on public.audit_events;
drop trigger if exists audit_events_no_delete on public.audit_events;
create trigger audit_events_no_update before update on public.audit_events for each row execute function public.prevent_audit_event_mutation();
create trigger audit_events_no_delete before delete on public.audit_events for each row execute function public.prevent_audit_event_mutation();
create index if not exists audit_events_company_created_idx on public.audit_events(company_id,created_at desc);

create table if not exists public.delivery_receipt_checks (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 station_id uuid not null references public.stations(id) on delete cascade,
 delivery_id uuid not null unique references public.tank_deliveries(id) on delete cascade,
 expected_quantity numeric(16,3) not null check(expected_quantity > 0), actual_quantity numeric(16,3) not null check(actual_quantity >= 0),
 expected_invoice_amount numeric(16,2) check(expected_invoice_amount >= 0), actual_invoice_amount numeric(16,2) check(actual_invoice_amount >= 0),
 quantity_variance numeric(16,3) generated always as (actual_quantity-expected_quantity) stored,
 invoice_variance numeric(16,2), status text not null check(status in ('matched','short','over','disputed','rejected')),
 supplier_document_reference text, notes text, verified_by uuid not null references auth.users(id), verified_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create index if not exists delivery_receipt_checks_station_time_idx on public.delivery_receipt_checks(station_id,verified_at desc);

-- Stock ledger calculations must exclude pending/rejected meter readings from official book stock.
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
 if v_tank.unit_of_measure is distinct from 'litre' then raise exception 'FUEL_UNIT_MISMATCH_USE_KG_WORKFLOW'; end if;
 if p_measured_stock_litres > v_tank.capacity_litres then raise exception 'MEASURED_STOCK_EXCEEDS_CAPACITY'; end if;
 select round(v_tank.opening_stock_litres
   + coalesce((select sum(case when rc.id is not null then rc.actual_quantity else d.quantity_litres end) from public.tank_deliveries d left join public.delivery_receipt_checks rc on rc.delivery_id=d.id where d.station_id=p_station_id and d.tank_id=p_tank_id),0)
   - coalesce((select sum(r.litres_sold) from public.nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where r.station_id=p_station_id and n.tank_id=p_tank_id and r.status='approved'),0)
   + coalesce((select sum(case when m.movement_type='adjustment_in' then m.quantity_litres else -m.quantity_litres end) from public.tank_stock_movements m where m.station_id=p_station_id and m.tank_id=p_tank_id),0),2)
 into v_book;
 if v_book < 0 then raise exception 'BOOK_STOCK_NEGATIVE'; end if;
 insert into public.tank_stock_checks(station_id,tank_id,book_stock_litres,measured_stock_litres,measurement_method,measured_by,notes)
 values(p_station_id,p_tank_id,v_book,p_measured_stock_litres,p_measurement_method,p_measured_by,left(p_notes,1000)) returning * into v_result;
 return to_jsonb(v_result);
end $$;
revoke all on function public.record_tank_stock_check(uuid,uuid,numeric,uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_tank_stock_check(uuid,uuid,numeric,uuid,text,text) to service_role;

create or replace function public.record_kg_tank_stock_check(
 p_station_id uuid,p_tank_id uuid,p_measured_stock_kg numeric,p_measured_by uuid,
 p_measurement_method text default 'manual_estimate',p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tank public.station_tanks%rowtype; v_book numeric(14,2); v_row public.kg_tank_stock_checks%rowtype;
begin
 if p_measured_stock_kg is null or p_measured_stock_kg<0 then raise exception 'INVALID_MEASURED_STOCK'; end if;
 if p_measurement_method not in ('manual_estimate','weigh_scale','electronic_gauge') then raise exception 'INVALID_MEASUREMENT_METHOD'; end if;
 select * into v_tank from public.station_tanks where id=p_tank_id and station_id=p_station_id and status='active' for update;
 if not found then raise exception 'ACTIVE_TANK_NOT_FOUND'; end if;
 if v_tank.unit_of_measure is distinct from 'kg' then raise exception 'FUEL_UNIT_MISMATCH_USE_LITRE_WORKFLOW'; end if;
 if p_measured_stock_kg>v_tank.capacity_units then raise exception 'MEASURED_STOCK_EXCEEDS_CAPACITY'; end if;
 select round(v_tank.opening_stock_units
   + coalesce((select sum(case when rc.id is not null then rc.actual_quantity else d.quantity_units end) from public.tank_deliveries d left join public.delivery_receipt_checks rc on rc.delivery_id=d.id where d.tank_id=v_tank.id and d.station_id=p_station_id),0)
   - coalesce((select sum(r.kg_sold) from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=v_tank.id and r.station_id=p_station_id and r.status='approved'),0)
   + coalesce((select sum(case when m.movement_type='adjustment_in' then m.quantity_kg else -m.quantity_kg end) from public.kg_tank_stock_movements m where m.station_id=p_station_id and m.tank_id=v_tank.id),0),2)
 into v_book;
 if v_book<0 then raise exception 'BOOK_STOCK_NEGATIVE'; end if;
 insert into public.kg_tank_stock_checks(station_id,tank_id,book_stock_kg,measured_stock_kg,measurement_method,measured_by,notes)
 values(p_station_id,p_tank_id,v_book,p_measured_stock_kg,p_measurement_method,p_measured_by,left(p_notes,1000)) returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.record_kg_tank_stock_check(uuid,uuid,numeric,uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_kg_tank_stock_check(uuid,uuid,numeric,uuid,text,text) to service_role;


create table if not exists public.shop_products (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 station_id uuid not null references public.stations(id) on delete cascade, sku text not null, name text not null check(length(trim(name)) between 2 and 120),
 category text not null default 'general', unit text not null default 'each', unit_price numeric(16,2) not null check(unit_price >= 0),
 stock_quantity numeric(16,3) not null default 0 check(stock_quantity >= 0), track_stock boolean not null default true,
 active boolean not null default true, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(station_id,sku), unique(station_id,id)
);
create index if not exists shop_products_station_active_idx on public.shop_products(station_id,active,name);

create table if not exists public.shop_sales (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 station_id uuid not null references public.stations(id) on delete cascade, receipt_number text not null,
 status text not null default 'posted' check(status in ('posted','voided','refunded')),
 subtotal numeric(16,2) not null check(subtotal >= 0), discount_amount numeric(16,2) not null default 0 check(discount_amount >= 0),
 total_amount numeric(16,2) not null check(total_amount >= 0), payment_method text not null check(payment_method in ('cash','pos','bank_transfer','credit','other')),
 payment_reference text, cashier_user_id uuid not null references auth.users(id), idempotency_key uuid not null,
 created_at timestamptz not null default now(), unique(station_id,idempotency_key), unique(station_id,receipt_number)
);
create index if not exists shop_sales_station_time_idx on public.shop_sales(station_id,created_at desc);
create table if not exists public.shop_sale_items (
 id uuid primary key default gen_random_uuid(), sale_id uuid not null references public.shop_sales(id) on delete restrict,
 station_id uuid not null references public.stations(id) on delete restrict, product_id uuid not null references public.shop_products(id) on delete restrict,
 sku_snapshot text not null, name_snapshot text not null, quantity numeric(16,3) not null check(quantity > 0),
 unit_price numeric(16,2) not null check(unit_price >= 0), line_total numeric(16,2) not null check(line_total >= 0), created_at timestamptz not null default now()
);
create index if not exists shop_sale_items_station_idx on public.shop_sale_items(station_id,created_at desc);

-- Idempotent atomic checkout: stock locks, totals and sale items commit in one transaction.
create or replace function public.checkout_shop_sale(
 p_station_id uuid, p_company_id uuid, p_cashier_user_id uuid, p_idempotency_key uuid,
 p_payment_method text, p_payment_reference text, p_discount_amount numeric, p_items jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_sale public.shop_sales%rowtype; v_item jsonb; v_product public.shop_products%rowtype; v_qty numeric(16,3); v_subtotal numeric(16,2):=0; v_total numeric(16,2); v_line numeric(16,2); v_receipt text;
begin
 if p_payment_method not in ('cash','pos','bank_transfer','credit','other') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>100 then raise exception 'INVALID_SALE_ITEMS'; end if;
 if exists (select 1 from jsonb_array_elements(p_items) as item(value) group by item.value->>'productId' having count(*)>1) then raise exception 'DUPLICATE_PRODUCT_ITEMS'; end if;
 if coalesce(p_discount_amount,0)<0 then raise exception 'INVALID_DISCOUNT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_station_id::text || ':' || p_idempotency_key::text, 0));
 select * into v_sale from public.shop_sales where station_id=p_station_id and idempotency_key=p_idempotency_key;
 if found then return jsonb_build_object('sale',to_jsonb(v_sale),'duplicate',true); end if;
 -- Lock all referenced products in deterministic ID order to avoid overselling and reduce deadlocks.
 perform 1 from public.shop_products p where p.station_id=p_station_id and p.id in (select (item.value->>'productId')::uuid from jsonb_array_elements(p_items) as item(value)) order by p.id for update;
 for v_item in select value from jsonb_array_elements(p_items) loop
   if coalesce(v_item->>'productId','') !~* '^[0-9a-f-]{36}$' then raise exception 'INVALID_PRODUCT_ID'; end if;
   v_qty:=nullif(v_item->>'quantity','')::numeric;
   if v_qty is null or v_qty<=0 or v_qty>1000000 then raise exception 'INVALID_ITEM_QUANTITY'; end if;
   select * into v_product from public.shop_products where id=(v_item->>'productId')::uuid and station_id=p_station_id and company_id=p_company_id and active=true;
   if not found then raise exception 'SHOP_PRODUCT_NOT_FOUND'; end if;
   if v_product.track_stock and v_product.stock_quantity<v_qty then raise exception 'SHOP_STOCK_INSUFFICIENT'; end if;
   v_line:=round(v_product.unit_price*v_qty,2); v_subtotal:=v_subtotal+v_line;
 end loop;
 if p_discount_amount>v_subtotal then raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL'; end if;
 v_total:=v_subtotal-coalesce(p_discount_amount,0); v_receipt:='SHOP-'||to_char(now() at time zone 'UTC','YYYYMMDDHH24MISS')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
 insert into public.shop_sales(company_id,station_id,receipt_number,subtotal,discount_amount,total_amount,payment_method,payment_reference,cashier_user_id,idempotency_key)
 values(p_company_id,p_station_id,v_receipt,v_subtotal,coalesce(p_discount_amount,0),v_total,p_payment_method,nullif(left(p_payment_reference,120),''),p_cashier_user_id,p_idempotency_key) returning * into v_sale;
 for v_item in select value from jsonb_array_elements(p_items) loop
   select * into v_product from public.shop_products where id=(v_item->>'productId')::uuid and station_id=p_station_id for update;
   v_qty:=(v_item->>'quantity')::numeric; v_line:=round(v_product.unit_price*v_qty,2);
   insert into public.shop_sale_items(sale_id,station_id,product_id,sku_snapshot,name_snapshot,quantity,unit_price,line_total)
   values(v_sale.id,p_station_id,v_product.id,v_product.sku,v_product.name,v_qty,v_product.unit_price,v_line);
   if v_product.track_stock then update public.shop_products set stock_quantity=stock_quantity-v_qty,updated_at=now() where id=v_product.id; end if;
 end loop;
 insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
 values(p_company_id,p_station_id,p_cashier_user_id,'SHOP_POS_SALE_POSTED','shop_sale',v_sale.id::text,jsonb_build_object('receiptNumber',v_receipt,'totalAmount',v_total,'paymentMethod',p_payment_method,'itemCount',jsonb_array_length(p_items)));
 return jsonb_build_object('sale',to_jsonb(v_sale),'duplicate',false);
end $$;
revoke all on function public.checkout_shop_sale(uuid,uuid,uuid,uuid,text,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.checkout_shop_sale(uuid,uuid,uuid,uuid,text,text,numeric,jsonb) to service_role;

create table if not exists public.operational_anomaly_cases (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 station_id uuid not null references public.stations(id) on delete cascade, fingerprint text not null,
 anomaly_type text not null, severity text not null check(severity in ('info','warning','critical')),
 title text not null, description text not null, source_table text, source_id uuid,
 status text not null default 'open' check(status in ('open','acknowledged','resolved','dismissed')),
 occurrence_count integer not null default 1 check(occurrence_count>0), first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
 escalation_level integer not null default 0 check(escalation_level between 0 and 3), next_escalation_at timestamptz,
 assigned_to uuid references auth.users(id) on delete set null, resolution_note text, resolved_by uuid references auth.users(id) on delete set null, resolved_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(station_id,fingerprint)
);
create index if not exists anomaly_cases_station_status_idx on public.operational_anomaly_cases(station_id,status,severity,last_seen_at desc);

create table if not exists public.integration_connections (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 station_id uuid references public.stations(id) on delete cascade, provider_key text not null,
 display_name text not null check(length(trim(display_name)) between 2 and 120), integration_type text not null check(integration_type in ('accounting','payment','dispenser','tank_gauge','pos','webhook','other')),
 status text not null default 'draft' check(status in ('draft','configured','testing','active','paused','error')),
 direction text not null default 'bidirectional' check(direction in ('inbound','outbound','bidirectional')),
 config jsonb not null default '{}'::jsonb check(jsonb_typeof(config)='object'), credential_reference text,
 last_tested_at timestamptz, last_success_at timestamptz, last_error_code text, created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists integration_connections_company_idx on public.integration_connections(company_id,station_id,status);
create table if not exists public.integration_event_log (
 id uuid primary key default gen_random_uuid(), connection_id uuid not null references public.integration_connections(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade, station_id uuid references public.stations(id) on delete set null,
 direction text not null check(direction in ('inbound','outbound')), event_type text not null, external_event_id text,
 idempotency_key text not null, status text not null default 'received' check(status in ('received','processed','ignored','failed')),
 payload_summary jsonb not null default '{}'::jsonb check(jsonb_typeof(payload_summary)='object'), error_code text,
 received_at timestamptz not null default now(), processed_at timestamptz, unique(connection_id,idempotency_key)
);
create index if not exists integration_event_log_connection_time_idx on public.integration_event_log(connection_id,received_at desc);

-- API-mediated access only: no direct client reads/writes through Supabase anon/authenticated keys.
do $$ declare t text; begin
 foreach t in array array['delivery_receipt_checks','shop_products','shop_sales','shop_sale_items','operational_anomaly_cases','integration_connections','integration_event_log'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon, authenticated',t);
  execute format('grant select, insert, update, delete on public.%I to service_role',t);
 end loop;
end $$;
grant select,insert,update on public.audit_events to service_role;

-- Central stock position query prevents frontend row limits or pending readings from distorting stock totals.
create or replace function public.calculate_tank_book_stock(p_tank_id uuid)
returns numeric(16,2) language plpgsql security definer set search_path=public,pg_temp as $$
declare v_tank public.station_tanks%rowtype; v_delivered numeric(16,2); v_sold numeric(16,2); v_adjustments numeric(16,2);
begin
 select * into v_tank from public.station_tanks where id=p_tank_id;
 if not found then raise exception 'TANK_NOT_FOUND'; end if;
 if v_tank.unit_of_measure is distinct from 'litre' then return null; end if;
 select coalesce(sum(case when rc.id is not null then rc.actual_quantity else d.quantity_litres end),0)
 into v_delivered from public.tank_deliveries d left join public.delivery_receipt_checks rc on rc.delivery_id=d.id where d.tank_id=p_tank_id and d.station_id=v_tank.station_id;
 select coalesce(sum(r.litres_sold),0) into v_sold from public.nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=p_tank_id and r.station_id=v_tank.station_id and r.status='approved';
 select coalesce(sum(case when movement_type='adjustment_in' then quantity_litres else -quantity_litres end),0) into v_adjustments from public.tank_stock_movements where tank_id=p_tank_id and station_id=v_tank.station_id;
 return round(coalesce(v_tank.opening_stock_litres,0)+v_delivered-v_sold+v_adjustments,2);
end $$;
revoke all on function public.calculate_tank_book_stock(uuid) from public,anon,authenticated;
grant execute on function public.calculate_tank_book_stock(uuid) to service_role;

create or replace function public.get_station_tank_stock_positions(p_station_id uuid)
returns table(tank_id uuid,unit_of_measure text,book_stock_units numeric(16,2))
language sql security definer set search_path=public,pg_temp as $$
 select t.id,t.unit_of_measure,round(
   coalesce(t.opening_stock_units,0)
   + case when t.unit_of_measure='kg' then
       coalesce((select sum(case when rc.id is not null then rc.actual_quantity else d.quantity_units end) from public.tank_deliveries d left join public.delivery_receipt_checks rc on rc.delivery_id=d.id where d.station_id=t.station_id and d.tank_id=t.id),0)
     else coalesce((select sum(case when rc.id is not null then rc.actual_quantity else d.quantity_litres end) from public.tank_deliveries d left join public.delivery_receipt_checks rc on rc.delivery_id=d.id where d.station_id=t.station_id and d.tank_id=t.id),0) end
   - case when t.unit_of_measure='kg' then
       coalesce((select sum(r.kg_sold) from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where r.station_id=t.station_id and n.tank_id=t.id and r.status='approved'),0)
     else coalesce((select sum(r.litres_sold) from public.nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where r.station_id=t.station_id and n.tank_id=t.id and r.status='approved'),0) end
   + case when t.unit_of_measure='kg' then
       coalesce((select sum(case when m.movement_type='adjustment_in' then m.quantity_kg else -m.quantity_kg end) from public.kg_tank_stock_movements m where m.station_id=t.station_id and m.tank_id=t.id),0)
     else coalesce((select sum(case when m.movement_type='adjustment_in' then m.quantity_litres else -m.quantity_litres end) from public.tank_stock_movements m where m.station_id=t.station_id and m.tank_id=t.id),0) end
 ,2) as book_stock_units
 from public.station_tanks t where t.station_id=p_station_id and t.status='active' order by t.name;
$$;
revoke all on function public.get_station_tank_stock_positions(uuid) from public,anon,authenticated;
grant execute on function public.get_station_tank_stock_positions(uuid) to service_role;
