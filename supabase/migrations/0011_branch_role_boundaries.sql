-- HySmart Station v1.1.0: enforce CEO-only company-wide authority and branch-scoped staff invitations.
-- Existing business records are retained. The API uses service_role, so these checks are repeated in the RPC.
create or replace function public.create_station_invitation(
 p_actor_user_id uuid,p_station_id uuid,p_phone text,p_role text,p_token_hash text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_station public.stations%rowtype; v_owner boolean:=false; v_manager boolean:=false; v_id uuid;
begin
 if p_actor_user_id is null or not exists(select 1 from auth.users where id=p_actor_user_id) then raise exception 'Authenticated user not found'; end if;
 if p_role not in ('STATION_MANAGER','ATTENDANT') then raise exception 'Invalid invitation role'; end if;
 if p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone number must use international format'; end if;
 select * into v_station from public.stations where id=p_station_id; if not found then raise exception 'Station not found'; end if;
 select exists(select 1 from public.company_members where company_id=v_station.company_id and user_id=p_actor_user_id and status='active' and role='COMPANY_OWNER') into v_owner;
 select exists(select 1 from public.station_members where station_id=p_station_id and user_id=p_actor_user_id and status='active' and role='STATION_MANAGER') into v_manager;
 if p_role='STATION_MANAGER' and not v_owner then raise exception 'Only the company owner can invite a branch manager'; end if;
 if p_role='ATTENDANT' and not (v_owner or v_manager) then raise exception 'Only the company owner or assigned branch manager can invite attendants'; end if;
 insert into public.station_invitations(station_id,phone,role,token_hash,invited_by) values(p_station_id,p_phone,p_role,p_token_hash,p_actor_user_id) returning id into v_id;
 insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id) values(v_station.company_id,p_station_id,p_actor_user_id,'INVITATION_CREATED','station_invitation',v_id::text);
 return jsonb_build_object('id',v_id,'status','pending','expiresAt',now()+interval '72 hours');
end $$;
revoke all on function public.create_station_invitation(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.create_station_invitation(uuid,uuid,text,text,text) to service_role;
