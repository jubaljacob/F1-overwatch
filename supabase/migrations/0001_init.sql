-- F1Overwatch P0 schema.
-- Apply to Supabase via `supabase db push` once a Supabase project is provisioned,
-- or via the Postgres CLI for local development:
--   psql $DATABASE_URL -f supabase/migrations/0001_init.sql

create extension if not exists "pgcrypto";

-- Users: when running against Supabase, this mirrors auth.users for app-level data.
-- Locally (docker-compose Postgres) it stands alone.
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.saved_replays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  year smallint not null,
  round smallint not null,
  session_type text not null default 'R',
  title text not null,
  state_json jsonb not null default '{}'::jsonb,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_replays_user_idx on public.saved_replays (user_id);
create index if not exists saved_replays_session_idx on public.saved_replays (year, round, session_type);

create table if not exists public.annotations (
  id uuid primary key default gen_random_uuid(),
  replay_id uuid not null references public.saved_replays(id) on delete cascade,
  t_seconds double precision not null,
  driver_code text,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists annotations_replay_idx on public.annotations (replay_id);
