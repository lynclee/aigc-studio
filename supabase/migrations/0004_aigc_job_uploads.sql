-- Modal Bridge aigc-r2 交付：在途上传台账。
--
-- 记录 /api/internal/asset-intake 签发的每文件上传意图，由
-- /api/internal/job-complete 经 HeadObject 核验后确认。让 aigc_assets 保持
-- “只存已完成资产”：只有核验通过后才写入 aigc_assets。
--
-- 幂等：unique(job_id, asset_type, position) 保证 intake 重试时返回同一 r2_key，
-- 从而 Bridge 的重复回调解析到同一个 R2 对象。
--
-- 仅 service_role 访问；启用 RLS 且不加 policy，与其余 aigc_* 表一致。

create table if not exists public.aigc_job_uploads (
  id              uuid        primary key default gen_random_uuid(),
  job_id          uuid        not null references public.aigc_jobs(id) on delete cascade,
  user_id         text        not null,
  asset_type      text        not null,
  position        integer     not null default 0,
  r2_key          text        not null,
  content_type    text,
  size_bytes      bigint,
  etag            text,
  checksum_sha256 text,
  status          text        not null default 'pending'
                                    check (status in ('pending', 'uploaded', 'recorded')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (job_id, asset_type, position)
);

create index if not exists aigc_job_uploads_job_idx
  on public.aigc_job_uploads (job_id);

alter table public.aigc_job_uploads enable row level security;
