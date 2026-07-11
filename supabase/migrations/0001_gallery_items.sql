-- LEGACY ONLY: old personal gallery index table.
--
-- This table/documented flow is retained only for deployments that still have
-- historical gallery_items data. Current generation output is written through
-- aigc_jobs / aigc_generations / aigc_assets (see 0002_aigc_jobs_generations_assets.sql)
-- after provider completion; upload-token/operator-plugin upload is no longer the main flow.
--
-- 本项目不用 Supabase Auth(用飞书 OAuth + 自管 cookie session),
-- 所以这张表「仅服务端用 service_role 访问」。
-- 下面 enable RLS 但**不加任何 anon / authenticated policy**:
-- service_role 绕过 RLS,anon / authenticated 则被默认拒绝(零 policy = 全拒),
-- 避免有人误用 anon key 直连后裸读全表。

create table if not exists public.gallery_items (
  id            uuid        primary key default gen_random_uuid(),
  user_open_id  text        not null,
  r2_key        text        not null,
  prompt        text,
  source        text        default 'bridge',
  created_at    timestamptz default now()
);

-- Legacy portal index by owner and creation time.
create index if not exists gallery_items_user_created_idx
  on public.gallery_items (user_open_id, created_at desc);

-- 开 RLS:不加任何 anon/authenticated policy。
-- 仅服务端 service_role 访问(service_role 绕过 RLS)。
alter table public.gallery_items enable row level security;
