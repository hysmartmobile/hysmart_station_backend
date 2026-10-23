-- v2.11.0: explicit per-shift nozzle roster and all-nozzle opening readiness gate.
create table if not exists public.shift_nozzle_roster (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 cash_shift_id uuid not null references public.station_cash_shifts(id) on delete cascade,
 nozzle_id uuid not null, assigned_by uuid not null references auth.users(id), assigned_at timestamptz not null default now(),
 unique(cash_shift_id,nozzle_id),
 foreign key(station_id,nozzle_id) references public.pump_nozzles(station_id,id)
);
create index if not exists shift_nozzle_roster_station_shift_idx on public.shift_nozzle_roster(station_id,cash_shift_id);
alter table public.shift_nozzle_roster enable row level security;

create or replace function public.set_shift_nozzle_roster(p_station_id uuid,p_shift_id uuid,p_nozzle_ids uuid[],p_assigned_by uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_shift public.station_cash_shifts%rowtype; v_count integer; v_expected integer;
begin
 select * into v_shift from public.station_cash_shifts where id=p_shift_id and station_id=p_station_id for update;
 if not found or v_shift.status <> 'open' then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 if exists(select 1 from public.nozzle_meter_readings where cash_shift_id=p_shift_id) or
    exists(select 1 from public.kg_nozzle_meter_readings where cash_shift_id=p_shift_id) then
   raise exception 'ROSTER_LOCKED_AFTER_ACTIVITY';
 end if;
 select count(*) into v_count from (select distinct unnest(coalesce(p_nozzle_ids,'{}'::uuid[])) as id) x;
 if v_count=0 then raise exception 'EMPTY_SHIFT_NOZZLE_ROSTER'; end if;
 select count(*) into v_expected from public.pump_nozzles n where n.station_id=p_station_id and n.status='active' and n.id=any(coalesce(p_nozzle_ids,'{}'::uuid[]));
 if v_expected<>v_count then raise exception 'INVALID_SHIFT_NOZZLE'; end if;
 delete from public.shift_nozzle_roster where cash_shift_id=p_shift_id and station_id=p_station_id;
 insert into public.shift_nozzle_roster(station_id,cash_shift_id,nozzle_id,assigned_by)
 select p_station_id,p_shift_id,x.id,p_assigned_by from (select distinct unnest(p_nozzle_ids) id) x;
 return jsonb_build_object('cash_shift_id',p_shift_id,'nozzle_count',v_count,'nozzle_ids',to_jsonb(p_nozzle_ids));
end $$;
revoke all on function public.set_shift_nozzle_roster(uuid,uuid,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.set_shift_nozzle_roster(uuid,uuid,uuid[],uuid) to service_role;

-- Every nozzle in a configured manager-defined roster must have an approved opening
-- before ANY closing/sales meter can be recorded for this shift. Legacy shifts without
-- a roster retain the per-nozzle opening gate so deployment does not deadlock old shifts.
create or replace function public.enforce_approved_shift_opening()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_unit text; v_roster_count integer; v_missing_count integer;
begin
 if tg_table_name='kg_nozzle_meter_readings' then v_unit:='kg'; else v_unit:='litre'; end if;
 select count(*) into v_roster_count from public.shift_nozzle_roster r where r.station_id=new.station_id and r.cash_shift_id=new.cash_shift_id;
 if v_roster_count>0 then
   if not exists(select 1 from public.shift_nozzle_roster r where r.station_id=new.station_id and r.cash_shift_id=new.cash_shift_id and r.nozzle_id=new.nozzle_id) then
     raise exception 'NOZZLE_NOT_ASSIGNED_TO_SHIFT';
   end if;
   select count(*) into v_missing_count from public.shift_nozzle_roster r
   where r.station_id=new.station_id and r.cash_shift_id=new.cash_shift_id and not exists(
    select 1 from public.shift_meter_openings o where o.station_id=r.station_id and o.cash_shift_id=r.cash_shift_id and o.nozzle_id=r.nozzle_id and o.status='approved'
   );
   if v_missing_count>0 then raise exception 'SHIFT_OPENING_READINESS_INCOMPLETE'; end if;
 end if;
 if not exists(select 1 from public.shift_meter_openings o where o.station_id=new.station_id and o.cash_shift_id=new.cash_shift_id and o.nozzle_id=new.nozzle_id and o.unit_of_measure=v_unit and o.status='approved') then
   raise exception 'APPROVED_OPENING_METER_REQUIRED';
 end if;
 return new;
end $$;
