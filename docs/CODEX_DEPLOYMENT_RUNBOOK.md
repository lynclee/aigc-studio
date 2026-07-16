# AIGC Studio 部署与首轮全链路验收手册

> 最后核对：2026-07-15  
> 适用范围：当前 `main`，AIGC Studio + `comfyui_modal_bridge` 0.6.0 `aigc-r2` 交付模式。  
> 相关文档：[`HANDOFF.md`](./HANDOFF.md)、[`PLATFORM_OVERVIEW.md`](./PLATFORM_OVERVIEW.md)、[`PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md`](./PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md)。

## 1. 本轮目标与成功标准

第一次不要同时接图片、视频和 3D。先跑通最短但完整的生产链路：

```text
GitHub 登录
  → 提交 Modal Bridge 标准文生图
  → Modal GPU 执行 Z-Image-Turbo
  → Bridge 申请 R2 staging PUT 地址并直传
  → Vercel 核验、Copy 到 final key
  → Supabase 原子 finalize
  → 个人作品库显示
  → 用户删除作品
  → cleanup 物理删除 R2 对象
```

完成以下检查才算 Stage 0 通过：

- [ ] GitHub OAuth 登录后进入 `/portal`。
- [ ] 图片 Job 最终为 `succeeded`，provider 为 `modal-bridge`。
- [ ] R2 只有服务端权威 final 对象，作品库可通过预签名 GET 展示。
- [ ] `aigc_generations` 和 `aigc_assets` 正确落库，资产状态为 `active`。
- [ ] 删除后 Generation 立即 tombstone，作品从个人库消失。
- [ ] cleanup 后 Asset 为 `deleted`，R2 final/staging 对象均不存在。
- [ ] 未登录用户不能访问个人 API，R2 Bucket 未公开。

---

## 2. 需要注册的账号与最低权限

| 平台 | Stage 0 | 用途 | 最低所需权限 |
|---|---:|---|---|
| GitHub | 必需 | Vercel 导入仓库、用户 OAuth 登录 | 目标仓库访问权；能创建 OAuth App |
| Supabase | 必需 | Auth + Postgres | 能查看 API Key、配置 Auth Provider、执行 SQL migration |
| Cloudflare | 必需 | 私有 R2 作品存储 | 能启用 R2、创建 Bucket 和 R2 API Token |
| Vercel | 必需 | 部署 Next.js、环境变量、Cron、日志 | Project Owner/Admin 或等效权限 |
| Modal | 必需 | Serverless GPU、Modal Bridge App/Secret/Volume | Workspace 内可部署 App、创建 Secret/Volume、使用 GPU |
| ComfyUI Desktop | 必需 | 部署 Bridge、准备并同步模型 | 本地软件，不需要账号 |
| Hugging Face | 可选 | 下载公开模型 | 公开文件通常不需要 Token |
| Google Cloud | 可选 | Google 登录 | 第一次只验 GitHub 时不需要 |
| comfy.org | 可选 | Seedance/Tripo/GPT 等付费 API 节点 | 标准图片工作流不需要 |
| fal.ai | 可选 | 当前默认视频/3D 后端 | Stage 0 图片不需要 |
| OpenRouter | 可选 | 替代图片 provider | Stage 0 图片不需要 |

### 2.1 不需要申请的额外权限

- GitHub 登录只使用基础身份信息，不需要 repo、组织管理等额外 OAuth scope。
- R2 不需要公开访问、不需要 `r2.dev`、不需要自定义域名。
- 标准图片工作流只使用本地模型节点，不需要 `COMFY_API_KEY_COMFY_ORG`。
- Stage 0 不提交视频/3D，因此暂时不需要 `FAL_KEY`。

---

## 3. 凭据去向总表

| 凭据 | 获取/生成位置 | 应放置位置 | 禁止放置位置 |
|---|---|---|---|
| GitHub OAuth Client ID/Secret | GitHub OAuth App | Supabase GitHub Provider | Git、浏览器、Modal |
| Supabase anon key | Supabase API Settings | Vercel `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 不要错填 service role |
| Supabase service_role key | Supabase API Settings | 仅 Vercel 服务端 | 浏览器、Modal、Git |
| R2 Access Key ID/Secret | Cloudflare R2 API Token | 仅 Vercel | Modal、ComfyUI、浏览器、Git |
| Modal Token ID/Secret | Modal Workspace Settings | 本地插件配置 | Vercel、Modal App Secret、Git |
| Bridge API Key | Bridge 部署时自动生成 | Modal Secret + Vercel | 浏览器、Git、公开日志 |
| Delivery HMAC Secret | 本地随机生成 | 仅 Vercel | Modal Secret、浏览器、Git |
| Cron Secret | 本地随机生成 | 仅 Vercel | 浏览器、Git |
| Vercel Protection Bypass | Vercel Deployment Protection | Vercel 平台 + Modal Secret | 浏览器、Git |
| comfy.org API Key | comfy.org | 仅 Modal Secret | Stage 0 不需要 |

安全边界：

- R2 长期凭据只存在于 Vercel。
- Modal 只拿每个 Job 的短期 delivery token 和预签名 PUT URL。
- `SUPABASE_SERVICE_ROLE_KEY`、R2 Secret、Bridge Key 都不得使用 `NEXT_PUBLIC_` 前缀。
- `.env.local`、Modal `config.json`、任何 Token 截图都不得提交 Git。

生成两个不同的随机值：

```bash
openssl rand -hex 32  # CRON_SECRET
openssl rand -hex 32  # BRIDGE_DELIVERY_TOKEN_SECRET
```

不要复用同一个值。

---

## 4. 推荐部署顺序

```text
1. 在 Vercel 预留稳定 Production 域名
2. 创建 Supabase，执行 0001→0010
3. 配置 Supabase URL allowlist + GitHub OAuth
4. 创建私有 R2 Bucket、运行时 Token、CORS
5. 安装并部署 Modal Bridge，准备模型 Volume
6. 把 Bridge endpoint/key 和全部基础变量填入 Vercel
7. Redeploy Production
8. 登录 → 生成 → 作品库 → 删除 → cleanup 验收
```

不要用随机 Preview deployment 做首次闭环；OAuth、R2 CORS 和 Modal 回调都应绑定同一个稳定 Production origin。

---

## 5. Vercel：先确定稳定生产域名

1. 使用 GitHub 集成导入本仓库。
2. 选择固定项目名。
3. 在 `Project → Settings → Domains` 复制 Production 域名，例如：

   ```text
   https://aigc-studio-example.vercel.app
   ```

4. 后续统一把该 origin 作为：
   - `NEXT_PUBLIC_SITE_URL`
   - Supabase Site URL
   - Supabase Redirect URL 的 origin
   - GitHub OAuth Homepage URL
   - R2 CORS Allowed Origin
   - Modal Secret 的 `AIGC_STUDIO_BASE_URL`

可以先完成一次未配置服务的占位部署，拿到域名后再填完整环境变量并 Redeploy。

---

## 6. Supabase：项目、Key、迁移和 Auth

### 6.1 创建项目并复制 Key

在 Supabase Project Settings/API 中取得：

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

第一次部署建议严格按变量名使用 legacy `anon` 与 `service_role`，不要在首次验收时混搭多套 Key。

### 6.2 全新数据库执行 migration

在 SQL Editor 中严格按文件名顺序执行：

```text
supabase/migrations/0001_gallery_items.sql
supabase/migrations/0002_aigc_jobs_generations_assets.sql
supabase/migrations/0003_rename_legacy_user_columns.sql
supabase/migrations/0004_aigc_job_uploads.sql
supabase/migrations/0005_finalize_job_assets.sql
supabase/migrations/0006_harden_finalize_job_assets.sql
supabase/migrations/0007_pin_workflow_job_revision.sql
supabase/migrations/0008_require_workflow_job_snapshot.sql
supabase/migrations/0009_aigc_asset_deletion.sql
supabase/migrations/0010_asset_delete_operations.sql
```

全新库可以一次按顺序执行完。`0007 → 部署新写入代码 → 0008` 是旧库滚动升级要求，不适用于当前全新项目。

执行完后刷新 PostgREST schema cache：

```sql
notify pgrst, 'reload schema';
```

基本验证：

```sql
select
  to_regclass('public.aigc_jobs') as jobs,
  to_regclass('public.aigc_generations') as generations,
  to_regclass('public.aigc_assets') as assets,
  to_regclass('public.aigc_job_uploads') as uploads,
  to_regclass('public.aigc_asset_delete_redrive_events') as redrive_events;
```

所有列都应非空。

### 6.3 配置 Auth URL

进入：

```text
Authentication → URL Configuration
```

填写：

```text
Site URL:
https://你的生产域名

Redirect URLs:
https://你的生产域名/api/auth/callback
```

需要本地登录调试时再加：

```text
http://localhost:3000/api/auth/callback
```

### 6.4 创建 GitHub OAuth App

GitHub：

```text
Settings → Developer settings → OAuth Apps → New OAuth App
```

填写：

```text
Homepage URL:
https://你的生产域名

Authorization callback URL:
https://<project-ref>.supabase.co/auth/v1/callback
```

注意两套 callback 不同：

| 配置位置 | 正确地址 |
|---|---|
| GitHub OAuth App | Supabase `/auth/v1/callback` |
| Supabase Redirect URLs | 网站 `/api/auth/callback` |

生成 GitHub Client Secret 后，将 Client ID/Secret 填入：

```text
Supabase → Authentication → Providers → GitHub
```

启用 GitHub Provider。

参考：

- [Supabase GitHub Login](https://supabase.com/docs/guides/auth/social-login/auth-github)
- [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)

### 6.5 Google 登录（可选）

Stage 0 可以不配。如果要启用：

1. Google Cloud 建 OAuth Consent Screen。
2. 创建 Web OAuth Client。
3. Authorized JavaScript Origin 填生产 origin。
4. Authorized Redirect URI 填 Supabase `/auth/v1/callback`。
5. 只申请 `openid`、email、profile 基础 scope。
6. Client ID/Secret 填入 Supabase Google Provider。

参考：[Supabase Google Login](https://supabase.com/docs/guides/auth/social-login/auth-google)。

---

## 7. Cloudflare R2：私有 Bucket、Token 和 CORS

### 7.1 创建私有 Bucket

示例名称：

```text
aigc-studio-prod
```

要求：

- 保持 private。
- 不启用 `r2.dev` public URL。
- 不需要自定义域名。
- 使用普通/default jurisdiction，不要选择 EU/FedRAMP jurisdiction。

当前 `lib/r2.ts` 固定构造：

```text
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

EU/FedRAMP Bucket 使用不同 endpoint，当前代码没有配置对应后缀。

### 7.2 创建运行时 R2 Token

进入：

```text
R2 → Overview → Manage API Tokens
```

选择：

```text
Object Read & Write
Apply to specific buckets only
选择 aigc-studio-prod
```

保存以下值，Secret 只显示一次：

```env
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET=aigc-studio-prod
```

日常 Vercel 运行时只使用这组 scoped Object Token。不要把 Admin Token 放进 Vercel。

### 7.3 配置 CORS

推荐直接在 Bucket：

```text
Settings → CORS Policy
```

填写：

```json
[
  {
    "AllowedOrigins": ["https://你的生产域名"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["content-length", "ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

也可运行仓库脚本：

```bash
node scripts/setup-r2-cors.mjs https://你的生产域名
```

但编辑 Bucket CORS 需要 `Admin Read & Write`。若运行时 Object Token 被拒：

1. 临时创建 scoped Admin Token。
2. 只用它执行一次 CORS 配置。
3. 配置完成后立即撤销。
4. Vercel 中继续使用原 Object Read & Write Token。

参考：

- [Cloudflare R2 S3 Setup](https://developers.cloudflare.com/r2/get-started/s3/)
- [Cloudflare R2 Token Permissions](https://developers.cloudflare.com/r2/api/tokens/)
- [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

---

## 8. Modal Bridge：部署、Key 和模型准备

### 8.1 插件版本

使用 `comfyui_modal_bridge` 0.6.0、commit `3d4366f` 或更新的兼容版本。该版本已包含 `aigc-r2`：

```text
https://github.com/lynclee/comfyui_modal_bridge
```

### 8.2 准备 Modal Workspace Token

在 Modal Workspace Settings 创建或读取：

```text
Workspace name
Token ID: ak-...
Token Secret: as-...
```

Modal Token 只供本地插件执行部署、Secret、Volume 操作；不要填进 Vercel，也不要作为 Modal App 运行时 Secret。

确保 Workspace 已允许使用 GPU，并按 Modal 当前要求完成 Billing 设置。

### 8.3 安装插件

推荐通过 ComfyUI Manager 搜索 `Modal Bridge`。也可手工安装：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/lynclee/comfyui_modal_bridge
```

安装后重启 ComfyUI。

### 8.4 Modal Setup

打开：

```text
⚙️ Modal Setup
```

填写：

```text
Workspace              = 你的 Modal workspace
Token ID               = ak-...
Token Secret           = as-...
GPU Mode               = Auto
AIGC Studio URL        = https://你的生产域名
AIGC Bypass Secret     = 留空，除非启用 Vercel Deployment Protection
comfy.org API Key      = Stage 0 留空
```

点击部署。插件会自动创建/更新：

- Modal App `comfyui-bridge`
- Modal Secret `comfyui-bridge-secrets`
- 模型 Volume `comfyui-bridge-models`
- 私有 `BRIDGE_API_KEY`
- `run/status/cancel/health` 四个 endpoint

部署日志最后应出现 `/health` 成功。也可用 Setup 面板的“测试连接”。

### 8.5 准备 Stage 0 模型

`standard` 图片工作流固定引用：

```text
ComfyUI/models/diffusion_models/z_image_turbo_bf16.safetensors
ComfyUI/models/text_encoders/qwen_3_4b.safetensors
ComfyUI/models/vae/ae.safetensors
```

大约占用：

| 文件 | 大小 |
|---|---:|
| `z_image_turbo_bf16.safetensors` | 12.3 GB |
| `qwen_3_4b.safetensors` | 8.04 GB |
| `ae.safetensors` | 335 MB |

公开文件来源：[Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo/tree/main/split_files)。

部署插件后同步：

```bash
cd ComfyUI/custom_nodes/comfyui_modal_bridge

python sync_models.py --dry-run
python sync_models.py --type diffusion_models
python sync_models.py --type text_encoders
python sync_models.py --type vae
```

`--type` 会同步该类型目录下所有缺失模型。如果本地模型库很大，改用本地加载 Z-Image 工作流后执行一次 `RunModal`，让插件只同步当前工作流依赖。

重要：网站直接调用 Modal endpoint 时不会经过本地插件的“提交前同步”。所以首次网站验收前，模型必须已经存在于 Modal Volume。

### 8.6 取得 Endpoint Base 和 Bridge Key

插件本地配置：

```text
ComfyUI/user/default/modal_bridge/config.json
```

读取：

```text
modal_endpoint_base
bridge_api_key
```

典型结果：

```env
MODAL_BRIDGE_ENDPOINT_BASE=https://<workspace>--comfyui-bridge
MODAL_BRIDGE_API_KEY=bk-xxxxxxxx
```

Endpoint base 不要填成完整 run URL。AIGC Studio 会自动拼接：

```text
<base>-run.modal.run
<base>-status.modal.run
<base>-cancel.modal.run
```

如果健康检查 URL 是：

```text
https://alice--comfyui-bridge-health.modal.run
```

那么正确 base 是：

```text
https://alice--comfyui-bridge
```

### 8.7 Modal Secret 应包含什么

```env
BRIDGE_API_KEY=<与 Vercel MODAL_BRIDGE_API_KEY 相同>
AIGC_STUDIO_BASE_URL=https://你的生产域名
AIGC_STUDIO_BYPASS_SECRET=<可选>
COMFY_API_KEY_COMFY_ORG=<可选；Stage 0 不需要>
```

Modal Secret 绝不能包含：

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
SUPABASE_SERVICE_ROLE_KEY
MODAL_TOKEN_ID
MODAL_TOKEN_SECRET
OPENROUTER_API_KEY
FAL_KEY
```

参考：

- [Modal Getting Started](https://modal.com/docs/guide)
- [Modal Secrets](https://modal.com/docs/guide/secrets)
- [Modal Workspaces](https://modal.com/docs/guide/workspaces)

---

## 9. Vercel：最终环境变量与 Production Redeploy

### 9.1 Stage 0 必填环境变量

在 Vercel Project 的 Production Environment 中填写：

```env
# ── 网站 ──
NEXT_PUBLIC_SITE_URL=https://你的生产域名

# ── Supabase ──
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# ── 私有 R2 ──
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=aigc-studio-prod

# ── 图片 provider ──
AIGC_IMAGE_PROVIDER=modal-bridge
MODAL_BRIDGE_ENDPOINT_BASE=https://<workspace>--comfyui-bridge
MODAL_BRIDGE_API_KEY=bk-xxxxxxxx
BRIDGE_DELIVERY_TOKEN_SECRET=<独立随机64位hex>

# ── Cron ──
CRON_SECRET=<另一个独立随机64位hex>
```

### 9.2 Stage 0 暂时不填

```text
FAL_KEY
OPENROUTER_API_KEY
COMFY_ORG_API_KEY
MODAL_ENDPOINT_BASE
MODAL_KEY
MODAL_SECRET
AIGC_ASSET_HOST_ALLOWLIST
```

`AIGC_VIDEO_PROVIDER` 和 `AIGC_MODEL3D_PROVIDER` 可以暂时保持默认，但不要在缺少 `FAL_KEY` 时提交视频/3D。

### 9.3 不要使用旧交互脚本选择 provider

当前 `scripts/setup-env.sh` 尚未完整覆盖 `modal-bridge` 交互项。本次应手动填写 `.env.local`/Vercel Environment，并明确设置：

```env
AIGC_IMAGE_PROVIDER=modal-bridge
```

不要误用默认值 `modal`，它会切到遗留 `modal-image` adapter。

### 9.4 Redeploy

保存环境变量后必须重新部署 Production。Vercel 环境变量变更不会作用于旧 Deployment。

参考：[Vercel Environment Variables](https://vercel.com/docs/environment-variables)。

### 9.5 Deployment Protection

Stage 0 最简单方案：Production 域名不启用 Deployment Protection。

如果必须启用：

1. 在 Vercel 创建 `Protection Bypass for Automation`。
2. 复制生成的 secret。
3. 将同一个值填入 Modal Setup 的 `AIGC Bypass Secret`。
4. 重新部署 Modal Bridge，使 Modal Secret 获得：

   ```env
   AIGC_STUDIO_BYPASS_SECRET=<同一值>
   ```

5. Bridge 回调会带 `x-vercel-protection-bypass` 请求头。

参考：[Vercel Protection Bypass for Automation](https://examples.vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)。

### 9.6 Cron

`vercel.json` 已声明：

```text
03:30 UTC  /api/jobs/reconcile
04:00 UTC  /api/assets/cleanup
```

只要设置 `CRON_SECRET`，Vercel 会自动发送：

```text
Authorization: Bearer <CRON_SECRET>
```

当前 Vercel 官方限制下，Hobby 可配置最多 100 条 Cron，但每条最低每天一次且触发时间按小时精度；本项目两条每日 Cron 符合要求。

参考：

- [Vercel Cron Security](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Vercel Cron Usage and Limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)

---

## 10. Production 全链路验收

### 10.1 登录验收

打开：

```text
https://你的生产域名
```

点击 GitHub 登录。正确跳转：

```text
网站 /api/auth/github/login
  → Supabase Auth
  → GitHub
  → Supabase /auth/v1/callback
  → 网站 /api/auth/callback
  → /portal
```

### 10.2 提交标准文生图

在 `/portal`：

```text
类型：图片
工作流：标准出图
参考图：不上传
Prompt：a cute robot mascot, clean concept art, soft studio lighting
```

预期链路：

```text
create aigc_jobs
  → POST Modal Bridge /run
  → GPU 执行 z_image_turbo
  → POST /api/internal/asset-intake
  → PUT R2 staging
  → POST /api/internal/job-complete
  → Head staging + Copy staging→final
  → finalize_job_assets RPC
  → aigc_generations/aigc_assets
  → 作品库展示
```

### 10.3 数据库检查

```sql
select
  id,
  status,
  provider,
  workflow_id,
  workflow_revision,
  provider_job_id,
  error,
  created_at,
  completed_at
from public.aigc_jobs
order by created_at desc
limit 5;

select
  job_id,
  asset_type,
  position,
  status,
  r2_key,
  size_bytes,
  etag,
  updated_at
from public.aigc_job_uploads
order by created_at desc
limit 5;

select
  id,
  job_id,
  user_id,
  workflow_id,
  deleted_at,
  created_at
from public.aigc_generations
order by created_at desc
limit 5;

select
  id,
  generation_id,
  job_id,
  asset_type,
  state,
  r2_key,
  deleted_at,
  created_at
from public.aigc_assets
order by created_at desc
limit 5;
```

成功状态：

```text
aigc_jobs.status          = succeeded
aigc_jobs.provider        = modal-bridge
aigc_job_uploads.status   = recorded
aigc_generations.deleted_at is null
aigc_assets.state         = active
r2_key                    = aigc/<user>/<job>/*.png
```

### 10.4 R2 和作品库检查

- [ ] R2 final 对象存在。
- [ ] 对应 `.staging/` 对象已被 best-effort 清理。
- [ ] `/portal` 作品库能显示和下载图片。
- [ ] Bucket 仍为 private。
- [ ] 无登录 cookie 时 `/api/library` 返回 401。

### 10.5 删除验收

在作品库删除刚才生成的作品。

立即应看到：

```text
作品从个人库消失
generation.deleted_at 非空
asset.state = pending_delete 或 deleted
```

### 10.6 手动触发物理删除

```bash
export SITE_URL="https://你的生产域名"
export CRON_SECRET="你的 CRON_SECRET"

curl -fsS \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${SITE_URL}/api/assets/cleanup"
```

若启用 Deployment Protection，再加：

```bash
-H "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}"
```

预期响应包含：

```json
{
  "ok": true,
  "assetDeleteCleanup": {
    "deleted": 1
  }
}
```

再次检查：

```sql
select
  state,
  delete_attempts,
  delete_error,
  deleted_at
from public.aigc_assets
order by created_at desc
limit 5;
```

对应资产应为：

```text
state = deleted
deleted_at 非空
```

同时确认 R2 final 和对应 `.staging/` 对象均不存在。

### 10.7 手动触发 reconcile（仅排障时）

```bash
curl -fsS \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  "${SITE_URL}/api/jobs/reconcile"
```

正常生成不依赖手动调用；Modal Bridge push 回调是主路径，reconcile 是兜底。

---

## 11. 常见失败定位

| 现象 | 首要检查 |
|---|---|
| `auth_unconfigured` | `NEXT_PUBLIC_SUPABASE_URL`、anon key 是否存在并已 Redeploy |
| `oauth_failed` | GitHub callback 与网站 callback 是否填反；Production origin 是否在 allowlist |
| `Provider is not configured` | `AIGC_IMAGE_PROVIDER=modal-bridge` 和三个 Bridge env |
| Modal `/run` 401 | Vercel `MODAL_BRIDGE_API_KEY` 与插件 `bridge_api_key` 是否相同 |
| Modal 报模型不存在 | 三个 Z-Image 模型是否已同步到 Volume；文件名是否完全一致 |
| Modal 已出图但回调失败 | `AIGC_STUDIO_BASE_URL`、Deployment Protection bypass |
| R2 `AccessDenied` | Token 是否 Object Read & Write、是否限制到了正确 Bucket |
| R2 endpoint/签名错误 | 是否误建 EU/FedRAMP jurisdiction Bucket；Account ID 是否正确 |
| 图片入库但浏览器不显示 | R2 CORS origin 是否精确匹配 Production origin |
| 修改 env 后仍是旧值 | Vercel 是否重新部署了 Production |
| Job 长时间 `running` | Modal status/logs、Bridge callback、手动 reconcile |
| `delivery_unconfigured` | `BRIDGE_DELIVERY_TOKEN_SECRET` 缺失 |
| cleanup/RPC schema 错误 | 是否执行到 `0010`；执行 `notify pgrst, 'reload schema'` |
| cleanup `errorTotal > 0` | 查看稳定错误码，按运维流程调查后使用 operator redrive；用户 DELETE 不会自动 redrive |

排障时不要打印或复制以下内容到公开日志：

- Supabase service_role/secret key
- R2 Secret Access Key
- Bridge API Key
- 完整 delivery token
- 完整预签名 R2 URL
- Modal Token Secret

---

## 12. Stage 0 通过后的扩展顺序

### 12.1 Google 登录

注册 Google Cloud OAuth Client，配置 Supabase Google Provider；不需要修改业务代码。

### 12.2 Modal Bridge 视频/3D

设置：

```env
AIGC_VIDEO_PROVIDER=modal-bridge
AIGC_MODEL3D_PROVIDER=modal-bridge
```

使用 Seedance/Tripo 等 ComfyUI API 节点时，Modal Secret 还需：

```env
COMFY_API_KEY_COMFY_ORG=<comfy.org key>
```

在切换前先用真实 ComfyUI/Modal E2E 验证对应节点能够消费模板中的多参考图 data URI。

### 12.3 fal 视频/3D

保留默认 provider 时，在 Vercel 填：

```env
FAL_KEY=<fal key>
```

按 `.env.example` 需要时覆盖具体 endpoint。Provider 不会自动 fallback；切换会明确改变扣费方。

### 12.4 OpenRouter 图片

只有选择：

```env
AIGC_IMAGE_PROVIDER=openrouter
```

时才需要 `OPENROUTER_API_KEY` 和图片模型配置。

---

## 13. 最终上线 Checklist

### 身份与数据库

- [ ] GitHub OAuth App callback 指向 Supabase。
- [ ] Supabase Site URL/Redirect URL 使用稳定 Production origin。
- [ ] `0001→0010` 全部成功执行。
- [ ] PostgREST schema cache 已刷新。
- [ ] service_role key 只在 Vercel。

### R2

- [ ] Bucket private 且为 default jurisdiction。
- [ ] 运行时 Token 为 scoped Object Read & Write。
- [ ] Vercel 未保存临时 Admin Token。
- [ ] CORS 只允许实际 Production origin 的 GET/HEAD。

### Modal Bridge

- [ ] 插件版本支持 `aigc-r2`。
- [ ] Modal `/health` 成功。
- [ ] `AIGC_STUDIO_BASE_URL` 指向 Production。
- [ ] 三个 Z-Image 模型已在 Volume。
- [ ] Endpoint base 未错误包含 `-run.modal.run`。
- [ ] Bridge API Key 两端一致。
- [ ] Modal Secret 不含 R2/Supabase 长期凭据。

### Vercel

- [ ] `AIGC_IMAGE_PROVIDER=modal-bridge`。
- [ ] 所有必填 env 已配置到 Production。
- [ ] 修改 env 后已 Redeploy。
- [ ] Deployment Protection 已关闭或正确配置 bypass。
- [ ] 两个 Cron 已出现在 Vercel Cron Jobs 页面。
- [ ] 缺失/错误 `CRON_SECRET` 调用返回 401。

### E2E

- [ ] GitHub 登录成功。
- [ ] 标准图片 Job succeeded。
- [ ] 作品库展示/下载正常。
- [ ] 删除后立即隐藏。
- [ ] cleanup 后 DB/R2 物理删除完成。

