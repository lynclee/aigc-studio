# AIGC Studio

AIGC Studio 是给设计师和美术同学使用的 AIGC 作品网站。使用者用 **GitHub 登录（优先）** 或 **Google / Gmail 登录**，选择图片、3D、视频入口，填写文字描述，然后在个人作品库查看云端生成的结果。

> 术语说明：
> - **AIGC**：用 AI 生成图片、3D 模型、视频等内容。
> - **prompt**：给 AI 的文字描述，例如“赛博朋克风格的狐狸角色设定图”。
> - **工作流**：预设好的创作方法；使用者只选名称，不需要接触底层工具。

## 产品主流程

```text
GitHub 登录（优先）/ Google-Gmail 登录
  → 图片 / 3D / 视频三入口
  → 选择预设工作流并填写 prompt
  → 云端服务器后台生成
  → 网站检查任务状态
  → 完成作品进入个人作品库
```

提交后，任务记录会先写进数据库，再交给部署同学选定的云端生成服务。使用者重新打开网站时会检查自己的任务；Vercel Cron 每天做一次后台兜底检查。作品只有成功保存到 Cloudflare R2 后，才会出现在个人作品库。

## 角色分工

| 角色 | 负责什么 | 不需要做什么 |
|---|---|---|
| 部署 / 运营同学 | 配置 Supabase 登录、Vercel、R2、生成服务与后台检查 | 不把任何密钥发给普通用户 |
| 美术 / 设计使用同学 | 登录、选择入口和工作流、填写 prompt、查看作品 | 不安装底层生成工具，不配置后台参数 |

## 核心架构

```text
浏览器
  ├─ GitHub / Google 登录
  │    → Supabase Auth
  │    → /api/auth/callback
  └─ /portal 创作工作台
       ├─ 图片 → 部署者选定的图片服务
       ├─ 3D / 视频 → fal 或 Modal Bridge（部署者选）
       ├─ 任务状态 → Supabase
       └─ 个人作品库 → Cloudflare R2

Vercel Cron → 每天 03:30 检查未完成任务
```

## 第一部分：部署 / 运营

### 1. 配置 GitHub 与 Google / Gmail 登录

登录由 **Supabase Auth** 统一处理。GitHub 是页面第一入口；Google / Gmail 是备用入口，二者没有自动切换关系。

1. 在 Supabase 创建项目，打开 **Authentication → Providers**。
2. 启用 GitHub 与 Google 两个登录方式，并填入各自 OAuth 应用的 Client ID 与 Client Secret。
3. 在 Supabase 的 **URL Configuration** 中设置：
   - **Site URL**：稳定网站地址，例如 `https://studio.example.com`；
   - **Redirect URLs**：加入 `https://你的域名/api/auth/callback`。本地开发另加 `http://localhost:3000/api/auth/callback`。
4. GitHub 和 Google 的 OAuth 应用回调地址都填写 Supabase 给出的地址：
   `https://<你的 Supabase Project Ref>.supabase.co/auth/v1/callback`。
5. 在 Vercel 填写环境变量并重新部署。

> 同一个人若分别用 GitHub 和 Google 登录，Supabase 默认会把它们视为两个账号、两个作品库。团队应统一优先使用 GitHub；Google / Gmail 只作为备用登录方法。

官方说明：[GitHub 登录](https://supabase.com/docs/guides/auth/social-login/auth-github)、[Google 登录](https://supabase.com/docs/guides/auth/social-login/auth-google)、[回调地址](https://supabase.com/docs/guides/auth/redirect-urls)。

### 2. 环境变量

生产环境在 Vercel Project → Settings → Environment Variables 配置。本地可运行 `bash scripts/setup-env.sh` 写入 `.env.local`；脚本不会替你写线上变量。真实密钥不能提交到 git、截图或对话记录。

| 变量 | 用途 |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | 稳定网站地址，例如 `https://studio.example.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 登录所需的公开 anon key；不是 service role key |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅服务端访问任务与作品表的密钥 |
| `CRON_SECRET` | 每天后台检查任务的专用口令 |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | Cloudflare R2 私有作品库 |
| `AIGC_IMAGE_PROVIDER` | 图片服务开关：`modal-bridge` / `modal` / `openrouter` / `fal` / `comfyui` |
| `AIGC_VIDEO_PROVIDER` / `AIGC_MODEL3D_PROVIDER` | 视频 / 3D 服务开关：`fal`（默认）或 `modal-bridge` |
| `MODAL_BRIDGE_ENDPOINT_BASE` / `MODAL_BRIDGE_API_KEY` / `BRIDGE_DELIVERY_TOKEN_SECRET` | 选 `modal-bridge` 时填写（comfyui_modal_bridge 的 aigc-r2 交付）|
| `VERCEL_AUTOMATION_BYPASS_SECRET` | 可选；生产域名开 Deployment Protection 时,让 Bridge 回调内部 endpoint |
| `MODAL_ENDPOINT_BASE` / `MODAL_KEY` / `MODAL_SECRET` | 遗留 `modal` 图片服务时填写 |
| `OPENROUTER_API_KEY` / `OPENROUTER_IMAGE_MODEL` | 图片服务选择 OpenRouter 时填写 |
| `FAL_KEY` | 视频/3D 默认后端;图片服务选择 fal 时也使用 |
| `FAL_IMAGE_ENDPOINT` | 图片服务选择 fal 时填写 endpoint 路径 |
| `COMFYUI_BASE_URL` | 图片服务选择自建 ComfyUI 时填写服务地址 |
| `COMFY_ORG_API_KEY` | 工作流含 ComfyUI 付费 API 节点时填写；只在服务端传给 ComfyUI（Bridge 侧对应 Modal Secret 的 `COMFY_API_KEY_COMFY_ORG`）|

`AIGC_IMAGE_PROVIDER` 是部署者的快速切换开关。当前推荐顺序是 **OpenRouter → fal**，但它不是自动备用：切换后要重新部署，并保留旧服务的配置直到旧任务全部结束。

### 3. 数据库、文件库与生成服务

**新建数据库**在 Supabase SQL Editor 依次执行：

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

当前流程使用 `aigc_jobs`、`aigc_generations`、`aigc_assets` 三张表，以 Supabase 登录用户的 `user_id` 做作品归属;`0004` 增加上传台账，`0005-0006` 增加并加固原子 finalize RPC，`0007-0008` 固定并强制 Job workflow snapshot，`0009` 增加原子作品 tombstone 与 fenced R2 删除队列，`0010` 增加仅运维可用的死信重驱动、不可变审计与聚合 backlog。**已有旧版数据库不要重新执行历史 migration**；先备份，只补执行未跑过的 migration，具体滚动顺序和上线门禁见 `docs/HANDOFF.md`。

Cloudflare R2 是正式作品库。生成服务返回的文件会先安全地存入 R2，再进入个人作品库。图片可选 Modal、OpenRouter、fal 或自建 ComfyUI；3D 与视频使用 fal。普通使用者不会看到、更不能选择这些服务。

### 4. 上线检查

1. 配好 Supabase 的 GitHub / Google 登录和回调地址。
2. 在 Vercel 填好环境变量，特别是 `NEXT_PUBLIC_SITE_URL`、两项 Supabase key、R2 与 `CRON_SECRET`。
3. 在全新 Supabase 按顺序执行 `0001`→`0010`；旧库按 `docs/HANDOFF.md` 的滚动顺序升级。
4. 确认 `vercel.json` 有两个适配 Vercel Hobby 的每日 Cron：`03:30 /api/jobs/reconcile` 与 `04:00 /api/assets/cleanup`。
5. 如果 Vercel 开启了 Deployment Protection，确认 OAuth 外部回调不会被它拦住。
6. 打开网站，依次测试 GitHub 登录、Google / Gmail 登录、任务提交和个人作品库。

### 主要 API

| 路由 | 说明 |
|---|---|
| `GET /api/auth/github/login` | 开始 GitHub 登录 |
| `GET /api/auth/google/login` | 开始 Google / Gmail 登录 |
| `GET /api/auth/callback` | 完成 Supabase 登录并进入作品门户 |
| `POST /api/auth/logout` | 退出登录 |
| `POST /api/generate/image` / `model3d` / `video` | 提交生成任务 |
| `GET /api/jobs` / `GET /api/jobs/[id]` | 读取当前用户自己的任务与状态 |
| `GET /api/library` | 读取当前用户自己的个人作品库 |
| `DELETE /api/library/[id]` | owner-only 隐藏作品并把 R2 资产送入 fenced 删除队列 |

### 安全边界

- 用户身份只从 Supabase Auth 的服务端会话读取；浏览器不能指定作品属于谁。
- 任务、取消和作品库查询都按当前会话的 `user_id` 过滤。
- `SUPABASE_SERVICE_ROLE_KEY`、R2、生成服务与 `CRON_SECRET` 只在服务端使用。
- R2 bucket 保持私有；浏览器只取得短期访问链接。
- 每个用户最多同时 3 个排队 / 生成中任务，60 秒最多提交 10 个任务。

## 第二部分：美术 / 设计使用

### 怎么登录和使用

1. 打开部署同学给的网站地址。
2. 优先点 **使用 GitHub 登录**；没有 GitHub 或团队另有规定时，点 **使用 Google / Gmail 登录**。
3. 进入图片、3D 或视频入口，选择预设工作流，填写 prompt。
4. 在任务列表等待状态变化；云端服务器会在后台生成。
5. 完成后到个人作品库查看、下载或继续讨论作品。

| 状态 | 含义 |
|---|---|
| 排队中 | 已提交，等待云端服务器处理 |
| 生成中 | 云端服务器正在生成 |
| 已完成 | 作品已保存到个人作品库 |
| 失败 | 保存截图、入口类型、prompt 和时间，交给部署 / 运营同学排查 |

使用同学不需要安装或打开任何底层工具，也不需要知道服务商、密钥或后台配置。

截图和验收材料统一放在：`/workspace/documents/screenshot`。
