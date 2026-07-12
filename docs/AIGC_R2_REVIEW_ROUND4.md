# AIGC R2 四轮 Review(codex 修复跟进)

> 针对 `7e9da10` fix(delivery): harden lease fencing and asset persistence 的跟进 review。
> 前序:ROUND1(一轮)/ FOLLOWUP(二轮)/ ROUND3(三轮)。
> 审阅者:GLM 5.2(独立会话)。审完本文件可随 brief 一起删。

## 0. 跟进范围

- `7e9da10` fix(delivery): harden lease fencing and asset persistence
- 改动:`job-complete/route.ts`(6±)、`verify.ts`(7±,beforeCopy hook)、`reconcile.ts`(5±)、`store.ts`(29±,renewClaimedJobLease + redact 增强)、`r2-store.ts`(26±,providerAssetKey 版本化)、`modal-bridge.ts`(10±)、`providers.ts`(7±,beforeAssetCopy 透传)、`0005`(1+,fence lease_until)、`0006`(101++,新 migration 重声明 RPC + 权限)、`package.json`(6++,rollup optionalDeps)、`store-redaction.test.ts`+`r2-store.test.ts`(新单测)
- typecheck ✅ 全绿;npm test ❌ 仍崩(F5 未生效,见 §3)

## 1. codex 加固总结

### 1.1 租约续约机制(lease renewal)✅ 合理
**问题背景**:原 5min 租约(`RECONCILE_LEASE_MS`),若 verify(多 asset HEAD)+ Copy 耗时长,租约可能中途过期 -> 另一个 reconcile/cancel 抢入 -> 竞态。

**codex 修复**:
- `store.ts:148-163` `renewClaimedJobLease`:刷新 `reconcile_lease_until` + 5min,`.eq("reconcile_token", job.reconcile_token")` + `.in("status",[queued,running])`;失败抛 `JobLeaseLostError`(:120-123,409)
- `verify.ts:136` 阶段 2 每个 Copy 前 `await options.beforeCopy?.()`
- `job-complete/route.ts:47` `beforeCopy: () => renewClaimedJobLease(claimed)`
- `reconcile.ts:54` 经 `providers.ts:93` -> `modal-bridge.ts:91/117` 透传 `beforeAssetCopy`

**评价**:关闭了"长 verify+Copy 期间租约过期"的竞态窗口。每个 Copy 前续约,Copy 期间 5min 足够(R2 Copy <1s)。续约失败(token 被抢/terminal)-> 不 Copy。**设计合理。**

### 1.2 fence 加 `lease_until > now()` ✅ 双重保险
- `0005:34` + `0006:38`:`finalize_job_assets` 的 fence `perform 1 ... where reconcile_token = p_token and reconcile_lease_until > now() and status in (...)`
- 配合续约:若续约没及时做/失败,lease 过期 -> fence 返回 null -> 不落库
- `0006` 给已跑旧 0005(无 lease_until fence)的库补丁,`create or replace` + revoke/grant service_role 幂等。**合理**(生产库不能重跑 0005)。

### 1.3 URL-provider key 版本化 ✅ 防覆盖(含 N5 副作用)
- `r2-store.ts:118-134` `providerAssetKey`:`${userId}/${jobId}/${assetType}-${position}${version ? `-${version}` : ""}.${ext}`,`safeKeyVersion` 剥非 `[a-zA-Z0-9_-]` + 截断 64
- `finalizeJobWithAssets:365` 传 `keyVersion: job.reconcile_token`
- **仅影响 URL-provider**(下载侧);aigc-r2 的 asset 有 `r2Key` 跳过(`r2-store.ts:76`)
- 防止 reconcile 重试(新 token)下载覆盖旧 R2 对象。**但见 N5(孤儿)。**

### 1.4 redactObjectSecrets 增强 ✅ 更严格
- `store.ts:272-285`:string 值现在也跑 `sanitizeStoredError`(原只替换 env 密钥精确值)。覆盖 error message 内嵌的 `auth_key=xxx` / `bearer xxx` 模式。
- `store-redaction.test.ts`(17 行,我三轮建议的单测):验证 `auth_key`/`delivery_token` 字段 + error 内嵌 credential 脱敏。✅
- `sanitizeStoredError` 正则顺序调整(:253-256):bearer 先于 credential 正则。不影响安全性。

### 1.5 我三轮建议的落实
| 三轮建议 | 落实 |
|---|---|
| 补 `redactObjectSecrets`/`isSecretKeyName` 单测 | ✅ `store-redaction.test.ts` |
| M8"零部分副作用"措辞调整 | ❌ 未改(信息级,非阻塞) |
| HANDOFF 补 staging 双路径删除说明 | ❌ 未改(信息级) |

## 2. 新发现

### N4 [中低] reconcile 路径 JobLeaseLostError 走 failClaimedJob 二次失败

**证据**:
- `reconcile.ts:47-56` catch:`isTransientProviderPollError(error)` 判断;`JobLeaseLostError` 不在瞬时类型列表(`reconcile.ts:98-103` 只认 FetchJsonTimeoutError/HttpJsonError(408/429/5xx)/AbortError/TypeError)。
- 因此 `JobLeaseLostError` 走 `failClaimedJob(claimedJob, message)`(:54)。
- `failClaimedJob`(`store.ts:187-206`):`update status=failed where reconcile_token=job.reconcile_token`。但 JobLeaseLostError 意味着 token 已失效(被别人抢)-> `.eq("reconcile_token")` 0 行 -> `.single()` error -> **throw BackendStoreError**。
- reconcileJob 抛 BackendStoreError -> `reconcile/route.ts` catch -> `reconcileErrors++` + failureSamples。

**影响**:
- ✅ **job 安全**:failClaimedJob 的 update 0 行,job 不被错误 fail(token 失效保护)。另一个持租约的 reconciler 继续处理。
- ❌ **噪音**:reconcile route 报 `reconcileErrors++`,BackendStoreError 混入 failureSamples,可能掩盖真实错误。
- ❌ **不一致**:job-complete 路径把 JobLeaseLostError 当 409(`mapInternalError` 用 `error.code="reconcile_lease_lost"`)让 Bridge 重试;reconcile 路径却当"非瞬时 provider 错误"failClaimedJob。

**修复建议**:`reconcile.ts:47` catch 显式判断 JobLeaseLostError,读回状态返回(不 fail):
```ts
if (error instanceof JobLeaseLostError) {
  const fresh = await getOwnedJob(claimedJob.id, claimedJob.user_id)
  return { job: fresh ?? claimedJob, generation: null, assets: [], changed: true }
}
```
与 job-complete 的 409 语义对齐:租约丢失 = 放弃当前轮,不 fail。

### N5 [低] URL-provider key 版本化后重试留孤儿 R2 对象

**证据**:
- `r2-store.ts:providerAssetKey` 加 `keyVersion`(= reconcile_token)。每次 reconcile claim 生成新 `randomUUID`(`store.ts:125`)。
- 若第一次 reconcile 下载+PUT 成功但 `finalizeJobWithAssets` 失败(RPC 错误),job 未 succeeded。下次 reconcile 用新 token -> 新 keyVersion -> 下载到**新 key**。旧 key 的 R2 对象残留。
- `cleanup.ts` 只清 aigc-r2 的 staging/final(经 `aigc_job_uploads` 台账),**不清 URL-provider 的 R2 对象**。

**影响**:URL-provider(fal/openrouter,非 aigc-r2 主线)reconcile 重试留孤儿 R2 对象,累积存储。功能不受影响(新 key 的对象正确)。概率低(需 finalize 失败才重试)。

**修复建议**(非阻塞):
- 方案 A:`cleanup.ts` 扩展,按 `aigc/<uid>/<jid>/` 前缀扫描非 aigc_assets 引用的旧对象(复杂)。
- 方案 B:URL-provider 重试用同一 key(去掉 keyVersion),覆盖旧对象(但失去版本化防覆盖的好处)。
- 方案 C:接受孤儿,加存储监控。

### N6 [信息] redactObjectSecrets 对 string 截断 500 字符
`store.ts:282` string 值走 `sanitizeStoredError`,其 `:256` `out.slice(0, 500)`。provider_response 的 >500 字符合法字段(如完整 workflow JSON)会被截断。**安全优先,可接受**。若需保留长字段,可对 string 只跑 credential 正则不截断(但降低脱敏强度)。信息级,无需修。

## 3. F5 状态:方向性修复,当前未生效

### codex 修复尝试
- `package.json:32-36` 新增 `optionalDependencies`:`@rollup/rollup-darwin-arm64/x64` + `@rollup/rollup-linux-arm64-gnu/x64-gnu`,均 `4.62.2`
- `package-lock.json` 锁了 4 处 `rollup-darwin-arm64` 条目

### 当前环境验证(只读)
- `node_modules/rollup/package.json` version = `4.62.2`(与声明匹配 ✅)
- `node_modules/@rollup/` **只有 `rollup-linux-arm64-gnu`**(macOS arm64 仍缺 darwin binding ❌)
- `npm test` 实测仍崩:`Cannot find module '@rollup/rollup-darwin-arm64'`

### 结论
codex **正确声明**了 optionalDependencies + 锁了 lock 条目(方向对),但**本机未 `npm install` 装载 darwin binding**,npm test 仍崩。版本匹配(4.62.2),可推断开发者/部署同学跑 `npm install` 后 darwin binding 会被装,F5 应能修复。**但我无法在不违反"不动同级工程"边界的前提下验证**(npm install 会改 lock + node_modules,被权限拒绝)。

**F5 状态**:方向性修复(声明 + lock),**待 `npm install` 验证生效**。codex 应在提交前 `npm install && npm test` 自验(显然没做,否则会发现本机仍崩)。

## 4. 单测评价

### 新增(7e9da10)
- `lib/assets/r2-store.test.ts`(20 行):`providerAssetKey` 版本化(claim-a ≠ claim-b)+ `safeKeyVersion` 剥离 `../claim token` -> `claimtoken`。✅ 覆盖 key 版本化与注入防护。
- `lib/jobs/store-redaction.test.ts`(17 行):`redactObjectSecrets` 脱敏 `auth_key`/`delivery_token` 字段 + error 内嵌 `auth_key=dynamic-secret` / `Bearer abc.def`。✅ **我三轮建议的单测**,精确覆盖 F3 修复。

### 累计单测
token(6)+ asset-policy(6)+ input(8)+ verify(10)+ r2-store(2)+ store-redaction(1)= **33 个**。

### 缺口
- 仍是纯函数/mock 单测,无集成测试(租约续约 + fence 的端到端竞态未覆盖,难 mock)。
- `renewClaimedJobLease` / `JobLeaseLostError` 路径无单测(N4 相关)。
- **npm test 仍崩**(F5),33 个单测当前无法执行验证。

## 5. 修复总览(四轮累计)

| 编号 | 状态 | 修复者 |
|---|---|---|
| F1 reconcile staging 清理 | ✅ 修复 | Claude 二轮 |
| F2 claim 失败 staging 残留 | ✅ 修复 | Claude 二轮 |
| F3 provider_response sanitize | ✅ 修复 + codex 增强(string 也 sanitize) | Claude 二轮 + codex 四轮 |
| F4 3h running 占配额 | ✅ 修复 | Claude 二轮 |
| F5 单测跑不起来 | ⚠️ 方向修(声明 optionalDeps + lock),待 npm install 验证 | codex 四轮 |
| N1 M8 措辞 | ❌ 未处理(信息级) | - |
| N4 reconcile JobLeaseLostError | ❌ 新发现(中低) | - |
| N5 URL-provider 孤儿 | ❌ 新发现(低) | - |
| N6 redact 截断 | 信息级,可接受 | - |

## 6. 总结

### codex 加固评价
**高质量加固,非纸面**。租约续约 + fence lease_until + key 版本化 + redact 增强都是实质性的并发/安全改进,且补了我三轮建议的 redaction 单测。0006 migration 对旧库的补丁策略合理。修复深度高于前几轮。

### 必须处理(上线前)
- **F5**: codex 声明了 optionalDependencies + lock,但需 `npm install` 装载 darwin binding 才生效。**codex 提交前应自验 `npm install && npm test`**(当前本机仍崩)。开发者部署时跑 `npm install` 应可修复(版本匹配 4.62.2)。
- **N4**(中低): reconcile 路径 JobLeaseLostError 走 failClaimedJob 二次失败。job 安全但噪音 + 与 job-complete 的 409 语义不一致。建议 reconcile catch 显式处理(读回状态,不 fail)。

### 建议处理(非阻塞)
- **N5**: URL-provider 重试留孤儿 R2 对象(无清理)。低概率,监控或 cleanup 扩展。
- 补 `renewClaimedJobLease`/`JobLeaseLostError` 单测。
- M8"零部分副作用"措辞调整(N1,信息级)。

### 无新代码逻辑缺陷
`7e9da10` 的租约续约 + fence + key 版本化 + redact 增强**未引入新的逻辑缺陷**。N4 是"错误处理路径不一致"(安全但噪音),N5 是"新机制的副作用"(孤儿),N6 是"脱敏副作用"(截断)。核心 aigc-r2 实现质量维持**实质全 PASS**。

### 验证状态
- `npm run typecheck`:✅ 全绿
- `npm test`:❌ 仍崩(F5,codex 声明未装 darwin binding)
- `npm install` 后 F5:推断可修(版本匹配),但未验证(边界限制)

### 一句话给部署同学
codex 四轮加固了租约续约与 fence(并发更稳)、URL-provider key 版本化、redact 增强(覆盖 error 内嵌 credential),并补了 redaction 单测;**F5 单测仍跑不起来**(codex 声明了 rollup optionalDeps 但没 npm install 装载,需开发者跑 `npm install`);新发现 N4(reconcile 的 JobLeaseLostError 处理与 job-complete 不一致,安全但噪音)建议修;其余已达可上线质量。
