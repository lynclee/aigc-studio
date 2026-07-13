# Playground 架构比对与采纳建议

> 深度比对 `../v0-nano-banana-pro-playground`(架构母本)与 aigc-studio，并记录 Batch1/Batch2 采纳结果。
> 目的:找出 playground 有用但 aigc-studio 仍缺、值得移植/参考的模块。
> 方法:读 playground 核心文件(jobs/repository.ts / assets/repository.ts / image-engine/engine-client.ts / generation-kernel/workflow-contract.ts)+ Grep 双向确认 aigc-studio 缺口。

## 执行原则与当前采纳状态

Playground 是实现参考库,**不是 aigc-studio 的产品路线图**。执行顺序始终服从 `PLATFORM_OVERVIEW`:

1. 先完成 Stage 0:至少一条真实工作流跑通登录→生成→R2→入库→作品库。
2. 再用真实链路暴露的缺口决定采纳顺序,不为了“搬功能”整体复制 Playground。
3. 保留 aigc-studio 已有的 delivery token / staging→final / lease fence / 原子 finalize 强语义。

当前已采纳:

- workflow + provider 参考图 capability 矩阵(UI 与服务端共用)。
- fal video 禁止参考图、fal 3D 保留 1~4 视图、Modal Bridge 未真机验证前只开放完整槽位。
- catalog workflow / execution variant / template version 分离并跨 poll/cancel 持久保留。
- inline 参考图 3MiB 合计边界与稳定 API 错误码。
- PNG/JPEG/WebP/GIF signature sniff + 声明 MIME 一致性校验；先做全量大小预检，再分配解码 Buffer。
- 7 个 ComfyUI 模板启动时静态校验（节点、占位符、连接、参考槽、主输出、可达性）与非递归模板替换。
- `WorkflowDefinition` 代码内目录：公共元数据、provider-effective input schema、执行变体、参考图能力、模板版本、输出契约成为 UI/API/renderer/adapter/交付核验共同数据源。
- 输出完整性统一覆盖 aigc-r2 与 URL/direct provider；video/model preview 按 image 类别核验，作品库按 output contract 选择主资产与预览。
- 浏览器只接收 public catalog；generation/API 错误不再暴露 provider/variant/env 名。
- 资产删除后端闭环：owner-only DELETE、单事务 Generation tombstone + Asset queue、跨用户活引用闸门、claim lease/token fence、5 次有界重试与 dead-letter；`0010` 再补 aggregate backlog、ops-only 单项重驱动和不可变审计，普通用户重复 DELETE 不会复活死信。

当前定位是**带不可变 Job snapshot 的高质量 Phase 1 代码内 Catalog**，不是最终平台级“加一条数据即可上线”。仍未落地：input R2 staging、按 workflow 路由引擎、通用 parameters/bindings、DB/UGC 工作流目录。

## 0. 架构定位差异

| 维度 | aigc-studio | playground |
|---|---|---|
| 产物交付 | **aigc-r2 直传**(Bridge 直传 R2 + push 回调,主线) | provider 返回 URL -> Vercel 下载 -> 存 R2(旧模式) |
| 状态机 | application 层(claimJobForReconcile + finalize_job_assets RPC fence + lease_until) | **CAS + DB trigger**(`transitionJob` with `fromStatuses` + `enforce_job_state_transition`) |
| 资产生命周期 | **已实现更强的原子 tombstone + pending_delete + fenced 异步重试** | tombstone + pending_delete 队列 + 异步重试(参考实现无事务/claim fence) |
| 工作流抽象 | **Phase 1 代码内 WorkflowDefinition Catalog + immutable Job snapshot**；通用参数 binding / DB 化待做 | **workflow-contract 契约层**(capability 声明 + validate) |
| Engine 抽象 | providers.ts switch 分发,5 adapter 无统一 interface | **EngineClient interface**(submit/status/cancel/health) |
| 历史/UI | listUserLibrary(API 每次),无前端缓存 | **3 层历史**(L1 localStorage + L2 Supabase + L3 签名缓存) |
| 积分 | 无(设计师免费) | credit_events 账本(begin_job_submission/refund + business_key 幂等) |
| JobStatus | 5 状态(queued/running/succeeded/failed/cancelled) | 7 状态(created/submitted/queued/running/completed/failed/cancelled) |

**关键判断**:aigc-studio 在 **aigc-r2 直传链路**上比 playground 更先进(playground 无此机制);但 playground 在**资产生命周期、状态机 DB 约束、工作流契约、Engine 抽象、前端缓存**上更成熟。两者互补。

## 1. P0 移植候选(填补功能/安全缺口)

### 1.1 资产删除:tombstone + pending_delete 队列 ⭐ 最高价值

**采纳状态:✅ 后端闭环已完成。** `0009_aigc_asset_deletion.sql` 扩展现有 generation/assets 权威表，没有复制 Playground 的第二套资产模型。

**playground 参考**:
- `lib/assets/repository.ts:201-254` `tombstoneGenerationAndQueueAssets`:generation 置 `status=deleted`(软删 tombstone)+ assets 置 `state=pending_delete`
- `lib/assets/repository.ts:256-340` `processPendingAssetDeletes`/`processPendingAssetDeleteBatch`:异步删 R2 对象,**5 次重试**(`delete_attempts` >= 5 -> `error` 状态),失败不阻断批次
- `lib/assets/repository.ts:46-62` `registerAsset` 用 `upsert_owned_asset` RPC(migration `20260610180000`):**原子 owner 守卫**(`INSERT...ON CONFLICT...WHERE user_id=excluded.user_id`),防 TOCTOU 静默改 owner
- `lib/assets/repository.ts:307-309` `derivedSiblingKeys`(lib/r2.ts):mesh GLB 的派生兄弟件(rendition + 多格式导出)随基件清理,防孤儿
- `app/api/generations/delete/route.ts`:删除 route 入口
- `app/api/assets/cleanup/route.ts`:独立清理 route(vs aigc-studio 内联在 reconcile)

**实际实现(没有照搬参考缺陷)**:
- `tombstone_generation_assets` 在一个 DB 事务内做 owner/job/asset 一致性校验、锁 Generation、写 tombstone 并队列全部 Asset；重复 DELETE 不重置 pending/error/deleted 或 attempts。
- `claim_pending_asset_deletes` 用 `FOR UPDATE SKIP LOCKED`、claim token 与 lease；失败按 30/60/120/240 秒退避；`complete_asset_delete` 按 token fence，最多 5 次后进入 `error`，过期第五次 claim 由另一个 bounded/SKIP LOCKED RPC 转死信并计数。
- `lib/assets/delete.ts` 删除每个资产的 final + delivery staging sibling；preview/其它 provider 输出本身是独立 Asset 行，会单独入队。任何其他用户/作品的 active row 仍引用相同 key 时，逻辑删除当前行但保留共享物理对象。
- `app/api/library/[id]/route.ts` 只接受 session owner；Library 与 Job 结果查询只认未 tombstone Generation + active Asset，serializer 也不会为非 active 资产签新 URL。
- 独立 `/api/assets/cleanup` 与 reconcile 每日错峰；独立 route 在 45 秒预算内最多 drain 4×25 条，reconcile 最前面再保留一批兜底，以兼容项目既定 Vercel Hobby 目标。单项失败不阻断批次，错误只落稳定码，不保存/返回 R2 key 或原始异常。
- `0010_asset_delete_operations.sql` 把死信处置限定为 service-role：只允许已调查的单行 `error → pending_delete`，重新校验 tombstone/owner/key namespace，attempts 归零但写一条不可变审计；Cron/SQL 监控只给 pending/due/leased/error 聚合数。没有用户重驱动 API，避免“再次点删除”无限刷新失败预算。

**成本**:中(1 migration + 1 repository + 1 route + cron 扩展)。**价值**:填补功能缺口 + 合规。

### 1.2 DB Job 状态转换约束

**当前状态:**项目已经有三类 DB 级防线：`0007-0008` 冻结并强制 workflow snapshot，`0009` 用 CHECK + claim/token RPC fence 约束资产删除状态，`0010` 用 append-only trigger 保护重驱动审计。但 **Job `status` 合法转换白名单**仍由 application CAS + `finalize_job_assets` RPC fence 维护；尚无 `enforce_job_state_transition` trigger。这里是 defense-in-depth 待办，不再是资产删除或 workflow revision 的上线阻塞项。

**playground 参考**:
- `supabase/migrations/20260608182124_establish_jobs_authority.sql`:`enforce_job_state_transition` trigger + 合法转换白名单(如 `cancelled->running` 非法)
- `supabase/migrations/20260608194100_freeze_jobs_authoritative_fields.sql`:冻结 authoritative 字段(provider_job_id 等)防 application 误改
- `lib/jobs/repository.ts:134-170` `transitionJob`:CAS `.in("status", fromStatuses)` + `requireNoCancelRequest`(`.is("cancel_requested_at", null)`)

**后续建议**:
- 加 migration:在 `aigc_jobs` 上建 `enforce_job_state_transition` trigger,白名单合法转换(queued->running->succeeded/failed/cancelled,running->cancelled)
- aigc-studio 的 5 状态比 playground 7 状态简单,trigger 更小
- **与现有 finalize_job_assets RPC fence 互补**:RPC fence 防"租约过期落库",trigger 防"非法状态转换"。两者正交。

**成本**:低(一个 trigger migration)，但必须先以真实 provider/取消/reconcile 轨迹锁定转换白名单，避免 trigger 误伤恢复路径。**价值**:DB 层最后防线，防 application bug/直接 SQL 绕过。

### 1.3 输入真实性校验 + 参考图 R2 staging

**当前状态**:inline data-uri 已有 3MiB 合计保护，并完成 PNG/JPEG/WebP/GIF signature sniff 与声明 MIME 对比；这仍是文件头真实性检查，不是完整图片解码。图片正文仍会经过 Vercel 并写入 job request。

**playground 参考**:
- `lib/upload-policy.ts`:PNG/JPEG/WebP magic-byte sniff、声明 MIME 与真实 MIME 对比、单文件/合计大小限制。
- 输入资产先持久化再向引擎传引用的模式,避免大 data-uri 贯穿请求与数据库。

**采纳状态 / 下一步**:
- ✅ Batch1 已补 magic-byte(signature)校验与两阶段大小预检。
- inline E2E 跑通后,改成浏览器申请 job-scoped R2 PUT→直传 input staging→job 保存 asset ID→Bridge 拿短期 GET。
- 这是多参考图真正解除 4.5MB 部署边界的正式方案。

## 2. P1 移植候选(对齐愿景 + 改进)

### 2.1 workflow-contract 契约层(对齐 PLATFORM_OVERVIEW "工作流即数据")

**aigc-studio 当前状态**:Batch2 已把 `lib/workflows/capabilities.ts` 收敛为兼容转发层，权威数据位于 `lib/workflows/definitions.ts`。工作流标题、provider-effective input schema、输出契约、模板版本、provider execution mapping 已共同驱动 Portal、API、renderer、adapter 与两条资产交付路径。

**playground 参考**:
- `lib/generation-kernel/workflow-contract.ts:11-26` `resolveWorkflowContract`:enabled/cost/mode/capabilities 声明 + 校验
- `lib/generation-kernel/workflow-contract.ts:28-58` `validateGenerationRequest`:mode 匹配 + prompt/inputs 非空 + **capability 校验**(supportsFileInput/UrlInput/AssetInput/meshViewSet)
- `GenerationKernelError`(UNKNOWN_WORKFLOW/DISABLED_WORKFLOW/INVALID_COST/MODE_MISMATCH/NO_INPUT/UNSUPPORTED_*)
- `lib/generation-kernel/` 整体:orchestrator/asset-plan/credit-policy/types(纯函数无副作用,workflow contract 唯一权威)

**已完成 / 后续演进**:
- ✅ 已扩为 `WorkflowDefinition{inputSchema,outputContract,executions}` 代码内唯一目录。
- ✅ UI 工作流列表/现有参数控件、API 校验、provider 变体和输出核验共同消费定义。
- ✅ 已补不可变 definition revision / Job snapshot；新任务固定 provider execution、模板、参考图形状与 output contract，旧定义退役后在途任务仍按原契约完成。
- 下一步演进为通用 `parameters[] + binding`，最后抽到 DB(PLATFORM_OVERVIEW Phase 2)。
- **不要照搬 cost/credit**(aigc-studio 无积分)

**成本**:高(重构 workflows/ + 参数 Schema)。**价值**:对齐核心愿景,为"上百工作流"铺路。可渐进。

### 2.2 EngineClient interface 统一

**aigc-studio 缺口**(Grep 确认):无 `EngineClient`/`NormalizedStatus`。`providers.ts` switch 分发 5 个 adapter(modal-bridge/modal-image/fal-image/openrouter-image/comfyui-image),无统一契约。每个 adapter 的 submit/status/cancel 签名各异。

**playground 参考**:
- `lib/image-engine/engine-client.ts:10-31` `EngineClient` interface:`submit/status/cancel/health` 四方法
- `lib/image-engine/types.ts`:`NormalizedStatus` 5 值(queued/running/completed/failed/cancelled)+ `EngineJob`(含 `wasRunningAtCancel` 退款决策)
- `lib/image-engine/factory.ts`:`getEngineClient(engine)` 工厂
- adapter 实现(modal-client/runpod-client/openrouter-client/fal-client)各自 implement

**移植建议**:
- 定义 `lib/engines/engine-client.ts` interface(submit/status/cancel,health 可选 -- aigc-studio 非自动 fallback,health 价值低)
- 让现有 5 adapter 实现 interface(渐进,先 modal-bridge)
- `providers.ts` switch 改为 factory + interface 调用
- `NormalizedStatus` 对齐 `JobStatus`(aigc-studio 已有 5 状态,基本一致)

**成本**:低(定义 interface + 渐进 implement)。**价值**:代码组织 + 为未来 provider 扩展铺路。

### 2.3 3 层历史(usePersistentHistory)

**aigc-studio 缺口**(Grep 确认):无 `localStorage`/`usePersistentHistory`。作品库是 `listUserLibrary`(API 每次),无 L1 缓存。

**playground 参考**:
- `components/image-combiner/hooks/use-persistent-history.tsx`:L1 localStorage 即时 paint + L2 Supabase 后台 sync(30s tab 会话缓存)+ L3 签名 URL cache
- dedupe by `supabaseId || id`(不按 prompt+imageUrl)
- `savedToSupabase` 标记:remote 全收 + local `savedToSupabase=false` 保留

**移植建议**:
- aigc-studio 的 `app/api/library/route.ts` + portal-workbench 作品库,加 `usePersistentLibrary` hook:L1 localStorage 缓存最近 N 个作品(即时显示)+ L2 Supabase 拉取更新
- 签名 URL 缓存:复用 playground 的 `signed-url-cache.ts`(micro-batch 8ms + 并发≤4 + user-scoped + auth 变更清缓存)

**成本**:中(前端 hook + 缓存策略)。**价值**:作品库加载 UX。

### 2.4 cancel 意图分离(cancel_requested_at)

**aigc-studio 现状**:`markJobCancelled` 直接置 cancelled + 租约检查(`store.ts:411`)。cancel 与 finalize 的竞态已由租约 fence 解决(我 4 轮 review 确认)。

**playground 参考**:
- `lib/jobs/repository.ts:111-132` `requestJobCancellation`:只标记 `cancel_requested_at` + `cancel_reason`,不直接置 cancelled;`.in("status",["created","submitted"])`(running 后只能请求)
- `transitionJob` 的 `requireNoCancelRequest`:`.is("cancel_requested_at", null)` 防 cancel 后 transition
- sweep/finalize 时检查 cancel_requested_at 决定真取消 + 退款

**移植建议**:
- aigc-studio 的租约 fence 已解决竞态,所以"意图分离"是**锦上添花**(更细 cancel 语义 + 审计)
- 加 `cancel_requested_at` + `cancel_reason` 字段,cancel route 改为"请求"(不直接置 cancelled),由 reconcile/finalize 决定真取消
- aigc-studio 无积分,退款不适用,但 cancel 意图审计有价值

**成本**:低。**价值**:中等(审计 + 更细语义,非必须)。

### 2.5 R2 直连下载 + 批量 ownership/签名

**playground 参考**:
- `app/api/download-image/route.ts`:服务端 ownership 校验后签 `Content-Disposition: attachment`,浏览器直连 R2 下载。
- `lib/assets/r2-ownership.ts` + `app/api/r2-sign/route.ts`:一次鉴权、一次批量所有权查询、N 次本地 presign。
- `signed-url-cache.ts`:用户隔离缓存 + micro-batch + 并发限制。

**采纳建议**:作品库真实数据量上来后实施;先做直连下载与批量签名,再做客户端缓存。TTL 由服务端返回,不照搬固定 7 天。

## 3. P2 不适用/低价值

| 模块 | 原因 |
|---|---|
| `credit_events` 账本 + `begin_job_submission`/`refund_job_credits` RPC | aigc-studio 无积分(设计师免费)。`business_key` 幂等模式可参考,但 aigc-studio 已有 `unique(job_id,asset_type,position)` 幂等 |
| `complete_remesh_job_with_variants` 原子 RPC | playground 特有 mesh remesh 流程,aigc-studio 无 remesh。但"注册 asset + transition job 单事务"模式,aigc-studio 的 `finalize_job_assets` RPC 已类似 |
| mesh 优化(`lib/mesh/optimize.ts` + @gltf-transform + meshoptimizer) | aigc-studio 3D 刚起步(brief §6:tripo 模板待真 ComfyUI 验证),mesh 后处理(减面/压缩)是远期 |
| `image-to-3d-client`/`smart-topology-client` | playground 特有 mesh pipeline,aigc-studio 用 tripo API 节点 |
| 7 状态机(created/submitted 分离) | aigc-studio 的 5 状态(queued 合并 created/submitted/queued)够用,简化即正确 |
| `signed-url-cache` micro-batch | aigc-studio 的 `lib/generations/serialize.ts`/`portal-workbench.tsx` 已有签名 URL 逻辑(部分有),micro-batch 缓存是优化,中低价值(可并入 2.3) |

## 4. aigc-studio 已有且更优的(playground 无,无需移植)

- **aigc-r2 直传链路**:`delivery_token` HMAC + `asset-intake` 签 staging PUT + `job-complete` HeadObject 核验 + staging->final Copy + `finalize_job_assets` RPC fence。playground 是"provider 返回 URL -> Vercel 下载 -> 存 R2"旧模式,无直传。
- **租约续约 + lease_until fence**:`renewClaimedJobLease` + `finalize_job_assets` 的 `reconcile_lease_until > now()` 双重保险。playground 的 CAS `transitionJob` 无租约时效。
- **两阶段核验**(verify.ts 阶段 1 HEAD 全核验 -> 阶段 2 全 Copy):playground 无。
- **staging key 不可覆写**:final key 从不签 PUT。playground 无此边界。
- **sanitizeStoredError + redactObjectSecrets**(env 密钥 + credential 模式 + 字段名屏蔽):playground 的 error 处理较简单。

**结论**:aigc-studio 在交付链路上更先进;playground 在资产生命周期/状态机/工作流契约上更成熟。移植方向是**取 playground 的资产删除 + DB trigger + workflow-contract + EngineClient**,**保留 aigc-studio 的 aigc-r2 直传**。

## 5. 综合执行顺序

| 顺序 | 批次 | 进入条件 / 目标 |
|---|---|---|
| 1 | Stage 0 最短真实 E2E | 先证明一个 Modal Bridge 文生图任务可完成登录→生成→R2→DB→作品库；magic-byte 与模板静态检查已完成，不能替代真机 |
| 2 | ✅ Immutable Workflow revision / Job snapshot | 已固定在途 Job 的 execution、template version identity 与 output contract；仅双空迁移前旧任务临时回退当前 Catalog |
| 3 | 参考图 R2 input staging | inline 链路跑通后解除请求体/DB 大对象边界 |
| 4 | 🟡 DB Job 状态不变量 / ✅ 资产删除 | 资产生命周期已完成；Job 合法状态转换 trigger 仍需基于真实状态轨迹补齐 |
| 5 | 直连下载 + 批量签名 + 作品库缓存/分页 | 真实作品库有数据后优化 UX/成本 |
| 6 | ✅ Phase 1 Workflow Execution Catalog | 已由现有图片/视频/3D 工作流落地；通用 binding/DB 化后续继续 |
| 7 | EngineClient 收敛 | Catalog/引擎边界稳定后渐进重构 adapter |
| 8 | 视频/3D 专业 UI 与 mesh 优化 | 真实视频/GLB 主链稳定后再引入重依赖 |

## 6. 关键迁移文件(playground 参考)

| playground 文件 | 用途 | 移植目标 |
|---|---|---|
| `lib/assets/repository.ts` | tombstone + pending_delete + upsert_owned_asset | `lib/assets/delete.ts` + `app/api/library/[id]/route.ts` |
| `supabase/migrations/20260610180000_atomic_asset_ownership_rpc.sql` | upsert_owned_asset 原子 RPC | ✅ 参考 owner/invariant 理念实现 `0009_aigc_asset_deletion.sql`，未复制其通用资产表 |
| `supabase/migrations/20260608182124_establish_jobs_authority.sql` | enforce_job_state_transition trigger | aigc-studio 后续独立 migration（未排号，当前 `0010` 已用于删除运维） |
| `lib/generation-kernel/workflow-contract.ts` | workflow 契约 + capability | ✅ `lib/workflows/definitions.ts` + `output-contract.ts` |
| `lib/image-engine/engine-client.ts` + `types.ts` | EngineClient interface + NormalizedStatus | `lib/engines/engine-client.ts`(新建) |
| `components/image-combiner/hooks/use-persistent-history.tsx` | 3 层历史 | `components/library/use-persistent-library.tsx`(新建) |
| `components/image-combiner/signed-url-cache.ts` | 签名 URL micro-batch 缓存 | `lib/assets/signed-url-cache.ts`(新建) |

## 7. 一句话总结

aigc-studio 的 aigc-r2 直传链路领先 playground；当前已吸收**输入真实性校验、模板完整性检查、Phase 1 workflow-contract/catalog、immutable workflow revision/Job snapshot 与 fenced 资产删除闭环**，且未替换现有强交付语义。下一优先级仍是真实 Stage 0 E2E；随后做 input R2 staging 与 Job 状态转换 DB trigger。
