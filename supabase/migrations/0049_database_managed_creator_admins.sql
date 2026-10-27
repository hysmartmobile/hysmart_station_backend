-- HySmart Station v2.25.4: manage creator-console access through Supabase.
-- Apply after migrations 0001-0048. Existing environment-variable creator access is retired.

create table if not exists public.creator_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  active boolean not null default true,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_admins_email_not_blank check (length(trim(email)) > 3)
);

create unique index if not exists creator_admins_email_lower_uidx
  on public.creator_admins (lower(email));
create index if not exists creator_admins_active_idx
  on public.creator_admins (active) where active = true;

alter table public.creator_admins enable row level security;
-- Never expose the creator roster or allow users to grant themselves creator access.
revoke all on table public.creator_admins from anon, authenticated;
grant all on table public.creator_admins to service_role;

comment on table public.creator_admins is
  'Private allowlist of HySmart platform creator administrators. Manage through trusted Supabase SQL/admin tooling only.';
comment on column public.creator_admins.active is
  'Set false to revoke creator-console access without deleting the audit-relevant grant record.';
