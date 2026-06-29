# AIGC Studio

给美术同学的 AIGC **配套门户**:飞书登录 + 作品画廊。

出图**不在网页里跑** —— 美术同学在本地 ComfyUI Desktop 用 [`comfyui_modal_bridge`](https://github.com/lynclee/comfyui_modal_bridge) 插件把工作流分发到**自己的 Modal GPU**,产物存进 Cloudflare R2 并回写本门户;门户只负责**登录、索引、展示**。因此**部署门户本身不需要 Modal 账号**。

## 技术栈

- Next.js 16（App Router）+ TypeScript + Tailwind CSS
- 飞书（Lark）OAuth 登录 + HMAC 签名 cookie 会话（零依赖,非 Supabase Auth）
- Supabase Postgres（作品索引）
- Cloudflare R2（作品图存储 + 预签名 URL）

## 数据流

走 **presigned-PUT**:插件只持一串绑自己 `open_id` 的 **upload-token**(门户 portal 页复制),
**不碰 R2 凭据、不传 open_id**。出图后跟门户换一张限定到本人前缀、短过期的预签名 PUT URL 直传 R2。

```
美术同学本地 ComfyUI + comfyui_modal_bridge
  → 出图跑在各自的 Modal GPU
  → 插件 POST /api/gallery/upload-url(Authorization: Bearer <upload-token>)
      ↳ 门户验 token 推导 open_id(客户端无法冒名)
      ↳ 生成 r2_key = <open_id>/<uuid>.<ext>(强制本人前缀)
      ↳ 写一条索引到 Supabase + 返回 { uploadUrl, r2_key }
  → 插件 PUT 图到 uploadUrl(直传 Cloudflare R2,门户/Vercel 零出口流量)
门户:飞书登录 → 按 open_id 读 Supabase → 对 r2_key 签预签名 GET URL → 画廊展示
```

## 本地开发

```bash
npm install
bash scripts/setup-env.sh   # 交互式填 .env.local(敏感值不回显,3 个密钥可回车自动生成)
# 或手动:cp .env.example .env.local 后编辑
npm run dev                 # http://localhost:3000
```

脚本:`npm run dev | build | start | typecheck`。

## 快速配置(最快路径)

老手照这张清单走即可;每步细节见下面「部署(从零到上线)」。配置有 4 个落点:**门户 env**、**三个服务后台**(Supabase / R2 / 飞书)、**Vercel 部署**、**美术同学插件**。

| 步骤 | 怎么做 |
|---|---|
| 1. 本地 env | `bash scripts/setup-env.sh`(交互填 `.env.local`,密钥不回显,`SESSION_SECRET` 回车自动生成) |
| 2. 生产 env | **首选** Vercel 网页 Settings → Environment Variables,右上角**直接粘贴整个 `.env.local`**,一次导入全部变量;命令行党用 `bash scripts/push-env-to-vercel.sh`(需先 `vercel login` + `vercel link`) |
| 3. Supabase | SQL Editor 贴 [`supabase/migrations/0001_gallery_items.sql`](./supabase/migrations/0001_gallery_items.sql) → Run;或装 CLI 后 `supabase db push` |
| 4. Vercel 部署 | Import GitHub 仓库 → 填好 env → Deploy → 拿到 `https://xxx.vercel.app` |
| 5. R2 CORS(拿到域名后) | `node scripts/setup-r2-cors.mjs https://你的域名.vercel.app` |
| 6. 飞书回调 | 飞书后台 **安全设置 → 重定向 URL** 手动填 `https://你的域名.vercel.app/api/auth/lark/callback`(无 API,绕不过),并确保 `LARK_REDIRECT_URI` 与之一致 |
| 7. 美术同学 | 登录门户 → 复制顶部「ComfyUI Modal Bridge 插件配置」里的 **upload-token** → 配进插件 |

**第 5 步说明(R2 CORS 一键脚本)**:用 `@aws-sdk/client-s3` 的 `PutBucketCorsCommand` 程序化配 CORS(R2 的 S3 API 支持,[官方文档](https://developers.cloudflare.com/r2/api/s3/api/))。⚠️ 配 CORS 属「编辑桶配置」,按 [R2 token 权限矩阵](https://developers.cloudflare.com/r2/api/tokens/#permissions)需 **Admin Read & Write** 档的 token;门户日常用的 Object 档 token 跑这个**可能 AccessDenied**。失败就走兜底:

- **dashboard 手动贴**(最稳):进桶 **Settings → CORS Policy**,贴下面 JSON(把 origin 换成你的域名):
  ```json
  [{ "AllowedOrigins": ["https://你的域名.vercel.app"], "AllowedMethods": ["GET","HEAD","PUT"], "AllowedHeaders": ["*"], "ExposeHeaders": ["content-length"], "MaxAgeSeconds": 3600 }]
  ```
- **或 wrangler**:`wrangler r2 bucket cors set <桶名> --file cors.json`(wrangler 走自己的 OAuth 登录,权限与 S3 access key 独立)。

> 两个辅助脚本(`scripts/setup-r2-cors.mjs`、`scripts/push-env-to-vercel.sh`)的完整前置与用法都写在脚本顶部注释里。

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

另外用 `openssl rand -hex 32` 生成一串 `SESSION_SECRET`(同时用于会话 cookie 与 upload-token 的 HMAC 签名;轮换它即可让所有旧 upload-token 失效)。

### 2. Supabase 建库 + 跑迁移

1. supabase.com 建项目（记下数据库密码）。
2. 左侧 **SQL Editor** → 新建查询 → 把 `supabase/migrations/0001_gallery_items.sql` 内容贴进去 → **Run**。
3. 左侧 **Settings → API** 复制 `Project URL`、`service_role`（机密）。

### 3. Cloudflare R2 建桶 + CORS

1. R2 → 开通（绑卡,有免费额度）→ Create bucket（桶名 = `R2_BUCKET`）。
2. 进桶 **Settings → CORS Policy**，贴（拿到 Vercel 域名后把 origin 换成实际域名）。
   `AllowedMethods` 必须含 `PUT`，否则插件 presigned-PUT 直传会被 CORS 挡:
   ```json
   [{ "AllowedOrigins": ["https://你的域名.vercel.app"], "AllowedMethods": ["GET","HEAD","PUT"], "AllowedHeaders": ["*"], "ExposeHeaders": ["content-length"], "MaxAgeSeconds": 3600 }]
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

走 **presigned-PUT**:美术同学先登录门户(portal),复制顶部「ComfyUI Modal Bridge 插件配置」区里那串 **upload-token**(绑本人 `open_id`、长期有效),填进插件的「门户 upload token」。**插件不需要任何 R2 凭据,也不传 open_id**。

出图后插件分两步:

```
① 换预签名 PUT URL（门户验 token → 推导 open_id → 写索引 → 签 URL）
POST https://你的域名/api/gallery/upload-url
Authorization: Bearer <upload-token>
Content-Type: application/json

{ "prompt": "...", "ext": "png" }     # ext 默认 png,白名单 png/jpg/webp/mp4/glb
→ 200 { "uploadUrl": "https://...r2...", "r2_key": "ou_xxx/<uuid>.png" }

② 把图直传 R2（10 分钟内有效,Content-Type 须与 ext 对应)
PUT <uploadUrl>
Content-Type: image/png
<二进制图像数据>
```

`open_id` 由门户从 token 签名推导(客户端无法冒名)、`r2_key` 由门户**强制成 `<open_id>/<uuid>.<ext>`**(只能写本人前缀)、索引由门户写入。插件只管「换 URL + PUT」,不碰 Supabase、不持 R2 凭据。

> **信任假设(internal trust assumption)**:presigned-PUT 已让**每个人只能写自己 `open_id` 前缀下的对象**(key 由服务端强制),且**不再下发任何 R2 凭据**给插件 —— 冒名 / 凭据泄露面已大幅收紧。剩余假设是 **upload-token 本身要妥善保管**:它长期有效,泄露后持有者可往泄露者本人前缀写图(只能冒充本人,无法冒充他人)。需要作废时,泄露者重新登录门户、并轮换服务端 `SESSION_SECRET`(HMAC 密钥),所有旧 upload-token 随之失效,各人重登复制新 token 即可。

## 环境变量与密钥安全

完整清单见 [`.env.example`](./.env.example)。**密钥永不进 git**（`.gitignore` 已拦截所有 `.env*`）；本地填 `.env.local`，生产填 Vercel 的 Environment Variables，两处都不经过版本库。
