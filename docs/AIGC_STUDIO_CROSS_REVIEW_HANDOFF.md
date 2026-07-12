# AIGC Studio — 交叉审阅与继续开发说明

> 面向后续 Claude / GLM / Codex 的代码审阅者。本文记录当前实现、与早期 playground 的关键差异、已做决定和仍需真实控制台配置的部分。

## 1. 产品目标与边界

这是一个轻量 AIGC 作品网站，不是多模型商城或复杂工作台。

普通设计 / 美术用户只看到三张入口卡片：**图片、3D、视频**。选择预设工作流、填写 prompt、查看任务状态和个人作品库即可；他们不应该看到 ComfyUI、服务商名称、积分、密钥、上传口令或“作品属于谁”的参数。

部署 / 运营同学负责网站、Supabase、R2、云端生成服务与定时检查。云端服务器在后台出图，完成后自动把作品存入个人作品库。

## 2. 与 `v0-nano-banana-pro-playground` 的差异

| 方面 | 早期 playground | AIGC Studio 当前实现 |
|---|---|---|
| 页面定位 | 更接近试验 playground | 面向团队交付的三入口作品门户 |
| 登录 | 参考过 Supabase OAuth 实现 | Supabase Auth：GitHub 优先，Google / Gmail 备用 |
| 用户路径 | 可能直接试验不同功能 | 图片 / 3D / 视频 → 任务 → 个人作品库 |
| 模型与服务 | 容易暴露更多技术选择 | provider 是部署配置，前端不显示 |
| 任务记录 | 可仅关注单次结果 | `jobs → generations → assets` 完整记录 |
| 文件保存 | 临时结果可直接显示 | 成功保存到私有 R2 才算完成 |
| 后台检查 | 依赖当前页面 | 页面查询 + Vercel 每日 Cron 兜底 |
| 图片服务 | 单条运行路径 | Modal / OpenRouter / fal / 自建 ComfyUI 可切换 |

产品决定：不做 credits、不做多引擎选择壳、不做复杂 UI shell。OpenRouter 的推荐优先级高于 fal，但两者不是自动 fallback。

## 3. 当前架构

```text
设计 / 美术用户
  → GitHub 登录（优先）或 Google / Gmail 登录
  → Supabase Auth
  → AIGC Studio /portal
      → 创建任务（Supabase）
      → 云端图片 / 3D / 视频服务
      → R2 保存结果
      → 个人作品库

Vercel Cron（每天 03:30）
  → 查询未完成任务
  → 云端状态检查
  → R2 保存 + 结果入库
```

### 3.1 认证和归属

- `app/api/auth/[provider]/login/route.ts` 只允许 `github` 与 `google`。
- `app/api/auth/callback/route.ts` 用授权码交换 Supabase 会话；`lib/supabase/auth.ts` 把 cookie 写入响应。
- `lib/session.ts` 每次服务端读取 `auth.getUser()`，返回可信 `userId`、名称、头像、登录来源。
- 所有 jobs、generations、assets 归属字段统一为 `user_id`。浏览器不能传“目标用户”。
- GitHub 和 Google 默认是不同身份。团队要求 GitHub 优先；若要让同一人保留同一作品库，始终使用同一种登录方式，身份合并需另行设计。

### 3.2 数据模型

| 表 | 用途 | 关键字段 |
|---|---|---|
| `aigc_jobs` | 一次提交和 provider 状态 | `user_id`、kind、workflow、provider、状态、request |
| `aigc_generations` | 已完成的一次结果 | `user_id`、job、prompt、provider |
| `aigc_assets` | 图片、视频、3D 文件 | `user_id`、generation、R2 key、类型 |

- `0001_gallery_items.sql` 是历史兼容表。
- `0002_aigc_jobs_generations_assets.sql` 是当前主表。
- `0003_rename_legacy_user_columns.sql` 让已执行早期迁移的数据库把旧归属列改为 `user_id`；新数据库可安全执行它。
- 业务读写用服务端 `SUPABASE_SERVICE_ROLE_KEY`，RLS 保持开启但没有浏览器直接访问 policy。

### 3.3 Provider 和结果保存

- 图片：`AIGC_IMAGE_PROVIDER=modal|openrouter|fal|comfyui`。切换只在 Vercel 改变量并重新部署。
- 3D / 视频：fal Queue API。
- OpenRouter 在提交时返回图片字节，服务端直接落 R2。
- 自建 ComfyUI 调用 `/prompt`、`/history/:id`、`/view`；如工作流含 GPT Image 等付费 API 节点，服务端把 `COMFY_ORG_API_KEY` 放到 `extra_data.api_key_comfy_org`，不会发给浏览器。
- Modal / fal 返回 URL 时，`lib/assets/r2-store.ts` 先检查 HTTPS、域名、DNS、文件大小，再写入 R2。
- 只有 R2 保存和数据库记录都成功，任务才标记 `succeeded`。

## 4. 从旧登录实现迁移的改动

旧的自管网页登录、state、HMAC session 和外部平台 `open_id` 已删除。新基础是：

```text
登录按钮
  → /api/auth/github/login 或 /api/auth/google/login
  → Supabase Auth
  → /api/auth/callback
  → Supabase HttpOnly 会话 cookie
  → getSession() 取得 Supabase user.id
```

新增环境变量：

```text
NEXT_PUBLIC_SITE_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

删除的变量：旧登录应用 ID、Secret、回调 URL、自管 session secret。`CRON_SECRET` 保留，因为它只保护后台任务检查。

## 5. 需要部署同学在控制台完成的配置

代码不包含真实密钥，也不会自动创建第三方 OAuth 应用。

1. 在 Supabase 开启 GitHub 与 Google provider，填 Client ID / Secret。
2. 两个 OAuth 应用的回调地址填写：`https://<project-ref>.supabase.co/auth/v1/callback`。
3. 在 Supabase URL Configuration 设置 Site URL，并允许：
   - `https://稳定域名/api/auth/callback`
   - `http://localhost:3000/api/auth/callback`（本地开发）
4. 在 Supabase SQL Editor 执行 `0001`、`0002`、`0003`。
5. 在 Vercel 填 `NEXT_PUBLIC_SITE_URL`、Supabase 两种 key、R2、`CRON_SECRET`、fal 和所选图片服务变量。
6. Vercel 如启用 Deployment Protection，要允许 OAuth 外部回调。
7. 完整验证 GitHub、Google 登录及图片 / 3D / 视频的提交、R2 保存和作品库。

当前 Vercel main 预览别名：`https://aigc-studio-git-main-liqi-s-projects.vercel.app`。建议最终换成稳定自定义域名，并把这个稳定地址填进 Supabase 与 `NEXT_PUBLIC_SITE_URL`。

## 6. 验证要求

运行 `npm run typecheck`、`npm run build`、`git diff --check`、`bash -n scripts/setup-env.sh`。UI 改动后检查 1920×1080 与 1080×1920。真实端到端生成需部署同学提供自己的 provider、Supabase 与 R2 配置。

## 7. 文档与截图

- 用户部署手册仍托管在：<https://my.feishu.cn/docx/X9JddcFVpoLuOxxJAHCcqiClnSe>。
- 文档标题：`从零上线一个自己的 AIGC 作品网站：给设计师和美术同学的部署手册`。
- 读者分为部署 / 运营同学、美术 / 设计使用同学；流程图和截图位置要保留。
- 所有截图统一从 `/workspace/documents/screenshot` 寻找。
