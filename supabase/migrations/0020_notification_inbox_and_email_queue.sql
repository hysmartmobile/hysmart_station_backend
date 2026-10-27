-- v2.4.0 persistent per-user inbox and email delivery queue metadata.
create table if not exists public.notification_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid references public.stations(id) on delete cascade,
  fingerprint text not null,
  title text not null,
  message text not null,
  severity text not null default 'info' check (severity in ('critical','warning','info','success')),
  notification_type text not null,
  action_path text not null default '/alerts',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notification_inbox_user_fingerprint_unique unique(user_id, fingerprint)
);
create index if not exists notification_inbox_user_created_idx on public.notification_inbox(user_id, created_at desc);
create index if not exists notification_inbox_user_unread_idx on public.notification_inbox(user_id, created_at desc) where read_at is null;
alter table public.notification_inbox enable row level security;
revoke all on public.notification_inbox from anon, authenticated;
grant select, insert, update, delete on public.notification_inbox to service_role;
create index if not exists notification_delivery_log_queued_idx on public.notification_delivery_log(created_at) where status = 'queued' and channel = 'email';
create unique index if not exists notification_delivery_email_fingerprint_unique on public.notification_delivery_log ((metadata->>'fingerprint')) where channel = 'email' and metadata ? 'fingerprint';
