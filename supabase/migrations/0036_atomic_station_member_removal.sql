-- HySmart Station v2.23.3: atomic, audited station-member removal.
-- Owner/director may remove any branch member. A branch manager may remove attendants only.
-- Removal and audit insertion run in one transaction; historical operational records remain intact.
create or replace function public.remove_station_member(
  p_actor_user_id uuid,
  p_station_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_station public.stations%rowtype;
  v_company_role text;
  v_company_status text;
  v_actor_role text;
  v_actor_status text;
  v_target public.station_members%rowtype;
  v_is_leader boolean := false;
  v_is_manager boolean := false;
begin
  if p_actor_user_id is null or p_target_user_id is null or p_station_id is null then
    raise exception 'INVALID_MEMBER_REMOVAL_REQUEST';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception 'SELF_REMOVAL_NOT_ALLOWED';
  end if;

  select * into v_station
    from public.stations
    where id = p_station_id
    for share;
  if not found then raise exception 'STATION_NOT_FOUND'; end if;

  select role, status into v_company_role, v_company_status
    from public.company_members
    where company_id = v_station.company_id and user_id = p_actor_user_id
    for share;
  v_is_leader := coalesce(
    v_company_status = 'active' and v_company_role in ('COMPANY_OWNER', 'COMPANY_ADMIN'),
    false
  );

  select role, status into v_actor_role, v_actor_status
    from public.station_members
    where station_id = p_station_id and user_id = p_actor_user_id
    for share;
  v_is_manager := coalesce(
    v_actor_status = 'active' and v_actor_role = 'STATION_MANAGER',
    false
  );

  if not v_is_leader and not v_is_manager then
    raise exception 'FORBIDDEN';
  end if;

  select * into v_target
    from public.station_members
    where station_id = p_station_id and user_id = p_target_user_id
    for update;
  if not found or v_target.status <> 'active' then
    raise exception 'MEMBER_NOT_FOUND';
  end if;
  if v_target.role = 'STATION_MANAGER' and not v_is_leader then
    raise exception 'MANAGER_CANNOT_REMOVE_MANAGER';
  end if;
  if v_target.role = 'ATTENDANT' and not (v_is_leader or v_is_manager) then
    raise exception 'FORBIDDEN';
  end if;

  update public.station_members
    set status = 'removed', updated_at = now()
    where station_id = p_station_id and user_id = p_target_user_id and status = 'active'
    returning * into v_target;
  if not found then raise exception 'MEMBER_CHANGED'; end if;

  insert into public.audit_events(
    company_id, station_id, actor_user_id, action, entity_type, entity_id, metadata
  ) values (
    v_station.company_id, p_station_id, p_actor_user_id,
    'STATION_MEMBER_REMOVED', 'station_member', p_target_user_id::text,
    jsonb_build_object('role', v_target.role, 'status', v_target.status)
  );

  return jsonb_build_object(
    'station_id', v_target.station_id,
    'user_id', v_target.user_id,
    'role', v_target.role,
    'status', v_target.status,
    'updated_at', v_target.updated_at
  );
end;
$$;

revoke all on function public.remove_station_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_station_member(uuid, uuid, uuid) to service_role;
