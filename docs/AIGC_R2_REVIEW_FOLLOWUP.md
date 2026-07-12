# AIGC R2 二次 Review(新提交跟进)

> 针对 `55cf0a6`(单测)+ `a90131f`(docs 同步)两提交的跟进 review。
> 上次报告:`docs/AIGC_R2_REVIEW_RESPONSE.md`(未修改,原样提交,17467 字节一致)。
> 审阅者:GLM 5.2(独立会话)。审完本文件可随 brief 一起删。

## 0. 跟进范围

- `55cf0a6` test: 21 个 vitest 单测(token/asset-policy/input)
- `a90131f` docs: HANDOFF/CLAUDE/README 同步 + 删 3 旧 docs + 提交上次 review 报告 + brief + PLATFORM_OVERVIEW + PLUGIN_MODAL_BRIDGE_CHANGE_PLAN
- **核心逻辑改动 `82b7761..HEAD`(lib/app)**: 仅 `image-registry.ts`(+46, i2i 逻辑,上次已审)+ 3 个模板 JSON + 3 个测试文件。**`reconcile.ts` / `cleanup.ts` / `store.ts` / `job-complete route.ts` 均未改动**。

## 1. F5 [高/阻塞] 单测跑不起来

### 现象
`npm test` 报错退出:
```
Error: Cannot find module '@rolldown/binding-darwin-arm64'
Cannot find module './rolldown-binding.darwin-arm64.node'
```

### 根因
- 依赖链:`vitest@4.1.10` -> `vite@8.1.4` -> `rolldown@1.1.5`
- `rolldown` 的 `optionalDependencies` 声明了 `@rolldown/binding-darwin-arm64@1.1.5`(以及其他 13 个平台 binding)
- 但 `node_modules/@rolldown/` **只装了 `binding-linux-arm64-gnu`**(本机是 macOS arm64)
- `package-lock.json` 跨平台锁定不当(疑似在 Linux 环境生成,锁了 linux binding),macOS `npm install`/`npm ci` 未装 darwin binding

### 影响
- **本地 macOS 开发者无法跑单测**(`npm test` 直接崩)
- `55cf0a6` commit message 说"npm run test",但本机无法验证--单测形同虚设
- CI 若是 Linux 可能能跑(有 linux binding),但跨平台一致性破坏;若 CI 也是 macOS 则同样崩
- 上次报告 §0 提的"初读过时缓存"问题部分源于此:无单测护栏,代码改动依赖人工 review

### 修复建议(按推荐度)
- **方案 A(最稳)**: 降级 `vitest` 到 `3.x`(用 esbuild,不依赖 rolldown native binding)。vitest 4 切到 rolldown 是新依赖,跨平台 native binding 反复出问题。
- **方案 B**: 删 `package-lock.json` + `node_modules`,在 macOS 重 `npm install`(会装 darwin binding)。但 lock 文件若在 CI(Linux)重新生成会反过来缺 linux binding--治标不治本。
- **方案 C(临时)**: `npm install @rolldown/binding-darwin-arm64@1.1.5 --no-save` 补上当前平台。
- **配套**: 无论选哪个,CI 矩阵应同时跑 linux + macOS 验证单测可执行。

## 2. F1-F4 状态:全部未处理

`82b7761..HEAD` 无 `lib/jobs/reconcile.ts` / `lib/delivery/cleanup.ts` / `lib/jobs/store.ts` / `app/api/internal/job-complete/route.ts` 改动。上次报告的 4 个发现均未修复。

| 编号 | 上次结论 | 当前状态 | 说明 |
|---|---|---|---|
| **F1** [中] reconcile 路径 staging 不清理 | 上线前应修 | **未处理** | `reconcile.ts:60-82` succeeded 分支仍无 `deleteObject(stagingKey)`。aigc-r2 核心兜底场景的存储泄漏,累积性。 |
| F2 [低] job-complete claim 失败 staging 残留 | 非阻塞 | 未处理 | `job-complete/route.ts:48-64` verify 在 claim 前的竞态窗口仍在。 |
| F3 [低/信息] provider_response JSON 未 sanitize | 非阻塞 | 未处理 | `store.ts:335` 仍直接存 Bridge 响应 JSON。 |
| F4 [信息] 3h running 占配额 | 可观察 | 未处理 | `reconcile.ts:24` MAX_JOB_AGE_MS 不变。 |

**F1 仍是上线前应处理项**。修复成本约一行(`reconcile.ts` succeeded 分支补 `deleteObject(stagingKey)`,同 `job-complete/route.ts:80`)。

## 3. docs 同步评价(a90131f)

### 到位
- ✅ **HANDOFF 新版准确描述 aigc-r2 链路** + "不可变固化(Codex review 后加固)"段(staging key `.staging/…` / Copy staging->final / `finalize_job_assets` RPC fence + reconcile_token)。这与代码一致(我上次核实)。
- ✅ **删 3 个旧 docs**(`MODAL_BRIDGE_R2_CLAUDE_REVIEW_BRIEF` / `MODAL_COMFY_BACKEND_ARCHITECTURE` / `AIGC_STUDIO_CROSS_REVIEW_HANDOFF`)被 `PLUGIN_MODAL_BRIDGE_CHANGE_PLAN` + `PLATFORM_OVERVIEW` 取代,合理收敛。
- ✅ **migration 列表更新 0001-0005**(含 0004 上传台账 + 0005 `finalize_job_assets` RPC),部署段补 `0004`/`0005`。
- ✅ **我的上次报告原样提交**(17467 字节,`git show HEAD:docs/AIGC_R2_REVIEW_RESPONSE.md` 与工作树一致),未被篡改。

### 不一致(小,建议修)
- ⚠️ **HANDOFF 链路图措辞过时**:写"`-> 领 reconcile 租约 -> materialize -> succeeded`",但实际代码用 `finalizeJobWithAssets` RPC(非 `materializeCompletedJob`)。虽"不可变固化"段提了 RPC,链路图本身仍用旧词。建议链路图改"`-> finalize_job_assets RPC(原子落库 fence)-> succeeded`"。
- ⚠️ **HANDOFF 未纳入 F1**: "不可变固化"段描述了 staging->final Copy,但**未提 staging 在 reconcile 路径不清理的泄漏**。HANDOFF "待做"清单也未列。我的上次报告已记录 F1,但 HANDOFF 现状描述未反映此问题--docs 与 review 发现脱节。建议 HANDOFF "待做"或"已知限制"补一条 staging 清理不一致。

## 4. 单测质量评价(55cf0a6)

### 覆盖良好(21 个纯函数单测)
| 文件 | 测试数 | 覆盖 | 对应不变量 |
|---|---|---|---|
| `lib/delivery/token.test.ts` | 6 | HMAC 篡改 payload/签名、过期、不同 secret、非字符串/格式错、round-trip 绑定 | 不变量 1 核心 |
| `lib/delivery/asset-policy.test.ts` | 6 | content-type 白名单、asset_type 按 kind(H5)、octet-stream ext 保真(M8)、staging key 派生、ETag 归一化、position/size 边界 | 不变量 4/5 局部 |
| `lib/jobs/input.test.ts` | 8 | prompt 非空/4000、workflow 白名单、width/height 范围 + **"1e9"科学计数拒绝**、aspectRatio 99:1/0:0 拒、seed 范围、参考图 base64/URL 拒/text/html 拒/非法字符拒、数量上限、filename `..`/前导点/去重 | 不变量 9 核心 |

**亮点**:`input.test.ts:23` 的 `"1e9"` 科学计数拒绝直接对应 brief §3.9 点名的浮点/科学计数校验;`:41` 的 URL 参考图拒绝对应 SSRF 防护;`:51` 的 `../etc` filename 对应路径注入防护。断言清晰,边界到位(0/999/1000 position、0/-5 size、4001 char prompt、5 张参考图)。

### 缺口(可选增强,非阻塞)
- **未覆盖 F1-F4**(集成级,纯函数单测难覆盖,需 mock R2/DB。建议未来加集成测试覆盖 staging 清理与 RPC fence)。
- `stagingKeyForFinal` 无 `/` 边界(finalKey 无斜杠时返回 `.staging/${finalKey}`,逻辑正确但无断言)。
- `extForAsset` filename 路径注入(如 `../x.png` -> ext "png",我上次确认安全但无单测锁定)。
- prompt 模板注入(`{{WIDTH}}` 替换,低风险但无单测)。

### 单测本身无 bug
断言正确,无 `test.skip`/`.only`,无 stub 占位。**唯一问题是跑不起来**(F5)。

## 5. 总结

### 必须处理(上线前)
- **F5**: 单测跑不起来(vitest 4 + rolldown native binding 跨平台缺失)。不修则 CI 无法跑单测,21 个单测形同虚设。推荐降级 vitest 3.x。
- **F1**: reconcile 路径 staging 清理(上次已提,仍未处理)。存储泄漏,累积性。

### 建议处理(非阻塞)
- HANDOFF 链路图措辞(`materialize` -> `finalize_job_assets` RPC)+ "待做"补 staging 清理不一致。
- 单测补 `stagingKeyForFinal` 边界 + `extForAsset` filename 注入(锁定已知安全行为)。

### 无新代码缺陷
`55cf0a6`(单测)+ `a90131f`(docs)**未引入新的生产代码逻辑缺陷**。`image-registry.ts` +46(i2i 自动切)上次已审。核心 aigc-r2 实现质量维持上次评价(**11 不变量 9 PASS + 2 CONDITIONAL PASS + 0 FAIL**)。

### 复核 typecheck
`npm run typecheck` = ✅ 全绿(上次已确认,本次未变)。

### 一句话给部署同学
Claude 的新提交加了单测和 docs 同步,但**单测在本机跑不起来**(rolldown binding 缺失),且**上次提的 staging 泄漏(F1)未修**;上线前需修这两项,其余维持上次评价。
