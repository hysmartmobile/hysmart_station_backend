-- v2.7.0: group each direct-message send so sender read receipts can be reported.
alter table public.notification_inbox
  add column if not exists message_group_id uuid;

create index if not exists notification_inbox_sender_receipts_idx
  on public.notification_inbox(sender_user_id, message_group_id, created_at desc)
  where message_type = 'direct';

-- Keep inbox and read receipts server-mediated; clients cannot query other users' receipts directly.
revoke all on public.notification_inbox from anon, authenticated;
grant select, insert, update, delete on public.notification_inbox to service_role;
