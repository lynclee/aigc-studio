# CLAUDE.md

本文件为 Claude Code 在 aigc-studio 仓库工作时提供指引。

> 项目:**AIGC Studio** — 美术同学的 AIGC 配套门户(飞书 OAuth 登录 + 作品画廊)。
> 门户只管**登录、索引、展示**,不跑算力;出图在美术同学本地 ComfyUI Desktop 经
> comfyui_modal_bridge 插件跑各自的 Modal,产物直传 R2 后回写索引到这里。

**新会话第一步:先读 `docs/HANDOFF.md`** — 详细的任务清单、从 v0-nano-banana-pro-playground
抽取的资产清单、已知 gap 与踩坑经验都在那里。本文件只放稳定的架构事实。

## 语言

始终使用简体中文与用户对话。

## 命令

```bash
npm run dev        # 开发服务器
npm run build      # 生产构建
npm run typecheck  # tsc --noEmit
```

CI(`.github/workflows/ci.yml`)跑 typecheck + build,**不注入任何密钥** —— 代码在缺 env
时必须优雅降级(`getR2Client` / `getSupabaseAdmin` / `signGetUrl` 返回 null,绝不在模块
加载期抛错),这是 build 门禁能过的前提,改动时必须维持。

## 架构事实

### 路由全景

| 路由 | 职责 |
|---|---|
| `/` | 登录页(有会话 302 `/portal`);`?error=` 只渲染固定文案映射,不回显原始字符串 |
| `/portal` | 门户主页:插件配置区(upload-token 复制)+ 作品画廊(server 端签 GET URL) |
| `/api/auth/lark/login` | 生成随机 state(HttpOnly cookie,10 分钟)→ 302 飞书授权页 |
| `/api/auth/lark/callback` | 验 state → code 换 token(v2 endpoint)→ user_info → setSession → `/portal` |
| `/api/auth/logout` | 清会话 cookie |
| `/api/gallery/upload-token` | 需登录;签发绑本人 open_id 的 upload-token(备用入口,portal 页已直接展示) |
| `/api/gallery/upload-url` | 插件核心:验 upload-token → 写索引行 → 签预签名 PUT URL(见下方不变量) |

### 认证与会话(不用 Supabase Auth)

- 飞书 OAuth 2.0(`lib/lark/oauth.ts`):authorize → `authen/v2/oauth/token` → `authen/v1/user_info`,scope `contact:user.base:readonly`
- 会话 = HMAC-SHA256 签名 cookie(`lib/session.ts`):payload `{open_id,name,avatar,exp}`,7 天,HttpOnly + Secure + SameSite=Lax
- upload-token(`lib/upload-token.ts`):同一把 `SESSION_SECRET` 签 `{open_id,type:"upload"}`,**无 exp 长期有效**;轮换 `SESSION_SECRET` = 作废所有旧会话 + 旧 token

### 数据层

- Supabase Postgres 仅一张表 `gallery_items`(id / user_open_id / r2_key / prompt / source / created_at),迁移只有 `supabase/migrations/0001_gallery_items.sql`
- **RLS 开启但零 policy** = anon/authenticated 全拒;只有服务端 service_role(绕过 RLS)可读写,应用层按 open_id 过滤。别加 policy、别引入 anon key 直连
- R2 私有桶(`lib/r2.ts`):`signGetUrl` 默认 7 天,`signPutUrl` 默认 10 分钟

### 安全不变量(改动必须维持)

1. **open_id 只从 token/session 的签名 payload 推导,绝不接受客户端在 body/query 里传**
2. **r2_key 由服务端强制 `<openId>/<uuid>.<ext>` 本人前缀**(ext 白名单 png/jpg/webp/mp4/glb,默认 png)—— 两道闸合起来杜绝冒名写入
3. service_role key / R2 凭据只在服务端用,绝不进客户端 bundle
4. **密钥不经过 AI、不进 git**:`.env.local` 由用户跑 `bash scripts/setup-env.sh` 自己填(敏感值不回显),Claude 不读 `.env.local`;push 前核 `git status` 确认无密钥文件

## 工作流程

- 每次完成代码修改后 `git add` + `git commit`(中文 conventional 风格,同现有 8 个 commit);
  远端接好后(GitHub 私仓 + Vercel push-to-deploy)改为 commit + push 自动部署
- UI 改动用 Playwright 验证桌面 1920×1080 + 移动 390×844 两种视口(画廊 grid 是 2/3/4 列响应式)
- 部署手册(飞书,面向零基础):https://my.feishu.cn/docx/QmyFdqheWoMnoExJpGicbE1Nnth —
  第三节 10 个 env、第五节 8 步部署、第六节 CORS JSON;改部署流程时同步更新该文档(lark-cli,`--as user`)

## 环境变量(10 个,详见 .env.example)

`LARK_APP_ID` `LARK_APP_SECRET` `LARK_REDIRECT_URI` `SESSION_SECRET`
`NEXT_PUBLIC_SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY`
`R2_ACCOUNT_ID` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` `R2_BUCKET`
