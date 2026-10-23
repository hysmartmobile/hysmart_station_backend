-- v2.5.0: record sender metadata for authenticated, branch-scoped direct messages.
alter table public.notification_inbox
  add column if not exists sender_user_id uuid references auth.users(id) on delete set null,
  add column if not exists message_type text not null default 'system' check (message_type in ('system','direct'));
create index if not exists notification_inbox_direct_messages_idx
  on public.notification_inbox(user_id, message_type, created_at desc);
-- Keep access server-mediated; clients must not bypass the API's branch checks.
revoke all on public.notification_inbox from anon, authenticated;
grant select, insert, update, delete on public.notification_inbox to service_role;
