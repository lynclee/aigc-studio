# AIGC Studio 部署手册(简明版)

> 最后核对:2026-07-15。
> 本文是**简明版**:步骤精简、术语带解释,适合第一次部署照着走。
> 每一步的完整细节、验证 SQL 和排错表见详版 [`CODEX_DEPLOYMENT_RUNBOOK.md`](./CODEX_DEPLOYMENT_RUNBOOK.md)。

## 目标:先跑通一条最短闭环

第一次**只接图片**,不碰视频/3D:

```text
GitHub 登录 → 提交文生图 → Modal GPU 出图 → 直传 R2 → 回调落库 → 作品库显示 → 删除 → 物理清理
```

这条链路跑通,鉴权、任务、回调、存储、数据库、删除闭环就全验证过了。视频/3D 之后再加(见详版第 12 节)。

---

## 术语速查

| 术语 | 一句话解释 |
|---|---|
| OAuth | "用 GitHub/Google 账号登录本站"的授权协议,网站不接触你的密码 |
| callback(回调地址) | OAuth 登录完成后跳回来的 URL;填错是登录失败的头号原因 |
| anon key | Supabase 的公开钥匙,浏览器可见,权限受限 |
| service_role key | Supabase 的万能钥匙,绕过一切权限检查,**只能放服务端** |
| RLS | Row Level Security,数据库行级权限;本项目保持开启,业务读写全走服务端 |
| migration(迁移) | 建表/改表的 SQL 脚本,必须按编号顺序执行 |
| R2 | Cloudflare 的对象存储(类似网盘的程序版),存生成的作品,保持私有 |
| 预签名 URL(presigned URL) | 带签名的短期临时链接;浏览器看图、Modal 传图都靠它,不用交出长期密钥 |
| CORS | 浏览器跨域访问许可;不配的话作品库图片会加载失败 |
| Serverless GPU(Modal) | 按秒租 GPU 跑 ComfyUI,不用自己维护服务器 |
| Cron | 定时任务;本项目每天两条,做对账和删除清理 |
| env(环境变量) | 填在 Vercel 后台的配置项和密钥,改完必须 Redeploy 才生效 |
| HMAC token | 带密钥的签名令牌;Modal 回调网站时用它证明"我是本 job 的合法回调" |

---

## 一、账号清单

**必需(6 个)**:

| 平台 | 用途 | 费用 |
|---|---|---|
| GitHub | 代码托管 + 用户登录入口 | 免费 |
| Supabase | 登录鉴权 + 数据库 | 免费档够 |
| Vercel | 托管网站 + 定时任务 | Hobby 免费 |
| Cloudflare | R2 私有存储 | 10GB 免费 |
| Modal | Serverless GPU 跑生成 | 按秒计费,有免费额度 |
| ComfyUI Desktop | 本地部署插件、同步模型 | 本地软件,无需账号 |

**可选(首轮都不需要)**:Google Cloud(备用登录)、fal.ai(视频/3D)、comfy.org(付费 API 节点)、OpenRouter(替代图片后端)、Hugging Face(公开模型无需 Token)。

---

## 二、凭据放哪(核心安全表)

| 凭据 | 从哪拿 | 放哪 | 绝不能去哪 |
|---|---|---|---|
| GitHub OAuth Client ID/Secret | GitHub OAuth App | Supabase Auth Provider | git、浏览器 |
| Supabase anon key | Supabase API 设置 | Vercel | (公开的,但别和 service_role 弄混) |
| Supabase service_role key | Supabase API 设置 | 仅 Vercel | 浏览器、Modal、git |
| R2 Access Key/Secret | Cloudflare R2 Token | 仅 Vercel | **Modal、ComfyUI**、浏览器、git |
| Modal Token(ak-/as-) | Modal 后台 | 本地插件配置 | Vercel、git |
| Bridge API Key | 插件部署时自动生成 | Modal Secret + Vercel(同一值) | 浏览器、git |
| BRIDGE_DELIVERY_TOKEN_SECRET | 自己生成 | 仅 Vercel | Modal、浏览器、git |
| CRON_SECRET | 自己生成 | 仅 Vercel | 浏览器、git |

自己生成的两个,各跑一次、**不要复用同一个值**:

```bash
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 32   # BRIDGE_DELIVERY_TOKEN_SECRET
```

**红线**:R2 长期密钥只在 Vercel,绝不进 Modal——Modal 每次只拿现签的短期预签名 PUT 链接。

---

## 三、执行八步

### 1. Vercel 拿稳定域名

Vercel 导入 GitHub 仓库,先随便部署一次,从 Settings → Domains 复制 Production 域名(形如 `https://xxx.vercel.app`)。后面所有 OAuth、CORS、Modal 回调都用这一个域名,**不要用带随机 hash 的 Preview 链接**。

### 2. Supabase 建库 + 跑迁移

新建 project,记下 URL、anon key、service_role key。SQL Editor 里**按编号顺序**执行 `supabase/migrations/0001` 到 `0010` 共 10 个文件(全新库一次跑完即可),最后执行:

```sql
notify pgrst, 'reload schema';
```

(刷新 API 层的表结构缓存,跳过这步首次请求可能报 `0A000` 错误。)

### 3. GitHub OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New。

- Homepage URL:你的 Vercel 域名
- **Authorization callback URL:`https://<project-ref>.supabase.co/auth/v1/callback`**

注意方向,这是最常踩的坑:

| 填在哪 | 填什么 |
|---|---|
| GitHub OAuth App | **Supabase** 的 `/auth/v1/callback` |
| Supabase Redirect URLs | **你网站**的 `/api/auth/callback` |

### 4. Supabase Auth 配置

Authentication → Providers 启用 GitHub(填 Client ID/Secret);URL Configuration 里 Site URL 填 Vercel 域名,Redirect URLs 加 `https://<域名>/api/auth/callback`。

### 5. R2 建桶 + Token + CORS

1. 建**私有** bucket(不开 public、不绑域名、用默认 jurisdiction——EU/FedRAMP 区的 endpoint 当前代码不支持)。
2. 建 API Token:权限 **Object Read & Write**,只限这个 bucket。记下 Access Key ID / Secret(只显示一次)、Account ID。
3. 配 CORS(否则浏览器拿不到图):bucket → Settings → CORS Policy,AllowedOrigins 填你的生产域名、方法 GET/HEAD。也可以跑仓库脚本 `node scripts/setup-r2-cors.mjs https://<域名>`(需要临时 Admin Token,用完即撤)。

### 6. Modal Bridge 部署 + 模型准备

1. ComfyUI Desktop 装 `comfyui_modal_bridge` 插件(Manager 搜 "Modal Bridge")。
2. 打开 ⚙️ Modal Setup,填 Modal workspace / Token ID / Token Secret,`AIGC Studio URL` 填生产域名,点部署。插件自动创建 App、Secret、模型 Volume,并生成 `BRIDGE_API_KEY`。
3. 同步模型(标准图片工作流需要三个文件,约 20GB):

```bash
cd ComfyUI/custom_nodes/comfyui_modal_bridge
python sync_models.py --type diffusion_models   # z_image_turbo_bf16.safetensors
python sync_models.py --type text_encoders      # qwen_3_4b.safetensors
python sync_models.py --type vae                # ae.safetensors
```

> 网站直调 Modal 时**不会**触发本地插件的提交前同步——首次验收前模型必须已在 Volume 里。

4. 从 `ComfyUI/user/default/modal_bridge/config.json` 读出 `modal_endpoint_base` 和 `bridge_api_key`。endpoint base 形如 `https://<workspace>--comfyui-bridge`,**不要**带 `-run.modal.run` 后缀(代码会自动拼)。

### 7. Vercel 填 env + Redeploy

Production 环境填:

```env
NEXT_PUBLIC_SITE_URL=https://<你的域名>
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
R2_ACCOUNT_ID=<...>
R2_ACCESS_KEY_ID=<...>
R2_SECRET_ACCESS_KEY=<...>
R2_BUCKET=<bucket 名>
AIGC_IMAGE_PROVIDER=modal-bridge
MODAL_BRIDGE_ENDPOINT_BASE=https://<workspace>--comfyui-bridge
MODAL_BRIDGE_API_KEY=<config.json 里的 bridge_api_key>
BRIDGE_DELIVERY_TOKEN_SECRET=<随机 hex>
CRON_SECRET=<另一个随机 hex>
```

两个注意:

- `AIGC_IMAGE_PROVIDER` 必须显式写 `modal-bridge`——默认值 `modal` 是遗留后端,会走错路。
- 改完 env **必须 Redeploy**,旧部署不会读到新值。
- Deployment Protection 先不开,省一层回调配置。

### 8. 验收

按顺序:

- [ ] GitHub 登录 → 进 `/portal`
- [ ] 提交标准文生图 → 状态流转到完成 → 作品库出图
- [ ] 未登录访问 `/api/library` 返回 401;R2 bucket 仍是私有
- [ ] 删除作品 → 库里立即消失
- [ ] 手动触发物理删除并确认 R2 对象已删:

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" https://<域名>/api/assets/cleanup
```

数据库层面的逐表检查 SQL 见详版第 10 节。

---

## 四、常见坑速查

| 症状 | 大概率原因 |
|---|---|
| 登录跳转报错 | 两套 callback 填反了(见步骤 3 的表) |
| 提交报 provider 未配置 | `AIGC_IMAGE_PROVIDER` 没写 `modal-bridge`,或三个 Bridge 变量缺失 |
| Modal 返回 401 | Vercel 的 `MODAL_BRIDGE_API_KEY` 和插件生成的 `bridge_api_key` 不一致 |
| Modal 报模型不存在 | 模型没同步到 Volume,或文件名不完全一致 |
| 出图了但网站没结果 | Modal Secret 的 `AIGC_STUDIO_BASE_URL` 不对,回调打不回来 |
| 作品库图片加载失败 | R2 CORS 没配,或 origin 和生产域名不完全一致 |
| 改了 env 没效果 | 忘了 Redeploy |
| 首次请求报 `0A000` | 迁移后没执行 `notify pgrst, 'reload schema'` |
| 任务卡 running | 等每日 03:30 reconcile 兜底,或手动 curl `/api/jobs/reconcile` |

## 五、Cron 说明

`vercel.json` 已声明两条,部署后在 Vercel → Cron Jobs 面板确认:

| UTC 时间 | 路径 | 职责 |
|---|---|---|
| 03:30 | `/api/jobs/reconcile` | 任务对账兜底 + 孤儿清理 |
| 04:00 | `/api/assets/cleanup` | 删除队列物理清理 |

Vercel Hobby 限制(2026-06 官方文档):每项目最多 100 条 Cron,但**每条最低每日一次**、触发精度 ±59 分钟。约束在频率不在条数;要更快的删除 SLA 就升级套餐或用外部 scheduler 带 `CRON_SECRET` 调同一端点。

## 六、安全红线

1. 密钥不进 git、不进截图、不进对话。
2. service_role、R2 密钥、Bridge Key、`CRON_SECRET` 只在 Vercel 服务端,永不带 `NEXT_PUBLIC_` 前缀。
3. **R2 长期密钥绝不进 Modal**;Modal 只拿短期预签名 PUT。
4. R2 bucket 保持私有,浏览器只拿短期签名链接。
5. 所有读写按登录会话的 `userId` 限定,不信浏览器传来的用户 ID。
