create table if not exists public.station_invitations(id uuid primary key default gen_random_uuid(),station_id uuid not null references public.stations(id) on delete cascade,phone text not null,role text not null check(role in ('STATION_MANAGER','ATTENDANT')),token_hash text not null unique,invited_by uuid not null references auth.users(id),status text not null default 'pending' check(status in ('pending','accepted','revoked','expired')),expires_at timestamptz not null default now()+interval '72 hours',accepted_by uuid references auth.users(id),accepted_at timestamptz,created_at timestamptz not null default now());
create index if not exists station_invites_expiry_idx on public.station_invitations(status,expires_at);
alter table public.station_invitations enable row level security;
create or replace function public.create_station_invitation(p_station_id uuid,p_phone text,p_role text,p_token_hash text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_station public.stations%rowtype; v_owner boolean:=false; v_manager boolean:=false; v_id uuid;
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 select * into v_station from public.stations where id=p_station_id; if not found then raise exception 'Station not found'; end if;
 select exists(select 1 from public.company_members where company_id=v_station.company_id and user_id=v_uid and status='active' and role in ('COMPANY_OWNER','COMPANY_ADMIN')) into v_owner;
 select exists(select 1 from public.station_members where station_id=p_station_id and user_id=v_uid and status='active' and role='STATION_MANAGER') into v_manager;
 if p_role='STATION_MANAGER' and not v_owner then raise exception 'Only company owner/admin can invite a manager'; end if;
 if p_role='ATTENDANT' and not (v_owner or v_manager) then raise exception 'Only owner/admin or assigned manager can invite attendants'; end if;
 insert into public.station_invitations(station_id,phone,role,token_hash,invited_by) values(p_station_id,p_phone,p_role,p_token_hash,v_uid) returning id into v_id;
 insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id) values(v_station.company_id,p_station_id,v_uid,'INVITATION_CREATED','station_invitation',v_id::text);
 return jsonb_build_object('id',v_id,'status','pending','expiresAt',now()+interval '72 hours');
end $$;
create or replace function public.accept_station_invitation(p_token_hash text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_uid uuid:=auth.uid(); v_inv public.station_invitations%rowtype; v_company uuid;
begin
 if v_uid is null then raise exception 'Authentication required'; end if;
 select * into v_inv from public.station_invitations where token_hash=p_token_hash for update;
 if not found or v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'Invitation is invalid, expired or already used'; end if;
 if not exists(select 1 from auth.users u where u.id=v_uid and regexp_replace(coalesce(u.phone,''),'[^0-9]','','g')=regexp_replace(v_inv.phone,'[^0-9]','','g') and u.phone_confirmed_at is not null) then raise exception 'Verified phone number must match the invitation'; end if;
 select company_id into v_company from public.stations where id=v_inv.station_id;
 if v_inv.role='STATION_MANAGER' then
  -- Enforce one active manager: deactivation and reassignment are atomic.
  update public.station_members set status='removed',updated_at=now() where station_id=v_inv.station_id and role='STATION_MANAGER' and status='active' and user_id<>v_uid;
 end if;
 insert into public.station_members(station_id,user_id,role,status) values(v_inv.station_id,v_uid,v_inv.role,'active') on conflict(station_id,user_id) do update set role=excluded.role,status='active',updated_at=now();
 update public.station_invitations set status='accepted',accepted_by=v_uid,accepted_at=now() where id=v_inv.id;
 insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id) values(v_company,v_inv.station_id,v_uid,'INVITATION_ACCEPTED','station_invitation',v_inv.id::text);
 return jsonb_build_object('stationId',v_inv.station_id,'role',v_inv.role,'status','active');
end $$;
revoke all on function public.create_station_invitation(uuid,text,text,text) from public;grant execute on function public.create_station_invitation(uuid,text,text,text) to authenticated,service_role;
revoke all on function public.accept_station_invitation(text) from public;grant execute on function public.accept_station_invitation(text) to authenticated,service_role;
