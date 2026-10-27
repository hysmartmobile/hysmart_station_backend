-- HySmart Station v2.23.7: auditable owner/manager/attendant money handovers.
-- Apply after 0040. This records declared transfers and recipient confirmation;
-- it does not itself prove that cash or a bank transfer physically occurred.
create table if not exists public.branch_accountability_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('funds_issued','cash_handover','cash_remittance','staff_advance','reimbursement','shortage_report','overage_report','other')),
  direction text not null check (direction in ('outgoing','incoming')),
  from_user_id uuid not null references auth.users(id),
  to_user_id uuid not null references auth.users(id),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'NGN' check (currency='NGN'),
  transaction_date date not null,
  reference text not null check (length(trim(reference)) between 3 and 120),
  description text not null check (length(trim(description)) between 5 and 1500),
  evidence_reference text,
  related_shift_id uuid references public.station_cash_shifts(id),
  status text not null default 'pending_acknowledgement' check (status in ('pending_acknowledgement','acknowledged','disputed','resolved')),
  recorded_by uuid not null references auth.users(id),
  recorded_at timestamptz not null default now(),
  responded_by uuid references auth.users(id),
  responded_at timestamptz,
  response_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  constraint accountability_distinct_parties check (from_user_id <> to_user_id),
  constraint accountability_recorder_is_party check (recorded_by = from_user_id),
  constraint accountability_response_integrity check (
    (status='pending_acknowledgement' and responded_by is null and responded_at is null and resolved_by is null and resolved_at is null)
    or (status in ('acknowledged','disputed') and responded_by=to_user_id and responded_at is not null and resolved_by is null and resolved_at is null)
    or (status='resolved' and responded_by=to_user_id and responded_at is not null and resolved_by is not null and resolved_at is not null and length(trim(coalesce(resolution_note,'')))>=3)
  ),
  constraint accountability_resolution_only_dispute check (status <> 'resolved' or responded_by is not null)
);
create index if not exists accountability_company_date_idx on public.branch_accountability_transactions(company_id, transaction_date desc, created_at desc);
create index if not exists accountability_station_status_idx on public.branch_accountability_transactions(station_id, status, transaction_date desc);
create index if not exists accountability_parties_idx on public.branch_accountability_transactions(from_user_id, to_user_id, created_at desc);
create unique index if not exists accountability_company_reference_uq on public.branch_accountability_transactions(company_id, lower(trim(reference)));
alter table public.branch_accountability_transactions enable row level security;
revoke all on public.branch_accountability_transactions from anon, authenticated;
grant select, insert, update on public.branch_accountability_transactions to service_role;

create or replace function public.guard_accountability_transaction_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if row(new.company_id,new.station_id,new.transaction_type,new.direction,new.from_user_id,new.to_user_id,new.amount,new.currency,new.transaction_date,new.reference,new.description,new.evidence_reference,new.related_shift_id,new.recorded_by,new.recorded_at)
     is distinct from
     row(old.company_id,old.station_id,old.transaction_type,old.direction,old.from_user_id,old.to_user_id,old.amount,old.currency,old.transaction_date,old.reference,old.description,old.evidence_reference,old.related_shift_id,old.recorded_by,old.recorded_at) then
    raise exception 'ACCOUNTABILITY_TRANSACTION_IMMUTABLE';
  end if;
  if old.status='pending_acknowledgement' then
    if new.status not in ('acknowledged','disputed') or new.responded_by is distinct from old.to_user_id or new.responded_at is null or new.resolved_by is not null or new.resolved_at is not null or new.resolution_note is not null then
      raise exception 'INVALID_ACCOUNTABILITY_RESPONSE';
    end if;
  else
    if row(new.responded_by,new.responded_at,new.response_note) is distinct from row(old.responded_by,old.responded_at,old.response_note) then
      raise exception 'ACCOUNTABILITY_RESPONSE_IMMUTABLE';
    end if;
    if old.status='disputed' then
      if new.status <> 'resolved' or new.resolved_by is null or new.resolved_at is null or length(trim(coalesce(new.resolution_note,'')))<3 then
        raise exception 'DISPUTE_RESOLUTION_REQUIRED';
      end if;
    elsif row(new.status,new.resolved_by,new.resolved_at,new.resolution_note) is distinct from row(old.status,old.resolved_by,old.resolved_at,old.resolution_note) then
      raise exception 'ACCOUNTABILITY_TRANSACTION_FINAL';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists accountability_transaction_guard on public.branch_accountability_transactions;
create trigger accountability_transaction_guard before update on public.branch_accountability_transactions
for each row execute function public.guard_accountability_transaction_change();

create or replace function public.audit_accountability_transaction_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,new.recorded_by,'ACCOUNTABILITY_TRANSACTION_RECORDED','branch_accountability_transaction',new.id,
      jsonb_build_object('type',new.transaction_type,'direction',new.direction,'fromUserId',new.from_user_id,'toUserId',new.to_user_id,'amount',new.amount,'currency',new.currency,'transactionDate',new.transaction_date,'reference',new.reference,'evidenceReference',new.evidence_reference,'relatedShiftId',new.related_shift_id));
  elsif new.status is distinct from old.status then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,case when new.status='resolved' then new.resolved_by else new.responded_by end,
      case new.status when 'acknowledged' then 'ACCOUNTABILITY_TRANSACTION_ACKNOWLEDGED' when 'disputed' then 'ACCOUNTABILITY_TRANSACTION_DISPUTED' else 'ACCOUNTABILITY_TRANSACTION_DISPUTE_RESOLVED' end,
      'branch_accountability_transaction',new.id,
      jsonb_build_object('amount',new.amount,'reference',new.reference,'responseNote',new.response_note,'resolutionNote',new.resolution_note));
  end if;
  return new;
end $$;
drop trigger if exists accountability_transaction_audit on public.branch_accountability_transactions;
create trigger accountability_transaction_audit after insert or update on public.branch_accountability_transactions
for each row execute function public.audit_accountability_transaction_change();
