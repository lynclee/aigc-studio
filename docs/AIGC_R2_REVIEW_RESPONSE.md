# AIGC R2 实现 Review 响应(网站侧)

> 对 `docs/AIGC_R2_REVIEW_BRIEF.md` 的独立审阅响应。
> 审阅者:GLM 5.2(独立会话,交叉验证)。审完本文件可随 brief 一起删。
> 范围:`../aigc-studio` 网站侧 TS(插件侧 `comfyui_modal_bridge` 不在范围)。
> 方法:逐文件读码(35+ 文件)+ 11 不变量逐条实证 + 7 决策挑战 + 7 重点问题 + grep 交叉核实。

## 0. 核验总览

- **typecheck**:✅ 全绿(`npm run typecheck` = `tsc --noEmit`,无错误输出)
- **代码版本**:基于 2026-07-12 工作树快照(main 分支)
- **关键修正声明**:初读时 `lib/jobs/store.ts` / `app/api/internal/job-complete/route.ts` / `lib/jobs/reconcile.ts` 返回了**过时缓存**(显示 application 层 `materializeCompletedJob`+`completeClaimedJob` 分离 upsert)。经 grep + 重读确认,实际代码已重构为 `finalize_job_assets` RPC 单事务 fence(`supabase/migrations/0005_finalize_job_assets.sql` + `store.ts:326`)。**brief §5 的 H4/H6 修复已落地**。本报告以下所有结论基于最新代码,凡与过时缓存冲突处均已重新核实。

## 1. 11 条契约/安全不变量逐条核验

| # | 不变量 | 结论 | 关键证据(file:line) |
|---|---|---|---|
| 1 | delivery_token 不可伪造/篡改 | ✅ PASS | `lib/delivery/token.ts:60-83`:HMAC-SHA256 + `timingSafeEqual`(:68/:85-90 常量时间)+ `exp` 过期(:80)+ 结构 `v1.payload.sig` 3 段校验(:64)。载荷 `{j,u,e}` base64url 明文(决策 3 已接受)。`claims.jobId !== jobId` 拒(:44 job-complete/:38 asset-intake)+ `getOwnedJob(jobId, userId)` 绑用户(`store.ts:252`)。A 的 token 落不了 B 的 job。 |
| 2 | R2 密钥边界 | ✅ PASS | `lib/r2.ts:33-40`:`getR2Env` 只从 `process.env` 读,长期 key 不出 Vercel。`signPutUrl`(:92-106):`PutObjectCommand` 只设 `ContentType`,**不锁 Content-Length**。预签名 PUT 指向 **staging key**(`asset-intake/route.ts:84`),final key 从不签 PUT(C1)。 |
| 3 | 内部 endpoint 鉴权 | ✅ PASS | `asset-intake/route.ts:4` / `job-complete/route.ts:5` 注释明示不走 `getSession`。只认 `delivery_token`(`:43/:37`)+ Vercel Protection Bypass(部署层)。未配 secret:`getSecret` 抛 `DeliveryTokenConfigError`(:17-22)→ `http.ts:13` 映射 503。未配 R2:`asset-intake/route.ts:66` / `verify.ts:59` → 503。**不崩、不误放行**。 |
| 4 | r2_key 注入 | ✅ PASS | `asset-intake/route.ts:70`:`candidateKey = aigc/${user_id}/${job_id}/${assetType}-${position}.${ext}` 服务端重算。`ext` 来自 `extForAsset`(`asset-policy.ts:97-103`):content-type 白名单 + octet-stream 走 `OCTET_STREAM_EXTS` 白名单(`:62-67`)。filename 仅取 `split(".").pop()`(:100),无路径分隔符注入。manifest 的 `r2_key` 若与服务端台账不一致 → `invalid_r2_key`(`verify.ts:90`)。**Bridge 无法自造路径**。 |
| 5 | 核验只信 R2 实际 size+ETag | ✅ PASS | `verify.ts:93-100`:HEAD staging → `head.size` 上下限(:97 `<=0 || > maxBytes`)且 `== reportedSize`(:98)+ `stagingEtag == reportedEtag`(:100)。`checksum_sha256` 仅存 metadata(`:116`,不入核验门)。size/etag 必填(:82-84,H2)。权威 identity 来自台账 `getUpload`(:87,H3)。Copy 后 final 不可覆写(C1,:102-104)。 |
| 6 | 并发/幂等 | ✅ PASS(含副作用,见 F1) | `claimJobForReconcile`(`store.ts:120-141`):`.in(status,[queued,running])` + `.or(reconcile_token.is.null,reconcile_lease_until.is.null,reconcile_lease_until.lt.now)` 串行化。`finalize_job_assets` RPC(`0005:29-37`):`for update` 行锁 + fence `reconcile_token` + 写 generation/assets/succeeded 单事务。已 succeeded 短路(`job-complete/route.ts:42`)。`markJobCancelled`(`store.ts:411`)同样检查租约 → cancel 与 push/reconcile 互斥。**H4 正确修复**:cancelled job 不会带 assets(fence 返回 null 即不落库)。 |
| 7 | /status 兜底容错 | ✅ PASS | `modal-bridge.ts:139-146`:`DeliveryVerifyError`(manifest 本身错)→ `failed`(:141-143,永久);其他(含 R2 瞬时/未配置)→ `running`(:144-146,保守)。`MAX_JOB_AGE_MS=3h`(`reconcile.ts:24`)兜底:超时强制 `failed`(:89-91,M7)。**不会永久 running**(决策 2 的隐患由 M7 兜底)。 |
| 8 | 无密钥外泄 | ⚠️ CONDITIONAL PASS | `sanitizeStoredError`(`store.ts:224-237`)**已增强**:env 密钥精确值→`[redacted]`(:227-230,H6)+ credential 模式正则 `*_key/token/secret/password/authorization=值`→`$1=[redacted]`(:232-234)+ bearer(:234)+ URL(:235)+ 截断 500(:236)。四条 error 写入路径都过它(`updateClaimedJobFromProviderStatus`/`releaseClaimedJob`/`failClaimedJob`/`markJobFailed`)。**但 `provider_response` JSON 不过 sanitize**(见 F3)。 |
| 9 | 不可信输入 | ✅ PASS | `input.ts`:prompt 1-4000(:30-32);workflow 白名单(:8-12,:35-39);width/height 整数 64-4096(:14-15,:66-68);aspectRatio 关键字或 `^\d{1,2}:\d{1,2}$` + 最大比 4(:18-19,:77-81);seed 0..2^32(:16,:88);参考图 **base64 data-uri only**(:23 正则,杜绝 SSRF),无嵌套量词(无 ReDoS);filename 剥前导点+拒 `.`/`..`+唯一化(:117-126)。`Number()` 对 `NaN/Infinity/0x` 均 `isSafeInteger/isInteger` 拦截。 |
| 10 | 孤儿清理不误删活资产 | ⚠️ CONDITIONAL PASS | `cleanup.ts:33-37`:`assetExistsForKey(upload.r2_key)` 闸门命中则补标 `recorded` **绝不删**。grace 期 10min(`uploads.ts:93`)。DELETE 幂等(`r2.ts:145-155`)。**final key 清理到位**。但 **staging key 不在台账、不被 cleanup 清理**(见 F1)。 |
| 11 | provider 分发 | ✅ PASS | `providers.ts:39-43` 按 kind 选;`:46-65` ensureConfigured 挡未配;`:93-119` poll 按 `job.provider` 分发,`assertProviderKind`(:172-176)挡 kind/provider 错配(如 video 走 fal-image 抛 `ProviderContractError`);未知 provider 抛错(:117/:144)。`modal-bridge` 是唯一不限 kind 的 provider(:98-100 注释明示)。 |

**小结:11 条中 9 条 PASS,2 条 CONDITIONAL PASS(F3 provider_response / F1 staging 清理),0 条 FAIL。**

## 2. 7 个设计决策挑战

| # | 决策 | 挑战结论 | 风险 |
|---|---|---|---|
| 1 | job-complete 复用 reconcile 租约串行化 push⇄reconcile、挡上传中 cancel | **合理,已落地为 RPC fence**。`finalize_job_assets`(`0005:10-89`)单事务 `for update` 行锁 + fence token,比纯 application 层租约更强。**唯一残留**:job-complete 的 verify(HeadObject+Copy)在 claim **前**(`job-complete/route.ts:50` vs `:58`),而 reconcile 的 verify 在 claim **后**(`reconcile.ts:46` vs `:39`)。job-complete 的 verify 窗口 cancel 可进入,但因 finalize fence,孤儿 final 不会入库(被 cleanup 删);**staging 残留**(F1/F2)。 | 低 |
| 2 | /status 非 DeliveryVerifyError 一律 running | **合理,有 M7 兜底**。`MAX_JOB_AGE_MS=3h`(`reconcile.ts:24`)强制 failed。但 3h 内"真失败但被当 running"会占配额(用户 max 3 active jobs,`store.ts:72`)。**建议**:对"连续 N 次 running 且距 created_at > X"加更早的失败探测,或暴露给用户手动 cancel。 | 低 |
| 3 | delivery_token 载荷明文含 userId | **接受**。base64url 不算加密,但 HMAC 防篡改;只发自建 bridge。**残留风险**:若 bridge 被攻破拿到 token,可读 userId(但本就能从 /status 推断归属)。 | 信息 |
| 4 | BRIDGE_API_KEY 走 status `?key=` | **可接受(临时)**。`modal-bridge.ts:95` URL query。GET query 会进 Modal/TLS 终止代理访问日志。已确认不入 DB/浏览器(`mapInternalError` 不含 URL,`sanitizeStoredError` 剥 URL)。**等插件支持 header 后切**(`PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md:236` 已计划)。 | 低 |
| 5 | 参考图 base64 塞 POST body | **边界安全但不宽裕**。`input.ts:21` 单图 4MB,最多 4 张=16MB,超 Vercel 4.5MB body 限制。实际最多 ~3 张小图。无 SSRF(data-uri only)。**正解 R2-staging 未做**(brief §6 已知)。当前不阻塞图生图小图。 | 低 |
| 6 | 图生图自动切(检测参考图切 i2i,不动 DB CHECK) | **合理**。`image-registry.ts:72` `config.i2iTemplate && referenceName ? i2iTemplate : template`。`flux2_klein` 无 i2iTemplate(`:56-61`)→ 参考图静默走文生图。**已知限制**(brief §6)。建议:无 i2i 模板时若传了参考图,前端提示或后端拒。 | 信息 |
| 7 | 视频/3D 模板 = 原始 ComfyUI API JSON,只替换 `{{PROMPT}}/{{SEED}}` | **合理**。`render-template.ts:3-31` 递归替换,精确匹配 `{{VAR}}` 整字段返回值(:17-21),非精确 split/join(:23-26),**无递归替换**(无无限循环)。`needsGpu=false` CPU worker(`registry.ts:65/:69`)。**小点**:prompt 含 `{{WIDTH}}` 会被替换成数值(模板注入),但值是数值/文件名,非安全漏洞。 | 信息 |

## 3. 7 个重点问题回答

1. **内部 endpoint 鉴权绕越/越权?** ✅ **无**。`asset-intake`/`job-complete` 不走 `getSession`,只认 `delivery_token`(HMAC 绑 job+user)。`claims.jobId !== body.job_id` 拒 + `getOwnedJob(jobId, claims.userId)` 二次绑用户。token 2h 过期 + job 终态拒。未配 secret/R2 → 503 不放行。
2. **push⇄reconcile⇄cancel 三路竞态?** ✅ **无数据错乱**。三者都过 `claimJobForReconcile` 租约 + `finalize_job_assets` RPC 单事务 `for update` 行锁。已 succeeded 短路。cancel 在租约活跃时 `ReconcileLeaseActiveError`(`cancel-route.ts:28-30`)。**副作用**:staging 对象在 reconcile 路径泄漏(F1),不影响 DB 一致性。
3. **服务端密钥到 DB/浏览器/日志?** ⚠️ **error 字段到位,provider_response JSON 未 sanitize**(F3)。`aigc_jobs.error` 四条写入路径都过增强版 `sanitizeStoredError`。浏览器侧 `publicJob`(`submit-route.ts:43-63`)只暴露 `generation_failed`/`storage_failed` code,不暴露原始 message。`reconcile/route.ts:72-88` failureSample 只保留 `[A-Za-z0-9_.-]`。**残留**:Bridge /status 响应整体进 `provider_response`(`store.ts` updateClaimedJobFromProviderStatus + `finalizeJobWithAssets:335` 进 `aigc_generations.metadata`),不过 sanitize。
4. **input.ts 注入/DoS/绕过?** ✅ **无**。base64 data-uri only(SSRF 防护);数值 `Number.isInteger/isSafeInteger` + 范围;正则无嵌套量词(无 ReDoS);filename 剥前导点+拒 `..`+唯一化;aspectRatio 最大比 4 + `round64` 上钳 4096(`image-registry.ts:148-151`)。
5. **孤儿清理误删活资产?** ✅ **不会**。`assetExistsForKey` 闸门(`cleanup.ts:33-37`)查 `aigc_assets`,命中补标 recorded 绝不删。grace 10min 躲开在途 job-complete。**但 staging key 不被清**(F1,泄漏非误删)。
6. **modal-bridge 对 image/video/3D kind 通用假设破绽?** ✅ **无破绽**。`mapBridgeStatus`(`modal-bridge.ts:111-150`)按 `job.kind` 通用;`verifyDeliveredAssets`(`verify.ts:58`)按 `categoryForKind(job.kind)` 取类别与上限;`asset-policy.ts:55-59` 按 kind 白名单 asset_type。`assertProviderKind`(`providers.ts:172`)挡其他 provider 的 kind 错配。视频/3D 模板 needsGpu=false CPU worker。
7. **优雅降级?** ✅ **到位**。缺 `BRIDGE_DELIVERY_TOKEN_SECRET` → 503;缺 R2 env → 503;缺 `MODAL_BRIDGE_*` → `MissingProviderEnvError` 503;缺 workflow → `WorkflowNotConfiguredError` 503。未知 workflow → 400 拒(`registry.ts:106`,M9)。`getR2Env`/`getR2Client` env 缺失返回 null 不崩(`r2.ts:33-64`)。

## 4. 新发现(真实缺陷)

### F1 [中] reconcile 路径的 staging 对象不清理(存储泄漏)

**证据**:
- `job-complete/route.ts:80`:`await Promise.all(verified.map((v) => deleteObject(v.stagingKey))).catch(() => {})` — **job-complete 成功路径删 staging**(best-effort)。
- `lib/jobs/reconcile.ts:60-82`:succeeded 分支调 `finalizeJobWithAssets` 后直接返回,**没有 `deleteObject(stagingKey)`**。
- `lib/delivery/cleanup.ts:40`:`deleteObject(upload.r2_key)` 删的是 **final key**(`aigc/<uid>/<jid>/<type>-<pos>.<ext>`),不是 staging key(`aigc/<uid>/<jid>/.staging/<type>-<pos>.<ext>`)。台账 `aigc_job_uploads.r2_key` 存的是 final key。

**影响**:push 丢失、reconcile 兜底成功的 job(正是 aigc-r2 的核心兜底场景),其 staging 对象永久残留 R2。随时间累积存储费。不影响安全或数据一致性。

**风险等级**:中(存储泄漏,累积性)。

**修复建议**:
- 方案 A(最小):`reconcile.ts` succeeded 分支在 `finalizeJobWithAssets` 后也 `deleteObject(stagingKey)`(best-effort,同 job-complete)。需要 `verifyDeliveredAssets` 返回 stagingKey(已返回,`verify.ts:53/:121`)。
- 方案 B(更稳):`cleanup.ts` 增加按 `.staging/` 前缀扫描旧对象清理(独立于台账)。或 `listOrphanUploads` 同时返回 stagingKey 一并清。

### F2 [低] job-complete claim 失败时 staging 残留

**证据**:`job-complete/route.ts:48-55` verify(含 Copy staging→final)在 claim **前**;`:58` claim;`:59-64` claim 失败提前返回(409),**未执行 `:80` 的 staging 删除**。

**影响**:cancel 在 verify 与 claim 之间进入(毫秒级窗口),verify 已 Copy staging→final,但 claim 失败 → staging 残留 + final 被 cleanup 删(因 job cancelled,finalize 没跑)。概率低,影响同 F1(单 staging 对象泄漏)。

**风险等级**:低(竞态窗口小,仅泄漏单个 staging 对象)。

**修复建议**:将 verify 的 Copy 也移入 claim 租约内(与 reconcile 一致),或 claim 失败路径也 best-effort 删 staging。

### F3 [低/信息] provider_response JSON 链路未 sanitize

**证据**:
- `lib/engines/modal-bridge.ts:138`:`mapBridgeStatus` 把整个 Bridge `/status` 响应 `response` 放入 `ProviderStatusResult.response`。
- `lib/jobs/store.ts` `updateClaimedJobFromProviderStatus`:`provider_response: statusResult.response` 直接存入 `aigc_jobs.provider_response`。
- `lib/jobs/store.ts:335`:`finalizeJobWithAssets` 的 `p_generation_metadata: { provider_response: job.provider_response }` → 进 `aigc_generations.metadata`。
- `sanitizeStoredError` 只作用于 `error` 字段,**不作用于 `provider_response` JSON**。

**影响**:Bridge 是可信方(用 `BRIDGE_API_KEY` 鉴权),正常响应不含密钥。但若 Bridge 被攻破/配置错/日志回显,`/status` 响应的 `error` 字段若回吐密钥模式,会原样进 `aigc_jobs.provider_response` + `aigc_generations.metadata`。brief §5 的"四条 error 写入 sanitize"不覆盖此路径。

**风险等级**:低/信息(需 Bridge 不可信才触发,且 Bridge 响应预期不含密钥)。

**修复建议**:对 Bridge 不可信响应做字段白名单(只存 `status`/`delivery.assets`/`id` 等已知字段),或对 `provider_response` 跑一遍 credential 模式 sanitize(复用 `sanitizeStoredError` 的正则)。

### F4 [信息] mapBridgeStatus 未知/瞬时状态在 3h 内占配额

**证据**:`modal-bridge.ts:144-149` 非 `DeliveryVerifyError` 一律 `running`(含 R2 瞬时错误);`reconcile.ts:24` `MAX_JOB_AGE_MS=3h` 才强制 failed。

**影响**:R2 持续故障期间,job 保持 running 最长 3h,占用户 max 3 active jobs 配额(`store.ts:72`)。brief 决策 2 已知。

**风险等级**:信息(M7 已兜底,3h 上限可接受)。

**修复建议**(可选):对"连续 N 次 reconcile 仍 running 且无 provider 状态变化"的 job 提前告警或降级;或允许用户强制 cancel(当前 cancel 在租约活跃时被挡)。

## 5. 已做内审复核(brief §5)

| 内审项 | 复核结论 | 证据 |
|---|---|---|
| Stage 1: HeadObject 权威 size 上限核验 | ✅ 到位 | `verify.ts:97` `head.size <= 0 \|\| > maxBytes` |
| Stage 1: 租约避免孤儿 + push/reconcile 双写 | ✅ 到位(RPC fence 强化) | `0005:29-37` `for update` + fence token |
| Stage 1: r2_key 精确重算 | ✅ 到位 | `asset-intake/route.ts:70` |
| Stage 1: 先签名后记台账 | ✅ 到位 | `asset-intake/route.ts:73-86` |
| Stage 2: /status 瞬时 R2 错误不永久失败 | ✅ 到位 | `modal-bridge.ts:144-146` + `reconcile.ts:89` M7 |
| Stage 2: 四条 error 写入统一 sanitize | ✅ 到位(增强版) | `store.ts:224-237` |
| Stage 2: manifest 长度 cap 32 | ✅ 到位 | `verify.ts:56` `MAX_MANIFEST_ASSETS` |
| input.ts: filename 剥前导点/拒 `..`/唯一化 | ✅ 到位 | `input.ts:117-126` |
| input.ts: aspectRatio 极端比拒绝 + round64 上钳 4096 | ✅ 到位 | `input.ts:79` + `image-registry.ts:148-151` |

## 6. 总结

**整体评价**:aigc-r2 网站侧实现**质量高于一般"已落代码"水准**。brief §5 列出的内审修复(H4 RPC fence / H6 增强 sanitize / C1 staging→final Copy / M7 超时兜底 / M9 未知 workflow 拒绝)**均已正确落地**,非纸面修复。11 条契约不变量 9 条 PASS、2 条 CONDITIONAL PASS、0 FAIL。7 决策均合理,7 重点问题无致命缺陷。

**必须处理**(上线前):
- **F1**(中):reconcile 路径 staging 清理。这是 aigc-r2 核心兜底场景的存储泄漏,随时间累积。修复成本低(方案 A 一行 `deleteObject`)。

**建议处理**(非阻塞):
- **F3**(低/信息):`provider_response` 字段白名单或 sanitize。纵深防御。
- **F2**(低):job-complete claim 失败路径补删 staging,或 verify Copy 移入租约。

**可观察**(运维):
- **F4**(信息):3h running 占配额的监控/告警。

**未发现问题**:delivery_token 伪造、R2 密钥外泄到 Modal、r2_key 路径注入、核验绕过、input ReDoS/SSRF、孤儿误删活资产、kind/provider 错配。这些 brief 最关心的安全不变量均实证 PASS。

**部署前提醒**(非本次 review 范围,brief §6 已列):端到端从未真跑(无 Modal/R2/ComfyUI 环境);工作流模板(z_image_turbo_i2i / seedance / tripo)需真 ComfyUI 验证;UI 实机视觉(1920/1080)待部署后带会话做。
