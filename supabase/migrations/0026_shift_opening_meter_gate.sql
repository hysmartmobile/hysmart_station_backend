-- v2.10.0: shift-specific opening meter baseline and approval gate.
create table if not exists public.shift_meter_openings (
 id uuid primary key default gen_random_uuid(), station_id uuid not null references public.stations(id) on delete cascade,
 cash_shift_id uuid not null references public.station_cash_shifts(id) on delete cascade,
 nozzle_id uuid not null, unit_of_measure text not null check(unit_of_measure in ('litre','kg')),
 opening_meter numeric(16,3) not null check(opening_meter >= 0), status text not null default 'pending' check(status in ('pending','approved','rejected')),
 submitted_by uuid not null references auth.users(id), submission_notes text, submitted_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id), reviewed_at timestamptz, review_note text,
 foreign key(station_id,nozzle_id) references public.pump_nozzles(station_id,id)
);
create unique index if not exists one_active_shift_opening_per_nozzle on public.shift_meter_openings(cash_shift_id,nozzle_id) where status in ('pending','approved');
create index if not exists shift_openings_station_status_idx on public.shift_meter_openings(station_id,status,submitted_at desc);
alter table public.shift_meter_openings enable row level security;

create or replace function public.review_shift_meter_opening(p_opening_id uuid,p_reviewer uuid,p_approve boolean,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.shift_meter_openings%rowtype; v_shift public.station_cash_shifts%rowtype; v_nozzle public.pump_nozzles%rowtype;
begin
 select * into v from public.shift_meter_openings where id=p_opening_id for update;
 if not found then raise exception 'OPENING_READING_NOT_FOUND'; end if;
 if v.status <> 'pending' then raise exception 'OPENING_READING_ALREADY_REVIEWED'; end if;
 if v.submitted_by=p_reviewer then raise exception 'SELF_APPROVAL_NOT_ALLOWED'; end if;
 select * into v_shift from public.station_cash_shifts where id=v.cash_shift_id and station_id=v.station_id for update;
 if not found or v_shift.status <> 'open' then raise exception 'OPEN_CASH_SHIFT_REQUIRED'; end if;
 if p_approve then
   select * into v_nozzle from public.pump_nozzles where id=v.nozzle_id and station_id=v.station_id for update;
   if not found or v_nozzle.status <> 'active' then raise exception 'ACTIVE_NOZZLE_NOT_FOUND'; end if;
   if v.unit_of_measure='kg' then
     if v.opening_meter < v_nozzle.last_meter_kg then raise exception 'METER_ROLLBACK'; end if;
     update public.pump_nozzles set last_meter_kg=v.opening_meter where id=v.nozzle_id and station_id=v.station_id;
   else
     if v.opening_meter < v_nozzle.last_meter_litres then raise exception 'METER_ROLLBACK'; end if;
     update public.pump_nozzles set last_meter_litres=v.opening_meter where id=v.nozzle_id and station_id=v.station_id;
   end if;
   update public.shift_meter_openings set status='approved',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_opening_id returning * into v;
 else
   update public.shift_meter_openings set status='rejected',reviewed_by=p_reviewer,reviewed_at=now(),review_note=left(coalesce(p_note,''),1000) where id=p_opening_id returning * into v;
 end if;
 return to_jsonb(v);
end $$;
revoke all on function public.review_shift_meter_opening(uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_shift_meter_opening(uuid,uuid,boolean,text) to service_role;

-- Existing meter-sales submissions are closing readings. Do not accept them until
-- this cashier shift has an approved opening snapshot for the same nozzle and unit.
create or replace function public.enforce_approved_shift_opening()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_unit text; v_opening numeric;
begin
 if tg_table_name='kg_nozzle_meter_readings' then v_unit:='kg'; else v_unit:='litre'; end if;
 if not exists(select 1 from public.shift_meter_openings o where o.station_id=new.station_id and o.cash_shift_id=new.cash_shift_id and o.nozzle_id=new.nozzle_id and o.unit_of_measure=v_unit and o.status='approved') then
   raise exception 'APPROVED_OPENING_METER_REQUIRED';
 end if;
 return new;
end $$;
drop trigger if exists require_approved_opening_for_litre_closing on public.nozzle_meter_readings;
create trigger require_approved_opening_for_litre_closing before insert on public.nozzle_meter_readings for each row execute function public.enforce_approved_shift_opening();
drop trigger if exists require_approved_opening_for_kg_closing on public.kg_nozzle_meter_readings;
create trigger require_approved_opening_for_kg_closing before insert on public.kg_nozzle_meter_readings for each row execute function public.enforce_approved_shift_opening();
