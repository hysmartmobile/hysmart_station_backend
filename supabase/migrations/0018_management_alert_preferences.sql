-- v2.1.0: persistent, company/branch-scoped management alert thresholds.
-- Apply after 0017_kg_adjustments_and_collection_reversals.sql.
create table if not exists public.management_alert_preferences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  station_id uuid null references public.stations(id) on delete cascade,
  open_shift_hours integer not null default 12 check (open_shift_hours between 1 and 72),
  litre_stock_variance numeric(14,3) not null default 10 check (litre_stock_variance > 0),
  kg_stock_variance numeric(14,3) not null default 5 check (kg_stock_variance > 0),
  cash_variance_ngn numeric(16,2) not null default 1000 check (cash_variance_ngn > 0),
  collection_gap_ngn numeric(16,2) not null default 10000 check (collection_gap_ngn > 0),
  daily_summary_enabled boolean not null default true,
  updated_by uuid null references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint management_alert_preferences_scope_unique unique nulls not distinct (company_id, station_id)
);
create index if not exists management_alert_preferences_company_idx on public.management_alert_preferences(company_id);
create index if not exists management_alert_preferences_station_idx on public.management_alert_preferences(station_id) where station_id is not null;
-- Access is mediated by the authenticated API and its branch/company membership checks.
-- Do not grant direct anon access to this table.
revoke all on public.management_alert_preferences from anon, authenticated;
