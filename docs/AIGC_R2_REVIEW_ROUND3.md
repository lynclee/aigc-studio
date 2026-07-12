# AIGC R2 三轮 Review(二轮修复跟进)

> 针对 `6ef3bb0`(fix delivery 二轮修复)+ `d956ddf`(归档 followup)两提交的跟进 review。
> 前序:`docs/AIGC_R2_REVIEW_RESPONSE.md`(一轮)+ `docs/AIGC_R2_REVIEW_FOLLOWUP.md`(二轮)。
> 审阅者:GLM 5.2(独立会话)。审完本文件可随 brief 一起删。

## 0. 跟进范围

- `6ef3bb0` fix(delivery): claim-先行 Copy + 两阶段核验 + 脱敏/权限 + vitest 3.x
- `d956ddf` docs: 归档二轮 followup 报告(我的二轮报告原样提交)
- 改动文件:`job-complete/route.ts`(58±)、`verify.ts`(60±)、`reconcile.ts`(12±)、`store.ts`(25±)、`verify.test.ts`(91++,新)、`0005`(9+)、`package.json`(vitest 3.x)、`package-lock.json`(1722±)、`HANDOFF.md`(2±)

## 1. F1-F5 状态总表

| 编号 | 二轮结论 | 三轮状态 | 证据(file:line) |
|---|---|---|---|
| **F1** reconcile 路径 staging 不清理 | 上线前应修 | ✅ **已修复** | `reconcile.ts:93-96`:`finalized.assets.filter(a => a.r2_key).map(a => deleteObject(stagingKeyForFinal(a.r2_key))).catch(() => {})` best-effort。fence 失败分支(71-90)不删(合理:可能属别人)。 |
| **F2** job-complete claim 失败 staging 残留 | 非阻塞 | ✅ **已修复** | `job-complete/route.ts:43-48`:claim **先行**,claim 失败 -> `resolveNonClaim`(不 Copy)。verify(HEAD+Copy)全在租约内。 |
| **F3** provider_response JSON 未 sanitize | 非阻塞 | ✅ **完全修复** | `store.ts:102`/`154`/`457` **三条写入路径全过 `redactObjectSecrets`**;新增 `isSecretKeyName`(:241-249)按字段名屏蔽 `*_key/*_token/*_secret/authorization/password`。`finalizeJobWithAssets:374` 用 `job.provider_response`(已 redact 的 DB 值),间接安全。 |
| **F4** 3h running 占配额 | 信息 | ✅ **已修复(M4)** | `reconcile.ts:57-61`:瞬时错误分支也受 `isPastMaxAge` 3h 兜底,持续瞬时失败不再永久 running。 |
| **F5** 单测跑不起来 | 高/阻塞 | ❌ **未修复** | `package.json:30` vitest `4.1.10`->`3.2.7`(rolldown->rollup),但 `@rollup/` 只装了 `rollup-linux-arm64-gnu`,macOS arm64 缺 `@rollup/rollup-darwin-arm64`。`npm test` 仍崩(`Cannot find module @rollup/rollup-darwin-arm64`,npm/cli#4828)。**根因未解决**。 |

**F1-F4 全部修复,F5 仍开放。**

## 2. 额外加固 review(Claude 主动,我未提)

### H2 ✅ finalize null 不假 ACK succeeded
`job-complete/route.ts:62-64`:`finalized = await finalizeJobWithAssets(...)`,`if (!finalized) return resolveNonClaim(...)`。原代码不接返回值直接返回 succeeded--若 fence 失败(租约在 verify 期间过期/被接管)会假 ACK。现在读回真实状态。**合理,修复了一个我上轮漏审的隐蔽点。**

### M5 ✅ verify 至少一个主资产
`verify.ts`:`if (!plans.some(p => p.assetType !== "preview")) throw "no_primary_asset"`。防"只交一张 preview 就算成功"。`isAllowedAssetType` 仍允许 preview(`asset-policy.ts:55-59`),M5 在其上加"至少一个非 preview"。**合理。**

### M7 ✅ finalize RPC 权限收紧
`0005:23` `set search_path = public`(防 search_path 注入)+ `:92-98` `revoke execute from public, anon, authenticated` + `grant execute to service_role`。之前 RPC 默认权限可能让 authenticated 调用。**合理安全加固。**

### M8 ⚠️ 两阶段核验(设计好,措辞略乐观)
`verify.ts`:阶段 1 全 asset 做 校验+HEAD staging(纯读,存 `plans[]`) -> M5 检查 -> 阶段 2 全 Copy staging->final。

**价值**:阶段 1 任一失败则**完全不 Copy**(原代码边核验边 Copy,第 N 个失败时前 N-1 个已 Copy 到 final)。`CopySourceIfMatch: plan.stagingRawEtag` 仍防 HEAD->Copy 间篡改。

**但 commit message 的"零部分副作用"措辞略乐观**:阶段 2 是**顺序 Copy**,若 Copy A 成功后 Copy B 失败(B 的 staging 被删/etag 变),A 的 final 已存在。这仍是部分副作用。不过:(a) 比原"边核验边 Copy"显著更好(阶段 1 失败则零 Copy);(b) 部分孤儿 final 被 cleanup 兜底(`assetExistsForKey` 未命中 -> 删)。**可接受,见 N1。**

## 3. 新观察

### N1 [低/信息] M8 阶段 2 顺序 Copy 仍可能留部分 final
如上所述,阶段 2 内 Copy A 成功后 Copy B 抛错(瞬时 R2 错误或 `CopyPreconditionError`),A 的 final 已存在。`verifyDeliveredAssets` 抛非 `DeliveryVerifyError` -> job-complete 500 可重试 / reconcile `failClaimedJob`。A 的 final 是临时孤儿,由 cleanup 兜底删除(`assetExistsForKey` 查 aigc_assets 未命中 -> 删 final key)。

**影响**:低。功能正确(不会入库错误 assets),仅临时存储残留(被 cleanup 清)。R2 无批量 Copy 事务,这是不可避免的权衡。建议:commit message 措辞从"零部分副作用"改为"阶段 1 失败则零 Copy;阶段 2 仍可能部分 Copy,由 cleanup 兜底"。

### N2 [信息] claim 先行后 verify 失败的 releaseClaim 不带 message
`job-complete/route.ts:52` verify catch:`releaseClaimedJob(claimed).catch(() => {})` 不带 errorMessage(原代码 `releaseClaimedJob(claimed, message)`)。这是**有意的**:verify 错误还没到 DB 存储阶段,`DeliveryVerifyError` 返回 400 不需写 error;瞬时错误 throw 500 由 Bridge 重试。`releaseClaimedJob` 不带 message 时保留 `job.error`(`store.ts:174`)。**合理,非 bug。**

### N3 [信息] reconcile staging 删除用 final key 反推
`reconcile.ts:95` 用 `stagingKeyForFinal(a.r2_key)`(从 aigc_assets 的 final key 反推 staging key),而 job-complete:70 用 `v.stagingKey`(verify 直接返回)。两条路径的 staging key 推导一致(`stagingKeyForFinal` 确定性映射),**正确**。reconcile 能拿到的是 `finalized.assets`(aigc_assets 记录,只有 r2_key),反推是唯一方式。

## 4. 单测评价(verify.test.ts 91 行,新增)

### 覆盖良好(10 个测试)
happy path / ETag mismatch 不 Copy / size mismatch / H2 etag+size required / H5 asset_type / duplicate / never intaked / staging missing / M5 only-preview-no-primary / **M8 two-phase 任一失败不 Copy**。

**亮点**:M8 测试(`verify.test.ts` 末尾)用两个 asset,第二个 HEAD etag `"WRONG"`,断言 `copyObject not called`--精确验证两阶段设计。mock 了 `@/lib/r2` 与 `@/lib/delivery/uploads`,纯逻辑测试。

### 累计单测 31 个(21+10)
token(6)+ asset-policy(6)+ input(8)+ verify(10)= 30... commit message 说 31,可能我数差 1。覆盖不变量 1/4/5/9 + verify 核心。

### 缺口
- 仍是纯函数/mock 单测,**无集成测试**(F1-F4 修复后的端到端竞态未覆盖)。
- `redactObjectSecrets`/`isSecretKeyName`(F3 修复核心)无单测。建议补:构造含 `auth_key`/`delivery_token` 字段的 provider_response,断言被 `[redacted]`。
- `resolveNonClaim`(H2 修复核心)无单测(需 mock store,较重)。

## 5. F5 根因深析(仍未修复)

### 现象演变
- 二轮:`Cannot find module '@rolldown/binding-darwin-arm64'`(vitest 4 -> rolldown)
- 三轮:`Cannot find module '@rollup/rollup-darwin-arm64'`(vitest 3 -> rollup)

### 根因
Claude 把 vitest 4->3.2.7 换掉了 rolldown,但 vitest 3 依赖 rollup,rollup 同样有平台 specific 的 native binding(`@rollup/rollup-darwin-arm64` 等,optionalDependencies)。`package-lock.json` 疑似在 Linux 环境生成,锁了 `rollup-linux-arm64-gnu`,`npm install`/`npm ci` 在 macOS 不装 darwin binding(npm/cli#4828 的 optional deps 跨平台 bug)。

**换 vitest 版本只换了 binding 的名字,没解决根因。** Claude 可能没在本机 macOS 跑过 `npm test`(否则会发现 rollup 也缺)。

### 修复建议(按推荐度)
- **方案 A(根治)**:删 `package-lock.json` + `node_modules`,在目标平台(或 CI)重 `npm install`。若 CI 是 Linux,macOS 开发者仍需本地 `npm install` 装 darwin binding。或用 `npm install --force` 重装 optional deps。
- **方案 B(规避 native binding)**:rollup 支持 WASM 后端。设 ` Rollup` 环境变量或用 `@rollup/wasm-node` 替代。但 vitest 不一定支持切换。
- **方案 C(锁定平台 binding)**:`package.json` 显式声明 `optionalDependencies` 含 `@rollup/rollup-darwin-arm64` + `@rollup/rollup-linux-arm64-gnu`。但这是 workaround。
- **配套**:CI 矩阵跑 linux + macOS,确保单测在两个平台都可执行。

## 6. docs 同步

- ✅ `HANDOFF.md` `materialize`->`finalize RPC` 措辞修复(我二轮提的 docs 不一致)。
- ✅ 我的二轮 followup 报告原样归档(`d956ddf`)。
- ⚠️ HANDOFF "不可变固化"段可补一句:staging 清理现在 job-complete + reconcile 双路径删除(F1 已修)。

## 7. 总结

### 修复评价
**F1-F4 全部正确修复,F5 根因未解。** Claude 额外加固的 H2/M5/M7/M8 均合理且有价值(H2 修了我漏审的假 ACK;M7 RPC 权限收紧;M8 两阶段核验显著降低部分 Copy 风险)。修复质量高,不是纸面修复--每条都有对应代码改动 + 单测(verify.test.ts 覆盖 M5/M8)。

### 必须处理(上线前)
- **F5**: 单测跑不起来。vitest 3 + rollup 仍缺 darwin binding。需删 lock + node_modules 重装(方案 A)。**不修则 31 个单测形同虚设,CI 无法执行。**

### 建议处理(非阻塞)
- commit message M8"零部分副作用"措辞调整为"阶段 1 失败零 Copy;阶段 2 部分 Copy 由 cleanup 兜底"(N1)。
- 补 `redactObjectSecrets`/`isSecretKeyName` 单测(F3 修复核心无测试覆盖)。
- HANDOFF "不可变固化"段补 staging 双路径删除说明。

### 无新代码缺陷
`6ef3bb0` 的 claim-先行 + 两阶段核验 + 脱敏/权限加固**未引入新的逻辑缺陷**。N1/N2/N3 均为信息级观察。核心 aigc-r2 实现质量从一轮的"9 PASS + 2 CONDITIONAL PASS"提升至**实质全 PASS**(F1/F3/F4 已修,F5 是工具链非代码逻辑)。

### 验证状态
- `npm run typecheck`:✅ 全绿
- `npm test`:❌ 崩(`@rollup/rollup-darwin-arm64` 缺失,F5 未修复)
- `npm run build`:未跑(本轮聚焦 review,build 在一轮已确认 typecheck 绿)

### 一句话给部署同学
二轮 review 的 F1-F4 已全部正确修复(含额外加固 H2/M5/M7/M8),**但 F5 单测仍跑不起来**(vitest 3 的 rollup binding 同样跨平台缺失)——需删 `package-lock.json` + `node_modules` 重装后单测才能执行;上线前必修 F5,其余已达可上线质量。
