-- HySmart Station v2.23.0: only approved meter readings contribute to owner dashboard sales totals.
-- Collections remain net of the append-only litre and kg reversal ledgers.
-- Apply after migrations 0001-0031.
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
        'salesToday', coalesce((select sum(nmr.expected_amount) from public.nozzle_meter_readings nmr where nmr.station_id=s.id and nmr.status='approved' and nmr.recorded_at >= date_trunc('day', now()) and nmr.recorded_at < date_trunc('day', now()) + interval '1 day'),0) + coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved' and kg.recorded_at >= date_trunc('day', now()) and kg.recorded_at < date_trunc('day', now()) + interval '1 day'),0),
        'salesAllTime', coalesce((select sum(nmr.expected_amount) from public.nozzle_meter_readings nmr where nmr.station_id=s.id and nmr.status='approved'),0) + coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved'),0),
        'kgSalesToday', coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved' and kg.recorded_at >= date_trunc('day', now()) and kg.recorded_at < date_trunc('day', now()) + interval '1 day'),0),
        'kgSalesAllTime', coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved'),0),
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
