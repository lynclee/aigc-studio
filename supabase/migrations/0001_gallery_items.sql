-- 作品画廊索引表 / Gallery index table
--
-- 数据流(presigned-PUT):美术同学的 comfyui_modal_bridge 插件持 upload-token(绑本人
-- open_id)→ POST /api/gallery/upload-url 验 token 推导 open_id、写一条索引到这里、签 R2
-- 预签名 PUT URL → 插件把图直传 R2(key 强制 <open_id>/<uuid>.<ext> 前缀隔离)→ 门户按
-- 登录用户 open_id 读取并对 r2_key 签预签名 GET URL 展示。
--
-- ⚠️ 本项目不用 Supabase Auth(用飞书 OAuth + 自管 cookie session),
-- 所以这张表「仅服务端用 service_role 访问,并在应用层按 open_id 过滤」。
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

-- 门户读取按 (user_open_id, created_at desc) 拉最近 N 条,covering 这个排序
create index if not exists gallery_items_user_created_idx
  on public.gallery_items (user_open_id, created_at desc);

-- 开 RLS:不加任何 anon/authenticated policy。
-- 仅服务端 service_role 访问(service_role 绕过 RLS),应用层按 open_id 过滤。
alter table public.gallery_items enable row level security;
