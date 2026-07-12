-- Reapply finalize_job_assets with lease fencing and explicit privileges for databases
-- that already executed an earlier revision of migration 0005.
-- 原子化任务落库(修 H4:五分钟租约超时期间,materialize 的中间写未被 fence,
-- 可能出现 cancelled job 下已有资产、或与并发 reconciler 互相覆盖)。
--
-- 把「fence 校验 reconcile_token + 写 generation + 写 assets + 置 succeeded」放进**单个函数=单事务**:
-- 只有仍持有本次租约 token 且 job 未终态时才写;否则返回 null,一个字节都不落。
-- R2 副作用(下载/Copy)在调用本函数**之前**完成(R2 不在 DB 事务内);本函数只保证 DB 侧原子。
--
-- 经 service_role 调用,绕过 RLS。资产为空则视为失败(不置 succeeded)。

create or replace function public.finalize_job_assets(
  p_job_id uuid,
  p_reconcile_token uuid,
  p_kind text,
  p_workflow_id text,
  p_user_id text,
  p_prompt text,
  p_provider text,
  p_provider_job_id text,
  p_generation_metadata jsonb,
  p_assets jsonb
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_generation_id uuid;
  v_asset jsonb;
begin
  -- fence + 行锁:仅当 job 仍持有本次租约 token 且未终态。否则放弃(租约已失/被取消/已完成)。
  perform 1
    from public.aigc_jobs
    where id = p_job_id
      and reconcile_token = p_reconcile_token
      and reconcile_lease_until > now()
      and status in ('queued', 'running')
    for update;
  if not found then
    return null;
  end if;

  insert into public.aigc_generations
    (job_id, user_id, kind, workflow_id, prompt, provider, provider_job_id, metadata)
  values
    (p_job_id, p_user_id, p_kind, p_workflow_id, p_prompt, p_provider, p_provider_job_id,
     coalesce(p_generation_metadata, '{}'::jsonb))
  on conflict (job_id) do update set
    prompt = excluded.prompt,
    provider = excluded.provider,
    provider_job_id = excluded.provider_job_id,
    metadata = excluded.metadata
  returning id into v_generation_id;

  for v_asset in select value from jsonb_array_elements(p_assets)
  loop
    insert into public.aigc_assets
      (generation_id, job_id, user_id, kind, asset_type, position, r2_key, source_url, content_type, metadata)
    values (
      v_generation_id, p_job_id, p_user_id, p_kind,
      coalesce(v_asset->>'asset_type', 'output'),
      coalesce((v_asset->>'position')::int, 0),
      v_asset->>'r2_key',
      null,
      v_asset->>'content_type',
      coalesce(v_asset->'metadata', '{}'::jsonb)
    )
    on conflict (job_id, asset_type, position) do update set
      generation_id = excluded.generation_id,
      r2_key = excluded.r2_key,
      content_type = excluded.content_type,
      metadata = excluded.metadata;
  end loop;

  -- 至少要有一个带 r2_key 的资产才算成功。
  if not exists (
    select 1 from public.aigc_assets where job_id = p_job_id and r2_key is not null
  ) then
    return null;
  end if;

  update public.aigc_jobs
    set status = 'succeeded',
        error = null,
        updated_at = now(),
        completed_at = coalesce(completed_at, now()),
        reconcile_token = null,
        reconcile_lease_until = null
    where id = p_job_id and reconcile_token = p_reconcile_token;

  return v_generation_id;
end;
$$;

-- 显式收紧执行权限(M7):只有 service_role 能调用,anon/authenticated/public 一律拒绝。
revoke execute on function public.finalize_job_assets(
  uuid, uuid, text, text, text, text, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_job_assets(
  uuid, uuid, text, text, text, text, text, text, jsonb, jsonb
) to service_role;
