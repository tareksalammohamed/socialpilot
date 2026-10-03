-- Disposable CI database: minimal existing schema consumed by the real migration.
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.workspaces (id uuid primary key);
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces,
  platform text not null, external_id text, handle text, display_name text,
  status text not null check (status in ('connected','disconnected','error','expired')),
  needs_reconnect boolean not null default false, metadata jsonb not null default '{}',
  last_sync_at timestamptz, updated_at timestamptz not null default now(),
  unique(workspace_id, platform)
);
create table public.social_account_tokens (
  account_id uuid primary key references public.social_accounts, access_token text not null,
  refresh_token text, token_type text not null, expires_at timestamptz, updated_at timestamptz not null default now()
);
create table public.inbox_conversations (id uuid primary key default gen_random_uuid(), account_id uuid not null references public.social_accounts);
alter table public.social_accounts enable row level security;
alter table public.social_account_tokens enable row level security;
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
