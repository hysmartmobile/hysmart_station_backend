-- HySmart Station v0.9.0: auditable discrepancy cases and dual-control collection reversals.
-- Additive migration. Apply 0001-0007 in order in staging first; back up before production.
create extension if not exists pgcrypto;

create table if not exists public.station_disputes (
 id uuid primary key default gen_random_uuid(),
 station_id uuid not null references public.stations(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade,
 title text not null check(length(trim(title)) between 5 and 160),
 category text not null check(category in ('cash_variance','sales_variance','stock_variance','meter_issue','payment_issue','attendance_issue','other')),
 description text not null check(length(trim(description)) between 10 and 3000),
 evidence_reference text,
 status text not null default 'open' check(status in ('open','investigating','resolved','closed')),
 priority text not null default 'normal' check(priority in ('low','normal','high','critical')),
 reported_by uuid not null references auth.users(id),
 assigned_to uuid references auth.users(id),
 resolution text,
 resolved_by uuid references auth.users(id),
 resolved_at timestamptz,
 closed_by uuid references auth.users(id),
 closed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check ((status not in ('resolved','closed')) or (resolution is not null and resolved_by is not null and resolved_at is not null))
);
create index if not exists station_disputes_station_status_idx on public.station_disputes(station_id,status,priority,created_at desc);

create table if not exists public.station_dispute_events (
 id uuid primary key default gen_random_uuid(),
 dispute_id uuid not null references public.station_disputes(id) on delete cascade,
 actor_user_id uuid not null references auth.users(id),
 event_type text not null check(event_type in ('created','assigned','status_changed','evidence_added','commented','resolved','reopened','closed')),
 note text not null check(length(trim(note)) between 1 and 2000),
 evidence_reference text,
 created_at timestamptz not null default now()
);
create index if not exists station_dispute_events_timeline_idx on public.station_dispute_events(dispute_id,created_at);

create table if not exists public.sales_collection_reversal_requests (
 id uuid primary key default gen_random_uuid(),
 station_id uuid not null references public.stations(id) on delete cascade,
 collection_id uuid not null references public.sales_collections(id),
 requested_amount numeric(16,2) not null check(requested_amount > 0),
 reason text not null check(length(trim(reason)) between 10 and 1000),
 reference text,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_by uuid not null references auth.users(id),
 requested_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 review_note text,
 check(reviewed_by is null or reviewed_by <> requested_by),
 unique(id,station_id)
);
create index if not exists collection_reversal_requests_station_idx on public.sales_collection_reversal_requests(station_id,status,requested_at desc);

create table if not exists public.sales_collection_reversals (
 id uuid primary key default gen_random_uuid(),
 station_id uuid not null references public.stations(id) on delete cascade,
 collection_id uuid not null references public.sales_collections(id),
 request_id uuid not null unique references public.sales_collection_reversal_requests(id),
 amount numeric(16,2) not null check(amount > 0),
 payment_method text not null check(payment_method in ('cash','pos','bank_transfer','other')),
 reference text,
 reason text not null,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now()
);
create index if not exists collection_reversals_collection_idx on public.sales_collection_reversals(collection_id);
create index if not exists collection_reversals_station_idx on public.sales_collection_reversals(station_id,created_at desc);

alter table public.station_disputes enable row level security;
alter table public.station_dispute_events enable row level security;
alter table public.sales_collection_reversal_requests enable row level security;
alter table public.sales_collection_reversals enable row level security;

create or replace function public.review_sales_collection_reversal(p_request_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_req public.sales_collection_reversal_requests%rowtype; v_collection public.sales_collections%rowtype; v_already numeric(16,2); v_row public.sales_collection_reversals%rowtype;
begin
 select * into v_req from public.sales_collection_reversal_requests where id=p_request_id for update;
 if not found then raise exception 'REVERSAL_REQUEST_NOT_FOUND'; end if;
 if v_req.status <> 'pending' then raise exception 'REVERSAL_ALREADY_REVIEWED'; end if;
 if v_req.requested_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 select * into v_collection from public.sales_collections where id=v_req.collection_id and station_id=v_req.station_id for update;
 if not found then raise exception 'COLLECTION_NOT_FOUND'; end if;
 if not p_approve then
  update public.sales_collection_reversal_requests set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
  return jsonb_build_object('request',to_jsonb(v_req),'reversal',null);
 end if;
 select coalesce(sum(amount),0) into v_already from public.sales_collection_reversals where collection_id=v_collection.id;
 if v_req.requested_amount > v_collection.amount-v_already then raise exception 'REVERSAL_EXCEEDS_REMAINING_AMOUNT'; end if;
 insert into public.sales_collection_reversals(station_id,collection_id,request_id,amount,payment_method,reference,reason,created_by)
 values(v_req.station_id,v_collection.id,v_req.id,v_req.requested_amount,v_collection.payment_method,v_req.reference,v_req.reason,p_reviewer) returning * into v_row;
 update public.sales_collection_reversal_requests set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_request_id returning * into v_req;
 return jsonb_build_object('request',to_jsonb(v_req),'reversal',to_jsonb(v_row));
end $$;
revoke all on function public.review_sales_collection_reversal(uuid,uuid,boolean,text) from public;
grant execute on function public.review_sales_collection_reversal(uuid,uuid,boolean,text) to service_role;

-- Reconciliation uses net collections after approved reversals; originals remain immutable.
create or replace function public.reconcile_station_cash_shift(p_station_id uuid,p_shift_id uuid,p_reconciled_by uuid,p_notes text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_expected numeric(16,2); v_cash numeric(16,2); v_pos numeric(16,2); v_bank numeric(16,2); v_other numeric(16,2); v_total numeric(16,2); v_var numeric(16,2); v_row public.station_shift_reconciliations%rowtype;
begin
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id and status='closed' for update;
 if not found then raise exception 'CLOSED_CASH_SHIFT_REQUIRED'; end if;
 select coalesce(sum(expected_amount),0) into v_expected from public.nozzle_meter_readings where cash_shift_id=p_shift_id;
 select coalesce(sum(c.amount-coalesce(rv.amount,0)) filter(where c.payment_method='cash'),0),
        coalesce(sum(c.amount-coalesce(rv.amount,0)) filter(where c.payment_method='pos'),0),
        coalesce(sum(c.amount-coalesce(rv.amount,0)) filter(where c.payment_method='bank_transfer'),0),
        coalesce(sum(c.amount-coalesce(rv.amount,0)) filter(where c.payment_method='other'),0)
 into v_cash,v_pos,v_bank,v_other
 from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id
 where c.cash_shift_id=p_shift_id;
 v_total:=v_cash+v_pos+v_bank+v_other; v_var:=round(v_total-v_expected,2);
 insert into public.station_shift_reconciliations(station_id,cash_shift_id,expected_sales,collected_total,cash_collected,pos_collected,bank_transfer_collected,other_collected,sales_variance,status,notes,reconciled_by,reconciled_at)
 values(p_station_id,p_shift_id,v_expected,v_total,v_cash,v_pos,v_bank,v_other,v_var,case when abs(v_var)<0.01 then 'balanced' when v_var<0 then 'short' else 'over' end,left(coalesce(p_notes,''),1000),p_reconciled_by,now())
 on conflict(cash_shift_id) do update set expected_sales=excluded.expected_sales,collected_total=excluded.collected_total,cash_collected=excluded.cash_collected,pos_collected=excluded.pos_collected,bank_transfer_collected=excluded.bank_transfer_collected,other_collected=excluded.other_collected,sales_variance=excluded.sales_variance,status=excluded.status,notes=excluded.notes,reconciled_by=excluded.reconciled_by,reconciled_at=excluded.reconciled_at
 returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) from public;
grant execute on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) to service_role;

-- Cash expected at close must reflect approved reversals of cash collections.
create or replace function public.close_station_cash_shift(p_shift_id uuid,p_closed_by uuid,p_counted_cash numeric,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_cash numeric(14,2); v_expected numeric(14,2);
begin
 if p_counted_cash < 0 then raise exception 'INVALID_CASH_COUNT'; end if;
 select * into v_shift from public.station_cash_shifts where id=p_shift_id for update;
 if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
 if v_shift.status <> 'open' then raise exception 'SHIFT_ALREADY_CLOSED'; end if;
 select coalesce(sum(c.amount-coalesce(rv.amount,0)),0) into v_cash
 from public.sales_collections c left join (select collection_id,sum(amount) amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=c.id
 where c.cash_shift_id=v_shift.id and c.payment_method='cash';
 v_expected:=v_shift.opening_float+v_cash;
 update public.station_cash_shifts set status='closed',closed_by=p_closed_by,closed_at=now(),cash_collections=v_cash,expected_cash=v_expected,counted_cash=p_counted_cash,variance=round(p_counted_cash-v_expected,2),close_notes=left(coalesce(p_note,''),1000) where id=p_shift_id returning * into v_shift;
 return to_jsonb(v_shift);
end $$;
revoke all on function public.close_station_cash_shift(uuid,uuid,numeric,text) from public;
grant execute on function public.close_station_cash_shift(uuid,uuid,numeric,text) to service_role;
