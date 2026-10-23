-- v2.17.0 worker heartbeat for operational visibility and safe retry controls.
create table if not exists public.notification_worker_heartbeat (
  worker_name text primary key,
  status text not null check (status in ('running','succeeded','failed')),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  summary jsonb,
  error_message text
);
alter table public.notification_worker_heartbeat enable row level security;
revoke all on public.notification_worker_heartbeat from anon, authenticated;
grant select, insert, update, delete on public.notification_worker_heartbeat to service_role;
create index if not exists notification_delivery_log_status_created_idx
  on public.notification_delivery_log(company_id, status, created_at desc) where channel = 'email';
