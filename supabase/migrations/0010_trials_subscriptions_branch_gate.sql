-- HySmart Station: seven-day account trial metadata and paid branch entitlements.
-- Additive only; existing operational records are preserved.
alter table public.companies add column if not exists trial_started_at timestamptz;
alter table public.companies add column if not exists trial_ends_at timestamptz;

-- Existing companies receive a conservative trial window based on their owner's account creation date.
update public.companies c
set trial_started_at = coalesce(c.trial_started_at, u.created_at, c.created_at),
    trial_ends_at = coalesce(c.trial_ends_at, coalesce(u.created_at, c.created_at) + interval '7 days')
from auth.users u where u.id = c.created_by;
update public.companies c set trial_started_at = coalesce(c.trial_started_at, c.created_at), trial_ends_at = coalesce(c.trial_ends_at, c.created_at + interval '7 days') where c.trial_started_at is null or c.trial_ends_at is null;
alter table public.companies alter column trial_started_at set default now();
alter table public.companies alter column trial_ends_at set default (now() + interval '7 days');

create table if not exists public.company_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  plan text not null check (plan in ('starter','multi')),
  status text not null default 'pending' check (status in ('pending','paid','failed','abandoned')),
  amount_naira integer not null check (amount_naira in (30000,120000)),
  branch_limit integer not null check (branch_limit in (1,5)),
  paystack_reference text not null unique,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  check ((plan = 'starter' and amount_naira = 30000 and branch_limit = 1) or (plan = 'multi' and amount_naira = 120000 and branch_limit = 5))
);
create index if not exists company_payment_attempts_company_created_idx on public.company_payment_attempts(company_id, created_at desc);
alter table public.company_payment_attempts enable row level security;
revoke all on public.company_payment_attempts from anon, authenticated;
grant select, insert, update, delete on public.company_payment_attempts to service_role;

create table if not exists public.company_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null unique references public.companies(id) on delete cascade,
  plan text not null check (plan in ('starter','multi')),
  status text not null default 'pending' check (status in ('pending','active','past_due','cancelled','expired')),
  amount_naira integer not null check (amount_naira in (30000,120000)),
  branch_limit integer not null check (branch_limit in (1,5)),
  paystack_reference text unique,
  paystack_transaction_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((plan = 'starter' and amount_naira = 30000 and branch_limit = 1) or (plan = 'multi' and amount_naira = 120000 and branch_limit = 5))
);
create index if not exists company_subscriptions_status_period_idx on public.company_subscriptions(status,current_period_end);
alter table public.company_subscriptions enable row level security;
revoke all on public.company_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.company_subscriptions to service_role;

-- Service-role only RPC: subscription entitlement is enforced in the database and not just in UI.
create or replace function public.create_station_for_owner(p_actor_user_id uuid, p_company_id uuid, p_name text, p_address text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_station public.stations%rowtype; v_sub public.company_subscriptions%rowtype; v_count integer; v_name text := trim(p_name); v_address text := trim(p_address);
begin
  if p_actor_user_id is null or not exists(select 1 from public.company_members where company_id=p_company_id and user_id=p_actor_user_id and status='active' and role='COMPANY_OWNER') then raise exception 'FORBIDDEN: only the active company owner can create branches'; end if;
  if length(v_name)<2 or length(v_name)>120 or length(v_address)<2 or length(v_address)>240 then raise exception 'Invalid branch name or address'; end if;
  select * into v_sub from public.company_subscriptions where company_id=p_company_id for update;
  if not found or v_sub.status <> 'active' or (v_sub.current_period_end is not null and v_sub.current_period_end <= now()) then raise exception 'SUBSCRIPTION_REQUIRED: an active paid plan is required to create a branch'; end if;
  select count(*) into v_count from public.stations where company_id=p_company_id and status='active';
  if v_count >= v_sub.branch_limit then raise exception 'BRANCH_LIMIT_REACHED: upgrade your plan to add another branch'; end if;
  insert into public.stations(company_id,name,address,created_by) values(p_company_id,v_name,v_address,p_actor_user_id) returning * into v_station;
  insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata) values(p_company_id,v_station.id,p_actor_user_id,'STATION_CREATED','station',v_station.id::text,jsonb_build_object('name',v_station.name,'plan',v_sub.plan));
  return jsonb_build_object('id',v_station.id,'company_id',v_station.company_id,'name',v_station.name,'address',v_station.address,'status',v_station.status,'created_at',v_station.created_at);
end $$;
revoke all on function public.create_station_for_owner(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_station_for_owner(uuid,uuid,text,text) to service_role;

-- New owner company trials are anchored to auth.users.created_at (not delayed company setup time).
create or replace function public.bootstrap_company_owner(p_user_id uuid,p_company_name text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_company_id uuid; v_name text:=trim(p_company_name); v_created_at timestamptz;
begin
 if p_user_id is null then raise exception 'Authenticated user not found'; end if;
 select created_at into v_created_at from auth.users where id=p_user_id;
 if v_created_at is null then raise exception 'Authenticated user not found'; end if;
 if length(v_name)<2 or length(v_name)>160 then raise exception 'Company name must contain 2–160 characters'; end if;
 if exists(select 1 from public.company_members where user_id=p_user_id and status='active') then raise exception 'User already belongs to an active company'; end if;
 insert into public.companies(name,created_by,trial_started_at,trial_ends_at) values(v_name,p_user_id,v_created_at,v_created_at+interval '7 days') returning id into v_company_id;
 insert into public.company_members(company_id,user_id,role,status) values(v_company_id,p_user_id,'COMPANY_OWNER','active');
 insert into public.audit_events(company_id,actor_user_id,action,entity_type,entity_id,metadata) values(v_company_id,p_user_id,'COMPANY_CREATED','company',v_company_id::text,jsonb_build_object('name',v_name,'trialEndsAt',v_created_at+interval '7 days'));
 return jsonb_build_object('companyId',v_company_id,'name',v_name,'role','COMPANY_OWNER','trialEndsAt',v_created_at+interval '7 days');
end $$;
revoke all on function public.bootstrap_company_owner(uuid,text) from public,anon,authenticated;
grant execute on function public.bootstrap_company_owner(uuid,text) to service_role;
