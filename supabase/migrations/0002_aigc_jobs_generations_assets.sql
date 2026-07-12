-- Slim AIGC job/result schema.
--
-- Identity model: user ownership is the Supabase Auth user ID from lib/session.ts.
-- Route handlers use service_role on the server and must owner-guard by user_id.
--
-- No credit/cost/refund accounting is represented here by design.

create table if not exists public.aigc_jobs (
  id                uuid        primary key default gen_random_uuid(),
  user_id           text        not null,
  kind              text        not null check (kind in ('image', 'model3d', 'video')),
  workflow_id       text        not null default 'standard',
  status            text        not null default 'queued'
                                      check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  provider          text        not null,
  provider_job_id   text,
  provider_status_url text,
  request           jsonb       not null default '{}'::jsonb,
  provider_response jsonb       not null default '{}'::jsonb,
  error             text,
  reconcile_token   uuid,
  reconcile_lease_until timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint aigc_jobs_workflow_id_check check (
    (kind = 'image' and workflow_id in ('standard', 'detail')) or
    (kind = 'model3d' and workflow_id in ('standard', 'game-asset')) or
    (kind = 'video' and workflow_id = 'standard')
  )
);

alter table public.aigc_jobs
  add column if not exists workflow_id text not null default 'standard';

alter table public.aigc_jobs
  add column if not exists reconcile_token uuid,
  add column if not exists reconcile_lease_until timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'aigc_jobs_workflow_id_check'
  ) then
    alter table public.aigc_jobs
      add constraint aigc_jobs_workflow_id_check check (
        (kind = 'image' and workflow_id in ('standard', 'detail')) or
        (kind = 'model3d' and workflow_id in ('standard', 'game-asset')) or
        (kind = 'video' and workflow_id = 'standard')
      );
  end if;
end $$;

create index if not exists aigc_jobs_user_created_idx
  on public.aigc_jobs (user_id, created_at desc);

create index if not exists aigc_jobs_user_status_idx
  on public.aigc_jobs (user_id, status, created_at desc);

create index if not exists aigc_jobs_active_reconcile_idx
  on public.aigc_jobs (status, updated_at)
  where provider_job_id is not null and status in ('queued', 'running');

create index if not exists aigc_jobs_reconcile_claim_idx
  on public.aigc_jobs (status, reconcile_lease_until, updated_at)
  where provider_job_id is not null and status in ('queued', 'running');

create index if not exists aigc_jobs_reconcile_token_idx
  on public.aigc_jobs (reconcile_token)
  where reconcile_token is not null;

create unique index if not exists aigc_jobs_provider_job_unique_idx
  on public.aigc_jobs (provider, provider_job_id)
  where provider_job_id is not null;

create table if not exists public.aigc_generations (
  id              uuid        primary key default gen_random_uuid(),
  job_id          uuid        not null references public.aigc_jobs(id) on delete cascade,
  user_id         text        not null,
  kind            text        not null check (kind in ('image', 'model3d', 'video')),
  workflow_id     text        not null default 'standard',
  prompt          text,
  provider        text        not null,
  provider_job_id text,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (job_id)
);

alter table public.aigc_generations
  add column if not exists workflow_id text not null default 'standard';

create index if not exists aigc_generations_user_created_idx
  on public.aigc_generations (user_id, created_at desc);

create table if not exists public.aigc_assets (
  id              uuid        primary key default gen_random_uuid(),
  generation_id   uuid        not null references public.aigc_generations(id) on delete cascade,
  job_id          uuid        not null references public.aigc_jobs(id) on delete cascade,
  user_id         text        not null,
  kind            text        not null check (kind in ('image', 'model3d', 'video')),
  asset_type      text        not null default 'output',
  position        integer     not null default 0,
  r2_key          text,
  source_url      text,
  content_type    text,
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (job_id, asset_type, position)
);

create index if not exists aigc_assets_user_created_idx
  on public.aigc_assets (user_id, created_at desc);

create index if not exists aigc_assets_generation_idx
  on public.aigc_assets (generation_id, position);

alter table public.aigc_jobs enable row level security;
alter table public.aigc_generations enable row level security;
alter table public.aigc_assets enable row level security;
