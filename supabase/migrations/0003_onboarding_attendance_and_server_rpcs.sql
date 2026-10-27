-- HySmart Station v0.4.0. Additive migration: does not delete existing business data.
create table if not exists public.attendance_records (
 id uuid primary key default gen_random_uuid(),
 station_id uuid not null references public.stations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 clock_in_at timestamptz not null default now(),
 clock_out_at timestamptz,
 status text not null default 'open' check(status in ('open','closed','reviewed','flagged')),
 notes text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check(clock_out_at is null or clock_out_at >= clock_in_at)
);
create unique index if not exists attendance_one_open_shift_per_staff_station
 on public.attendance_records(station_id,user_id) where clock_out_at is null;
create index if not exists attendance_station_clockin_idx on public.attendance_records(station_id,clock_in_at desc);
create index if not exists attendance_user_clockin_idx on public.attendance_records(user_id,clock_in_at desc);
alter table public.attendance_records enable row level security;

-- These functions are called by the API after it verifies the caller's Supabase JWT.
-- Execute is restricted to service_role; the caller id is never accepted from the browser directly.
create or replace function public.bootstrap_company_owner(p_user_id uuid,p_company_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_company_id uuid; v_name text:=trim(p_company_name);
begin
 if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id) then raise exception 'Authenticated user not found'; end if;
 if length(v_name)<2 or length(v_name)>160 then raise exception 'Company name must contain 2–160 characters'; end if;
 if exists(select 1 from public.company_members where user_id=p_user_id and status='active') then raise exception 'User already belongs to an active company'; end if;
 insert into public.companies(name,created_by) values(v_name,p_user_id) returning id into v_company_id;
 insert into public.company_members(company_id,user_id,role,status) values(v_company_id,p_user_id,'COMPANY_OWNER','active');
 insert into public.audit_events(company_id,actor_user_id,action,entity_type,entity_id,metadata) values(v_company_id,p_user_id,'COMPANY_CREATED','company',v_company_id::text,jsonb_build_object('name',v_name));
 return jsonb_build_object('companyId',v_company_id,'name',v_name,'role','COMPANY_OWNER');
end $$;
revoke all on function public.bootstrap_company_owner(uuid,text) from public,anon,authenticated;
grant execute on function public.bootstrap_company_owner(uuid,text) to service_role;

create or replace function public.create_station_invitation(p_actor_user_id uuid,p_station_id uuid,p_phone text,p_role text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_station public.stations%rowtype; v_owner boolean:=false; v_manager boolean:=false; v_id uuid;
begin
 if p_actor_user_id is null or not exists(select 1 from auth.users where id=p_actor_user_id) then raise exception 'Authenticated user not found'; end if;
 if p_role not in ('STATION_MANAGER','ATTENDANT') then raise exception 'Invalid invitation role'; end if;
 if p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone number must use international format'; end if;
 select * into v_station from public.stations where id=p_station_id; if not found then raise exception 'Station not found'; end if;
 select exists(select 1 from public.company_members where company_id=v_station.company_id and user_id=p_actor_user_id and status='active' and role in ('COMPANY_OWNER','COMPANY_ADMIN')) into v_owner;
 select exists(select 1 from public.station_members where station_id=p_station_id and user_id=p_actor_user_id and status='active' and role='STATION_MANAGER') into v_manager;
 if p_role='STATION_MANAGER' and not v_owner then raise exception 'Only company owner/admin can invite a manager'; end if;
 if p_role='ATTENDANT' and not (v_owner or v_manager) then raise exception 'Only owner/admin or assigned manager can invite attendants'; end if;
 insert into public.station_invitations(station_id,phone,role,token_hash,invited_by) values(p_station_id,p_phone,p_role,p_token_hash,p_actor_user_id) returning id into v_id;
 insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id) values(v_station.company_id,p_station_id,p_actor_user_id,'INVITATION_CREATED','station_invitation',v_id::text);
 return jsonb_build_object('id',v_id,'status','pending','expiresAt',now()+interval '72 hours');
end $$;
revoke all on function public.create_station_invitation(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_station_invitation(uuid,uuid,text,text,text) to service_role;

create or replace function public.accept_station_invitation(p_actor_user_id uuid,p_token_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_inv public.station_invitations%rowtype; v_company uuid;
begin
 if p_actor_user_id is null or not exists(select 1 from auth.users where id=p_actor_user_id and phone_confirmed_at is not null) then raise exception 'A verified phone number is required'; end if;
 select * into v_inv from public.station_invitations where token_hash=p_token_hash for update;
 if not found or v_inv.status<>'pending' or v_inv.expires_at<=now() then raise exception 'Invitation is invalid, expired or already used'; end if;
 if not exists(select 1 from auth.users u where u.id=p_actor_user_id and regexp_replace(coalesce(u.phone,''),'[^0-9]','','g')=regexp_replace(v_inv.phone,'[^0-9]','','g')) then raise exception 'Verified phone number must match the invitation'; end if;
 select company_id into v_company from public.stations where id=v_inv.station_id;
 if v_inv.role='STATION_MANAGER' then update public.station_members set status='removed',updated_at=now() where station_id=v_inv.station_id and role='STATION_MANAGER' and status='active' and user_id<>p_actor_user_id; end if;
 insert into public.station_members(station_id,user_id,role,status) values(v_inv.station_id,p_actor_user_id,v_inv.role,'active') on conflict(station_id,user_id) do update set role=excluded.role,status='active',updated_at=now();
 update public.station_invitations set status='accepted',accepted_by=p_actor_user_id,accepted_at=now() where id=v_inv.id;
 insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id) values(v_company,v_inv.station_id,p_actor_user_id,'INVITATION_ACCEPTED','station_invitation',v_inv.id::text);
 return jsonb_build_object('stationId',v_inv.station_id,'role',v_inv.role,'status','active');
end $$;
revoke all on function public.accept_station_invitation(uuid,text) from public,anon,authenticated;
grant execute on function public.accept_station_invitation(uuid,text) to service_role;
