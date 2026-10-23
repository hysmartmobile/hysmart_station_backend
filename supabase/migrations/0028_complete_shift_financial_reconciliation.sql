-- v2.12.0: complete shift reconciliation across litre + kg sales, reversals, and approval gates.
-- Additive migration; apply after 0027_shift_nozzle_roster_readiness.sql.
alter table public.station_shift_reconciliations
  add column if not exists cash_variance numeric(16,2) not null default 0,
  add column if not exists handover_note text,
  add column if not exists reconciliation_version integer not null default 2;

create or replace function public.reconcile_station_cash_shift(
 p_station_id uuid,p_shift_id uuid,p_reconciled_by uuid,p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 v_shift public.station_cash_shifts%rowtype;
 v_expected numeric(16,2); v_cash numeric(16,2); v_pos numeric(16,2); v_bank numeric(16,2); v_other numeric(16,2);
 v_total numeric(16,2); v_var numeric(16,2); v_row public.station_shift_reconciliations%rowtype;
begin
 select * into v_shift from public.station_cash_shifts
  where id=p_shift_id and station_id=p_station_id and status='closed' for update;
 if not found then raise exception 'CLOSED_CASH_SHIFT_REQUIRED'; end if;

 -- Do not finalize a financial handover while meter/opening decisions or reversals remain unresolved.
 if exists(select 1 from public.nozzle_meter_readings where cash_shift_id=p_shift_id and status='pending')
    or exists(select 1 from public.kg_nozzle_meter_readings where cash_shift_id=p_shift_id and status='pending')
    or exists(select 1 from public.shift_meter_openings where cash_shift_id=p_shift_id and status='pending') then
   raise exception 'SHIFT_APPROVALS_PENDING';
 end if;
 if exists(
   select 1 from public.shift_nozzle_roster r
   where r.station_id=p_station_id and r.cash_shift_id=p_shift_id
   and not exists(select 1 from public.shift_meter_openings o where o.station_id=r.station_id and o.cash_shift_id=r.cash_shift_id and o.nozzle_id=r.nozzle_id and o.status='approved')
 ) then raise exception 'SHIFT_OPENING_READINESS_INCOMPLETE'; end if;
 if exists(select 1 from public.sales_collection_reversal_requests rr join public.sales_collections c on c.id=rr.collection_id where c.cash_shift_id=p_shift_id and rr.status='pending')
    or exists(select 1 from public.kg_collection_reversal_requests rr join public.kg_sales_collections c on c.id=rr.collection_id where c.cash_shift_id=p_shift_id and rr.status='pending') then
   raise exception 'SHIFT_REVERSALS_PENDING';
 end if;

 select coalesce(sum(expected_amount),0) into v_expected
 from public.nozzle_meter_readings where cash_shift_id=p_shift_id and status='approved';
 select v_expected+coalesce(sum(expected_amount),0) into v_expected
 from public.kg_nozzle_meter_readings where cash_shift_id=p_shift_id and status='approved';

 with all_collections as (
   select 'litre'::text as source_type,c.id,c.amount,c.payment_method from public.sales_collections c where c.cash_shift_id=p_shift_id
   union all
   select 'kg'::text as source_type,c.id,c.amount,c.payment_method from public.kg_sales_collections c where c.cash_shift_id=p_shift_id
 ), all_reversals as (
   select 'litre'::text as source_type,r.collection_id,r.amount from public.sales_collection_reversals r where r.station_id=p_station_id
   union all
   select 'kg'::text as source_type,r.collection_id,r.amount from public.kg_sales_collection_reversals r where r.station_id=p_station_id
 ), net as (
   select c.source_type,c.id,c.payment_method,c.amount-coalesce(sum(r.amount),0) as net_amount
   from all_collections c left join all_reversals r on r.collection_id=c.id and r.source_type=c.source_type group by c.source_type,c.id,c.payment_method,c.amount
 )
 select coalesce(sum(net_amount) filter(where payment_method='cash'),0),
        coalesce(sum(net_amount) filter(where payment_method='pos'),0),
        coalesce(sum(net_amount) filter(where payment_method='bank_transfer'),0),
        coalesce(sum(net_amount) filter(where payment_method='other'),0)
 into v_cash,v_pos,v_bank,v_other from net;

 v_total:=v_cash+v_pos+v_bank+v_other;
 v_var:=round(v_total-v_expected,2);
 insert into public.station_shift_reconciliations(
   station_id,cash_shift_id,expected_sales,collected_total,cash_collected,pos_collected,
   bank_transfer_collected,other_collected,sales_variance,cash_variance,status,notes,handover_note,
   reconciled_by,reconciled_at,reconciliation_version
 ) values (
   p_station_id,p_shift_id,v_expected,v_total,v_cash,v_pos,v_bank,v_other,v_var,
   round(coalesce(v_shift.variance,0),2),
   case when abs(v_var)<0.01 then 'balanced' when v_var<0 then 'short' else 'over' end,
   left(coalesce(p_notes,''),1000),left(coalesce(p_notes,''),1000),p_reconciled_by,now(),2
 ) on conflict(cash_shift_id) do update set
   expected_sales=excluded.expected_sales,collected_total=excluded.collected_total,
   cash_collected=excluded.cash_collected,pos_collected=excluded.pos_collected,
   bank_transfer_collected=excluded.bank_transfer_collected,other_collected=excluded.other_collected,
   sales_variance=excluded.sales_variance,cash_variance=excluded.cash_variance,
   status=excluded.status,notes=excluded.notes,handover_note=excluded.handover_note,
   reconciled_by=excluded.reconciled_by,reconciled_at=excluded.reconciled_at,reconciliation_version=2
 returning * into v_row;
 return to_jsonb(v_row);
end $$;
revoke all on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) from public;
grant execute on function public.reconcile_station_cash_shift(uuid,uuid,uuid,text) to service_role;
