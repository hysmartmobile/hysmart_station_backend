-- HySmart Station v2.25.2: customer support desk, representative workflow, and searchable FAQs.
-- Apply after migrations 0001-0046. To authorize a HySmart service representative,
-- an existing trusted database administrator must insert their auth user id into support_representatives.

create table if not exists public.support_representatives (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 2 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  subject text not null check (length(trim(subject)) between 4 and 160),
  category text not null default 'technical' check (category in ('account','billing','sales','inventory','staff','technical','feature_request','other')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','waiting_on_customer','resolved','closed')),
  assigned_representative_id uuid references public.support_representatives(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.support_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete restrict,
  author_user_id uuid not null references auth.users(id) on delete restrict,
  author_type text not null check (author_type in ('customer','representative')),
  message text not null check (length(trim(message)) between 1 and 5000),
  created_at timestamptz not null default now()
);

create table if not exists public.support_faqs (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'General',
  question text not null check (length(trim(question)) between 5 and 240),
  answer text not null check (length(trim(answer)) between 5 and 5000),
  keywords text[] not null default '{}',
  published boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (question)
);

create index if not exists support_tickets_company_creator_recent_idx on public.support_tickets(company_id, created_by, last_message_at desc);
create index if not exists support_tickets_status_recent_idx on public.support_tickets(status, priority, last_message_at desc);
create index if not exists support_ticket_messages_ticket_recent_idx on public.support_ticket_messages(ticket_id, created_at);
create index if not exists support_faqs_published_order_idx on public.support_faqs(published, sort_order, question);

alter table public.support_representatives enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;
alter table public.support_faqs enable row level security;

drop policy if exists support_representatives_self_read on public.support_representatives;
create policy support_representatives_self_read on public.support_representatives for select to authenticated using (user_id = auth.uid());

drop policy if exists support_tickets_customer_read on public.support_tickets;
create policy support_tickets_customer_read on public.support_tickets for select to authenticated using (
  (created_by = auth.uid() and (
    exists (select 1 from public.company_members cm where cm.company_id = support_tickets.company_id and cm.user_id = auth.uid() and cm.status = 'active')
    or exists (select 1 from public.station_members sm join public.stations st on st.id=sm.station_id where st.company_id=support_tickets.company_id and sm.user_id=auth.uid() and sm.status='active')
  )) or exists (select 1 from public.support_representatives sr where sr.user_id = auth.uid() and sr.active = true)
);
drop policy if exists support_tickets_customer_create on public.support_tickets;
create policy support_tickets_customer_create on public.support_tickets for insert to authenticated with check (
  created_by = auth.uid() and assigned_representative_id is null and status = 'open' and (
    exists (select 1 from public.company_members cm where cm.company_id = support_tickets.company_id and cm.user_id = auth.uid() and cm.status = 'active')
    or exists (select 1 from public.station_members sm join public.stations st on st.id=sm.station_id where st.company_id=support_tickets.company_id and sm.user_id=auth.uid() and sm.status='active')
  )
);
drop policy if exists support_tickets_customer_update on public.support_tickets;
create policy support_tickets_customer_update on public.support_tickets for update to authenticated using (
  exists (select 1 from public.support_representatives sr where sr.user_id = auth.uid() and sr.active = true)
) with check (
  exists (select 1 from public.support_representatives sr where sr.user_id = auth.uid() and sr.active = true)
);

drop policy if exists support_ticket_messages_read on public.support_ticket_messages;
create policy support_ticket_messages_read on public.support_ticket_messages for select to authenticated using (
  exists (select 1 from public.support_tickets t where t.id = support_ticket_messages.ticket_id and (
    (t.created_by = auth.uid() and (exists (select 1 from public.company_members cm where cm.company_id=t.company_id and cm.user_id=auth.uid() and cm.status='active') or exists (select 1 from public.station_members sm join public.stations st on st.id=sm.station_id where st.company_id=t.company_id and sm.user_id=auth.uid() and sm.status='active')))
    or exists (select 1 from public.support_representatives sr where sr.user_id=auth.uid() and sr.active=true)
  ))
);
drop policy if exists support_ticket_messages_create on public.support_ticket_messages;
create policy support_ticket_messages_create on public.support_ticket_messages for insert to authenticated with check (
  author_user_id = auth.uid() and exists (select 1 from public.support_tickets t where t.id=support_ticket_messages.ticket_id and (
    (author_type='customer' and t.created_by=auth.uid() and t.status not in ('resolved','closed') and (exists (select 1 from public.company_members cm where cm.company_id=t.company_id and cm.user_id=auth.uid() and cm.status='active') or exists (select 1 from public.station_members sm join public.stations st on st.id=sm.station_id where st.company_id=t.company_id and sm.user_id=auth.uid() and sm.status='active')))
    or (author_type='representative' and exists (select 1 from public.support_representatives sr where sr.user_id=auth.uid() and sr.active=true))
  ))
);

drop policy if exists support_faqs_public_read on public.support_faqs;
create policy support_faqs_public_read on public.support_faqs for select to authenticated using (published=true);

insert into public.support_faqs(category,question,answer,keywords,sort_order) values
('Account setup','How do I set up my company and first station?','Sign in, complete company setup, choose your company currency, then create your first station. Invite team members from People & invites and assign each person only the access they need.','{"onboarding","company","station","setup","invite"}',10),
('Access & security','I cannot sign in or access a page. What should I check?','Confirm you are using the correct account, refresh the page, and check that your company or station membership is active. If the problem continues, open a support ticket and include the page, approximate time, and the error text. Never include your password, one-time code, or API secrets.','{"login","sign in","access","permission","password"}',20),
('Currency & reports','How do I choose my company currency?','A company owner or administrator can review Company settings. Company currency is intended to keep financial values consistently labelled; changing the display currency does not convert historical amounts or perform foreign-exchange calculations. Follow the currency setup guide before changing a production company.','{"currency","NGN","USD","reports","exchange rate"}',30),
('Sales & shifts','Why is a sale or shift awaiting approval?','Some official sales require approved opening meter readings and an open shift. Ask an authorized manager to review the meter reading, shift, and any reconciliation warning. Do not bypass approval controls or edit historical records to force a match.','{"sale","shift","meter","approval","reconciliation"}',40),
('Inventory','How do I resolve a tank or stock discrepancy?','Record a physical stock check with the correct product, unit, and measured quantity. Compare it with recorded movements and deliveries, then submit any required adjustment for authorized review. Keep the original evidence and explain the variance in the notes.','{"tank","stock","inventory","wet stock","discrepancy"}',50),
('Billing','How do I get help with a subscription or payment?','Open a ticket under Billing and include the company name, plan, transaction reference, date, and the exact message shown. Do not send full card numbers, bank passwords, or one-time banking codes.','{"billing","subscription","payment","invoice","plan"}',60),
('Support tickets','How do I follow up on a support request?','Open Support & FAQs, choose My tickets, and select the ticket to view its status and conversation. Reply in the same ticket so the service representative can see the full history. Resolved or closed tickets cannot be replied to; create a new ticket if the issue returns.','{"ticket","support","follow up","status","representative"}',70)
on conflict (question) do update set category=excluded.category, answer=excluded.answer, keywords=excluded.keywords, sort_order=excluded.sort_order, updated_at=now();
