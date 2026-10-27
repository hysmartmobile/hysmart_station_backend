-- HySmart Station: email-bound manager/attendant invitations.
-- Additive and data-preserving. Existing phone invitations remain readable, but
-- newly created invitations are bound to an email address.
alter table public.station_invitations alter column phone drop not null;
alter table public.station_invitations add column if not exists email text;
create index if not exists station_invitations_pending_email_idx
  on public.station_invitations(lower(email), station_id)
  where status = 'pending';

drop function if exists public.create_station_invitation(uuid,uuid,text,text,text);
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

drop function if exists public.accept_station_invitation(uuid,text);
create or replace function public.accept_station_invitation(p_actor_user_id uuid,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_inv public.station_invitations%rowtype;
  v_company uuid;
  v_user_email text;
begin
  if p_actor_user_id is null then raise exception 'Authentication required'; end if;
  select lower(email) into v_user_email from auth.users where id=p_actor_user_id and email_confirmed_at is not null;
  if v_user_email is null then raise exception 'Confirm your email address before accepting this invitation'; end if;
  select * into v_inv from public.station_invitations where token_hash=p_token_hash for update;
  if not found or v_inv.status<>'pending' or v_inv.expires_at<=now() then
    raise exception 'Invitation is invalid, expired or already used';
  end if;
  if v_inv.email is null or lower(v_inv.email)<>v_user_email then
    raise exception 'Sign in with the email address that received this invitation';
  end if;
  select company_id into v_company from public.stations where id=v_inv.station_id;
  if v_inv.role='STATION_MANAGER' then
    update public.station_members set status='removed',updated_at=now()
      where station_id=v_inv.station_id and role='STATION_MANAGER' and status='active' and user_id<>p_actor_user_id;
  end if;
  insert into public.station_members(station_id,user_id,role,status)
    values(v_inv.station_id,p_actor_user_id,v_inv.role,'active')
    on conflict(station_id,user_id) do update set role=excluded.role,status='active',updated_at=now();
  update public.station_invitations set status='accepted',accepted_by=p_actor_user_id,accepted_at=now() where id=v_inv.id;
  insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id)
    values(v_company,v_inv.station_id,p_actor_user_id,'INVITATION_ACCEPTED','station_invitation',v_inv.id::text);
  return jsonb_build_object('stationId',v_inv.station_id,'role',v_inv.role,'status','active');
end $$;
revoke all on function public.accept_station_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_station_invitation(uuid,text) to service_role;
