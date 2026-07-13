# CLAUDE.md

本文件为 Claude Code / Codex 在 `aigc-studio` 仓库工作时提供稳定架构指引。

> 项目：**AIGC Studio**。面向设计师和美术同学的 AIGC 创作网站。用户优先用 GitHub、备用用 Google / Gmail 登录，选择图片 / 3D / 视频预设，输入 prompt，由云端服务器后台生成，最后在个人作品库查看结果。

**新会话第一步：先读 `docs/HANDOFF.md`。**

## 命令

```bash
npm run dev
npm run build
npm run typecheck
npm run test    # vitest:token/asset-policy/input 等纯逻辑单测
npm run start
```

代码在缺少生产密钥时要优雅降级，不能在模块加载阶段因外部服务配置缺失而崩溃。

## 主流程

```text
GitHub 登录（优先）/ Google-Gmail 登录
  → 图片 / 3D / 视频
  → 预设工作流 + prompt
  → 云端服务器后台生成
  → 网站查询 + Vercel Cron 兜底检查
  → 个人作品库
```

## 路由

| 路由 | 职责 |
|---|---|
| `/` | 登录页；已有会话时跳转 `/portal` |
| `/portal` | 创作工作台、任务状态、个人作品库 |
| `/api/auth/github/login` | 开始 GitHub OAuth |
| `/api/auth/google/login` | 开始 Google OAuth |
| `/api/auth/callback` | 交换 Supabase OAuth code，写入登录会话 |
| `/api/auth/logout` | 退出 Supabase 会话 |
| `/api/generate/image` | 部署者选定的图片服务 |
| `/api/generate/model3d` / `/api/generate/video` | 部署者选定的 3D / 视频服务（fal 或 modal-bridge）|
| `/api/internal/asset-intake` / `/api/internal/job-complete` | aigc-r2 内部 endpoint，供 Modal Bridge 回调；**机器对机器，不走 getSession**，认 `delivery_token` + `x-vercel-protection-bypass` |
| `/api/jobs` / `/api/jobs/[id]` | 当前用户任务、状态同步与取消 |
| `/api/jobs/reconcile` | Vercel Cron 后台检查 + R2 孤儿清理，需要 `CRON_SECRET` |
| `/api/assets/cleanup` | Vercel Cron 异步清理用户删除后的 R2 资产队列，返回聚合 backlog，需要 `CRON_SECRET` |
| `/api/library` | 当前用户个人作品库 |
| `DELETE /api/library/[id]` | owner-only 隐藏作品并把 R2 资产送入 fenced 删除队列 |

## 认证与数据归属

- 登录使用 **Supabase Auth**。GitHub 是页面第一入口，Google / Gmail 是备用入口；两者不会自动合并或自动切换。根目录 `proxy.ts` 会在页面渲染前刷新 cookie；不要删除它，也不要改用已废弃的 `middleware.ts`。
- 服务端 `getSession()` 通过 Supabase Auth cookie 的 `getUser()` 验证身份。所有权只信当前会话的 `userId`，绝不信浏览器传来的用户 ID。登出只退出当前设备会话。
- 数据表用 `user_id` 保存归属。已有旧数据库时执行 `0003_rename_legacy_user_columns.sql`。
- 业务读写仍在服务端使用 `SUPABASE_SERVICE_ROLE_KEY`；不要给浏览器直连业务表的权限。RLS 保持开启且不添加 anon / authenticated policy。

## 生成服务和完成条件

| 类型 | provider | 配置 |
|---|---|---|
| 图片 | `modal-bridge` / `modal-image` / `openrouter-image` / `fal-image` / `comfyui-image` | `AIGC_IMAGE_PROVIDER` 选择 |
| 3D | `modal-bridge` / `fal-model3d` | `AIGC_MODEL3D_PROVIDER`（默认 fal）|
| 视频 | `modal-bridge` / `fal-video` | `AIGC_VIDEO_PROVIDER`（默认 fal）|

- provider 由部署者选择，用户不能选择。优先级 Modal → OpenRouter → fal，是部署建议而非自动 fallback。
- **`modal-bridge`**：通过 `comfyui_modal_bridge` 插件的 aigc-r2 交付模式，图片/视频/3D 通用。Worker 直传 R2、push 回调落库;R2 长期 key 只在 Vercel。视频/3D 工作流(seedance/tripo 等)在 `lib/workflows/registry.ts` 注册;API 节点款跑 CPU worker、需 Modal Secret 里的 `COMFY_API_KEY_COMFY_ORG`。`modal-image` 是遗留自研 worker,仅兼容旧任务。
- ComfyUI 接入的是自建服务的 `/prompt`、`/history/:id`、`/view`。若 API 工作流使用 GPT Image 等付费节点，`COMFY_ORG_API_KEY` 只在服务端随 `/prompt` 的 `extra_data.api_key_comfy_org` 传给 ComfyUI，不会进入浏览器。
- 任务检查要按已存的 `aigc_jobs.provider` 分发；切换图片服务后，保留旧服务配置直到旧任务全部结束。
- 只有结果成功保存到私有 R2、写入 `aigc_assets` 后，任务才能标为完成。不要把 provider 临时链接当最终作品。
- `vercel.json` 当前每天运行两条 Vercel Hobby Cron：`03:30 /api/jobs/reconcile`，`04:00 /api/assets/cleanup`。

## 环境变量

基础配置：

```text
NEXT_PUBLIC_SITE_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
CRON_SECRET
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
FAL_KEY
```

provider 按选择补充:
- Modal Bridge(`modal-bridge`,含视频/3D):`MODAL_BRIDGE_ENDPOINT_BASE`、`MODAL_BRIDGE_API_KEY`、`BRIDGE_DELIVERY_TOKEN_SECRET`;生产域名开 Deployment Protection 时加 `VERCEL_AUTOMATION_BYPASS_SECRET`。视频/3D 走 Bridge 再设 `AIGC_VIDEO_PROVIDER` / `AIGC_MODEL3D_PROVIDER=modal-bridge`。
- 旧 Modal 用 `MODAL_*`;OpenRouter 用 `OPENROUTER_API_KEY` 和 `OPENROUTER_IMAGE_MODEL`;fal 用 `FAL_IMAGE_ENDPOINT`;自建 ComfyUI 用 `COMFYUI_BASE_URL`,付费节点再加 `COMFY_ORG_API_KEY`。
- R2 长期 key 只在 Vercel;Modal Secret 侧只放 `BRIDGE_API_KEY` + (API 节点)`COMFY_API_KEY_COMFY_ORG`,绝不含 R2 密钥。完整清单见 `.env.example`。

Supabase 后台必须配置 GitHub 和 Google provider：两个第三方 OAuth 应用的回调地址都是 `https://<project-ref>.supabase.co/auth/v1/callback`；Supabase 的 Site URL / Redirect URLs 要包含网站的 `/api/auth/callback`。

## 安全不变量

1. 普通用户不看到服务端密钥、底层生成工具或后台参数。
2. 所有任务、取消、作品库读取必须按 Supabase 会话 `userId` 限定。
3. service role、R2、provider、ComfyUI 付费节点和 Cron 密钥只能在服务端。
4. R2 私有，浏览器只取短期签名链接。
5. 任务完成必须以 R2 保存成功为准。
6. provider 输出 URL 继续执行 HTTPS、允许域名、DNS、大小检查。
7. aigc-r2 内部 endpoint（asset-intake / job-complete）不走 getSession，只认 `delivery_token`（HMAC 绑 job）+ protection-bypass；R2 长期 key 只在 Vercel，Bridge 只拿短期预签名 PUT，且 r2_key 路径由服务端生成、核验只信 R2 实际 size+ETag。

## 工作流程

- 文档改动同步 README、`docs/HANDOFF.md`（现状入口）、`docs/PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md`（插件契约）和用户指定的在线部署手册。docs/ 精简为三份:HANDOFF、PLATFORM_OVERVIEW、PLUGIN_MODAL_BRIDGE_CHANGE_PLAN。
- 截图、验收图片统一在 `/workspace/documents/screenshot`。
- 代码改动至少跑 `npm run typecheck`；重要改动跑 `npm run build`。
- UI 改动后在 1920×1080 与 1080×1920 各验证一次。
- 密钥不进 git、截图、对话。
