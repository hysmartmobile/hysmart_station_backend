-- v2.2.0 notification delivery foundation. This migration stores preferences and delivery attempts;
-- it intentionally does not send messages without a configured provider/worker.
create table if not exists public.notification_delivery_preferences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid references public.stations(id) on delete cascade,
  channel text not null check (channel in ('email','sms','push','in_app')),
  enabled boolean not null default false,
  recipient text,
  daily_summary boolean not null default true,
  critical_alerts boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint notification_delivery_preferences_scope_channel_unique unique nulls not distinct (company_id, station_id, channel),
  constraint notification_recipient_required check (not enabled or channel = 'in_app' or nullif(trim(recipient),'') is not null)
);
create table if not exists public.notification_delivery_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid references public.stations(id) on delete set null,
  channel text not null check (channel in ('email','sms','push','in_app')),
  notification_type text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  recipient_masked text,
  provider_message_id text,
  error_code text,
  created_at timestamptz not null default now(),
  attempted_at timestamptz,
  sent_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists notification_delivery_log_company_created_idx on public.notification_delivery_log(company_id, created_at desc);
create index if not exists notification_delivery_log_station_created_idx on public.notification_delivery_log(station_id, created_at desc);
alter table public.notification_delivery_preferences enable row level security;
alter table public.notification_delivery_log enable row level security;
-- Access is mediated by the authenticated backend service and its company/branch authorization checks.
revoke all on public.notification_delivery_preferences from anon, authenticated;
revoke all on public.notification_delivery_log from anon, authenticated;
grant select, insert, update, delete on public.notification_delivery_preferences to service_role;
grant select, insert, update on public.notification_delivery_log to service_role;
