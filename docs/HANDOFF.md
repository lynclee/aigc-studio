# HANDOFF — AIGC Studio

给后续 Claude Code / Codex 会话的交接说明。开始前先看 `git status`,不要回退其他工作者的改动。
顶层愿景见 `docs/PLATFORM_OVERVIEW.md`;Modal Bridge 契约见 `docs/PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md`。

## 产品与主流程

设计 / 美术用的 AIGC 创作网站。**GitHub 登录(优先)/ Google-Gmail 登录** → 图片 / 3D / 视频 → 预设工作流 + prompt → 云端生成 → 个人作品库。部署在 Vercel,数据在 Supabase,资产在 Cloudflare R2。

- 认证:**Supabase Auth**,归属字段统一 `user_id`,只信服务端会话,绝不信浏览器传入身份。
- 完成条件:结果**成功落私有 R2 + 写 `aigc_assets`** 才算完成;不把 provider 临时链接当最终作品。
- 后台兜底:Vercel Cron 每天 `03:30` 调 `/api/jobs/reconcile`;页面打开时也逐任务 reconcile。

## 后端优先级

「优先」是部署默认与人工切换顺序,**不是自动 fallback**;失败要明确报错,不静默跨服务商扣费。

| 类型 | 第一 | 第二 | 第三 | 由谁选 |
|---|---|---|---|---|
| 图片 | Modal(`modal-bridge` / `modal-image`) | OpenRouter | fal | `AIGC_IMAGE_PROVIDER` |
| 视频 | Modal(`modal-bridge`) | (OpenRouter Video 待接) | fal | `AIGC_VIDEO_PROVIDER`(默认 fal) |
| 3D | Modal(`modal-bridge`) | fal | — | `AIGC_MODEL3D_PROVIDER`(默认 fal) |

## 两条 Modal 路径的区别

| | `modal-bridge`(当前主线) | `modal-image`(遗留) |
|---|---|---|
| 后端 | 用户维护的 `comfyui_modal_bridge` 插件(0.6.0) | 早期自研 art_ai worker |
| 协议 | body `auth_key` / status `?key=` | `Modal-Key`/`Modal-Secret` 头 |
| 结果交付 | Worker **直传 R2**(Vercel 签预签名 PUT)→ push 回调落库 | worker 返回 URL,Vercel 下载再存 R2 |
| R2 长期 key | **只在 Vercel**(Modal 只拿短期 PUT 地址) | 取决于 worker(旧模型) |
| kind | 图片/视频/3D 通用(按 workflow 分 kind) | 仅图片 |

新线走 `modal-bridge`;`modal-image` 保留只为兼容旧任务(靠 `job.provider` 分发)。

## aigc-r2 交付链路(核心)

```
用户提交 → Vercel 建 job + 签 delivery_token(HMAC,绑 job) → POST Bridge /run
  {workflow(按 kind 渲染), auth_key, needs_gpu/gpu_class, delivery:{mode:aigc-r2, job_id, token}}
Bridge worker 出片 → 逐文件调 /api/internal/asset-intake 换短期预签名 PUT → 直传 R2
  → POST /api/internal/job-complete {assets manifest}
Vercel job-complete → 领 reconcile 租约 → HeadObject 核验(size/ETag)+ Copy staging→final → finalize_job_assets RPC(fence)→ succeeded
  push 丢失时:reconcile 轮询 Bridge /status 拿 delivery.assets manifest 兜底恢复(同一套核验)
```

安全边界:R2 长期 key 只在 Vercel;Bridge 不可指定 r2_key 路径(服务端确定性生成);预签名 PUT 只锁 content-type、不锁 Content-Length;核验只信 R2 实际 size+ETag,不信 Bridge 上报 sha256;内部 endpoint 不走 getSession,只认 delivery_token + `x-vercel-protection-bypass`。

**不可变固化(Codex review 后加固)**:Bridge 只对 **staging key**(`.staging/…`)有 PUT 权限,**最终作品 key 从不发放 PUT**;job-complete/兜底核验 staging(强制比对 etag+size)后服务端 **Copy staging→final**,保证 succeeded 后作品不可被静默覆写。落库走 `finalize_job_assets` RPC(fence reconcile_token + 写 generation/assets + 置 succeeded,单事务原子),消除租约超时期间的中间写竞态。台账 identity 首次 intake 定死(同 tuple 恒返同 key)。

## 关键文件

| 文件 | 职责 |
|---|---|
| `app/page.tsx` / `app/portal/page.tsx` | 登录页 / 创作工作台(含尺寸·宽高比·参考图控件) |
| `app/api/auth/*` | GitHub/Google OAuth + Supabase 会话 |
| `app/api/generate/{image,model3d,video}` | 提交任务(经 `lib/jobs/submit-route.ts`) |
| `app/api/jobs*` / `reconcile` | 任务读取、状态同步、取消、Cron 兜底 + R2 孤儿清理 |
| `app/api/internal/asset-intake` / `job-complete` | **aigc-r2 内部 endpoint**(机器对机器,token 鉴权) |
| `lib/jobs/providers.ts` | provider 路由 + 分发(按 kind 选、按 `job.provider` 分) |
| `lib/engines/modal-bridge.ts` | Modal Bridge adapter(图片/视频/3D 通用) |
| `lib/engines/{modal-image,openrouter-image,fal-image,comfyui-image,fal-http}.ts` | 其它 provider adapter |
| `lib/delivery/{token,verify,uploads,cleanup,asset-policy,http}.ts` | delivery_token / HeadObject 核验 / 台账 / 孤儿清理 / 策略 |
| `lib/workflows/registry.ts` | 按 kind 渲染工作流(image=image-registry;video/3D=Bridge API 模板) |
| `lib/workflows/image-registry.ts` + `templates/*.json` | 图片工作流(含文生图 + 图生图 `z_image_turbo_i2i`);视频/3D 模板(seedance/tripo) |
| `lib/assets/r2-store.ts` / `lib/r2.ts` | R2 落库(URL 下载 + 字节直存)/ 预签名 GET·PUT / HeadObject / delete |
| `supabase/migrations/0001-0006` | 0002 主表;0004 上传台账;0005 原子落库 RPC;0006 租约 fencing + RPC 权限升级 |

## 数据模型

`aigc_jobs`(提交+provider 状态)→ `aigc_generations`(一次结果)→ `aigc_assets`(文件,`unique(job_id,asset_type,position)`)。
`aigc_job_uploads`:aigc-r2 在途上传台账,幂等 + 孤儿清理用。四表全开 RLS、无 policy(仅 service_role)。

## 部署同学必须完成

1. Supabase → Authentication → Providers 启用 GitHub 与 Google,填 Client ID/Secret;两者回调都填 `https://<project-ref>.supabase.co/auth/v1/callback`;Site URL / Redirect URLs 含网站 `/api/auth/callback`(本地加 localhost)。
2. SQL Editor 顺序执行 `0001`→`0006`;已有旧库先备份,只补执行未跑过的。即使已经执行过旧版 `0005`,也必须执行 `0006` 以应用租约 fencing 与 RPC 权限加固。
3. Vercel 环境变量(完整见 `.env.example`):
   - 基础:`NEXT_PUBLIC_SITE_URL`、两个 Supabase key、`SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET`、`R2_*`、`FAL_KEY`。
   - 图片 provider 按选择:Modal Bridge 用 `MODAL_BRIDGE_*` + `BRIDGE_DELIVERY_TOKEN_SECRET`(+ 生产域名有 Deployment Protection 时 `VERCEL_AUTOMATION_BYPASS_SECRET`);其它见 `.env.example`。
   - 视频/3D 走 Bridge:`AIGC_VIDEO_PROVIDER=modal-bridge` / `AIGC_MODEL3D_PROVIDER=modal-bridge`。
4. **Modal Secret**(部署插件时):`BRIDGE_API_KEY` + 用 API 节点(seedance/tripo/GPT Image 等)时加 `COMFY_API_KEY_COMFY_ORG`;可选 `AIGC_STUDIO_BASE_URL` / `AIGC_STUDIO_BYPASS_SECRET`。**R2 长期 key 绝不进 Modal**。
5. 若 Vercel 开 Deployment Protection,确认 OAuth 回调 + 内部 endpoint 可达(内部 endpoint 走 Protection Bypass for Automation)。

## 当前状态(诚实)

- **已完成 + 经审 + typecheck/build 通过**:aigc-r2 全链路(token/预签名/内部 endpoint/adapter/核验/reconcile 兜底/孤儿清理)、input 参数透传、UI 控件(尺寸·宽高比·参考图)、图生图(`z_image_turbo_i2i`)、视频/3D 通用化 + 文生视频(seedance)/文生 3D(tripo)接入、**多参考图**(seedance r2v / tripo i2model,可变 1~N 张 + video/3D 参考图上传 UI)。
- **待部署同学真跑一次**:**任一引擎端到端从未真跑过**。需配好 env + R2 + Modal Secret,跑一次文生图/视频/3D E2E。工作流模板(`z_image_turbo_i2i`、seedance t2v/r2v、tripo t2model/i2model)也需在真 ComfyUI 各验证一次(此环境跑不了 ComfyUI/Modal)。⚠️**多参考图欠槽裁剪**假设 `ByteDance2ReferenceNode` / `BatchImagesNode` 的图槽是 optional(少于满槽时删空槽节点+断开引用);若节点槽实为必填,不足满槽会报错——满槽(seedance 4 / tripo 3)一定安全,可变路径需真机确认。
- **待做**:OpenRouter Video adapter、视频/3D 的分辨率·时长·质量 UI 控件、hunyuan 3D 备选槽。

## 验证要求

```bash
npm run typecheck && npm run build
git diff --check
```
UI 改动后在 1920×1080 与 1080×1920 各验证一次(需登录会话)。真实 E2E 需部署同学的 provider / Supabase / R2 配置。
