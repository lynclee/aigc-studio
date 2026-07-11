# AIGC Studio

AIGC Studio 是给设计师和美术同学使用的 AIGC 作品网站。使用同学打开网站、用飞书登录、选择图片 / 3D / 视频入口、选择预设工作流、输入 prompt，然后等待云端服务器后台生成。页面关闭后，后台仍会继续检查任务；完成作品会进入个人作品库。

> 术语说明：
> - **AIGC**：用 AI 生成图片、3D 模型、视频等内容。
> - **prompt**：给 AI 的文字描述，例如“赛博朋克风格的狐狸角色设定图”。
> - **工作流**：预设好的创作方法，用户只需要选择名称，不需要接触底层工具。

## 产品主流程

```text
飞书登录
  → 图片 / 3D / 视频三入口
  → 选择预设工作流
  → 输入 prompt（文字描述）
  → 云端服务器后台生成
  → 网站和后台定时检查状态
  → 完成作品进入个人作品库
```

提交生成后，任务记录会先写入数据库，再交给部署同学选定的云端生成服务处理。Vercel Cron 每 5 分钟访问一次后台检查接口，继续同步未完成任务。即使使用者关掉页面，任务完成后仍会落到个人作品库。

迁移说明：旧上传口令 / `target_open_id` 已退出主流程；历史 gallery 数据不会自动回流，若需要保留由部署 / 运营同学做一次性迁移。

## 角色分工

| 角色 | 负责什么 | 不需要做什么 |
|---|---|---|
| 部署 / 运营同学 | 配置飞书登录、Vercel、Supabase、Cloudflare R2，以及图片服务（Modal / OpenRouter / fal.ai / ComfyUI）和后台定时检查 | 不把服务端密钥发给普通用户 |
| 美术 / 设计使用同学 | 登录网站，选择入口和工作流，填写 prompt，查看任务状态和个人作品库 | 不安装底层生成工具，不配置后台迁移参数 |

## 当前技术栈

- Next.js 16（App Router）+ TypeScript + Tailwind CSS
- 飞书 OAuth 登录 + HMAC 签名 cookie 会话
- Supabase Postgres：记录任务、生成结果和作品资产
- Cloudflare R2：保存生成后的图片、视频、3D 文件
- 图片生成服务：部署者可在 Modal、OpenRouter、fal.ai、ComfyUI 之间选择一种；普通使用者不需要、也不能选择服务
- fal.ai Queue API：3D 与视频生成入口；图片服务选为 fal.ai 时也走它
- Vercel Cron：每 5 分钟后台检查未完成任务

## 核心架构

```text
浏览器
  │
  ├─ 飞书 OAuth 登录
  │   └─ /api/auth/lark/login → /api/auth/lark/callback
  │
  └─ /portal 创作工作台
      ├─ POST /api/generate/image    → 部署者选定的图片生成服务
      ├─ POST /api/generate/model3d  → fal.ai 3D 生成服务
      ├─ POST /api/generate/video    → fal.ai 视频生成服务
      ├─ GET  /api/jobs/:id          → 查询任务状态，完成后保存到 R2 并落库
      └─ GET  /api/library           → 读取个人作品库

Vercel Cron
  └─ GET /api/jobs/reconcile          → 每 5 分钟检查未完成任务

服务端
  ├─ Supabase service_role 访问 aigc_jobs / aigc_generations / aigc_assets
  └─ Cloudflare R2 保存生成资产，并为浏览器生成临时访问链接
```

## 第一部分：部署 / 运营

### 环境变量

生产环境在 Vercel Project → Settings → Environment Variables 中配置。本地开发使用 `.env.local`；`scripts/setup-env.sh` 会协助写入同一组变量，包括 `AIGC_ASSET_HOST_ALLOWLIST`。脚本会对 `SESSION_SECRET` 和 `CRON_SECRET` 使用隐藏输入；直接回车时会自动生成随机值。脚本只写本地 `.env.local`，仍需把同一组变量填进 Vercel。敏感值不应提交到 git、截图或对话记录。

| 变量 | 用途 |
|---|---|
| `LARK_APP_ID` | 飞书开放平台应用 ID |
| `LARK_APP_SECRET` | 飞书开放平台应用密钥 |
| `LARK_REDIRECT_URI` | 飞书登录回调地址，形如 `https://你的域名/api/auth/lark/callback` |
| `SESSION_SECRET` | 签名登录 cookie 的随机密钥，可用 `openssl rand -hex 32` 生成 |
| `CRON_SECRET` | 后台定时检查专用口令，可用 `openssl rand -hex 32` 生成，只配置在 Vercel 服务端环境变量中 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务端 service role key，只能放服务端环境变量 |
| `R2_ACCOUNT_ID` | Cloudflare R2 Account ID |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret Access Key |
| `R2_BUCKET` | Cloudflare R2 bucket 名称 |
| `AIGC_IMAGE_PROVIDER` | 图片服务选择：`modal`（默认）/ `openrouter` / `fal` / `comfyui`。只由部署者设置，不显示在用户页面；此项就是快速切换开关 |
| `MODAL_ENDPOINT_BASE` / `MODAL_KEY` / `MODAL_SECRET` | 仅当图片服务选 `modal` 时填写；endpoint 前缀会自动拼接 `-run` / `-status` / `-cancel` |
| `OPENROUTER_API_KEY` / `OPENROUTER_IMAGE_MODEL` | 图片服务选 `openrouter` 时必填；后者是默认图片模型 ID |
| `OPENROUTER_IMAGE_STANDARD_MODEL` / `OPENROUTER_IMAGE_DETAIL_MODEL` | 可选：给“标准出图”和“细节增强”分别指定 OpenRouter 图片模型 |
| `OPENROUTER_IMAGE_RESOLUTION` / `OPENROUTER_IMAGE_ASPECT_RATIO` | 可选：统一指定 OpenRouter 的尺寸档和画面比例 |
| `FAL_KEY` | fal.ai API key；3D 与视频必填，图片服务选 `fal` 时也使用它 |
| `FAL_IMAGE_ENDPOINT` | 图片服务选 `fal` 时必填，填写 fal 的 endpoint 路径；可用 `FAL_IMAGE_STANDARD_ENDPOINT`、`FAL_IMAGE_DETAIL_ENDPOINT` 分别覆盖两个图片工作流 |
| `FAL_MODEL3D_STANDARD_ENDPOINT` / `FAL_MODEL3D_GAME_ASSET_ENDPOINT` / `FAL_VIDEO_ENDPOINT` | 可选：替换内置的 3D / 视频 fal endpoint；不填就使用项目默认值 |
| `COMFYUI_BASE_URL` | 图片服务选 `comfyui` 时必填，填写自建 ComfyUI 服务根地址，不要写 `/api`；Vercel 必须能访问该地址 |
| `COMFY_ORG_API_KEY` | 仅工作流用了 GPT Image 等 ComfyUI 付费 API 节点时填写。这是部署者 ComfyUI 账号里有 API 积分的密钥；付费节点会从该账号扣费。网站只在服务端把它放进提交工作流时需要的 `extra_data`，不会发给浏览器 |
| `AIGC_ASSET_HOST_ALLOWLIST` | 仅当自定义 Modal / fal 输出文件域名时填写；默认常见域名已覆盖。多个域名用英文逗号分隔 |

`CRON_SECRET` 是 `/api/jobs/reconcile` 的访问口令。Vercel Cron 会带这个口令调用后台检查接口，普通用户不需要知道它。`scripts/setup-env.sh` 会先询问图片服务，再只询问所选服务的主要变量；上线前请把同一组变量填进 Vercel。`~/.modal.toml` 只在图片服务选 Modal 且部署者本机使用 Modal CLI 时才需要，不能复制到 Vercel，也不能当作网站环境变量。

### 图片服务怎么选

| 选项 | 适合什么情况 | 部署同学需要做什么 |
|---|---|---|
| `modal` | 已有自己的 Modal 图片服务 | 填 Modal endpoint 与密钥；图片任务支持真实取消 |
| `openrouter` | 希望按模型 ID 更换云端图片模型 | 填 OpenRouter key 与默认图片模型；成图会直接保存到 R2 |
| `fal` | 希望图片、3D、视频都由 fal.ai 提供 | 填 `FAL_KEY`，再填一个图片 endpoint 路径 |
| `comfyui` | 已经有自建 ComfyUI 工作流，或要用 GPT Image 等付费节点 | 填自建服务地址；付费节点再填有 API 积分的 `COMFY_ORG_API_KEY`。网站会把它放进 ComfyUI 的后台提交信息，不会发给浏览器；完成后文件自动存到 R2 |

这四种方式是**部署选择**，不是用户界面的“选模型”功能。网站仍只显示“标准出图”“细节增强”两个易懂的创作方法。

#### 快速切换图片服务

部署同学在 Vercel 的同一个环境（production / preview / development）中，只需把 `AIGC_IMAGE_PROVIDER` 改为 `modal`、`openrouter`、`fal` 或 `comfyui`，然后重新部署；不需要改页面、数据库或迁移。OpenRouter 排在 fal 前面，是当前推荐的图片服务顺序，**不是**自动兜底规则。

切换前先保留旧图片服务的地址和密钥，直到它的未完成任务全部结束。旧任务会按自己数据库里保存的 provider 继续检查，不会因为新任务已改用 OpenRouter 而改去 fal 或其他服务。

目前仓库内置的两份 ComfyUI 模板仍是 Z-Image 和 FLUX 的本地节点，并不自动变成 GPT Image。要使用 GPT Image，部署同学需要从 ComfyUI 导出那条工作流的 **API 格式 JSON**，再替换或新增网站的图片工作流模板；配置有 API 积分的 `COMFY_ORG_API_KEY` 后，网站会自动把密钥随工作流安全地交给 ComfyUI，收费节点便会从这个账号扣费。

### 本地开发

```bash
npm install
bash scripts/setup-env.sh
npm run dev
```

然后打开 `http://localhost:3000`。常用脚本：

```bash
npm run dev
npm run typecheck
npm run build
npm run start
```

### 数据库和文件仓库

在 Supabase SQL Editor 依次执行：

```text
supabase/migrations/0001_gallery_items.sql
supabase/migrations/0002_aigc_jobs_generations_assets.sql
```

`0001_gallery_items.sql` 是历史兼容表；当前主流程使用 `aigc_jobs`、`aigc_generations`、`aigc_assets`。

Cloudflare R2 是作品库的正式文件仓库。任务只有在 provider 输出文件成功保存进 R2 后，才算真正完成；如果 R2 未配置、下载失败、上传失败或输出文件域名未通过安全检查，任务会显示失败，不再继续使用临时 provider 链接当作完成结果。

### 部署要点

1. 在飞书开放平台创建企业自建应用，开通网页应用登录，配置回调 URL。
2. 在 Supabase 执行数据库迁移，复制 Project URL 和 service role key。
3. 在 Cloudflare R2 创建私有 bucket，配置 API token 和 CORS。
4. 选择一个图片服务：Modal、OpenRouter、fal.ai 或 ComfyUI。按上表填写对应变量；3D 和视频另外准备 fal.ai key。
5. 在 Vercel 导入仓库并填写环境变量，特别是 `CRON_SECRET`。
6. 确认 `vercel.json` 中的 Cron 指向 `/api/jobs/reconcile`，计划为每 5 分钟一次。
7. 部署后打开网站，用飞书登录，提交图片 / 3D / 视频任务，确认任务状态和个人作品库正常。

截图和验收材料统一放在：`/workspace/documents/screenshot`。

### 主要 API

| 路由 | 说明 |
|---|---|
| `GET /api/auth/lark/login` | 跳转到飞书授权页 |
| `GET /api/auth/lark/callback` | 处理飞书回调并写入登录 cookie |
| `POST /api/auth/logout` | 清除登录 cookie |
| `POST /api/generate/image` | 提交图片生成任务 |
| `POST /api/generate/model3d` | 提交 3D 生成任务 |
| `POST /api/generate/video` | 提交视频生成任务 |
| `GET /api/jobs` | 读取当前用户自己的任务列表，并顺手同步状态 |
| `GET /api/jobs/[id]` | 查询当前用户自己的任务状态 |
| `POST /api/jobs/[id]` / `POST /api/jobs/[id]/cancel` | 取消当前用户自己的任务；只有图片服务选 Modal 时支持真实取消 |
| `GET /api/jobs/reconcile` | Vercel Cron 使用的后台检查接口，需要 `CRON_SECRET` |
| `GET /api/library` | 读取当前用户自己的个人作品库 |

### 安全边界

- 用户身份来自飞书 `open_id`，写入 HMAC 签名 cookie。
- 所有任务、取消和作品库读取都按当前登录用户的 `open_id` 过滤。
- Supabase `service_role`、R2 密钥、Modal / fal.ai / OpenRouter / ComfyUI 密钥、`CRON_SECRET` 只在服务端使用。
- R2 bucket 保持私有；浏览器只拿短期签名访问链接。
- 对于由 URL 下载的 Modal / fal 输出文件，系统要求 HTTPS、可信域名和安全 DNS；OpenRouter / ComfyUI 的图片由服务端直接保存到 R2。
- 系统限制单个用户同时最多 3 个排队 / 生成中任务，60 秒内最多提交 10 个任务，避免误提交大量任务。

## 第二部分：美术 / 设计使用

### 可以做什么

工作台只有三个入口：图片、3D、视频。每个入口只需要选择一个预设工作流，再填写文字描述。使用同学不用接触底层服务、密钥、上传口令或后台迁移参数。

| 入口 | 适合做什么 | 输出结果 |
|---|---|---|
| 图片 | 角色设定、场景氛围、宣传图、参考图 | 图片文件 |
| 3D | 道具、角色、场景模型草案 | 3D 模型文件，可能带预览图 |
| 视频 | 镜头运动、氛围短片、动态概念 | 视频文件，可能带封面图 |

### 提交后会发生什么

提交后，网站会显示任务状态。云端服务器会在后台继续处理；即使关闭页面，后台也会定时检查未完成任务。任务完成并保存到作品库后，再次打开网站就能看到结果。

常见状态：

| 状态 | 含义 |
|---|---|
| 排队中 | 已提交，等待云端服务器处理 |
| 生成中 | 云端服务器正在生成 |
| 已完成 | 作品已保存，可以在个人作品库查看 |
| 失败 | 本次没有成功，可截图并联系部署 / 运营同学排查 |
| 已取消 | 仅图片服务选 Modal 时，任务已向云端发送取消请求 |

### 取消说明

当图片服务选 Modal 时，图片任务支持服务端取消。fal.ai、OpenRouter、ComfyUI 以及 3D / 视频目前不提供“假取消”：如果云端服务本身不支持安全停止，页面不会假装任务已经停止，也不承诺能中止云端正在跑的任务。

### 使用建议

- 先用短 prompt 探索方向，再逐步补充细节。
- 等待任务时不要重复快速提交同一个 prompt。
- 同一方向可以保留几版结果，方便和同事讨论。
- 不要在 prompt 里写公司密钥、账号密码或不能外传的信息。
- 遇到失败时，保存截图、入口类型、prompt 和任务时间，方便部署 / 运营同学排查。
