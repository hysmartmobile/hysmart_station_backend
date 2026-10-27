-- HySmart Station v2.22.0: atomic, idempotent payment application and strict paid-period expiry.
-- Apply to staging first; this migration is additive except for the hardened branch RPC.

alter table public.company_payment_attempts
  add column if not exists paystack_transaction_id text;

create unique index if not exists company_payment_attempts_paystack_transaction_id_uidx
  on public.company_payment_attempts(paystack_transaction_id)
  where paystack_transaction_id is not null;

-- One transaction can activate an entitlement only once. The attempt row lock,
-- subscription update, paid marker and audit event commit as one database transaction.
create or replace function public.activate_company_subscription_from_payment(
  p_reference text,
  p_transaction_id text,
  p_paid_at timestamptz,
  p_actor_user_id uuid,
  p_source text
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_attempt public.company_payment_attempts%rowtype;
  v_existing public.company_subscriptions%rowtype;
  v_plan_name text;
  v_start timestamptz;
  v_end timestamptz;
  v_paid_at timestamptz := coalesce(p_paid_at, now());
begin
  if p_reference is null or length(p_reference) < 8 or p_transaction_id is null or length(p_transaction_id) = 0 then
    raise exception 'INVALID_PAYMENT: payment reference and transaction id are required';
  end if;
  if p_source is null or p_source not in ('paystack_webhook','browser_verify') then
    raise exception 'INVALID_PAYMENT_SOURCE: unsupported payment activation source';
  end if;

  select * into v_attempt
    from public.company_payment_attempts
    where paystack_reference = p_reference
    for update;
  if not found then raise exception 'PAYMENT_ATTEMPT_NOT_FOUND: no checkout attempt matches this reference'; end if;

  if v_attempt.status = 'paid' then
    if v_attempt.paystack_transaction_id = p_transaction_id then
      return jsonb_build_object('processed', false, 'alreadyProcessed', true, 'companyId', v_attempt.company_id);
    end if;
    raise exception 'PAYMENT_ALREADY_APPLIED: this reference was applied to a different transaction';
  end if;
  if v_attempt.status <> 'pending' then
    raise exception 'PAYMENT_ATTEMPT_NOT_PENDING: failed or abandoned checkout cannot activate a subscription';
  end if;
  if (v_attempt.plan = 'starter' and (v_attempt.amount_naira <> 30000 or v_attempt.branch_limit <> 1))
     or (v_attempt.plan = 'multi' and (v_attempt.amount_naira <> 120000 or v_attempt.branch_limit <> 5)) then
    raise exception 'PAYMENT_ATTEMPT_INVALID: stored plan, amount and branch limit do not match';
  end if;

  select * into v_existing from public.company_subscriptions where company_id = v_attempt.company_id for update;
  if found and v_existing.status = 'active' and v_existing.plan = v_attempt.plan
     and v_existing.current_period_end is not null and v_existing.current_period_end > now() then
    -- Early renewal of the same plan extends the existing paid-through date.
    v_start := v_existing.current_period_end;
  else
    -- Initial activation, expired renewal, or plan change starts when the verified payment is applied.
    v_start := now();
  end if;
  v_end := v_start + interval '1 month';

  insert into public.company_subscriptions(
    company_id, plan, status, amount_naira, branch_limit, paystack_reference,
    paystack_transaction_id, current_period_start, current_period_end, updated_at
  ) values (
    v_attempt.company_id, v_attempt.plan, 'active', v_attempt.amount_naira, v_attempt.branch_limit,
    p_reference, p_transaction_id, v_start, v_end, now()
  ) on conflict (company_id) do update set
    plan = excluded.plan,
    status = 'active',
    amount_naira = excluded.amount_naira,
    branch_limit = excluded.branch_limit,
    paystack_reference = excluded.paystack_reference,
    paystack_transaction_id = excluded.paystack_transaction_id,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    updated_at = now();

  update public.company_payment_attempts
    set status = 'paid', paid_at = v_paid_at, paystack_transaction_id = p_transaction_id
    where id = v_attempt.id and status = 'pending';
  if not found then raise exception 'PAYMENT_ATTEMPT_RACE: payment attempt changed during activation'; end if;

  v_plan_name := case v_attempt.plan when 'starter' then 'Starter' else 'Multi-Branch' end;
  insert into public.audit_events(company_id, actor_user_id, action, entity_type, entity_id, metadata)
  values (v_attempt.company_id, p_actor_user_id, 'SUBSCRIPTION_ACTIVATED', 'company_subscription', v_attempt.company_id::text,
    jsonb_build_object('plan', v_attempt.plan, 'amountNaira', v_attempt.amount_naira,
      'reference', p_reference, 'transactionId', p_transaction_id, 'source', p_source,
      'periodStart', v_start, 'periodEnd', v_end));

  return jsonb_build_object('processed', true, 'alreadyProcessed', false, 'companyId', v_attempt.company_id,
    'plan', v_attempt.plan, 'periodStart', v_start, 'periodEnd', v_end, 'planName', v_plan_name);
end $$;

revoke all on function public.activate_company_subscription_from_payment(text,text,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.activate_company_subscription_from_payment(text,text,timestamptz,uuid,text) to service_role;

-- Fail closed when legacy/malformed active subscriptions have no paid-through date.
create or replace function public.create_station_for_owner(p_actor_user_id uuid, p_company_id uuid, p_name text, p_address text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_station public.stations%rowtype;
  v_sub public.company_subscriptions%rowtype;
  v_count integer;
  v_name text := trim(p_name);
  v_address text := trim(p_address);
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.company_members
    where company_id=p_company_id and user_id=p_actor_user_id and status='active' and role='COMPANY_OWNER'
  ) then raise exception 'FORBIDDEN: only the active company owner can create branches'; end if;
  if length(v_name)<2 or length(v_name)>120 or length(v_address)<2 or length(v_address)>240 then
    raise exception 'Invalid branch name or address';
  end if;
  select * into v_sub from public.company_subscriptions where company_id=p_company_id for update;
  if not found or v_sub.status <> 'active' or v_sub.current_period_end is null or v_sub.current_period_end <= now() then
    raise exception 'SUBSCRIPTION_REQUIRED: an active paid plan is required to create a branch';
  end if;
  select count(*) into v_count from public.stations where company_id=p_company_id and status='active';
  if v_count >= v_sub.branch_limit then raise exception 'BRANCH_LIMIT_REACHED: upgrade your plan to add another branch'; end if;
  insert into public.stations(company_id,name,address,created_by) values(p_company_id,v_name,v_address,p_actor_user_id) returning * into v_station;
  insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(p_company_id,v_station.id,p_actor_user_id,'STATION_CREATED','station',v_station.id::text,jsonb_build_object('name',v_station.name,'plan',v_sub.plan));
  return jsonb_build_object('id',v_station.id,'company_id',v_station.company_id,'name',v_station.name,
    'address',v_station.address,'status',v_station.status,'created_at',v_station.created_at);
end $$;
revoke all on function public.create_station_for_owner(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.create_station_for_owner(uuid,uuid,text,text) to service_role;
