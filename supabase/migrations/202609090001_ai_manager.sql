create table if not exists public.leads (
  id uuid primary key,
  session_hash text not null,
  name text,
  company_activity text,
  current_process text,
  need text,
  desired_result text,
  summary_confirmed boolean,
  phone text,
  telegram text,
  work_email text,
  leads_per_month text,
  sales_managers_count text,
  selected_slot jsonb,
  booking_status text not null default 'none',
  cal_booking_id text,
  meeting_url text,
  notification_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.lead_tool_calls (
  lead_id uuid not null references public.leads(id) on delete cascade,
  call_id text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (lead_id, call_id)
);

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.leads(id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  telegram_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.leads enable row level security;
alter table public.lead_tool_calls enable row level security;
alter table public.notification_jobs enable row level security;

-- No browser roles receive policies. Only the server-side service role accesses these tables.
