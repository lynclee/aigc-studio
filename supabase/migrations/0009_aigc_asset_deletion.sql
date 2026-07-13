-- User-visible generation deletion and fenced R2 cleanup queue.
--
-- Rollout order: apply this migration before deploying the application code
-- that filters on deleted_at/state or invokes these RPCs.
--
-- A Job remains the immutable execution audit record. Deleting a work only
-- tombstones its Generation and queues its Assets for eventual physical R2
-- deletion.

alter table public.aigc_generations
  add column if not exists deleted_at timestamptz;

alter table public.aigc_assets
  add column if not exists state text not null default 'active',
  add column if not exists delete_requested_at timestamptz,
  add column if not exists delete_attempts integer not null default 0,
  add column if not exists delete_error text,
  add column if not exists delete_retry_after timestamptz,
  add column if not exists delete_claim_token uuid,
  add column if not exists delete_lease_until timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.aigc_assets
  drop constraint if exists aigc_assets_state_check;
alter table public.aigc_assets
  add constraint aigc_assets_state_check
  check (state in ('active', 'pending_delete', 'deleted', 'error'));

alter table public.aigc_assets
  drop constraint if exists aigc_assets_delete_attempts_check;
alter table public.aigc_assets
  add constraint aigc_assets_delete_attempts_check
  check (delete_attempts between 0 and 5);

alter table public.aigc_assets
  drop constraint if exists aigc_assets_delete_claim_check;
alter table public.aigc_assets
  add constraint aigc_assets_delete_claim_check
  check (
    (delete_claim_token is null and delete_lease_until is null)
    or (delete_claim_token is not null and delete_lease_until is not null)
  );

alter table public.aigc_assets
  drop constraint if exists aigc_assets_delete_state_fields_check;
alter table public.aigc_assets
  add constraint aigc_assets_delete_state_fields_check
  check (
    (
      state = 'active'
      and deleted_at is null
      and delete_retry_after is null
      and delete_claim_token is null
      and delete_lease_until is null
    )
    or (
      state = 'pending_delete'
      and deleted_at is null
      and delete_requested_at is not null
      and r2_key is not null
      and btrim(r2_key) <> ''
    )
    or (
      state = 'deleted'
      and deleted_at is not null
      and delete_requested_at is not null
      and delete_retry_after is null
      and delete_claim_token is null
      and delete_lease_until is null
    )
    or (
      state = 'error'
      and deleted_at is null
      and delete_requested_at is not null
      and delete_retry_after is null
      and delete_claim_token is null
      and delete_lease_until is null
    )
  );

create index if not exists aigc_generations_user_visible_idx
  on public.aigc_generations (user_id, created_at desc)
  where deleted_at is null;

create index if not exists aigc_assets_pending_delete_idx
  on public.aigc_assets (delete_retry_after, delete_requested_at, delete_lease_until)
  where state = 'pending_delete';

create index if not exists aigc_assets_active_r2_key_idx
  on public.aigc_assets (r2_key)
  where state = 'active' and deleted_at is null and r2_key is not null;

-- Owner-check, Generation tombstone, and Asset queueing are deliberately one
-- transaction. A service crash can therefore never hide a Generation without
-- also making every physical Asset discoverable by the cleanup worker.
create or replace function public.tombstone_generation_assets(
  p_generation_id uuid,
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_generation_id uuid;
  v_job_id uuid;
  v_pending_assets integer := 0;
  v_deleted_assets integer := 0;
  v_error_assets integer := 0;
begin
  select generation.id, generation.job_id
    into v_generation_id, v_job_id
    from public.aigc_generations as generation
    join public.aigc_jobs as job on job.id = generation.job_id
   where generation.id = p_generation_id
     and generation.user_id = p_user_id
     and job.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object(
      'found', false,
      'generation_id', p_generation_id,
      'pending_assets', 0,
      'deleted_assets', 0,
      'error_assets', 0
    );
  end if;

  -- Cross-table ownership is an invariant, not something to repair during a
  -- destructive request. Raising here rolls the whole transaction back.
  if exists (
    select 1
      from public.aigc_assets as asset
     where asset.generation_id = v_generation_id
       and (asset.user_id <> p_user_id or asset.job_id <> v_job_id)
  ) then
    raise exception 'generation asset ownership is inconsistent'
      using errcode = '23514';
  end if;

  update public.aigc_generations
     set deleted_at = coalesce(deleted_at, statement_timestamp())
   where id = v_generation_id;

  -- Rows without a physical key are already physically absent.
  update public.aigc_assets
     set state = 'deleted',
         delete_requested_at = coalesce(delete_requested_at, statement_timestamp()),
         delete_error = null,
         delete_retry_after = null,
         delete_claim_token = null,
         delete_lease_until = null,
         deleted_at = coalesce(deleted_at, statement_timestamp())
   where generation_id = v_generation_id
     and user_id = p_user_id
     and state <> 'deleted'
     and (r2_key is null or btrim(r2_key) = '');

  -- Only active rows enter the queue. Repeated DELETE calls do not reset a
  -- pending lease, retry count, deleted row, or exhausted/error dead letter.
  update public.aigc_assets
     set state = 'pending_delete',
         delete_requested_at = coalesce(delete_requested_at, statement_timestamp()),
         delete_error = null,
         delete_retry_after = null,
         delete_claim_token = null,
         delete_lease_until = null,
         deleted_at = null
   where generation_id = v_generation_id
     and user_id = p_user_id
     and state = 'active'
     and r2_key is not null
     and btrim(r2_key) <> '';

  select count(*) filter (where state = 'pending_delete'),
         count(*) filter (where state = 'deleted'),
         count(*) filter (where state = 'error')
    into v_pending_assets, v_deleted_assets, v_error_assets
    from public.aigc_assets
   where generation_id = v_generation_id
     and user_id = p_user_id;

  return jsonb_build_object(
    'found', true,
    'generation_id', v_generation_id,
    'pending_assets', v_pending_assets,
    'deleted_assets', v_deleted_assets,
    'error_assets', v_error_assets
  );
end;
$$;

-- Convert expired fifth claims to observable dead letters in a separate,
-- bounded SKIP LOCKED pass so cleanup never performs an unbounded UPDATE.
create or replace function public.deadletter_expired_asset_deletes(
  p_limit integer default 25
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deadlettered integer := 0;
begin
  with expired as (
    select asset.id
      from public.aigc_assets as asset
     where asset.state = 'pending_delete'
       and asset.delete_attempts >= 5
       and (asset.delete_lease_until is null or asset.delete_lease_until <= statement_timestamp())
     order by asset.delete_requested_at asc nulls first, asset.created_at asc
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), updated as (
    update public.aigc_assets as asset
       set state = 'error',
           delete_error = coalesce(asset.delete_error, 'asset_delete_lease_expired'),
           delete_retry_after = null,
           delete_claim_token = null,
           delete_lease_until = null
      from expired
     where asset.id = expired.id
    returning asset.id
  )
  select count(*) into v_deadlettered from updated;

  return v_deadlettered;
end;
$$;

-- Claim a bounded batch using row locks and a lease. Overlapping cron
-- invocations cannot process the same row until its lease expires.
create or replace function public.claim_pending_asset_deletes(
  p_limit integer default 25,
  p_lease_seconds integer default 300
)
returns setof public.aigc_assets
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return query
  with candidates as (
    select asset.id
      from public.aigc_assets as asset
     where asset.state = 'pending_delete'
       and asset.delete_attempts < 5
       and asset.r2_key is not null
       and btrim(asset.r2_key) <> ''
       and (asset.delete_retry_after is null or asset.delete_retry_after <= statement_timestamp())
       and (
         asset.delete_claim_token is null
         or asset.delete_lease_until is null
         or asset.delete_lease_until <= statement_timestamp()
       )
     order by asset.delete_requested_at asc nulls first, asset.created_at asc
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.aigc_assets as asset
     set delete_attempts = asset.delete_attempts + 1,
         delete_claim_token = gen_random_uuid(),
         delete_lease_until = statement_timestamp()
           + greatest(30, least(coalesce(p_lease_seconds, 300), 900)) * interval '1 second'
    from candidates
   where asset.id = candidates.id
  returning asset.*;
end;
$$;

-- Fence every completion by its claim token. Failed attempts are retryable up
-- to five times, then become an observable dead letter (state='error').
create or replace function public.complete_asset_delete(
  p_asset_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_state text;
  v_attempts integer;
begin
  if coalesce(p_succeeded, false) then
    update public.aigc_assets
       set state = 'deleted',
           delete_error = null,
           delete_retry_after = null,
           delete_claim_token = null,
           delete_lease_until = null,
           deleted_at = coalesce(deleted_at, statement_timestamp())
     where id = p_asset_id
       and state = 'pending_delete'
       and delete_claim_token = p_claim_token
    returning state, delete_attempts into v_state, v_attempts;
  else
    update public.aigc_assets
       set state = case when delete_attempts >= 5 then 'error' else 'pending_delete' end,
           delete_error = left(coalesce(nullif(btrim(p_error_code), ''), 'asset_delete_failed'), 160),
           delete_retry_after = case
             when delete_attempts >= 5 then null
             else statement_timestamp()
               + case delete_attempts
                   when 1 then 30
                   when 2 then 60
                   when 3 then 120
                   else 240
                 end * interval '1 second'
           end,
           delete_claim_token = null,
           delete_lease_until = null
     where id = p_asset_id
       and state = 'pending_delete'
       and delete_claim_token = p_claim_token
    returning state, delete_attempts into v_state, v_attempts;
  end if;

  if not found then
    return jsonb_build_object('completed', false);
  end if;

  return jsonb_build_object(
    'completed', true,
    'state', v_state,
    'attempts', v_attempts
  );
end;
$$;

revoke execute on function public.tombstone_generation_assets(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.deadletter_expired_asset_deletes(integer)
  from public, anon, authenticated;
revoke execute on function public.claim_pending_asset_deletes(integer, integer)
  from public, anon, authenticated;
revoke execute on function public.complete_asset_delete(uuid, uuid, boolean, text)
  from public, anon, authenticated;

grant execute on function public.tombstone_generation_assets(uuid, text) to service_role;
grant execute on function public.deadletter_expired_asset_deletes(integer) to service_role;
grant execute on function public.claim_pending_asset_deletes(integer, integer) to service_role;
grant execute on function public.complete_asset_delete(uuid, uuid, boolean, text) to service_role;
