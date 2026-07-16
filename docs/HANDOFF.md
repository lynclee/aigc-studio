# HANDOFF — AIGC Studio

给后续 Claude Code / Codex 会话的交接说明。开始前先看 `git status`,不要回退其他工作者的改动。
顶层愿景见 `docs/PLATFORM_OVERVIEW.md`;Modal Bridge 契约见 `docs/PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md`;从账号、Token、权限到首轮 E2E 的部署步骤见 `docs/CODEX_DEPLOYMENT_RUNBOOK.md`(详版)与 `docs/CLAUDE_DEPLOYMENT_RUNBOOK.md`(简明版,术语带注释)。

## 产品与主流程

设计 / 美术用的 AIGC 创作网站。**GitHub 登录(优先)/ Google-Gmail 登录** → 图片 / 3D / 视频 → 预设工作流 + prompt → 云端生成 → 个人作品库。部署在 Vercel,数据在 Supabase,资产在 Cloudflare R2。

- 认证:**Supabase Auth**,归属字段统一 `user_id`,只信服务端会话,绝不信浏览器传入身份。
- 完成条件:结果**成功落私有 R2 + 写 `aigc_assets`** 才算完成;不把 provider 临时链接当最终作品。
- 后台兜底:Vercel Hobby Cron 每天 `03:30` 调 `/api/jobs/reconcile`;页面打开时也逐任务 reconcile。用户删除后的 R2 队列由独立 `/api/assets/cleanup` 每天 `04:00` 在 45 秒预算内最多 drain 100 条，reconcile 开头另保留一批前置兜底。

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
| `app/api/library/[id]` / `app/api/assets/cleanup` / `lib/assets/delete.ts` | owner-only 作品删除；原子 tombstone+入队、独立 Cron、带 claim/lease/token fence 的异步 R2 清理 |
| `app/api/internal/asset-intake` / `job-complete` | **aigc-r2 内部 endpoint**(机器对机器,token 鉴权) |
| `lib/jobs/providers.ts` | provider 路由 + 分发(按 kind 选、按 `job.provider` 分) |
| `lib/engines/modal-bridge.ts` | Modal Bridge adapter(图片/视频/3D 通用) |
| `lib/engines/{modal-image,openrouter-image,fal-image,comfyui-image,fal-http}.ts` | 其它 provider adapter |
| `lib/delivery/{token,verify,uploads,cleanup,asset-policy,http}.ts` | delivery_token / HeadObject 核验 / 台账 / 孤儿清理 / 策略 |
| `lib/workflows/registry.ts` | 按 kind 渲染工作流(image=image-registry;video/3D=Bridge API 模板) |
| `lib/workflows/image-registry.ts` + `templates/*.json` | 图片工作流(含文生图 + 图生图 `z_image_turbo_i2i`);视频/3D 模板(seedance/tripo) |
| `lib/workflows/definitions.ts` | Phase 1 代码内工作流目录：公共元数据、provider-effective input schema、执行变体、参考图能力、模板版本、输出契约 |
| `lib/workflows/revision.ts` | Job 级不可变 workflow snapshot：固定 definition revision、provider execution、模板版本与输出契约；仅双空旧任务临时回退当前 Catalog |
| `lib/workflows/validate-template.ts` / `output-contract.ts` | 启动期模板完整性校验 / 所有 provider 共用的产物集合完整性校验 |
| `lib/assets/r2-store.ts` / `lib/r2.ts` | R2 落库(URL 下载 + 字节直存)/ 预签名 GET·PUT / HeadObject / delete |
| `supabase/migrations/0001-0010` | 0002 主表;0004 上传台账;0005 原子落库 RPC;0006 租约 fencing + RPC 权限升级;0007 workflow revision/snapshot 一致性与冻结;0008 强制新 Job 携带 snapshot;0009 Generation tombstone + Asset 删除队列/fence;0010 ops-only 死信重驱动、不可变审计与聚合 backlog |

## 数据模型

`aigc_jobs`(提交+provider 状态)→ `aigc_generations`(一次结果,`deleted_at` 为用户删除 tombstone)→ `aigc_assets`(文件,`unique(job_id,asset_type,position)`,`active → pending_delete → deleted/error`)。
`aigc_job_uploads`:aigc-r2 在途上传台账,幂等 + 孤儿清理用。`aigc_asset_delete_redrive_events`:只追加的运维重驱动审计，不存 R2 key、原始异常或凭据。所有表开 RLS、无浏览器 policy；服务端只用 service_role，审计表对 service_role 也只开放直读，写入只能经受限 RPC。

## 部署同学必须完成

1. Supabase → Authentication → Providers 启用 GitHub 与 Google,填 Client ID/Secret;两者回调都填 `https://<project-ref>.supabase.co/auth/v1/callback`;Site URL / Redirect URLs 含网站 `/api/auth/callback`(本地加 localhost)。
2. 全新环境在 SQL Editor 顺序执行 `0001`→`0010`。已有旧库先备份并只补未执行的 migration；详细顺序、数据审计和 canary 见下方「发布门禁」。即使已执行过旧版 `0005`，也必须执行 `0006` 以应用租约 fencing 与 RPC 权限加固。
3. Vercel 环境变量(完整见 `.env.example`):
   - 基础:`NEXT_PUBLIC_SITE_URL`、两个 Supabase key、`SUPABASE_SERVICE_ROLE_KEY`、`CRON_SECRET`、`R2_*`、`FAL_KEY`。
   - 图片 provider 按选择:Modal Bridge 用 `MODAL_BRIDGE_*` + `BRIDGE_DELIVERY_TOKEN_SECRET`(+ 生产域名有 Deployment Protection 时 `VERCEL_AUTOMATION_BYPASS_SECRET`);其它见 `.env.example`。
   - 视频/3D 走 Bridge:`AIGC_VIDEO_PROVIDER=modal-bridge` / `AIGC_MODEL3D_PROVIDER=modal-bridge`。
4. **Modal Secret**(部署插件时):`BRIDGE_API_KEY` + 用 API 节点(seedance/tripo/GPT Image 等)时加 `COMFY_API_KEY_COMFY_ORG`;可选 `AIGC_STUDIO_BASE_URL` / `AIGC_STUDIO_BYPASS_SECRET`。**R2 长期 key 绝不进 Modal**。
5. 若 Vercel 开 Deployment Protection,确认 OAuth 回调 + 内部 endpoint 可达(内部 endpoint 走 Protection Bypass for Automation)。
6. 本项目默认兼容 Vercel Hobby，因此两个 Cron 都保持每日一次并错峰；若生产删除 SLA 要求短于 24 小时，升级套餐或使用可控外部 scheduler，以同样的 `Authorization: Bearer $CRON_SECRET` 更频繁调用 `/api/assets/cleanup`。

### 发布门禁（部署同学必须逐项完成）

1. **迁移顺序不可颠倒。** 全新库执行 `0001→0010`。从旧版滚动升级 workflow snapshot 时必须 `0007` → 部署会写 snapshot 的版本 → `0008`；资产删除版本必须 `0009` → `0010` → 再部署会过滤 `deleted_at/state`、调用 `asset_delete_backlog_counts()` 的当前应用。不要在旧代码仍写无 snapshot Job 时提前执行 `0008`。
2. **首次提升 workflow revision 前排空 legacy active Job。** 运行 `select count(*) from public.aigc_jobs where status in ('queued','running') and workflow_snapshot is null;`，结果必须为 `0`；否则先 reconcile/终止，不让旧任务被新 Catalog 语义解释。
3. **审生产 R2 key 权威格式。** 发布删除 worker 前按下方查询分类，`unknown` 必须为 `0`；同时确认旧 OpenRouter Generation 的 `provider_job_id` 不缺失。无法归类的历史资产先迁移/豁免评审，不能靠放宽删除前缀解决。
4. **评估 `0009/0010` 锁窗口。** 先看 `aigc_assets` / `aigc_generations` 估算行数和总大小；小表直接维护窗口执行。主要风险在 `0009`：它会新增多列、校验 4 个未使用 `NOT VALID` 的 CHECK，并创建 3 个非 `CONCURRENTLY` 索引；约束变更会持有强锁，普通建索引也会扫描全表并阻塞写入。`0010` 的 version CHECK 已使用 `NOT VALID → VALIDATE`，但 error partial index 仍会扫描现有表。大表需另做经 review 的分阶段迁移（例如 `NOT VALID`、`CREATE INDEX CONCURRENTLY`、再 `VALIDATE`），不能临时改已发布 migration 或在业务高峰硬跑。
5. **确认 Cron 配额和鉴权。** `vercel.json` 当前两条每日 Cron（03:30 reconcile、04:00 cleanup）。按 Vercel 官方限制（2026-06 文档），Hobby 每项目最多 100 条 Cron，但每条最低每日一次且触发精度 ±59 分钟——约束在频率而非条数。缺失/错误 `CRON_SECRET` 必须 401 且 cleanup/backlog 零调用，正确鉴权响应只能含聚合计数。

R2 key 分类审计（只输出类别与数量，不导出 key）：

```sql
with keyed as (
  select asset.r2_key,
         asset.user_id,
         asset.job_id::text as job_id,
         generation.provider,
         generation.provider_job_id,
         coalesce(nullif(left(regexp_replace(asset.user_id, '[^A-Za-z0-9_-]', '_', 'g'), 160), ''), 'item') as user_segment,
         coalesce(nullif(left(regexp_replace(asset.job_id::text, '[^A-Za-z0-9_-]', '_', 'g'), 160), ''), 'item') as job_segment,
         coalesce(nullif(left(regexp_replace(generation.provider_job_id, '[^A-Za-z0-9_-]', '_', 'g'), 160), ''), 'item') as provider_segment
    from public.aigc_assets asset
    join public.aigc_generations generation on generation.id = asset.generation_id
   where asset.r2_key is not null and btrim(asset.r2_key) <> ''
), classified as (
  select case
    when left(r2_key, char_length('aigc/' || user_id || '/' || job_id || '/')) = 'aigc/' || user_id || '/' || job_id || '/' then 'current_aigc'
    when left(r2_key, char_length(user_segment || '/' || job_segment || '/')) = user_segment || '/' || job_segment || '/' then 'current_direct'
    when provider_job_id is not null and left(r2_key, char_length(user_segment || '/' || provider_segment || '/')) = user_segment || '/' || provider_segment || '/' then 'legacy_provider_job'
    else 'unknown'
  end as key_format
  from keyed
)
select key_format, count(*) from classified group by key_format order by key_format;

select count(*) as legacy_openrouter_without_provider_job_id
from public.aigc_generations
where provider like 'openrouter%' and provider_job_id is null;

select oid::regclass as relation,
       reltuples::bigint as estimated_rows,
       pg_size_pretty(pg_total_relation_size(oid)) as total_size
from pg_class
where oid in ('public.aigc_assets'::regclass, 'public.aigc_generations'::regclass)
order by relation;
```

### 资产删除死信监控与重驱动 Runbook

- backlog 正常时，cleanup 响应包含 `pendingTotal/pendingDue/pendingLeased/retryWait/deadletterDue/errorTotal` 与最老时间；也可在 SQL Editor 执行 `select public.asset_delete_backlog_counts();`。`error_total > 0` 或 pending 连续两天不下降即告警。观测 RPC 失败不回滚已提交的删除批次：route 返回 200、`assetDeleteBacklog: null`，并写稳定的 monitor error 日志；此时必须单独修复监控，不能把 `null` 当成零 backlog。
- 先检查稳定 `delete_error`、R2 凭据/权限、跨用户活引用与 key 分类。**不要**把 R2 key、原始异常、密钥写进 actor/reason 或工单公开字段。
- 只有已 tombstone、owner/job/generation 一致、key 属于当前或受控 legacy namespace 的 `error` 资产能重驱动；普通用户重复 DELETE 不会重置死信。
- 修复根因后由 service-role 运维身份执行一次：

```sql
-- 只列运维所需的稳定字段；谓词与排序匹配 error partial index，可供 planner 使用。
select id, delete_redrive_version, delete_attempts, delete_error, delete_requested_at
from public.aigc_assets
where state = 'error'
order by delete_requested_at asc
limit 100;

select id, delete_redrive_version, delete_attempts, delete_error
from public.aigc_assets
where id = '<asset-uuid>'::uuid and state = 'error';

select public.redrive_asset_delete(
  '<asset-uuid>'::uuid,
  0, -- 替换为上一步刚读到的 delete_redrive_version
  'ops.alice',
  'r2_access_restored'
);
```

  调用前从同一资产读取当前 `delete_redrive_version`，把它作为 CAS 版本传入；旧命令重放或并发操作者只能有一个成功。`actor` 只允许可归责标识，`reason` 只允许小写稳定码。成功必须返回 `requeued=true`、资产变 `pending_delete/attempts=0`，version 加一，且 `aigc_asset_delete_redrive_events` 恰好新增一条；下一轮 cleanup 应使 pending 下降。若返回 `requeued=false`、RPC 拒绝、或资产再次进入 `error`，立即停止盲目重置并重新调查。
- 生产启用前做一次 canary：合法 tombstone+error 行应成功；未 tombstone、owner 不一致、越权 key 三组应全部拒绝且不写审计。上线前必须用真实 PostgreSQL 验证：anon/authenticated 调 backlog/redrive 均 permission denied，service_role 成功；两连接并发重驱动同一资产时只能有一条审计。仓库当前只有 SQL contract 测试，不得把它当成真实数据库并发/RLS 证据。
- 执行 `0010` 后刷新 Supabase/PostgREST schema cache 与连接，再跑首次 cleanup/reconcile；若首次请求报 PostgreSQL `0A000 cached plan must not change result type`，刷新连接后重试并确认告警消失。原因是 `0010` 给 `aigc_assets` 增加了列，而 `claim_pending_asset_deletes()` 返回该表的复合类型 `setof public.aigc_assets`。
- 当前没有静默清除永久死信的 `abandoned` 状态。若 authority/key 约束导致无法 redrive，保持 `error` 告警、禁止裸写 `UPDATE` 绕过审计，并升级为单独的数据保留/合规事件；未来若引入终态豁免，必须另做带 actor/reason、不可变审计和独立 backlog 的设计评审。

## 当前状态(诚实)

- **已完成 + 独立 review + test/typecheck/build 通过**:aigc-r2 全链路、input 参数透传、图生图、视频/3D 与多参考图工作流。Batch1 新增 PNG/JPEG/WebP/GIF signature/MIME 校验、两阶段大小预检、7 模板启动期完整性校验、模板变量非递归替换。Batch2 新增 Phase 1 `WorkflowDefinition` Catalog：Portal 工作流列表/现有参数控件、API allowlist/schema、provider execution/reference、template version、aigc-r2 与 URL/direct provider 输出核验共同消费同一目录；Fal/OpenRouter effective schema 不再展示/接受会被忽略的参数；所有 provider 都拒绝 preview-only 完成；浏览器 public catalog/API/generation 不暴露 provider/variant/env。Batch3 已实现不可变 workflow revision/job snapshot。Batch4 已实现资产删除后端闭环：`DELETE /api/library/[id]` 只信 session owner；`0009` 在单事务中 tombstone Generation 并队列全部 Asset；所有公开读取立即过滤删除项；独立错峰 Cron 用 `FOR UPDATE SKIP LOCKED` + lease/token fence 删除 final/staging，跨用户活引用会阻止物理误删；失败按 30/60/120/240 秒退避，最多 5 次后进入 `error` 死信。`0010` 增加 ops-only 单行重驱动、不可变/无敏感数据审计和 aggregate backlog；没有普通用户重驱动 route。
- **待部署同学真跑一次**:**任一引擎端到端从未真跑过**。需配好 env + R2 + Modal Secret,跑一次文生图/视频/3D E2E。工作流模板(`z_image_turbo_i2i`、seedance t2v/r2v、tripo t2model/i2model)也需在真 ComfyUI 各验证一次(此环境跑不了 ComfyUI/Modal)。当前明确拒绝 Seedance 1~3 张和 Tripo 1~2 张欠槽输入;逐数量真机验证后才能放宽能力矩阵。
- **待做**:参考图先直传 job-scoped R2 staging(当前 inline data-uri 有 3MiB 合计保护)、OpenRouter Video adapter、视频/3D 的分辨率·时长·质量 UI 控件。Catalog 下一阶段做按 workflow 路由 provider 与通用 `parameters[] + binding`；当前仍是代码注册式 Phase 1，不应宣称已达到 DB/UGC 的“只加数据不发版”。

删除语义:RPC 提交后 Library/Job 结果立即不再返回或新签名该作品；物理 R2 删除是最终一致的，Hobby 默认调度下通常在下一次错峰 Cron（最长约 24 小时）处理。此前已发放的 GET 预签名 URL 最长仍可使用约 1 小时，但对象被 Cron 提前删除后会立即失效。`error` 资产不会被重复 DELETE 重置重试次数；必须先修根因，再按上方 Runbook 通过 ops-only RPC 单项重驱动并保留审计。

Workflow snapshot 只冻结在途任务的**执行身份与交付契约**；MIME、大小、鉴权、归属、租约等全局安全策略继续使用部署时最新规则。`workflow_revision` 与 `workflow_snapshot` 同时为空的迁移前旧任务会临时回退当前 Catalog；首次提升任一 definition revision 前，应先让这批 active legacy jobs 完成或终止，避免旧任务被新目录语义解释。

首次 bump 前的发布门禁：`select count(*) from public.aigc_jobs where status in ('queued','running') and workflow_snapshot is null;` 必须返回 `0`。

修改 provider execution mapping、execution variant、template version、参考图数量语义或 output contract 时，必须提升该 definition 的 `revision`；同一个 `(kind, workflow_id, revision)` 不得原地改变语义。旧 execution variant / 模板 artifact 至少保留到对应 active jobs 排空；标题、提示文案、样式等非执行变化无需 bump。

未来增加 snapshot schema v2 时必须新增版本分派并继续保留 v1 parser；不得直接把 v1 常量改成 v2 后删除历史解析路径。

## 验证要求

```bash
npm test && npm run typecheck && npm run build
git diff --check
```
UI 改动后在 1920×1080 与 1080×1920 各验证一次(需登录会话)。真实 E2E 需部署同学的 provider / Supabase / R2 配置。
