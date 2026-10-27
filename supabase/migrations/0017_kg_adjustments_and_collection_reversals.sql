-- HySmart Station v1.8.0: approved kilogram stock adjustments and dual-control kg collection reversals.
-- Apply after 0016_complete_kg_sales_workflow.sql. Originals remain immutable; all quantity ledgers stay unit-specific.
create table if not exists public.kg_stock_adjustment_requests (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, quantity_delta_kg numeric(14,2) not null check(quantity_delta_kg <> 0),
 reason text not null check(length(trim(reason)) between 5 and 500), reference text,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_by uuid not null references auth.users(id), requested_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id), reviewed_at timestamptz, review_note text,
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id),
 check(reviewed_by is null or reviewed_by <> requested_by)
);
create index if not exists kg_stock_adjustments_station_status_idx on public.kg_stock_adjustment_requests(station_id,status,requested_at desc);
create table if not exists public.kg_tank_stock_movements (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 tank_id uuid not null, movement_type text not null check(movement_type in ('adjustment_in','adjustment_out')),
 quantity_kg numeric(14,2) not null check(quantity_kg > 0), adjustment_request_id uuid not null unique references public.kg_stock_adjustment_requests(id),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 foreign key(station_id,tank_id) references public.station_tanks(station_id,id)
);
create index if not exists kg_stock_movements_tank_created_idx on public.kg_tank_stock_movements(tank_id,created_at desc);
alter table public.kg_stock_adjustment_requests enable row level security;
alter table public.kg_tank_stock_movements enable row level security;

create or replace function public.review_kg_stock_adjustment(p_request_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_req public.kg_stock_adjustment_requests%rowtype; v_tank public.station_tanks%rowtype; v_book numeric(14,2); v_next numeric(14,2);
begin
 select * into v_req from public.kg_stock_adjustment_requests where id=p_request_id for update;
 if not found then raise exception 'KG_ADJUSTMENT_NOT_FOUND'; end if;
 if v_req.status<>'pending' then raise exception 'KG_ADJUSTMENT_ALREADY_REVIEWED'; end if;
 if v_req.requested_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 select * into v_tank from public.station_tanks where id=v_req.tank_id and station_id=v_req.station_id and status='active' for update;
 if not found then raise exception 'TANK_NOT_FOUND'; end if;
 if v_tank.unit_of_measure is distinct from 'kg' then raise exception 'FUEL_UNIT_MISMATCH'; end if;
 if not p_approve then
  update public.kg_stock_adjustment_requests set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
  return to_jsonb(v_req);
 end if;
 select coalesce(v_tank.opening_stock_units,0)
   + coalesce((select sum(quantity_units) from public.tank_deliveries where station_id=v_req.station_id and tank_id=v_tank.id),0)
   - coalesce((select sum(r.kg_sold) from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=v_tank.id and r.station_id=v_req.station_id),0)
   + coalesce((select sum(case when movement_type='adjustment_in' then quantity_kg else -quantity_kg end) from public.kg_tank_stock_movements where station_id=v_req.station_id and tank_id=v_tank.id),0)
 into v_book;
 v_next:=v_book+v_req.quantity_delta_kg;
 if v_next<0 then raise exception 'ADJUSTMENT_NEGATIVE_STOCK'; end if;
 if v_next>v_tank.capacity_units then raise exception 'ADJUSTMENT_EXCEEDS_CAPACITY'; end if;
 insert into public.kg_tank_stock_movements(station_id,tank_id,movement_type,quantity_kg,adjustment_request_id,created_by)
 values(v_req.station_id,v_req.tank_id,case when v_req.quantity_delta_kg>0 then 'adjustment_in' else 'adjustment_out' end,abs(v_req.quantity_delta_kg),v_req.id,p_reviewer);
 update public.kg_stock_adjustment_requests set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
 return to_jsonb(v_req);
end $$;
revoke all on function public.review_kg_stock_adjustment(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_kg_stock_adjustment(uuid,uuid,boolean,text) to service_role;

create table if not exists public.kg_collection_reversal_requests (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 collection_id uuid not null references public.kg_sales_collections(id), requested_amount numeric(16,2) not null check(requested_amount>0),
 reason text not null check(length(trim(reason)) between 10 and 1000), reference text,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_by uuid not null references auth.users(id), requested_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id), reviewed_at timestamptz, review_note text,
 check(reviewed_by is null or reviewed_by<>requested_by), unique(id,station_id)
);
create index if not exists kg_collection_reversal_requests_station_idx on public.kg_collection_reversal_requests(station_id,status,requested_at desc);
create table if not exists public.kg_sales_collection_reversals (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 collection_id uuid not null references public.kg_sales_collections(id), request_id uuid not null unique references public.kg_collection_reversal_requests(id),
 amount numeric(16,2) not null check(amount>0), payment_method text not null check(payment_method in ('cash','pos','bank_transfer','other')),
 reference text, reason text not null, created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create index if not exists kg_collection_reversals_collection_idx on public.kg_sales_collection_reversals(collection_id);
create index if not exists kg_collection_reversals_station_idx on public.kg_sales_collection_reversals(station_id,created_at desc);
alter table public.kg_collection_reversal_requests enable row level security;
alter table public.kg_sales_collection_reversals enable row level security;

create or replace function public.review_kg_sales_collection_reversal(p_request_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_req public.kg_collection_reversal_requests%rowtype; v_collection public.kg_sales_collections%rowtype; v_already numeric(16,2); v_row public.kg_sales_collection_reversals%rowtype;
begin
 select * into v_req from public.kg_collection_reversal_requests where id=p_request_id for update;
 if not found then raise exception 'KG_REVERSAL_REQUEST_NOT_FOUND'; end if;
 if v_req.status<>'pending' then raise exception 'KG_REVERSAL_ALREADY_REVIEWED'; end if;
 if v_req.requested_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 select * into v_collection from public.kg_sales_collections where id=v_req.collection_id and station_id=v_req.station_id for update;
 if not found then raise exception 'KG_COLLECTION_NOT_FOUND'; end if;
 if not p_approve then
  update public.kg_collection_reversal_requests set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
  return jsonb_build_object('request',to_jsonb(v_req),'reversal',null);
 end if;
 select coalesce(sum(amount),0) into v_already from public.kg_sales_collection_reversals where collection_id=v_collection.id;
 if v_req.requested_amount>v_collection.amount-v_already then raise exception 'REVERSAL_EXCEEDS_REMAINING_AMOUNT'; end if;
 insert into public.kg_sales_collection_reversals(station_id,collection_id,request_id,amount,payment_method,reference,reason,created_by)
 values(v_req.station_id,v_collection.id,v_req.id,v_req.requested_amount,v_collection.payment_method,v_req.reference,v_req.reason,p_reviewer) returning * into v_row;
 update public.kg_collection_reversal_requests set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
 return jsonb_build_object('request',to_jsonb(v_req),'reversal',to_jsonb(v_row));
end $$;
revoke all on function public.review_kg_sales_collection_reversal(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_kg_sales_collection_reversal(uuid,uuid,boolean,text) to service_role;

-- Kg physical book balance now includes approved stock movements.
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
 select coalesce(v_tank.opening_stock_units,0)+coalesce((select sum(quantity_units) from public.tank_deliveries where tank_id=v_tank.id and station_id=p_station_id),0)
  -coalesce((select sum(r.kg_sold) from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=v_tank.id and r.station_id=p_station_id),0)
  +coalesce((select sum(case when movement_type='adjustment_in' then quantity_kg else -quantity_kg end) from public.kg_tank_stock_movements where tank_id=v_tank.id and station_id=p_station_id),0)
 into v_book;
 insert into public.kg_tank_stock_checks(station_id,tank_id,book_stock_kg,measured_stock_kg,measurement_method,measured_by,notes) values(p_station_id,p_tank_id,v_book,p_measured_stock_kg,p_measurement_method,p_measured_by,left(p_notes,1000)) returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.record_kg_tank_stock_check(uuid,uuid,numeric,uuid,text,text) from public,anon,authenticated;
grant execute on function public.record_kg_tank_stock_check(uuid,uuid,numeric,uuid,text,text) to service_role;

-- Cash shift cash count and sales reconciliation use net kg collections after approved reversals.
create or replace function public.close_station_cash_shift(p_shift_id uuid,p_closed_by uuid,p_counted_cash numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_cash numeric(14,2); v_expected numeric(14,2);
begin
 if p_counted_cash<0 then raise exception 'INVALID_CASH_COUNT'; end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id for update;
 if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
 if v_shift.status<>'open' then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
 select coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=v_shift.id and c.payment_method='cash'),0)
 +coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.kg_sales_collections c left join (select collection_id,sum(amount) amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=v_shift.id and c.payment_method='cash'),0) into v_cash;
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
 select
 coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='cash'),0)+coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.kg_sales_collections c left join (select collection_id,sum(amount) amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='cash'),0),
 coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='pos'),0)+coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.kg_sales_collections c left join (select collection_id,sum(amount) amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='pos'),0),
 coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='bank_transfer'),0)+coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.kg_sales_collections c left join (select collection_id,sum(amount) amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='bank_transfer'),0),
 coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='other'),0)+coalesce((select sum(c.amount-coalesce(rv.amount,0)) from public.kg_sales_collections c left join (select collection_id,sum(amount) amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id where c.cash_shift_id=p_shift_id and c.payment_method='other'),0)
 into v_cash,v_pos,v_bank,v_other;
 v_total:=v_cash+v_pos+v_bank+v_other; v_var:=round(v_total-v_expected,2);
 insert into public.station_shift_reconciliations(station_id,cash_shift_id,expected_sales,collected_total,cash_collected,pos_collected,bank_transfer_collected,other_collected,sales_variance,status,notes,reconciled_by,reconciled_at)
 values(p_station_id,p_shift_id,v_expected,v_total,v_cash,v_pos,v_bank,v_other,v_var,case when abs(v_var)<0.01 then 'balanced' when v_var<0 then 'short' else 'over' end,left(coalesce(p_notes,''),1000),p_reconciled_by,now())
 on conflict(cash_shift_id) do update set expected_sales=excluded.expected_sales,collected_total=excluded.collected_total,cash_collected=excluded.cash_collected,pos_collected=excluded.pos_collected,bank_transfer_collected=excluded.bank_transfer_collected,other_collected=excluded.other_collected,sales_variance=excluded.sales_variance,status=excluded.status,notes=excluded.notes,reconciled_by=excluded.reconciled_by,reconciled_at=excluded.reconciled_at returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) to service_role;

-- Company-owner dashboard now reports net kg collections after approved reversals.
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
        'collectionsToday', coalesce((select sum(sc.amount - coalesce(rv.reversed_amount,0)) from public.sales_collections sc left join (select collection_id,sum(amount) as reversed_amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=sc.id where sc.station_id=s.id and sc.collected_at >= date_trunc('day', now()) and sc.collected_at < date_trunc('day', now()) + interval '1 day'),0) + coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id and kc.collected_at >= date_trunc('day', now()) and kc.collected_at < date_trunc('day', now()) + interval '1 day'),0),
        'kgCollectionsToday', coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id and kc.collected_at >= date_trunc('day', now()) and kc.collected_at < date_trunc('day', now()) + interval '1 day'),0),
        'collectionsReversedToday', coalesce((select sum(rv.amount) from public.sales_collection_reversals rv join public.sales_collections sc on sc.id=rv.collection_id where sc.station_id=s.id and sc.collected_at >= date_trunc('day', now()) and sc.collected_at < date_trunc('day', now()) + interval '1 day'),0) + coalesce((select sum(rv.amount) from public.kg_sales_collection_reversals rv join public.kg_sales_collections sc on sc.id=rv.collection_id where sc.station_id=s.id and sc.collected_at >= date_trunc('day', now()) and sc.collected_at < date_trunc('day', now()) + interval '1 day'),0),
        'collectionsAllTime', coalesce((select sum(sc.amount - coalesce(rv.reversed_amount,0)) from public.sales_collections sc left join (select collection_id,sum(amount) as reversed_amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=sc.id where sc.station_id=s.id),0) + coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id),0),
        'kgCollectionsAllTime', coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id),0),
        'collectionsReversedAllTime', coalesce((select sum(rv.amount) from public.sales_collection_reversals rv where rv.station_id=s.id),0) + coalesce((select sum(rv.amount) from public.kg_sales_collection_reversals rv where rv.station_id=s.id),0),
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

-- Protect kilogram operational facts from in-place edits; approved correction records are the supported path.
drop trigger if exists immutable_kg_meter_reading_update on public.kg_nozzle_meter_readings;
create trigger immutable_kg_meter_reading_update before update on public.kg_nozzle_meter_readings for each row execute function public.reject_financial_fact_update();
drop trigger if exists immutable_kg_sales_collection_update on public.kg_sales_collections;
create trigger immutable_kg_sales_collection_update before update on public.kg_sales_collections for each row execute function public.reject_financial_fact_update();
drop trigger if exists immutable_kg_stock_movement_update on public.kg_tank_stock_movements;
create trigger immutable_kg_stock_movement_update before update on public.kg_tank_stock_movements for each row execute function public.reject_financial_fact_update();
drop trigger if exists immutable_kg_collection_reversal_update on public.kg_sales_collection_reversals;
create trigger immutable_kg_collection_reversal_update before update on public.kg_sales_collection_reversals for each row execute function public.reject_financial_fact_update();

-- Delivery capacity validation uses the same kg book-stock ledger as stock checks.
create or replace function public.guard_unit_aware_tank_delivery_capacity() returns trigger language plpgsql as $$
declare v_capacity numeric; v_opening numeric; v_unit text; v_prior_deliveries numeric; v_kg_sold numeric; v_adjustments numeric; v_book numeric;
begin
 select capacity_units,opening_stock_units,unit_of_measure into v_capacity,v_opening,v_unit from public.station_tanks where id=new.tank_id and station_id=new.station_id for update;
 if v_unit='kg' then
  select coalesce(sum(quantity_units),0) into v_prior_deliveries from public.tank_deliveries where tank_id=new.tank_id and station_id=new.station_id and id is distinct from new.id;
  select coalesce(sum(kg_sold),0) into v_kg_sold from public.kg_nozzle_meter_readings r join public.pump_nozzles n on n.id=r.nozzle_id and n.station_id=r.station_id where n.tank_id=new.tank_id and r.station_id=new.station_id;
  select coalesce(sum(case when movement_type='adjustment_in' then quantity_kg else -quantity_kg end),0) into v_adjustments from public.kg_tank_stock_movements where tank_id=new.tank_id and station_id=new.station_id;
  v_book:=coalesce(v_opening,0)+v_prior_deliveries-v_kg_sold+v_adjustments;
  if v_book+new.quantity_units>v_capacity then raise exception 'TANK_CAPACITY_EXCEEDED'; end if;
  if v_book<0 then raise exception 'NEGATIVE_BOOK_STOCK_REQUIRES_RECONCILIATION'; end if;
 end if;
 return new;
end $$;
