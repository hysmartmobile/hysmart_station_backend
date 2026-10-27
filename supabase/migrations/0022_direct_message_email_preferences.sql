-- v2.6.0: opt-in email delivery for direct staff messages. In-app delivery remains the source of truth.
create table if not exists public.notification_user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  direct_message_email_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.notification_user_preferences enable row level security;
revoke all on public.notification_user_preferences from anon, authenticated;
grant select, insert, update, delete on public.notification_user_preferences to service_role;
