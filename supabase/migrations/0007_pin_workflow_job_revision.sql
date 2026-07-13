-- Pin the exact workflow execution/delivery contract selected for every new Job.
--
-- Legacy rows remain (null, null) and temporarily use the current code catalog.
-- Before publishing the first revision change, drain/reconcile active legacy Jobs:
--   select count(*) from public.aigc_jobs
--   where status in ('queued', 'running') and workflow_snapshot is null;

alter table public.aigc_jobs
  add column if not exists workflow_revision text,
  add column if not exists workflow_snapshot jsonb;

-- Public workflow IDs are now catalog data. Keep only a generic shape constraint;
-- the server-side catalog remains the authoritative allowlist for new Jobs.
alter table public.aigc_jobs
  drop constraint if exists aigc_jobs_workflow_id_check;

alter table public.aigc_jobs
  drop constraint if exists aigc_jobs_workflow_id_format_check;
alter table public.aigc_jobs
  add constraint aigc_jobs_workflow_id_format_check
  check (workflow_id ~ '^[a-z0-9][a-z0-9-]{0,63}$');

alter table public.aigc_jobs
  drop constraint if exists aigc_jobs_workflow_snapshot_check;
alter table public.aigc_jobs
  add constraint aigc_jobs_workflow_snapshot_check
  check (
    (workflow_revision is null and workflow_snapshot is null)
    or coalesce((
      workflow_revision is not null
      and workflow_snapshot is not null
      and workflow_revision ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      and jsonb_typeof(workflow_snapshot) = 'object'
      and workflow_snapshot ?& array[
        'schemaVersion',
        'definitionRevision',
        'kind',
        'workflowId',
        'provider',
        'executionVariant',
        'templateVersion',
        'referenceCount',
        'outputContract'
      ]
      and workflow_snapshot->>'schemaVersion' = '1'
      and workflow_snapshot->>'definitionRevision' = workflow_revision
      and workflow_snapshot->>'kind' = kind
      and workflow_snapshot->>'workflowId' = workflow_id
      and workflow_snapshot->>'provider' = provider
      and workflow_snapshot->>'referenceCount' ~ '^(0|[1-9][0-9]?)$'
      and (workflow_snapshot->>'referenceCount')::integer between 0 and 32
      and jsonb_typeof(workflow_snapshot->'outputContract') = 'array'
    ), false)
  );

create or replace function public.freeze_aigc_job_workflow_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.workflow_revision is distinct from new.workflow_revision
     or old.workflow_snapshot is distinct from new.workflow_snapshot then
    raise exception 'workflow revision/snapshot is immutable once a Job is created'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_aigc_job_workflow_snapshot on public.aigc_jobs;
create trigger freeze_aigc_job_workflow_snapshot
before update of workflow_revision, workflow_snapshot on public.aigc_jobs
for each row execute function public.freeze_aigc_job_workflow_snapshot();

revoke execute on function public.freeze_aigc_job_workflow_snapshot() from public, anon, authenticated;
