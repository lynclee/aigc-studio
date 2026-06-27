# AIGC Studio

给美术同学的 AIGC **配套门户**:飞书登录 + 作品画廊。

出图**不在网页里跑** —— 美术同学在本地 ComfyUI Desktop 用 [`comfyui_modal_bridge`](https://github.com/lynclee/comfyui_modal_bridge) 插件把工作流分发到**自己的 Modal GPU**,产物存进 Cloudflare R2 并回写本门户;门户只负责**登录、索引、展示**。因此**部署门户本身不需要 Modal 账号**。

## 技术栈

- Next.js 16（App Router）+ TypeScript + Tailwind CSS
- 飞书（Lark）OAuth 登录 + HMAC 签名 cookie 会话（零依赖,非 Supabase Auth）
- Supabase Postgres（作品索引）
- Cloudflare R2（作品图存储 + 预签名 URL）

## 数据流

```
美术同学本地 ComfyUI + comfyui_modal_bridge
  → 出图跑在各自的 Modal GPU
  → 产物存 Cloudflare R2(key 以 open_id 前缀隔离)
  → POST /api/gallery/ingest(Authorization: Bearer BRIDGE_API_KEY)写一条索引到 Supabase
门户:飞书登录 → 按 open_id 读 Supabase → 对 r2_key 签预签名 URL → 画廊展示
```

## 本地开发

```bash
npm install
bash scripts/setup-env.sh   # 交互式填 .env.local(敏感值不回显,3 个密钥可回车自动生成)
# 或手动:cp .env.example .env.local 后编辑
npm run dev                 # http://localhost:3000
```

脚本:`npm run dev | build | start | typecheck`。

## 部署(从零到上线)

> 门户**不需要 Modal 账号**。按顺序走一遍即可上线。

### 1. 开账号(都要新申请)

| 服务 | 用途 | 要拿到的值 |
|---|---|---|
| GitHub | 放代码 | 一个 private 仓库 |
| 飞书开放平台 | 网页应用 OAuth 登录 | `App ID` / `App Secret` |
| Supabase | 画廊索引库 | `Project URL` / `service_role key` |
| Cloudflare R2 | 存作品图 | `Account ID` / `Access Key ID` / `Secret` / 桶名 |
| Vercel | 部署门户 | 用 GitHub 登录即可 |

另外用 `openssl rand -hex 32` 各生成一串:`SESSION_SECRET`、`BRIDGE_API_KEY`（给美术同学配进插件）。

### 2. Supabase 建库 + 跑迁移

1. supabase.com 建项目（记下数据库密码）。
2. 左侧 **SQL Editor** → 新建查询 → 把 `supabase/migrations/0001_gallery_items.sql` 内容贴进去 → **Run**。
3. 左侧 **Settings → API** 复制 `Project URL`、`service_role`（机密）。

### 3. Cloudflare R2 建桶 + CORS

1. R2 → 开通（绑卡,有免费额度）→ Create bucket（桶名 = `R2_BUCKET`）。
2. 进桶 **Settings → CORS Policy**，贴（拿到 Vercel 域名后把 origin 换成实际域名）:
   ```json
   [{ "AllowedOrigins": ["https://你的域名.vercel.app"], "AllowedMethods": ["GET","HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["content-length"], "MaxAgeSeconds": 3600 }]
   ```
3. R2 概览页复制 **Account ID**；**Manage R2 API Tokens** → Create → 拿 `Access Key ID` + `Secret Access Key`（只显示一次,立刻存好）。

### 4. 飞书网页应用 + OAuth

1. open.feishu.cn 开发者后台 → 创建企业自建应用。
2. 开通「**网页应用**」能力；按提示授予「获取用户基本信息（姓名/头像/open_id）」所需权限。
3. **安全设置 → 重定向 URL** 先留空,部署后回填 `https://你的域名.vercel.app/api/auth/lark/callback`。
4. **凭证与基础信息** 复制 `App ID` / `App Secret`。

### 5. 填环境变量

- **本地**：`bash scripts/setup-env.sh`，或手编 `.env.local`。
- **生产**：Vercel 项目 **Settings → Environment Variables** 逐条填（同一批值）。变量清单见 [`.env.example`](./.env.example)；`LARK_REDIRECT_URI` = 上面那个 callback URL。

### 6. push + Vercel 部署

1. 代码 push 到你的 GitHub 仓库。
2. vercel.com → Add New → Project → Import 该仓库。
3. 在 **Environment Variables** 填第 5 步那批变量 → **Deploy**。
4. 拿到 `https://xxx.vercel.app`。

### 7. 部署后回填（重要,漏了会登录失败/图片裂）

- 飞书 **重定向 URL** 填 `https://xxx.vercel.app/api/auth/lark/callback`，并确保 `LARK_REDIRECT_URI` 与之一致。
- R2 **CORS** 的 `AllowedOrigins` 换成实际 Vercel 域名。

### 8. 验证

打开网址 → 「用飞书登录」→ 授权 → 进门户。画廊此刻为空,等美术同学用 Modal Bridge 出图回写后出现。

## 让产物进画廊（门户 ↔ 插件对接约定）

美术同学的 `comfyui_modal_bridge` 出图后,把产物存到你的 R2（key 以本人 `open_id` 开头做隔离），并回写门户:

```
POST https://你的域名/api/gallery/ingest
Authorization: Bearer <BRIDGE_API_KEY>
Content-Type: application/json

{ "open_id": "ou_xxx", "r2_key": "ou_xxx/2026/abc.png", "prompt": "..." }
```

门户只读这张索引表 + 按需签 R2 预签名 URL 展示，不直接接触出图过程。后续可在插件侧封装成自动回写。

> **信任假设(internal trust assumption)**:当前 `BRIDGE_API_KEY` 是**全团队共享的同一把密钥**,且 `ingest` 直接接受调用方在 body 里传入的 `open_id` —— 因此**任一持钥者理论上可冒用他人 `open_id` 写入**。这在内部团队场景下是可接受的简化,但不是面向不可信调用方的隔离。要收紧(让每个人只能写自己的产物、避免共享密钥),见后续 **presigned-PUT 方案**(门户按登录用户签发受限的 R2 直传凭据,open_id 由服务端会话推导而非客户端传入)。

## 环境变量与密钥安全

完整清单见 [`.env.example`](./.env.example)。**密钥永不进 git**（`.gitignore` 已拦截所有 `.env*`）；本地填 `.env.local`，生产填 Vercel 的 Environment Variables，两处都不经过版本库。
