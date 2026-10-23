-- HySmart Station v2.25.3: creator operations dashboard and customer satisfaction feedback.
-- Apply after migrations 0001-0047.
alter table public.support_tickets add column if not exists satisfaction_rating smallint;
alter table public.support_tickets add column if not exists satisfaction_comment text;
alter table public.support_tickets drop constraint if exists support_tickets_satisfaction_rating_check;
alter table public.support_tickets add constraint support_tickets_satisfaction_rating_check check (satisfaction_rating is null or satisfaction_rating between 1 and 5);
alter table public.support_tickets drop constraint if exists support_tickets_satisfaction_comment_check;
alter table public.support_tickets add constraint support_tickets_satisfaction_comment_check check (satisfaction_comment is null or length(satisfaction_comment) <= 1000);
create index if not exists support_tickets_satisfaction_idx on public.support_tickets(satisfaction_rating) where satisfaction_rating is not null;
