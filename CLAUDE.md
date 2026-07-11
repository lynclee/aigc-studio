# CLAUDE.md

本文件为 Claude Code / Codex 在 `aigc-studio` 仓库工作时提供稳定架构指引。

> 项目：**AIGC Studio** — 面向设计师和美术同学的 AIGC 创作网站。用户用飞书登录，在图片 / 3D / 视频三入口选择预设工作流，输入 prompt，由云端服务器后台生成，随后在个人作品库查看结果。页面关闭不会停止后台检查；Vercel Cron 每 5 分钟继续同步未完成任务。
> 普通用户只使用门户提交和查看作品；旧后台上传流程已退出主流程，只在迁移说明中出现。

**新会话第一步：先读 `docs/HANDOFF.md`。** 该文件记录当前状态、交接要点和后续任务；本文件只放稳定架构事实。

## 语言

始终使用简体中文与用户对话。

## 命令

```bash
npm run dev        # 开发服务器
npm run build      # 生产构建
npm run typecheck  # tsc --noEmit
npm run start      # 启动生产服务
```

代码在缺少生产密钥时应尽量优雅降级，避免在模块加载阶段读取外部服务并抛错。涉及外部请求的路由应在运行时返回清晰错误。

## 当前产品主流程

```text
飞书登录
  → 图片 / 3D / 视频三入口
  → 选择预设工作流
  → 输入 prompt（文字描述）
  → 云端服务器后台生成
  → 网站轮询 + Vercel Cron 后台检查
  → 完成作品进入个人作品库
```

## 路由全景

| 路由 | 职责 |
|---|---|
| `/` | 登录页；有会话则跳转 `/portal`；`?error=` 只渲染固定文案映射 |
| `/portal` | 创作工作台：图片 / 3D / 视频入口、任务状态、个人作品库 |
| `/api/auth/lark/login` | 生成随机 state cookie，302 到飞书授权页 |
| `/api/auth/lark/callback` | 校验 state，code 换 token，获取 user_info，写入 session，跳转 `/portal` |
| `/api/auth/logout` | 清会话 cookie |
| `/api/generate/image` | 登录后提交图片生成任务，走部署者选定的 Modal / OpenRouter / fal.ai / ComfyUI 图片服务 |
| `/api/generate/model3d` | 登录后提交 3D 生成任务，走 fal.ai 3D 服务 |
| `/api/generate/video` | 登录后提交视频生成任务，走 fal.ai 视频服务 |
| `/api/jobs` | GET 当前用户任务列表，并对每条任务执行状态同步 |
| `/api/jobs/[id]` | GET 查询当前用户自己的任务；POST 取消任务 |
| `/api/jobs/[id]/cancel` | 取消当前用户自己的任务 |
| `/api/jobs/reconcile` | Vercel Cron 后台检查未完成任务；必须带 `Authorization: Bearer $CRON_SECRET` |
| `/api/library` | 读取当前用户自己的作品库 |

## 认证与会话

- 飞书 OAuth 2.0：authorize → token → user_info，默认 scope 为 `contact:user.base:readonly`。
- 会话是 HMAC-SHA256 签名 cookie：payload `{open_id,name,avatar,exp}`，7 天有效，HttpOnly + Secure + SameSite=Lax。
- `open_id` 是用户和作品归属的主键；不要把用户可控字段当作所有权依据。

## 数据层

- 当前主流程表：
  - `aigc_jobs`：任务记录，含用户、类型、状态、provider、provider_job_id、请求和 provider 响应。
  - `aigc_generations`：生成结果，一条成功任务对应一条结果。
  - `aigc_assets`：结果资产，记录图片、视频、模型文件的 R2 key 和必要元数据。
- 历史兼容表：`gallery_items` 仅保留给旧数据迁移，不是当前主流程。
- 本项目不用 Supabase Auth。服务端 route handler 用 `SUPABASE_SERVICE_ROLE_KEY` 访问数据库，并必须按 `user_open_id` 做所有权过滤。
- RLS 开启但不提供 anon / authenticated policy；不要引入浏览器端 anon key 直连读写。

## 生成服务和后台检查

| 类型 | 前端入口 | 后端 provider | 关键环境变量 | 取消能力 |
|---|---|---|---|---|
| 图片 | `/api/generate/image` | `modal-image` / `openrouter-image` / `fal-image` / `comfyui-image` | `AIGC_IMAGE_PROVIDER` 决定，另填对应服务变量 | 只有 Modal 支持真实服务端取消 |
| 3D | `/api/generate/model3d` | `fal-model3d` | `FAL_KEY`；可用 `FAL_MODEL3D_*_ENDPOINT` 覆盖 endpoint | 当前不支持；不要做“假取消” |
| 视频 | `/api/generate/video` | `fal-video` | `FAL_KEY`；可用 `FAL_VIDEO_ENDPOINT` 覆盖 endpoint | 当前不支持；不要做“假取消” |

图片工作流定义在 `lib/workflows/image-registry.ts` 和 `lib/workflows/templates/`。`AIGC_IMAGE_PROVIDER` 只由部署者设置，普通用户不应看到服务选择。fal 图片 endpoint 定义在环境变量；3D / 视频的 fal.ai endpoint 默认值在 `lib/engines/fal-http.ts`，可由环境变量覆盖。ComfyUI 接入的是自建服务的 `/prompt`、`/history/:id`、`/view` API；`COMFY_ORG_API_KEY` 是部署者带 API 积分的 ComfyUI 账号密钥，adapter 会把它放入 `/prompt` body 的 `extra_data.api_key_comfy_org`，供 GPT Image 等付费 API 节点扣费使用，绝不作为浏览器变量或普通请求 header 发送。

任务状态检查必须按已存的 `aigc_jobs.provider` 分发，不能用当前环境变量重新推断。部署侧顺序是 Modal → OpenRouter → fal → ComfyUI，但不是自动 fallback；快速切换只需修改 Vercel 的 `AIGC_IMAGE_PROVIDER` 并重新部署。之前已提交的任务仍会由原服务完成检查。
切换期间必须保留旧服务的地址与密钥，直到该服务的 active jobs 全部结束；`provider` 记录的是分发依据，不会保存密钥。

`vercel.json` 配置 Vercel Cron：`/api/jobs/reconcile` 每 5 分钟执行一次。该接口读取最多 50 个未完成任务，轮询 provider 状态；成功后必须把结果保存到 R2 并落库，失败则把任务标记为 failed。`CRON_SECRET` 是后台定时检查专用口令，只应配置在 Vercel 服务端环境变量中。

`~/.modal.toml` 只用于部署者本机 Modal CLI 登录和部署，不能复制到 Vercel，也不能写进仓库。

## R2 资产流

1. Modal / fal 返回结果 URL；`materializeCompletedJob` 调用 `storeProviderAssetsInR2` 下载并写入 R2。
2. OpenRouter 返回图片字节，`openrouter-image` 直接写入 R2；ComfyUI 完成后由 `comfyui-image` 下载结果并直接写入 R2。
3. 只有 R2 保存成功，任务才算完成并写入 `aigc_assets`。
4. R2 未配置、下载失败、上传失败、输出域名未通过安全检查时，任务应转为 failed；不要回退到临时 provider 链接当作完成结果。
5. `/api/library` 只返回当前登录用户的作品，并为 R2 对象生成短期签名 URL。

输出域名安全检查在 `lib/assets/r2-store.ts`：默认允许 fal / Modal 常见域名和 `MODAL_ENDPOINT_BASE` 的 host；只有自定义 Modal 输出文件域名时才填写 `AIGC_ASSET_HOST_ALLOWLIST`，多个域名用英文逗号分隔。下载前必须校验 HTTPS、无 URL 凭据、DNS 不指向内网地址和文件大小上限。

## 输入边界与限流

- 普通用户只能从图片、3D、视频三种类型中选择。
- 工作流必须来自服务端允许的预设列表；不要接受任意工作流 ID。
- prompt 不能为空，最长 4000 字符。
- 单个用户同时最多 3 个 queued / running 任务；60 秒内最多提交 10 个任务。

## 环境变量

部署到 Vercel 时必须配置：

`LARK_APP_ID` `LARK_APP_SECRET` `LARK_REDIRECT_URI` `SESSION_SECRET` `CRON_SECRET`
`NEXT_PUBLIC_SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY`
`R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET`
`AIGC_IMAGE_PROVIDER`
`MODAL_ENDPOINT_BASE` `MODAL_KEY` `MODAL_SECRET`（图片服务为 `modal`）
`OPENROUTER_API_KEY` `OPENROUTER_IMAGE_MODEL`（图片服务为 `openrouter`）
`COMFYUI_BASE_URL`（图片服务为 `comfyui`；付费 API 节点还需要 `COMFY_ORG_API_KEY`）
`FAL_KEY`（3D / 视频必填；图片服务为 `fal` 时还需要 `FAL_IMAGE_ENDPOINT`）

可选：`FAL_IMAGE_STANDARD_ENDPOINT` `FAL_IMAGE_DETAIL_ENDPOINT`、`FAL_MODEL3D_*_ENDPOINT`、`FAL_VIDEO_ENDPOINT`、`OPENROUTER_IMAGE_STANDARD_MODEL` `OPENROUTER_IMAGE_DETAIL_MODEL` 与输出样式变量、`COMFY_ORG_API_KEY`（仅 ComfyUI 工作流有付费 API 节点时）、`AIGC_ASSET_HOST_ALLOWLIST`（仅自定义 Modal / fal 输出文件域名时填写）。完整注释见 `.env.example`。

`SESSION_SECRET` 和 `CRON_SECRET` 都使用长随机串，例如 `openssl rand -hex 32`。`SESSION_SECRET` 签登录 cookie；`CRON_SECRET` 只给后台定时检查接口使用。

## 安全不变量（改动必须维持）

1. 普通用户不看到底层生成工具、后台迁移参数或服务端密钥。
2. 所有任务查询、取消、作品库读取都必须按 session 的 `open_id` 限定。
3. service role key、R2 凭据、Modal / fal.ai / OpenRouter / ComfyUI 凭据、`CRON_SECRET` 只能在服务端使用，不能进入客户端 bundle。
4. R2 bucket 保持私有；浏览器只拿短期签名 URL。
5. 作品必须保存进 R2 才能标记完成；R2 上传失败必须让任务失败。
6. Provider 输出 URL 必须经过 allowlist、HTTPS、DNS 与大小检查。
7. 只有图片服务选 Modal 时，取消才是真实服务端取消；fal / OpenRouter / ComfyUI、3D / 视频不支持时不要在 UI 上承诺停止云端任务。
8. 密钥不进 git、不进截图、不进对话；push 前先核对 `git status`。

## 工作流程

- 只改用户要求的范围。当前仓库可能有其他工作者的未提交改动，不要回退他人代码。
- 文档改动后同步更新 README、CLAUDE、docs/HANDOFF 以及用户指定的飞书文档。
- 截图、验收图片、页面证据统一放在 `/workspace/documents/screenshot`。
- 代码改动后至少跑 `npm run typecheck`，重要改动再跑 `npm run build`。
- UI 改动后按横屏 1920×1080 和竖屏 1080×1920 各验证一次。
- 给用户的飞书部署手册当前文档：`https://my.feishu.cn/docx/X9JddcFVpoLuOxxJAHCcqiClnSe`，标题保持“从零上线一个自己的 AIGC 作品网站：给设计师和美术同学的部署手册”。
