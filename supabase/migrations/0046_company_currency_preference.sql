-- HySmart Station v2.25.1: company base/reporting currency.
-- Currency is selected during company setup. It is locked after the first station is created
-- to prevent silently relabelling existing financial amounts without a reviewed conversion.
alter table public.companies
  add column if not exists currency text not null default 'NGN';

alter table public.companies drop constraint if exists companies_currency_check;
alter table public.companies add constraint companies_currency_check check (currency in (
  'NGN','USD','CAD','GHS','KES','ZAR','GBP','EUR','AUD','INR','PKR','UGX','TZS','RWF','XOF','XAF','AED'
));

alter table public.branch_payroll alter column currency set default 'NGN';
alter table public.branch_payroll drop constraint if exists branch_payroll_currency_check;
alter table public.branch_payroll add constraint branch_payroll_currency_check check (currency in (
  'NGN','USD','CAD','GHS','KES','ZAR','GBP','EUR','AUD','INR','PKR','UGX','TZS','RWF','XOF','XAF','AED'
));

alter table public.branch_accountability_transactions alter column currency set default 'NGN';
alter table public.branch_accountability_transactions drop constraint if exists branch_accountability_transactions_currency_check;
alter table public.branch_accountability_transactions add constraint branch_accountability_transactions_currency_check check (currency in (
  'NGN','USD','CAD','GHS','KES','ZAR','GBP','EUR','AUD','INR','PKR','UGX','TZS','RWF','XOF','XAF','AED'
));

create or replace function public.bootstrap_company_owner(
  p_user_id uuid,
  p_company_name text,
  p_company_currency text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_company_id uuid; v_name text:=trim(p_company_name); v_created_at timestamptz; v_currency text:=upper(trim(coalesce(p_company_currency,'NGN')));
begin
 if p_user_id is null then raise exception 'Authenticated user not found'; end if;
 select created_at into v_created_at from auth.users where id=p_user_id;
 if v_created_at is null then raise exception 'Authenticated user not found'; end if;
 if length(v_name)<2 or length(v_name)>160 then raise exception 'Company name must contain 2–160 characters'; end if;
 if v_currency not in ('NGN','USD','CAD','GHS','KES','ZAR','GBP','EUR','AUD','INR','PKR','UGX','TZS','RWF','XOF','XAF','AED') then raise exception 'Unsupported company currency'; end if;
 if exists(select 1 from public.company_members where user_id=p_user_id and status='active') then raise exception 'User already belongs to an active company'; end if;
 insert into public.companies(name,created_by,trial_started_at,trial_ends_at,currency) values(v_name,p_user_id,v_created_at,v_created_at+interval '7 days',v_currency) returning id into v_company_id;
 insert into public.company_members(company_id,user_id,role,status) values(v_company_id,p_user_id,'COMPANY_OWNER','active');
 insert into public.audit_events(company_id,actor_user_id,action,entity_type,entity_id,metadata) values(v_company_id,p_user_id,'COMPANY_CREATED','company',v_company_id::text,jsonb_build_object('name',v_name,'currency',v_currency,'trialEndsAt',v_created_at+interval '7 days'));
 return jsonb_build_object('companyId',v_company_id,'name',v_name,'currency',v_currency,'role','COMPANY_OWNER','trialEndsAt',v_created_at+interval '7 days');
end $$;
revoke all on function public.bootstrap_company_owner(uuid,text,text) from public,anon,authenticated;
grant execute on function public.bootstrap_company_owner(uuid,text,text) to service_role;
