# HANDOFF — AIGC Studio（2026-07-11）

给后续 Claude Code / Codex 会话的交接说明。开始前先看 `git status`，不要回退其他工作者的改动。

## 当前状态

- 产品：设计、美术使用的 AIGC 创作网站。
- 主流程：**GitHub 登录（优先）/ Google-Gmail 登录（备用）** → 图片 / 3D / 视频 → prompt → 云端生成 → 个人作品库。
- 认证：已从旧外部登录迁移为 **Supabase Auth**。网站服务端用 Supabase cookie 读取用户，数据库归属字段统一为 `user_id`。
- 生成：图片可选 Modal、OpenRouter、fal、自建 ComfyUI；3D / 视频使用 fal。普通用户不见 provider、密钥或后台工具。
- 作品：provider 结果必须先成功落入 Cloudflare R2 才标记为完成。
- 后台检查：Vercel Cron 每天 `03:30` 调用 `/api/jobs/reconcile`；页面打开时也会检查状态。
- 截图目录：`/workspace/documents/screenshot`。

## 关键文件

| 文件 | 职责 |
|---|---|
| `app/page.tsx` | GitHub 优先、Google 备用登录页 |
| `app/api/auth/[provider]/login/route.ts` | 发起 GitHub / Google OAuth |
| `app/api/auth/callback/route.ts` | 交换 code 为 Supabase 会话 |
| `lib/supabase/auth.ts` | Supabase SSR cookie client 与网站地址处理 |
| `lib/session.ts` | 从 Supabase Auth 取得可信 `userId` |
| `lib/jobs/*` | 创建、限流、同步、保存任务与结果 |
| `lib/engines/*` | Modal / OpenRouter / fal / ComfyUI provider |
| `lib/assets/*` | R2 保存与输出文件安全检查 |
| `supabase/migrations/0001_*` | 历史兼容表，新定义使用 `user_id` |
| `supabase/migrations/0002_*` | 当前 jobs / generations / assets 表 |
| `supabase/migrations/0003_*` | 已有旧库的归属字段改名兼容迁移 |

## 上线前必须由部署同学完成

1. Supabase → Authentication → Providers 中启用 GitHub 与 Google，填 Client ID / Secret。
2. GitHub 与 Google OAuth 应用的回调都填写：`https://<project-ref>.supabase.co/auth/v1/callback`。
3. Supabase URL Configuration 设置 Site URL，并把 `https://你的域名/api/auth/callback` 加入 Redirect URLs；本地再加 `http://localhost:3000/api/auth/callback`。
4. 在 Supabase SQL Editor 按顺序执行 `0001`、`0002`、`0003` 三份迁移。
5. Vercel 填好基础环境变量：

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

6. 再按图片服务选择填写 Modal / OpenRouter / fal / ComfyUI 对应变量。完整注释见 `.env.example`。
7. 若 Vercel 开启 Deployment Protection，确认 OAuth 外部回调不会被拦截。
8. 测 GitHub、Google 两种登录以及一次图片、3D、视频任务。两个登录方式默认是两个账号和两套个人库；团队应统一优先 GitHub。

## 风险与未完成外部配置

- 仓库代码已经改为 Supabase Auth，但实际 OAuth provider、Vercel 环境变量、R2、provider 密钥都必须由有权限的部署同学在控制台填写。
- Vercel 项目已关联 GitHub 仓库；现有环境变量曾为空，部署后未配置前登录页会提示“登录尚未完成配置”。
- 需要用真实 provider 配置联调一次端到端：提交、等待、R2 保存、个人作品库、Cron 兜底。
- ComfyUI 只有工作流内确实使用付费节点时才填 `COMFY_ORG_API_KEY`；当前内置模板不是自动 GPT Image。

## 验证要求

```bash
npm run typecheck
npm run build
git diff --check
bash -n scripts/setup-env.sh
```

在线部署手册保持原链接和标题：<https://my.feishu.cn/docx/X9JddcFVpoLuOxxJAHCcqiClnSe>。它是文档托管位置；网站登录不再使用该平台。
