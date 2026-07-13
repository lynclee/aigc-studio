-- Operations-only recovery and aggregate monitoring for fenced Asset deletion.
--
-- Rollout order: apply this migration before deploying application code that
-- calls asset_delete_backlog_counts(). User DELETE deliberately never redrives
-- a dead letter: an operator must first investigate the stable failure code,
-- then invoke redrive_asset_delete with an attributable actor and reason.

alter table public.aigc_assets
  add column if not exists delete_redrive_version bigint not null default 0;

alter table public.aigc_assets
  drop constraint if exists aigc_assets_delete_redrive_version_check;
alter table public.aigc_assets
  add constraint aigc_assets_delete_redrive_version_check
  check (delete_redrive_version >= 0) not valid;
alter table public.aigc_assets
  validate constraint aigc_assets_delete_redrive_version_check;

create table if not exists public.aigc_asset_delete_redrive_events (
  id                  uuid        primary key default gen_random_uuid(),
  asset_id            uuid        not null,
  generation_id       uuid        not null,
  job_id              uuid        not null,
  user_id             text        not null,
  actor               text        not null,
  reason              text        not null,
  redrive_version     bigint      not null,
  previous_attempts   integer     not null,
  previous_error_code text        not null,
  created_at          timestamptz not null default now(),
  constraint aigc_asset_delete_redrive_actor_check
    check (actor ~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,79}$'),
  constraint aigc_asset_delete_redrive_reason_check
    check (reason ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  constraint aigc_asset_delete_redrive_attempts_check
    check (previous_attempts between 0 and 5),
  constraint aigc_asset_delete_redrive_version_check
    check (redrive_version > 0),
  constraint aigc_asset_delete_redrive_error_check
    check (previous_error_code ~ '^[a-z0-9][a-z0-9_.-]{0,159}$')
);

create index if not exists aigc_asset_delete_redrive_events_asset_idx
  on public.aigc_asset_delete_redrive_events (asset_id, created_at desc);
create index if not exists aigc_asset_delete_redrive_events_created_idx
  on public.aigc_asset_delete_redrive_events (created_at desc);
create unique index if not exists aigc_asset_delete_redrive_events_version_idx
  on public.aigc_asset_delete_redrive_events (asset_id, redrive_version);
create index if not exists aigc_assets_delete_error_requested_idx
  on public.aigc_assets (delete_requested_at)
  where state = 'error';

alter table public.aigc_asset_delete_redrive_events enable row level security;

-- Even a future accidental table grant cannot mutate history. PostgreSQL
-- owners can still perform an explicit schema change, as with every DB audit.
create or replace function public.prevent_asset_delete_redrive_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'asset delete redrive events are append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists prevent_asset_delete_redrive_event_mutation
  on public.aigc_asset_delete_redrive_events;
create trigger prevent_asset_delete_redrive_event_mutation
before update or delete or truncate on public.aigc_asset_delete_redrive_events
for each statement execute function public.prevent_asset_delete_redrive_event_mutation();

-- Aggregate-only monitoring surface. It never returns identity, R2 keys,
-- provider details, stored error text, actor, or redrive reason.
create or replace function public.asset_delete_backlog_counts()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'observed_at', statement_timestamp(),
    'pending_total', count(*) filter (where state = 'pending_delete'),
    'pending_due', count(*) filter (
      where state = 'pending_delete'
        and delete_attempts < 5
        and r2_key is not null
        and btrim(r2_key) <> ''
        and (delete_retry_after is null or delete_retry_after <= statement_timestamp())
        and (
          delete_claim_token is null
          or delete_lease_until is null
          or delete_lease_until <= statement_timestamp()
        )
    ),
    'pending_leased', count(*) filter (
      where state = 'pending_delete'
        and delete_claim_token is not null
        and delete_lease_until > statement_timestamp()
    ),
    'retry_wait', count(*) filter (
      where state = 'pending_delete'
        and delete_attempts < 5
        and delete_retry_after > statement_timestamp()
        and (
          delete_claim_token is null
          or delete_lease_until is null
          or delete_lease_until <= statement_timestamp()
        )
    ),
    'deadletter_due', count(*) filter (
      where state = 'pending_delete'
        and delete_attempts >= 5
        and (
          delete_claim_token is null
          or delete_lease_until is null
          or delete_lease_until <= statement_timestamp()
        )
    ),
    'error_total', count(*) filter (where state = 'error'),
    'oldest_pending_at', min(delete_requested_at) filter (where state = 'pending_delete'),
    'oldest_error_at', min(delete_requested_at) filter (where state = 'error')
  )
  from public.aigc_assets;
$$;

-- Redrive exactly one investigated dead letter. SELECT ... FOR UPDATE plus the
-- state predicate is the concurrency fence: overlapping operators can produce
-- only one transition and one audit event. Audit insert and state reset share
-- this function transaction, so either both commit or neither does.
create or replace function public.redrive_asset_delete(
  p_asset_id uuid,
  p_expected_redrive_version bigint,
  p_actor text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_asset public.aigc_assets%rowtype;
  v_provider_job_id text;
  v_actor text;
  v_reason text;
  v_previous_error_code text;
  v_next_redrive_version bigint;
  v_event_id uuid := gen_random_uuid();
  v_user_segment text;
  v_job_segment text;
  v_provider_segment text;
  v_current_prefix text;
  v_direct_prefix text;
  v_legacy_prefix text;
begin
  v_actor := btrim(p_actor);
  v_reason := btrim(p_reason);
  if p_actor is null or v_actor !~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,79}$' then
    raise exception 'redrive actor must be an attributable identifier'
      using errcode = '22023';
  end if;
  if p_reason is null or v_reason !~ '^[a-z0-9][a-z0-9_.-]{0,79}$' then
    raise exception 'redrive reason must be a stable lowercase code'
      using errcode = '22023';
  end if;
  if p_expected_redrive_version is null or p_expected_redrive_version < 0 then
    raise exception 'expected redrive version must be non-negative'
      using errcode = '22023';
  end if;

  select asset.*
    into v_asset
    from public.aigc_assets as asset
   where asset.id = p_asset_id
     and asset.state = 'error'
     and asset.delete_attempts >= 5
     and asset.delete_requested_at is not null
     and asset.delete_retry_after is null
     and asset.delete_claim_token is null
     and asset.delete_lease_until is null
     and asset.deleted_at is null
     and asset.delete_redrive_version = p_expected_redrive_version
   for update;

  if not found then
    return jsonb_build_object('requeued', false);
  end if;

  -- The Generation tombstone and cross-table ownership remain authoritative.
  select generation.provider_job_id
    into v_provider_job_id
    from public.aigc_generations as generation
    join public.aigc_jobs as job on job.id = generation.job_id
   where generation.id = v_asset.generation_id
     and generation.job_id = v_asset.job_id
     and generation.user_id = v_asset.user_id
     and generation.deleted_at is not null
     and job.id = v_asset.job_id
     and job.user_id = v_asset.user_id;

  if not found then
    raise exception 'asset delete redrive authority is inconsistent'
      using errcode = '23514';
  end if;
  if v_asset.r2_key is null or btrim(v_asset.r2_key) = '' then
    raise exception 'asset delete redrive key is missing'
      using errcode = '23514';
  end if;

  -- Keep the same ASCII allowlist as safeDirectR2Segment(). The application
  -- worker revalidates the prefix again immediately before physical deletion.
  v_user_segment := coalesce(
    nullif(left(regexp_replace(v_asset.user_id, '[^A-Za-z0-9_-]', '_', 'g'), 160), ''),
    'item'
  );
  v_job_segment := coalesce(
    nullif(left(regexp_replace(v_asset.job_id::text, '[^A-Za-z0-9_-]', '_', 'g'), 160), ''),
    'item'
  );
  if v_provider_job_id is not null then
    v_provider_segment := coalesce(
      nullif(left(regexp_replace(v_provider_job_id, '[^A-Za-z0-9_-]', '_', 'g'), 160), ''),
      'item'
    );
  end if;

  v_current_prefix := 'aigc/' || v_asset.user_id || '/' || v_asset.job_id || '/';
  v_direct_prefix := v_user_segment || '/' || v_job_segment || '/';
  v_legacy_prefix := case
    when v_provider_segment is null then null
    else v_user_segment || '/' || v_provider_segment || '/'
  end;

  if left(v_asset.r2_key, char_length(v_current_prefix)) <> v_current_prefix
     and left(v_asset.r2_key, char_length(v_direct_prefix)) <> v_direct_prefix
     and (
       v_legacy_prefix is null
       or left(v_asset.r2_key, char_length(v_legacy_prefix)) <> v_legacy_prefix
     ) then
    raise exception 'asset delete redrive key ownership is inconsistent'
      using errcode = '23514';
  end if;

  -- Never copy arbitrary stored text into the audit trail. The application
  -- writes stable codes; legacy or hand-written text is classified instead.
  v_previous_error_code := case
    when v_asset.delete_error ~ '^[a-z0-9][a-z0-9_.-]{0,159}$'
      then v_asset.delete_error
    else 'unclassified_asset_delete_error'
  end;
  v_next_redrive_version := v_asset.delete_redrive_version + 1;

  insert into public.aigc_asset_delete_redrive_events (
    id,
    asset_id,
    generation_id,
    job_id,
    user_id,
    actor,
    reason,
    redrive_version,
    previous_attempts,
    previous_error_code
  ) values (
    v_event_id,
    v_asset.id,
    v_asset.generation_id,
    v_asset.job_id,
    v_asset.user_id,
    v_actor,
    v_reason,
    v_next_redrive_version,
    v_asset.delete_attempts,
    v_previous_error_code
  );

  update public.aigc_assets
     set state = 'pending_delete',
         delete_attempts = 0,
         delete_error = null,
         delete_retry_after = statement_timestamp(),
         delete_claim_token = null,
         delete_lease_until = null,
         deleted_at = null,
         delete_redrive_version = v_next_redrive_version
   where id = v_asset.id
     and state = 'error'
     and delete_redrive_version = p_expected_redrive_version;

  if not found then
    raise exception 'asset delete redrive lost its state fence'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'requeued', true,
    'event_id', v_event_id,
    'redrive_version', v_next_redrive_version
  );
end;
$$;

-- New functions default to PUBLIC execute in PostgreSQL. Remove it explicitly,
-- and keep the append-only audit table unreadable/unwritable by browser roles.
revoke all on table public.aigc_asset_delete_redrive_events
  from public, anon, authenticated, service_role;
grant select on table public.aigc_asset_delete_redrive_events to service_role;

revoke execute on function public.prevent_asset_delete_redrive_event_mutation()
  from public, anon, authenticated, service_role;
revoke execute on function public.asset_delete_backlog_counts()
  from public, anon, authenticated;
revoke execute on function public.redrive_asset_delete(uuid, bigint, text, text)
  from public, anon, authenticated;

grant execute on function public.asset_delete_backlog_counts() to service_role;
grant execute on function public.redrive_asset_delete(uuid, bigint, text, text) to service_role;
