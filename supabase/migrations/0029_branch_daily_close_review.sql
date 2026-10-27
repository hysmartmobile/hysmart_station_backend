create table if not exists public.station_daily_closing_reviews (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 station_id uuid not null references public.stations(id) on delete cascade,
 business_date date not null,
 submitted_by uuid not null references auth.users(id),
 manager_note text,
 summary jsonb not null default '{}'::jsonb,
 status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
 submitted_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 review_note text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(station_id,business_date),
 check (review_note is null or length(review_note)<=1500),
 check (manager_note is null or length(manager_note)<=1500)
);
create index if not exists station_daily_closing_reviews_company_date_idx on public.station_daily_closing_reviews(company_id,business_date desc,status);
alter table public.station_daily_closing_reviews enable row level security;
-- Application APIs enforce active company-owner or branch-manager membership; deny direct client access.
revoke all on public.station_daily_closing_reviews from anon, authenticated;
grant select,insert,update on public.station_daily_closing_reviews to service_role;
create or replace function public.set_station_daily_closing_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists station_daily_closing_updated_at on public.station_daily_closing_reviews;
create trigger station_daily_closing_updated_at before update on public.station_daily_closing_reviews for each row execute function public.set_station_daily_closing_updated_at();
