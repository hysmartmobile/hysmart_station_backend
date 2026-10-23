-- v2.25.8: repair columns omitted when legacy tables predated CREATE TABLE IF NOT EXISTS migrations.
-- Safe to run repeatedly; preserves all existing records.

begin;

-- Notification delivery worker and Alerts UI require a stable notification type.
alter table public.notification_delivery_log
  add column if not exists notification_type text;

update public.notification_delivery_log
set notification_type = coalesce(
  nullif(btrim(notification_type), ''),
  nullif(btrim(metadata ->> 'notification_type'), ''),
  nullif(btrim(metadata ->> 'type'), ''),
  'system'
)
where notification_type is null or btrim(notification_type) = '';

alter table public.notification_delivery_log
  alter column notification_type set default 'system',
  alter column notification_type set not null;

-- Shift-opening approval queue displays and sorts by submitted_at.
alter table public.shift_meter_openings
  add column if not exists submitted_at timestamptz;

update public.shift_meter_openings
set submitted_at = now()
where submitted_at is null;

alter table public.shift_meter_openings
  alter column submitted_at set default now(),
  alter column submitted_at set not null;

create index if not exists shift_openings_station_status_idx
  on public.shift_meter_openings(station_id, status, submitted_at desc);

commit;
