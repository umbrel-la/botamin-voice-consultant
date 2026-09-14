alter table public.leads
  add column if not exists last_user_message text,
  add column if not exists conversation_summary text,
  add column if not exists stages jsonb not null default '[]'::jsonb,
  add column if not exists offered_slots jsonb not null default '[]'::jsonb;

create index if not exists leads_session_hash_idx on public.leads (session_hash);
create index if not exists notification_jobs_status_next_attempt_idx
  on public.notification_jobs (status, next_attempt_at);
