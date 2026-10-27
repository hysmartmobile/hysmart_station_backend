-- v2.8.0: optional acknowledgement requests for direct staff messages.
alter table public.notification_inbox
  add column if not exists requires_acknowledgement boolean not null default false,
  add column if not exists acknowledged_at timestamptz;

create index if not exists notification_inbox_acknowledgement_idx
  on public.notification_inbox(user_id, acknowledged_at, created_at desc)
  where message_type = 'direct' and requires_acknowledgement = true;

-- Inbox data remains server-mediated; recipients acknowledge only their own messages via API.
revoke all on public.notification_inbox from anon, authenticated;
grant select, insert, update, delete on public.notification_inbox to service_role;
