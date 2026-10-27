-- HySmart Station v2.23.5: establish inventory cost basis and dual-control operating expenses.
-- Apply after migrations 0001-0037. Existing opening stock is intentionally unvalued until reviewed.
alter table public.station_tanks
  add column if not exists opening_stock_unit_cost numeric(14,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='station_tanks_opening_stock_unit_cost_check') then
    alter table public.station_tanks add constraint station_tanks_opening_stock_unit_cost_check
      check (opening_stock_unit_cost is null or opening_stock_unit_cost >= 0);
  end if;
end $$;

create table if not exists public.operating_expenses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  category text not null check (category in ('utilities','staff','maintenance','security','transport','bank_charges','rent','taxes','other')),
  description text not null check (length(trim(description)) between 3 and 500),
  amount numeric(14,2) not null check (amount > 0),
  incurred_on date not null,
  reference text not null check (length(trim(reference)) between 2 and 100),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint operating_expenses_review_integrity check (
    (status='pending' and reviewed_by is null and reviewed_at is null)
    or (status in ('approved','rejected') and reviewed_by is not null and reviewed_at is not null)
  ),
  constraint operating_expenses_no_self_approval check (reviewed_by is null or reviewed_by <> requested_by)
);
create index if not exists operating_expenses_company_date_idx on public.operating_expenses(company_id, incurred_on desc, status);
create index if not exists operating_expenses_station_date_idx on public.operating_expenses(station_id, incurred_on desc, status);
alter table public.operating_expenses enable row level security;

-- Every expense submission and review is audited in the same database transaction.
create or replace function public.audit_operating_expense_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,new.requested_by,'OPERATING_EXPENSE_SUBMITTED','operating_expense',new.id,
      jsonb_build_object('category',new.category,'amount',new.amount,'incurredOn',new.incurred_on,'reference',new.reference,'status',new.status));
  elsif new.status is distinct from old.status then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,new.reviewed_by,case when new.status='approved' then 'OPERATING_EXPENSE_APPROVED' else 'OPERATING_EXPENSE_REJECTED' end,'operating_expense',new.id,
      jsonb_build_object('category',new.category,'amount',new.amount,'incurredOn',new.incurred_on,'reference',new.reference,'status',new.status,'reviewNote',new.review_note));
  end if;
  return new;
end;
$$;
drop trigger if exists operating_expenses_audit_change on public.operating_expenses;
create trigger operating_expenses_audit_change after insert or update on public.operating_expenses
for each row execute function public.audit_operating_expense_change();
