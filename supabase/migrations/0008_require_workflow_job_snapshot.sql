-- Complete the rolling rollout started by 0007: existing rows may remain
-- (null, null), but every row inserted after this migration must carry the
-- server-authored workflow revision/snapshot pair.
--
-- Existing deployments: apply 0007, deploy the new-write application, then
-- apply 0008. Fresh deployments can run all migrations in order.

create or replace function public.require_aigc_job_workflow_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.workflow_revision is null or new.workflow_snapshot is null then
    raise exception 'new AIGC Jobs require a workflow revision/snapshot'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists require_aigc_job_workflow_snapshot on public.aigc_jobs;
create trigger require_aigc_job_workflow_snapshot
before insert on public.aigc_jobs
for each row execute function public.require_aigc_job_workflow_snapshot();

revoke execute on function public.require_aigc_job_workflow_snapshot() from public, anon, authenticated;
