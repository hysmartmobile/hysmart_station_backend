-- Forward-repair all permission-sensitive RPC regressions introduced by migration 0042.
-- Restore the email-bound invitation RPC, fail-closed subscription expiry, and Lagos dashboard day.
-- Safe to re-run; existing business records are not modified.
create or replace function public.create_station_for_owner(p_actor_user_id uuid, p_company_id uuid, p_name text, p_address text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_station public.stations%rowtype; v_sub public.company_subscriptions%rowtype; v_count integer; v_name text := trim(p_name); v_address text := trim(p_address);
begin
  if p_actor_user_id is null or not exists(
    select 1 from public.company_members
    where company_id=p_company_id and user_id=p_actor_user_id and status='active'
      and role in ('COMPANY_OWNER','COMPANY_ADMIN')
  ) then raise exception 'FORBIDDEN: only an active company owner or director can create branches'; end if;
  if length(v_name)<2 or length(v_name)>120 or length(v_address)<2 or length(v_address)>240 then raise exception 'Invalid branch name or address'; end if;
  select * into v_sub from public.company_subscriptions where company_id=p_company_id for update;
  if not found or v_sub.status <> 'active' or v_sub.current_period_end is null or v_sub.current_period_end <= now() then raise exception 'SUBSCRIPTION_REQUIRED: an active paid plan is required to create a branch'; end if;
  select count(*) into v_count from public.stations where company_id=p_company_id and status='active';
  if v_count >= v_sub.branch_limit then raise exception 'BRANCH_LIMIT_REACHED: upgrade your plan to add another branch'; end if;
  insert into public.stations(company_id,name,address,created_by) values(p_company_id,v_name,v_address,p_actor_user_id) returning * into v_station;
  insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(p_company_id,v_station.id,p_actor_user_id,'STATION_CREATED','station',v_station.id::text,jsonb_build_object('name',v_station.name,'plan',v_sub.plan,'actorRole',(select role from public.company_members where company_id=p_company_id and user_id=p_actor_user_id and status='active')));
  return jsonb_build_object('id',v_station.id,'company_id',v_station.company_id,'name',v_station.name,'address',v_station.address,'status',v_station.status,'created_at',v_station.created_at);
end $$;
revoke all on function public.create_station_for_owner(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_station_for_owner(uuid,uuid,text,text) to service_role;

create or replace function public.create_station_invitation(
  p_actor_user_id uuid, p_station_id uuid, p_email text, p_role text, p_token_hash text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_station public.stations%rowtype;
  v_owner boolean := false;
  v_manager boolean := false;
  v_id uuid;
  v_expiry timestamptz;
begin
  if p_actor_user_id is null or not exists(select 1 from auth.users where id=p_actor_user_id) then
    raise exception 'Authenticated user not found';
  end if;
  if p_role not in ('STATION_MANAGER','ATTENDANT') then raise exception 'Invalid invitation role'; end if;
  if p_email is null or length(trim(p_email)) > 254 or trim(p_email) !~* '^[A-Z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$' then
    raise exception 'A valid invitee email address is required';
  end if;
  select * into v_station from public.stations where id=p_station_id;
  if not found then raise exception 'Station not found'; end if;
  select exists(select 1 from public.company_members where company_id=v_station.company_id and user_id=p_actor_user_id and status='active' and role in ('COMPANY_OWNER','COMPANY_ADMIN')) into v_owner;
  select exists(select 1 from public.station_members where station_id=p_station_id and user_id=p_actor_user_id and status='active' and role='STATION_MANAGER') into v_manager;
  if p_role='STATION_MANAGER' and not v_owner then raise exception 'Only company owner/admin can invite a manager'; end if;
  if p_role='ATTENDANT' and not (v_owner or v_manager) then raise exception 'Only owner/admin or assigned manager can invite attendants'; end if;
  update public.station_invitations set status='revoked'
    where lower(email)=lower(trim(p_email)) and station_id=p_station_id and status='pending';
  insert into public.station_invitations(station_id,email,phone,role,token_hash,invited_by)
    values(p_station_id,lower(trim(p_email)),null,p_role,p_token_hash,p_actor_user_id)
    returning id, expires_at into v_id,v_expiry;
  insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(v_station.company_id,p_station_id,p_actor_user_id,'INVITATION_CREATED','station_invitation',v_id::text,jsonb_build_object('email',lower(trim(p_email)),'role',p_role));
  return jsonb_build_object('id',v_id,'status','pending','expiresAt',v_expiry);
end $$;
revoke all on function public.create_station_invitation(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_station_invitation(uuid,uuid,text,text,text) to service_role;

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
    and cm.role in ('COMPANY_OWNER', 'COMPANY_ADMIN')
    and cm.status = 'active'
  order by cm.created_at asc
  limit 1;

  if v_company_id is null then
    raise exception 'COMPANY_LEADER_REQUIRED';
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
        'attendanceToday', coalesce((select count(*) from public.attendance_records ar where ar.station_id=s.id and ar.clock_in_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and ar.clock_in_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0),
        'openShifts', coalesce((select count(*) from public.attendance_records ar where ar.station_id=s.id and ar.clock_out_at is null),0),
        'salesToday', coalesce((select sum(nmr.expected_amount) from public.nozzle_meter_readings nmr where nmr.station_id=s.id and nmr.status='approved' and nmr.recorded_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and nmr.recorded_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0) + coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved' and kg.recorded_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and kg.recorded_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0),
        'salesAllTime', coalesce((select sum(nmr.expected_amount) from public.nozzle_meter_readings nmr where nmr.station_id=s.id and nmr.status='approved'),0) + coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved'),0),
        'kgSalesToday', coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved' and kg.recorded_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and kg.recorded_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0),
        'kgSalesAllTime', coalesce((select sum(kg.expected_amount) from public.kg_nozzle_meter_readings kg where kg.station_id=s.id and kg.status='approved'),0),
        'collectionsToday', coalesce((select sum(sc.amount) from public.sales_collections sc where sc.station_id=s.id and sc.collected_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and sc.collected_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0) + coalesce((select sum(kc.amount) from public.kg_sales_collections kc where kc.station_id=s.id and kc.collected_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and kc.collected_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0) - coalesce((select sum(rv.amount) from public.sales_collection_reversals rv where rv.station_id=s.id and rv.created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and rv.created_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0) - coalesce((select sum(rv.amount) from public.kg_sales_collection_reversals rv where rv.station_id=s.id and rv.created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and rv.created_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0),
        'kgCollectionsToday', coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id and kc.collected_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and kc.collected_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0),
        'collectionsReversedToday', coalesce((select sum(rv.amount) from public.sales_collection_reversals rv where rv.station_id=s.id and rv.created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and rv.created_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0) + coalesce((select sum(rv.amount) from public.kg_sales_collection_reversals rv where rv.station_id=s.id and rv.created_at >= (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') and rv.created_at < (date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') + interval '1 day'),0),
        'collectionsAllTime', coalesce((select sum(sc.amount - coalesce(rv.reversed_amount,0)) from public.sales_collections sc left join (select collection_id,sum(amount) as reversed_amount from public.sales_collection_reversals group by collection_id) rv on rv.collection_id=sc.id where sc.station_id=s.id),0) + coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id),0),
        'kgCollectionsAllTime', coalesce((select sum(kc.amount - coalesce(rv.reversed_amount,0)) from public.kg_sales_collections kc left join (select collection_id,sum(amount) reversed_amount from public.kg_sales_collection_reversals group by collection_id) rv on rv.collection_id=kc.id where kc.station_id=s.id),0),
        'collectionsReversedAllTime', coalesce((select sum(rv.amount) from public.sales_collection_reversals rv where rv.station_id=s.id),0) + coalesce((select sum(rv.amount) from public.kg_sales_collection_reversals rv where rv.station_id=s.id),0),
        'tankCount', coalesce((select count(*) from public.station_tanks st where st.station_id=s.id and st.status='active'),0),
        'pumpCount', coalesce((select count(*) from public.station_pumps sp where sp.station_id=s.id and sp.status='active'),0),
        'deliveryVolumeAllTime', coalesce((select sum(td.quantity_litres) from public.tank_deliveries td where td.station_id=s.id),0),
        'kgDeliveryVolumeAllTime', coalesce((select sum(td.quantity_units) from public.tank_deliveries td where td.station_id=s.id and td.unit_of_measure='kg'),0),
        'latestReconciliation', (select jsonb_build_object('date',sr.reconciled_at::date,'status',sr.status,'variance',sr.sales_variance) from public.station_shift_reconciliations sr where sr.station_id=s.id order by sr.reconciled_at desc limit 1)
      ) order by s.name)
      from public.stations s where s.company_id=v_company_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.get_company_dashboard_summary(uuid) from public, anon, authenticated;
grant execute on function public.get_company_dashboard_summary(uuid) to service_role;
