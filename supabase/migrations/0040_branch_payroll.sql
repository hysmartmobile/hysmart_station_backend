-- HySmart Station v2.23.6: branch payroll with independent approval and payment evidence.
-- Apply after 0039. Payroll is recognized as an operating expense when approved;
-- payment is a separate cash-disbursement state and requires a payment reference.
alter table public.operating_expenses drop constraint if exists operating_expenses_category_check;
alter table public.operating_expenses add constraint operating_expenses_category_check
  check (category in ('utilities','staff','maintenance','security','transport','bank_charges','rent','taxes','generator_fuel','licenses','office_supplies','insurance','communications','staff_welfare','professional_fees','repairs','other'));

-- Submitted expense facts are immutable; only a pending item may receive one independent review.
create or replace function public.guard_operating_expense_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if row(new.company_id,new.station_id,new.category,new.description,new.amount,new.incurred_on,new.reference,new.requested_by,new.requested_at)
     is distinct from
     row(old.company_id,old.station_id,old.category,old.description,old.amount,old.incurred_on,old.reference,old.requested_by,old.requested_at) then
    raise exception 'OPERATING_EXPENSE_SUBMISSION_IMMUTABLE';
  end if;
  if old.status <> 'pending' then raise exception 'OPERATING_EXPENSE_ALREADY_REVIEWED'; end if;
  if new.status not in ('approved','rejected') or new.reviewed_by is null or new.reviewed_at is null or new.reviewed_by=old.requested_by then
    raise exception 'INVALID_OPERATING_EXPENSE_REVIEW';
  end if;
  return new;
end $$;
drop trigger if exists operating_expenses_guard_change on public.operating_expenses;
create trigger operating_expenses_guard_change before update on public.operating_expenses
for each row execute function public.guard_operating_expense_change();
create table if not exists public.branch_payroll (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid not null references public.stations(id) on delete cascade,
  employee_user_id uuid not null references auth.users(id),
  employee_role text not null check (employee_role in ('STATION_MANAGER','ATTENDANT')),
  period_start date not null,
  period_end date not null,
  basic_salary numeric(14,2) not null check (basic_salary >= 0),
  allowances numeric(14,2) not null default 0 check (allowances >= 0),
  deductions numeric(14,2) not null default 0 check (deductions >= 0),
  net_salary numeric(14,2) generated always as (basic_salary + allowances - deductions) stored,
  currency text not null default 'NGN' check (currency='NGN'),
  reference text not null check (length(trim(reference)) between 3 and 120),
  notes text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  submitted_by uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_note text,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid')),
  paid_by uuid references auth.users(id),
  paid_at timestamptz,
  payment_method text check (payment_method in ('cash','bank_transfer','pos','other')),
  payment_reference text,
  created_at timestamptz not null default now(),
  constraint branch_payroll_period_check check (period_end >= period_start and period_end - period_start <= 366),
  constraint branch_payroll_net_nonnegative check (basic_salary + allowances >= deductions),
  constraint branch_payroll_review_integrity check (
    (status='pending' and reviewed_by is null and reviewed_at is null)
    or (status in ('approved','rejected') and reviewed_by is not null and reviewed_at is not null)
  ),
  constraint branch_payroll_no_self_approval check (reviewed_by is null or reviewed_by <> submitted_by),
  constraint branch_payroll_payment_integrity check (
    (payment_status='unpaid' and paid_by is null and paid_at is null and payment_method is null and payment_reference is null)
    or (payment_status='paid' and status='approved' and paid_by is not null and paid_at is not null and payment_method is not null and length(trim(payment_reference)) >= 3)
  ),
  constraint branch_payroll_period_employee_unique unique (station_id, employee_user_id, period_start, period_end)
);
create index if not exists branch_payroll_company_period_idx on public.branch_payroll(company_id,period_start desc,status);
create index if not exists branch_payroll_station_period_idx on public.branch_payroll(station_id,period_start desc,status,payment_status);
alter table public.branch_payroll enable row level security;

create or replace function public.guard_branch_payroll_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='UPDATE' then
    if row(new.company_id,new.station_id,new.employee_user_id,new.employee_role,new.period_start,new.period_end,new.basic_salary,new.allowances,new.deductions,new.reference,new.notes,new.submitted_by,new.submitted_at)
       is distinct from
       row(old.company_id,old.station_id,old.employee_user_id,old.employee_role,old.period_start,old.period_end,old.basic_salary,old.allowances,old.deductions,old.reference,old.notes,old.submitted_by,old.submitted_at) then
      raise exception 'PAYROLL_SUBMISSION_IMMUTABLE';
    end if;
    if old.status <> 'pending' then
      if new.status is distinct from old.status or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at or new.review_note is distinct from old.review_note then
        raise exception 'PAYROLL_ALREADY_REVIEWED';
      end if;
    end if;
    if old.payment_status='paid' and row(new.payment_status,new.paid_by,new.paid_at,new.payment_method,new.payment_reference) is distinct from row(old.payment_status,old.paid_by,old.paid_at,old.payment_method,old.payment_reference) then
      raise exception 'PAYROLL_ALREADY_PAID';
    end if;
    if new.status is distinct from old.status and (new.status not in ('approved','rejected') or old.status <> 'pending' or new.reviewed_by is null or new.reviewed_at is null or new.reviewed_by=old.submitted_by) then
      raise exception 'INVALID_PAYROLL_REVIEW';
    end if;
    if new.payment_status='paid' and old.payment_status='unpaid' and (new.status<>'approved' or new.paid_by is null or new.paid_at is null or new.payment_method is null or length(trim(coalesce(new.payment_reference,'')))<3) then
      raise exception 'PAYROLL_PAYMENT_EVIDENCE_REQUIRED';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists branch_payroll_guard_change on public.branch_payroll;
create trigger branch_payroll_guard_change before update on public.branch_payroll for each row execute function public.guard_branch_payroll_change();

create or replace function public.audit_branch_payroll_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,new.submitted_by,'PAYROLL_SUBMITTED','branch_payroll',new.id,
      jsonb_build_object('employeeUserId',new.employee_user_id,'employeeRole',new.employee_role,'periodStart',new.period_start,'periodEnd',new.period_end,'netSalary',new.net_salary,'reference',new.reference,'status',new.status));
  elsif new.status is distinct from old.status then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,new.reviewed_by,case when new.status='approved' then 'PAYROLL_APPROVED' else 'PAYROLL_REJECTED' end,'branch_payroll',new.id,
      jsonb_build_object('employeeUserId',new.employee_user_id,'periodStart',new.period_start,'periodEnd',new.period_end,'netSalary',new.net_salary,'reviewNote',new.review_note));
  elsif new.payment_status is distinct from old.payment_status then
    insert into public.audit_events(company_id,station_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(new.company_id,new.station_id,new.paid_by,'PAYROLL_MARKED_PAID','branch_payroll',new.id,
      jsonb_build_object('employeeUserId',new.employee_user_id,'netSalary',new.net_salary,'paymentMethod',new.payment_method,'paymentReference',new.payment_reference));
  end if;
  return new;
end $$;
drop trigger if exists branch_payroll_audit_change on public.branch_payroll;
create trigger branch_payroll_audit_change after insert or update on public.branch_payroll for each row execute function public.audit_branch_payroll_change();
