# Review Brief:AIGC Studio × Modal Bridge aigc-r2 实现(网站侧)

> 给独立审阅者(Codex / GLM 5.2)。这是**已落代码**的 review,不是设计评审。
> 目标:找「纸面合理、上线偶发翻车」的集成级缺陷,以及安全/并发/输入校验漏洞。
> 本文是**临时 review 产物**,审完可删。契约来源见 `docs/PLUGIN_MODAL_BRIDGE_CHANGE_PLAN.md`,现状见 `docs/HANDOFF.md`。

## 1. 一句话背景

设计/美术用的 AIGC 网站(Vercel + Supabase + R2,GitHub 登录)。新增 `modal-bridge` provider:用户维护的 `comfyui_modal_bridge` 插件(已 0.6.0)出片后**直传 R2**(用 Vercel 签的短期预签名 PUT),再 **push 回调**网站落库;push 丢失时网站轮询 Bridge `/status` 拿 manifest 兜底。图片/视频/3D 通用。**插件是另一个仓库,不在本次 review 范围**;只审网站侧 TS。

## 2. 本次改了什么(review 范围)

**Stage 1 — 交付契约地基**
- `supabase/migrations/0004_aigc_job_uploads.sql`:在途上传台账(幂等 + 孤儿清理)。
- `lib/delivery/token.ts`:`delivery_token` HMAC 签发/校验(绑 job,2h)。
- `lib/delivery/asset-policy.ts`:content-type/大小/扩展名/position 校验(含视频/3D 白名单)。
- `lib/delivery/verify.ts`:HeadObject 核验 manifest → ProviderOutputAsset(job-complete 与 /status 兜底**共用**)。
- `lib/delivery/uploads.ts` / `cleanup.ts`:台账 CRUD + R2 孤儿清理。
- `lib/delivery/http.ts`:内部 endpoint 错误映射(只给稳定 code)。
- `app/api/internal/asset-intake/route.ts`:换短期预签名 PUT。
- `app/api/internal/job-complete/route.ts`:核验 → 落库 → 置成功。
- `lib/r2.ts`:`+signPutUrl`(只锁 content-type)/`+headObject`(404→null,瞬时错误抛)/`+deleteObject`。
- `lib/jobs/store.ts`:`+assetExistsForKey`;`failClaimedJob`/`updateClaimedJobFromProviderStatus`/`markJobFailed` 补 `sanitizeStoredError`。

**Stage 2 — adapter + 路由**
- `lib/engines/modal-bridge.ts`:kind 通用 adapter(submit 签 token + POST /run;`/status` 映射 + 兜底核验;cancel)。
- `lib/jobs/providers.ts`:provider 路由(`AIGC_IMAGE/VIDEO/MODEL3D_PROVIDER`)+ 按 `job.provider` 分发。
- `lib/jobs/submit-route.ts`:提交时把 `{jobId}` 传给 adapter 用于签 token。
- `lib/workflows/registry.ts`:`renderWorkflow(kind)` 分发(image / video / 3D)。

**Stage 3 — 输入 + 清理**
- `lib/jobs/input.ts`:参数透传 + 校验(width/height/aspectRatio/seed/参考图 base64)。
- `app/api/jobs/reconcile/route.ts`:对账后跑孤儿清理。

**UI + 工作流**
- `components/portal-workbench.tsx`:尺寸/宽高比/参考图上传控件(仅图片)。
- `lib/workflows/image-registry.ts`:图生图 `z_image_turbo_i2i`(参考图存在自动切)+ GPU 元数据。
- `lib/workflows/templates/`:`z_image_turbo_i2i.json`(核心节点 LoadImage/VAEEncode)、`api_seedance2_0_mini_t2v.json`(文生视频)、`api_tripo3_0_text_to_model.json`(文生 3D)。

## 3. 请逐条验证的契约与安全不变量

1. **delivery_token**:HMAC 能否伪造/篡改载荷绕过?常量时间比较?exp 过期?`claims.jobId===body.job_id` + `getOwnedJob(jobId, claims.userId)` 是否真绑定(A 的 token 落不了 B 的 job/用户)?
2. **R2 密钥边界**:R2 长期 key 是否只在 Vercel?预签名 PUT 是否**只锁 content-type、不锁 Content-Length**?
3. **内部 endpoint 鉴权**:是否**不走 getSession**、只认 token + protection-bypass?未配 token/R2 时是否优雅 503 而非崩/误放行?
4. **r2_key 注入**:服务端是否**重算**权威 key、拒绝 Bridge 自造路径(含 `..`)?伪造 manifest 能否写他人前缀?
5. **核验**:是否只信 R2 实际 HeadObject 的 size(含**上限**拦超大/0 字节)+ ETag、**不信** Bridge 上报 sha256?
6. **并发/幂等**:job-complete 与 reconcile 都过 `claimJobForReconcile` 租约是否真串行化?materialize upsert 幂等?**上传中 cancel** 会不会入库孤儿?已 succeeded 是否短路?
7. **/status 兜底容错**:completed 时核验遇 R2 **瞬时错误**是否**保守当作 running**(不把已完成 job 永久置失败)?manifest 本身错才 failed?
8. **无密钥外泄**:token/BRIDGE_API_KEY 是否可能进 `aigc_jobs.error` / 浏览器响应 / 日志?(四条 error 写入路径是否都 sanitize?)
9. **不可信输入**(`input.ts`):数值校验(NaN/浮点/科学计数/越界)、参考图只收 base64 data-uri(SSRF)、正则 ReDoS、文件名 `..`/前导点、aspectRatio 极端比绕过尺寸上限?
10. **孤儿清理**:`cleanupOrphanDeliveries` 会不会误删活资产?(`assetExistsForKey` 闸门是否可靠;grace 期是否够避开在途 job-complete。)
11. **provider 分发**:kind 与 provider 错配(如 video 走图片 adapter)是否被挡?未知 provider?

## 4. 我做的设计决策(请重点挑战)

- **job-complete 复用 reconcile 租约**(claim→materialize→complete)来串行化 push⇄reconcile、并挡上传中 cancel。合理吗?有无更隐蔽的竞态?
- **/status 兜底**:非 `DeliveryVerifyError` 一律返回 running(含 R2 未配置/瞬时错误)。会不会让「真失败」的 job 永远 running 徘徊?
- **delivery_token 载荷 base64url 明文含 userId**(HMAC 签名,只发给自建 bridge)——接受。有风险吗?
- **BRIDGE_API_KEY 放 status GET 的 `?key=`**(插件 status 只认 query)。已确认不入 DB/浏览器,仅日志面;插件加 header 支持后切走。可接受吗?
- **参考图 base64 塞 POST body**(受 Vercel 4.5MB 限制);正解是 R2-staging(未做)。当前边界安全吗?
- **图生图自动切**:图片工作流检测到参考图就切 i2i 模板,**不新增 workflow_id、不动 DB CHECK**。
- **视频/3D 模板 = 原始 ComfyUI API JSON**,只 `{{PROMPT}}/{{SEED}}` 替换;API 节点款 `needs_gpu=false` 跑 CPU worker。

## 5. 已做过的内审(别重复,可复核)

已用 code-reviewer 对 **Stage 1 / Stage 2 / input.ts** 各跑一轮独立审并修复,值得复核这些修复是否到位:
- Stage 1:job-complete 加 HeadObject **权威 size 上限**核验;改用租约避免孤儿资产 + push/reconcile 双写;r2_key 精确重算;先签名后记台账。
- Stage 2:**/status 瞬时 R2 错误不再永久失败**;四条 error 写入统一 sanitize;manifest 长度 cap 32。
- input.ts:文件名剥前导点/拒 `.`·`..`/唯一化;aspectRatio 极端比拒绝 + `round64` 上钳 4096。

## 6. 已知限制 / 未完成(不算 bug,别报)

- **端到端从未真跑过**(此环境无 Modal/R2/ComfyUI):代码级 typecheck+build 通过,真 E2E 待部署同学。
- **工作流模板需真 ComfyUI 验证**:`z_image_turbo_i2i`(Z-Image 的 VAEEncode+denoise 效果)、seedance/tripo(API 节点行为)。
- **多参考图工作流**(seedance r2v 4图 / tripo i2model 3视图)未接(需多图 UI)。
- **OpenRouter Video** adapter 未做;**flux2_klein 图生图**未做(FLUX.2 结构复杂)。
- 视频/3D 的分辨率/时长/质量为模板固定默认,未做 UI 控件。
- UI 实机视觉验证(1920/1080)待部署后带会话做。

## 7. 请审阅者重点回答

1. 内部 endpoint 有无**鉴权绕过 / 越权**路径?
2. push / reconcile / cancel 三者并发有无**竞态**导致孤儿资产、双写、或状态错乱?
3. 有无任何路径让**服务端密钥**到达 DB / 浏览器 / 日志?
4. `input.ts` 处理浏览器不可信输入有无**注入 / DoS / 绕过**?
5. 孤儿清理会不会**误删活资产**?
6. `modal-bridge` adapter 对 image/video/3D **kind 通用**的假设有无破绽(status 映射、核验、cancel)?
7. 优雅降级:缺 env(R2/token/bridge/workflow)时是否一律明确报错、不崩、不误放行?

## 8. 如何验证

```bash
npm run typecheck && npm run build   # 应全绿
git diff --check
```
真实 E2E 需部署同学的 provider / Supabase / R2 / Modal Secret 配置(见 `docs/HANDOFF.md` 部署段)。
