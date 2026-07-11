# HANDOFF — aigc-studio 交接总结（2026-07-10）

写给在本仓库继续工作的 Claude Code / Codex 会话。当前仓库已有多名工作者协作，接手时先看 `git status`，只改自己负责的文件，不要回退他人代码。

## 一、当前状态

- 项目定位：给设计师和美术同学使用的 AIGC 创作网站。
- 主流程：飞书登录 → 图片 / 3D / 视频三入口 → 选择预设工作流 → 输入 prompt → 云端服务器后台生成 → 网站和后台定时检查状态 → 个人作品库。
- 提交生成后，用户可以关闭页面；Vercel Cron 每 5 分钟调用后台检查接口，继续同步未完成任务。任务完成并成功保存到 R2 后，会进入个人作品库。
- 普通用户只使用门户提交和查看作品，不接触底层生成工具或后台迁移参数。
- 迁移说明：旧上传口令 / `target_open_id` 已退出主流程；历史 gallery 数据不会自动回流，若需要保留由部署 / 运营同学做一次性迁移。
- 截图、验收图片、页面证据统一放在 `/workspace/documents/screenshot`。

## 二、关键文件

| 文件 | 职责 |
|---|---|
| `app/page.tsx` | 飞书登录页；有 session 时跳转 `/portal` |
| `app/portal/page.tsx` | 保护页面入口，读取 session 后渲染工作台 |
| `components/portal-workbench.tsx` | 图片 / 3D / 视频三入口、任务列表、个人作品库 UI |
| `app/api/auth/lark/login/route.ts` | 生成 OAuth state 并跳转飞书授权页 |
| `app/api/auth/lark/callback/route.ts` | 处理飞书回调，写入签名 cookie |
| `app/api/auth/logout/route.ts` | 登出并清 cookie |
| `app/api/generate/image/route.ts` | 提交图片生成任务 |
| `app/api/generate/model3d/route.ts` | 提交 3D 生成任务 |
| `app/api/generate/video/route.ts` | 提交视频生成任务 |
| `app/api/jobs/route.ts` | 当前用户任务列表，并顺手同步状态 |
| `app/api/jobs/[id]/route.ts` | 查询 / 取消当前用户自己的任务 |
| `app/api/jobs/[id]/cancel/route.ts` | 取消当前用户自己的任务 |
| `app/api/jobs/reconcile/route.ts` | Vercel Cron 后台检查未完成任务，需要 `CRON_SECRET` |
| `app/api/library/route.ts` | 返回当前用户个人作品库 |
| `lib/jobs/*` | 任务创建、限流、状态更新、结果落库、provider 分发、后台 reconciliation |
| `lib/engines/modal-image.ts` | Modal 图片生成 provider，含 cancel 调用 |
| `lib/engines/fal-image.ts` | fal.ai 图片 provider；endpoint 由环境变量配置，取消当前返回不支持 |
| `lib/engines/openrouter-image.ts` | OpenRouter 图片 provider；同步取图后直接写入 R2 |
| `lib/engines/comfyui-image.ts` | 自建 ComfyUI 图片 provider；向 `/prompt` 提交 API 工作流、查状态、下载结果后写入 R2；付费节点密钥写入 `extra_data` |
| `lib/engines/fal-http.ts` | fal.ai 3D / 视频 provider；endpoint 可由环境变量覆盖，取消当前返回不支持 |
| `lib/workflows/*` | 图片工作流注册与模板渲染 |
| `lib/assets/r2-store.ts` | provider 结果下载、安全检查并写入 R2 |
| `lib/assets/r2-direct.ts` | OpenRouter / ComfyUI 返回的图片字节直接写入 R2 |
| `lib/generations/serialize.ts` | 资产序列化和 R2 签名 URL |
| `supabase/migrations/0001_gallery_items.sql` | 历史兼容表，非当前主流程 |
| `supabase/migrations/0002_aigc_jobs_generations_assets.sql` | 当前主流程数据库表 |
| `vercel.json` | Vercel Cron：每 5 分钟访问 `/api/jobs/reconcile` |

## 三、当前架构事实

### 认证

- 飞书 OAuth 登录使用 `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_REDIRECT_URI`。
- 登录成功后写入 HMAC 签名 cookie，签名密钥是 `SESSION_SECRET`。
- 会话 payload 包含 `open_id`、`name`、`avatar`、`exp`；所有权判断只信 session 里的 `open_id`。

### 生成任务

- 图片由 `AIGC_IMAGE_PROVIDER` 在部署时选择：`modal-image`、`openrouter-image`、`fal-image` 或 `comfyui-image`。普通用户不选择 provider。
  - `modal`（默认）：`MODAL_ENDPOINT_BASE`、`MODAL_KEY`、`MODAL_SECRET`，支持真实服务端取消。
  - `openrouter`：`OPENROUTER_API_KEY`、`OPENROUTER_IMAGE_MODEL`；OpenRouter 在提交时直接返回图片，服务端先写入 R2 再完成任务，不支持取消。
  - `fal`：`FAL_KEY` 加 `FAL_IMAGE_ENDPOINT`（可由标准 / 细节 endpoint 覆盖），不支持取消。
  - `comfyui`：`COMFYUI_BASE_URL` 指向自建 ComfyUI。当前图片模板以 API 格式提交，Comfy 服务需具备模板所用节点和模型；工作流用了 GPT Image 等付费 API 节点时，设置带 API 积分的 `COMFY_ORG_API_KEY`，adapter 会提交 `{ extra_data: { api_key_comfy_org: ... } }`，收费节点从这个 ComfyUI 账号扣费。完成后从 `/view` 下载到 R2，不支持取消。
- 3D 走 `fal-model3d`，需要 `FAL_KEY`；`FAL_MODEL3D_STANDARD_ENDPOINT`、`FAL_MODEL3D_GAME_ASSET_ENDPOINT` 可覆盖默认 endpoint，当前不支持取消。
- 视频走 `fal-video`，需要 `FAL_KEY`；`FAL_VIDEO_ENDPOINT` 可覆盖默认 endpoint，当前不支持取消。
- 前端提交 `{ prompt, workflow, mediaType }`，服务端创建 `aigc_jobs` 后调用对应 provider。
- `aigc_jobs.provider` 是已提交任务的事实来源。更换 `AIGC_IMAGE_PROVIDER` 后不能用新配置重写旧任务的状态检查；`lib/jobs/providers.ts` 已按已存 provider 分发。
- 部署侧推荐顺序是 Modal → OpenRouter → fal → ComfyUI，不是自动 fallback。快速切换时只在 Vercel 修改 `AIGC_IMAGE_PROVIDER` 并重新部署；切换期间保留旧服务的地址与密钥，直到该服务的 active jobs 全部结束。job 不保存密钥，仍需用对应服务的现有部署变量查询状态。
- 服务端限制每个用户最多 3 个 queued / running 任务，60 秒内最多 10 个任务，避免误提交大量任务。
- 用户查询 `/api/jobs` 或 `/api/jobs/[id]` 时会同步 provider 状态；用户关页面后，Vercel Cron 仍会继续检查。

### Vercel Cron

- `vercel.json` 当前配置：`/api/jobs/reconcile`，计划为 `*/5 * * * *`。
- `/api/jobs/reconcile` 要求 `Authorization: Bearer $CRON_SECRET`；`CRON_SECRET` 是后台定时检查专用口令，只配置在 Vercel 服务端环境变量中。
- 接口每次最多取 50 个 active jobs，逐个调用 `reconcileJob`。
- 如果 provider 成功但结果保存到 R2 失败，`reconcileJob` 会将任务标为 failed，而不是把 provider 临时链接当作完成作品。OpenRouter 与 ComfyUI 在 adapter 内先写入 R2，再由同一任务入库路径登记 assets。

### 作品库与 R2

- `/api/library` 只返回当前 session `open_id` 的作品。
- 资产必须保存到 Cloudflare R2 才算完成；保存成功时返回 R2 预签名 URL。
- `lib/assets/r2-store.ts` 会校验 provider 输出 URL：必须是 HTTPS、不能带用户名密码、host 必须在可信列表、DNS 不能指向内网地址，并检查文件大小。
- 默认可信域覆盖 fal / Modal 常见域名和 `MODAL_ENDPOINT_BASE` 的 host。只有自定义 Modal / fal 输出文件域名时才配置 `AIGC_ASSET_HOST_ALLOWLIST`。OpenRouter / ComfyUI 的图片由服务端直接存入 R2，不依赖 URL allowlist。
- UI 当前能展示图片、视频和 3D 模型下载卡片。

## 四、部署和环境变量

Vercel 环境变量先配置以下基础项，再按 `AIGC_IMAGE_PROVIDER` 配置**一种**图片服务：

```text
LARK_APP_ID
LARK_APP_SECRET
LARK_REDIRECT_URI
SESSION_SECRET
CRON_SECRET
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
FAL_KEY
```

图片服务变量：

```text
AIGC_IMAGE_PROVIDER=modal | openrouter | fal | comfyui

# modal
MODAL_ENDPOINT_BASE
MODAL_KEY
MODAL_SECRET

# openrouter
OPENROUTER_API_KEY
OPENROUTER_IMAGE_MODEL

# fal
FAL_IMAGE_ENDPOINT

# 自建 comfyui
COMFYUI_BASE_URL
# 付费 API 节点才需要
COMFY_ORG_API_KEY
```

可选变量：

```text
FAL_IMAGE_STANDARD_ENDPOINT
FAL_IMAGE_DETAIL_ENDPOINT
FAL_MODEL3D_STANDARD_ENDPOINT
FAL_MODEL3D_GAME_ASSET_ENDPOINT
FAL_VIDEO_ENDPOINT
OPENROUTER_IMAGE_STANDARD_MODEL
OPENROUTER_IMAGE_DETAIL_MODEL
OPENROUTER_IMAGE_RESOLUTION
OPENROUTER_IMAGE_ASPECT_RATIO
OPENROUTER_IMAGE_QUALITY
OPENROUTER_IMAGE_OUTPUT_FORMAT
OPENROUTER_IMAGE_BACKGROUND
AIGC_ASSET_HOST_ALLOWLIST
```

`SESSION_SECRET` 和 `CRON_SECRET` 都用长随机串，例如 `openssl rand -hex 32`。`CRON_SECRET` 只服务 `/api/jobs/reconcile`，不是普通用户、前端或美术同学需要知道的口令。

`AIGC_ASSET_HOST_ALLOWLIST` 只在自定义 Modal / fal 输出文件域名时填写；默认 fal / Modal 常见域已覆盖。多个域名用英文逗号分隔，不要写协议头。

`scripts/setup-env.sh` 用于协助写入本地 `.env.local`，会提示 `AIGC_ASSET_HOST_ALLOWLIST`，并为 `SESSION_SECRET` 和 `CRON_SECRET` 提供隐藏输入；直接回车时会自动生成随机值。脚本只负责本地文件，不会替你配置线上环境；部署 / 运营同学仍需按上面的清单把同一组变量填进 Vercel。不要修改或提交真实密钥。

`~/.modal.toml` 只用于部署者本机 Modal CLI 登录和部署，不能复制到 Vercel，也不能写入仓库。

Supabase 需要执行：

```text
supabase/migrations/0001_gallery_items.sql
supabase/migrations/0002_aigc_jobs_generations_assets.sql
```

`0001_gallery_items.sql` 是历史兼容；当前代码主读写 `0002` 创建的三张表。

## 五、待办与风险

1. **真实 provider 联调。** 需要分别用选择后的图片服务（Modal / OpenRouter / fal / ComfyUI）和 fal.ai 的 3D、视频配置验证完整链路，以及页面关闭后由 Cron 完成入库的路径。OpenRouter 提交可能较久；ComfyUI 自建地址必须能被 Vercel 安全访问。
2. **Vercel Cron 验收。** 部署后确认 Vercel 已按 `vercel.json` 注册 `/api/jobs/reconcile`，并确认请求会带正确的 `CRON_SECRET`。如果没有带 Authorization，需要按 Vercel 项目配置补齐。
3. **R2 是完成条件。** R2 未配置、权限不足、CORS / bucket 设置错误、provider 输出域名不在 allowlist、下载或上传失败，都会让任务失败。排查时优先看任务 error、Vercel 日志和 R2 权限。
4. **迁移风险。** 历史 `gallery_items` 不会自动回流到新作品库。若业务必须保留旧数据，由部署 / 运营同学安排一次性迁移，迁移前先备份并确认归属人映射。
5. **错误文案整理。** provider 返回缺环境变量、额度不足、请求格式错误时，前端可继续转成更友好的中文提示。
6. **3D 预览增强。** 当前 3D 作品以缩略图 + 下载为主，如需要在线预览，可再引入轻量 GLB viewer。

## 六、文档维护

- 用户飞书部署手册：`https://my.feishu.cn/docx/X9JddcFVpoLuOxxJAHCcqiClnSe`。
- 标题必须保持：`从零上线一个自己的 AIGC 作品网站：给设计师和美术同学的部署手册`。
- 面向设计和美术读者，少术语；术语第一次出现要用通俗解释。
- 手册按两大部分组织：第一部分部署 / 运营同学；第二部分美术 / 设计使用同学。
- 保留架构图、流程图和截图位置；截图目录统一写 `/workspace/documents/screenshot`。
- 不面向普通使用者讲底层工具、后台上传口令或后台迁移参数。

## 七、工作纪律

- 先读 `CLAUDE.md` 和本文件，再动手。
- 只改用户要求范围；如果工作区已有他人改动，不要回退。
- 密钥不进 git、不进截图、不进对话。
- 文档改动后至少检查 Markdown 结构；代码改动后跑 `npm run typecheck`，必要时跑 `npm run build`。
