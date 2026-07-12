# comfyui_modal_bridge 改造计划：新增 aigc-r2 交付模式

> 交付物。给维护 `comfyui_modal_bridge`(github.com/lynclee/comfyui_modal_bridge)的同学 / 会话。
> 目标:**不重写插件、不拆两套 Modal App**,只给 Modal Worker 增加一种**并行的结果交付方式**。
> 本文的 Vercel↔Bridge 接口契约是**双方唯一事实来源**;aigc-studio 侧按同一契约实现。
> 定位:合并并**取代** `docs/MODAL_BRIDGE_R2_CLAUDE_REVIEW_BRIEF.md` / `MODAL_BRIDGE_R2_REVIEW_RESPONSE.md` 中关于插件的部分。

## 0. 一句话

插件保留现有 `desktop` 模式(结果回本地 ComfyUI)不变,新增 `aigc-r2` 模式:结果**流式直传 Cloudflare R2**(用 Vercel 签发的短期预签名 PUT 地址),再回调通知 AIGC Studio。**R2 长期密钥永不进入 Modal**。

## 1. 铁律(安全不变量)

| 凭据 | 位置 |
|---|---|
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | **只在 Vercel**。Modal / Bridge / ComfyUI / 浏览器都不持有 |
| `BRIDGE_API_KEY` | 本地 Bridge config + Modal Secret + Vercel(调用 `/run` 的 `auth_key`) |
| `COMFY_API_KEY_COMFY_ORG` | 只在 Modal Secret |
| `delivery.token`(单任务临时许可) | Vercel 签发 → 随 `/run` 传入 → Bridge 仅内存/`job_state` 暂存,**不写本地 config、不进日志** |
| Modal Token | 只用于 `modal deploy`,只在本地 |

Bridge 上传 R2 时**只拿一个几分钟有效的预签名 PUT 地址**,不接触长期密钥。

## 2. 不要改动的部分

插件 main 已具备,**保持不变**:

- 4 档 Worker:`ComfyWorkerCPU` / `ComfyWorkerCheap` / `ComfyWorker` / `ComfyWorkerTop`;`run_endpoint()` 按 `needs_gpu` + `gpu_class` 路由。**GPU/CPU 路由已正确,无需再拆 URL。**
- 本地流程:`routes.py` 的 `/modal_bridge/submit` `/poll` `/fetch_result`、`web/modal_bridge.js`、本地 output 回填、模型同步、自定义节点同步、本地部署窗口。
- 三类输出识别(SaveImage→image / SaveVideo→video / SaveGLB·Preview3D→model3d)。

原插件用户仍能:本地选工作流 → 点 Modal → 云端生成 → 结果回本地。

## 3. 请求协议:`/run` 增加 `delivery`

AIGC Studio 调用:

```json
{
  "workflow": {},
  "auth_key": "Bridge API Key",
  "needs_gpu": true,
  "gpu_class": "primary",
  "delivery": {
    "mode": "aigc-r2",
    "job_id": "AIGC Studio 任务 UUID",
    "token": "该任务专用临时许可"
  }
}
```

本地 ComfyUI 调用:`{"delivery": {"mode": "desktop"}}`。
**向后兼容:没传 `delivery` 默认 `{"mode": "desktop"}`。** 不再用含义模糊的 `incognito` 控制结果去向。
`delivery.mode` ∉ {`desktop`,`aigc-r2`} → 返回 `{"error":"unsupported delivery mode"}`。

## 4. Vercel↔Bridge 接口契约(双方事实来源)

`AIGC_STUDIO_BASE_URL` 来自 Modal Secret。两个接口都可选带头 `x-vercel-protection-bypass: <AIGC_STUDIO_BYPASS_SECRET>`(仅当生产域名被 Vercel Protection 保护时需要)。二者都**不走用户登录**,只认 `token`。

### 4.1 `POST /api/internal/asset-intake`(每个输出文件调一次)

请求:
```json
{
  "job_id": "…",
  "token": "delivery.token",
  "asset_type": "image | video | model3d",
  "position": 0,
  "filename": "result.png",
  "content_type": "image/png",
  "size_bytes": 123456
}
```

成功 200:
```json
{
  "r2_key": "aigc/<user_id>/<job_id>/image-0.png",
  "asset_type": "image",
  "content_type": "image/png",
  "put_url": "https://<presigned>",
  "required_headers": { "Content-Type": "image/png" },
  "expires_in": 300
}
```

- **`required_headers` 只含 `Content-Type`。绝不含精确 `Content-Length`**(锁死会 403 且难查;size 由 Vercel 侧上限校验)。PUT 时**原样带回** `required_headers`,不要自加别的签名头。
- **r2_key 由 Vercel 生成,Bridge 不可自指定路径**。格式固定 `aigc/<user_id>/<job_id>/<asset_type>-<position>.<ext>`。
- **幂等**:同一 `(job_id, asset_type, position)` 重复 intake **返回同一 r2_key**(Vercel 侧 `aigc_job_uploads` 唯一约束保证)。

错误分类:

| 情况 | HTTP | 可否重试 |
|---|---|---|
| token 失效 / job 已终态 / job 属于他人 | 401/403 | **不重试** |
| 文件类型不允许 / size 超限 / 非法 | 400 | **不重试** |
| 502 / 503 / 504 / 网络超时 | 5xx | 重试 |

### 4.2 `POST /api/internal/job-complete`(全部文件传完后调一次)

请求:
```json
{
  "job_id": "…",
  "token": "delivery.token",
  "provider_job_id": "Modal job id",
  "assets": [
    {
      "asset_type": "image",
      "position": 0,
      "r2_key": "aigc/<user_id>/<job_id>/image-0.png",
      "content_type": "image/png",
      "size_bytes": 123456,
      "etag": "\"…R2 PUT 返回的 ETag…\"",
      "checksum_sha256": "可选"
    }
  ]
}
```

Vercel 行为:对每个 asset `HeadObject` 核验(存在 / size / r2_key 前缀 / ETag)→ 写 `aigc_generations` + `aigc_assets` → job 置 `succeeded`。幂等(唯一约束)。
**`checksum_sha256` 只作 metadata 存档,不作为完成门**——Vercel 不下载文件,无法重算,核验只信 R2 实际 size + ETag。

### 4.3 `/status` 必须回吐 delivery manifest(兜底恢复用)

即使 `job-complete` push 失败,`/status` 也要带上已上传的 assets manifest 和 delivery 状态,让 AIGC Studio 轮询时能从 manifest 恢复落库:

```json
{
  "status": "completed",
  "delivery": {
    "mode": "aigc-r2",
    "status": "completed | callback_failed",
    "assets": [{ "r2_key": "…", "asset_type": "image", "position": 0, "size_bytes": 123, "etag": "…" }]
  }
}
```

## 5. 具体改哪些文件

### 5.1 `modal_app/modal_app.py`
- Worker `run()` / `_worker_run(...)` 四个 Worker 同步增加 `delivery=None` 参数。
- `/run`:`delivery = payload.get("delivery") or {"mode":"desktop"}`;校验 mode;`worker().run.spawn(workflow, job_id, input_images, delivery)`。
- **`job_state` 不存敏感信息**:`delivery.token`、put_url、bypass 密钥都不写入。只存交付结果:
  ```json
  {"status":"completed","delivery":{"mode":"aigc-r2","status":"completed","assets":[{"r2_key":"…","size_bytes":123,"etag":"…"}]}}
  ```
- 状态机增加 `delivering`:`queued→running→delivering→completed`(失败 `failed`,取消 `cancelled`)。ComfyUI 出图后进 `delivering`,全部上传+回调成功才 `completed`。

### 5.2 新增 `modal_app/aigc_delivery.py`(网站交付独立成文件)
接口:`def deliver_outputs(job_id, outputs, delivery) -> list[dict]`。每个文件:
从 ComfyUI 读输出 → **流式写 /tmp,边写边算 size + SHA-256** → 调 `asset-intake` 换 PUT 地址 → `requests.put` 直传 R2 → 记 ETag → 删临时文件。全部完成后 POST `job-complete`。核心伪代码见附录 A。

### 5.3 `modal_app/_comfy_ws.py`（最核心改动:拆「发现」与「读取」)
现在 `run_workflow()` 收集输出后立刻 `get_image_data()` 读进内存 → base64/volume。拆两步:

1. **只发现输出**,返回引用,不读内容:
   ```json
   {"outputs":[{"filename":"result.mp4","subfolder":"","type":"output","node_id":"42","asset_type":"video"}]}
   ```
2. 按模式处理:`desktop` → 保持现有 `materialize_desktop_outputs`(base64/Volume);`aigc-r2` → 把引用交给 `aigc_delivery.py`。

收益:视频 / 3D 不再先进 Modal Dict;`job_state` 不再存大段 base64;**大文件流式,不整体进内存**(现 `get_image_data()` 会把整个 500MB 视频读进内存)。流式下载示例见附录 B。

### 5.4 `modal_app/modal_image.py`
`add_local_python_source(...)` 加入 `aigc_delivery`。镜像已有 `requests`,**上传预签名地址不需要 AWS SDK**:`requests.put(put_url, data=file_handle, headers=required_headers)`。R2 长期密钥不进 Modal。

### 5.5 `node_sync.py`（Modal Secret）
`secret_create_cmd()` 现存 `BRIDGE_API_KEY` + `COMFY_API_KEY_COMFY_ORG`,新增:
```
AIGC_STUDIO_BASE_URL
AIGC_STUDIO_BYPASS_SECRET   # 可选，仅生产域名被 Vercel Protection 保护时
```
**绝不含**:`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / Modal Token / OpenRouter Key / fal Key。

### 5.6 `config.py`（本地配置)
新增 `"aigc_studio_base_url": ""`、`"has_aigc_bypass_secret": false`。第一版可沿用现有本地保存 Comfy Key / Modal Token 的方式,但至少:config.json 权限设为仅当前用户可读;`/config` 永不返回密钥值;日志不打印;页面只显示「已保存」。

## 6. 重试与幂等

| 步骤 | 重试 | 退避 |
|---|---|---|
| asset-intake | ≤3 | 1/2/4/8s |
| R2 PUT(地址过期则重新申请) | ≤3 | 同上 |
| job-complete | ≤5 | 同上 |

**不重试**:token 失效 / job 已取消 / 类型不允许 / size 超限 / job 属他人 / 工作流非法。
**可重试**:网络超时 / 502·503·504 / PUT 地址上传前过期 / Vercel 暂不可用。
**重复安全**:同 `job_id + asset_type + position` 恒返同一 r2_key。

## 7. 完成 / 失败恢复

- ComfyUI 完成 → `delivering` → 全部上传成功 → `job-complete` 成功 → `completed`。
- 文件已传但回调失败:`job_state.delivery.status = "callback_failed"` 且保留 assets manifest。AIGC Studio 查 `/status` 拿到 manifest,用同一套落库逻辑恢复作品记录。**用户关页也不丢**(靠 Bridge push;push 失败靠 status 兜底)。

## 8. 最小闭环(第一版只做到这)

1. 保留 desktop 模式不变 → 2. 新增 aigc-r2 → 3. 只测**一个图片工作流** → 4. 图片流式写 /tmp → 5. 申请 PUT 地址 → 6. 直传 R2 → 7. 回调 job-complete → 8. 个人作品库显示图片。

稳定后再加:视频 / GLB / 多输出 / 输入参考图走 R2 GET(限 host `<account>.r2.cloudflarestorage.com`,防 SSRF)/ 回调失败恢复 / SHA-256 / 取消后孤儿文件清理。

## 9. 建议提交顺序

1. `feat(delivery): add desktop and aigc-r2 delivery contracts`(delivery 参数 + 校验 + 日志脱敏 + 单测 + 旧请求默认 desktop)
2. `refactor(outputs): separate output discovery from materialization`(desktop 行为不变,回归图片/视频/3D/本地回填)
3. `feat(delivery): stream Modal outputs to AIGC Studio R2`(aigc_delivery.py + /tmp 流式 + intake + PUT + complete + 重试)
4. `feat(config): add optional AIGC Studio delivery settings`(Modal Secret + GUI + 密钥隐藏 + README)
5. `test(delivery): cover retries, expiry and duplicate callbacks`

> ⚠️ Commit 3 两个坑:**sha256 不作核验门(只存 metadata)**;**PUT 的 required_headers 不锁精确 Content-Length**。

## 10. 测试矩阵

单图 / 多图 / MP4 / GLB / PUT 地址过期 / token 失效 / 重复 complete / 取消中完成 / 上传成功但 callback 失败 / desktop 模式无变化。

## 11. aigc-studio 侧对接清单（合同的另一半，AI 实现）

> 与本文契约严丝合缝。此清单取代原 `MODAL_BRIDGE_R2_REVIEW_RESPONSE.md` 第 5 节。

1. 新增 provider `modal-bridge`(`lib/engines/modal-bridge-image.ts`),**不改**旧 `modal-image`;`AIGC_IMAGE_PROVIDER` 加枚举,按 `job.provider` 分发,新旧任务并存。
2. adapter 用 Bridge 的 `auth_key`(body)协议,替代旧 `Modal-Key`/`Modal-Secret` 头;`/run` 带 `delivery{mode:aigc-r2, job_id, token}` + `needs_gpu`/`gpu_class`。
3. 新增 `/api/internal/asset-intake`、`/api/internal/job-complete`:只认 `delivery_token`(HMAC)+ `x-vercel-protection-bypass`,**不走 `getSession()`**。
4. `delivery_token` = `HMAC-SHA256(secret, "{job_id}|{user_id}|{exp}")`,`exp` 绑 job 最大生命周期(如 2h),校验 job 未 terminal;R2 PUT URL 才短 TTL(约 5min)。
5. `r2_key` 由 Vercel 生成,统一 `aigc/<user_id>/<job_id>/<asset_type>-<position>.<ext>`。
6. 预签名 PUT 只锁 `content-type` + size 上限,**不锁精确 Content-Length**。
7. 核验只信 R2 实际 `HeadObject` 的 size + ETag,**不信** Bridge 上报 sha256(仅存 metadata)。
8. migration:新表 `aigc_job_uploads`(在途上传记录 + `unique(job_id, asset_type, position)` 保证 r2_key 幂等);`aigc_assets` 保持「只存已完成资产」。
9. reconcile 改「running 超时兜底」;正常完成走 `job-complete` push;push 丢失时从 `/status` 的 manifest 恢复落库。
10. workflow 元数据(`image-registry.ts`)决定 `needs_gpu`,普通用户不可覆盖,无法判定走 GPU。
11. 修 `lib/jobs/input.ts` 丢参 bug:透传并校验 width/height/aspectRatio/seed/images(否则图生图与自定义尺寸走不通)。

新增 Vercel 变量:`MODAL_BRIDGE_ENDPOINT_BASE`、`MODAL_BRIDGE_API_KEY`、`BRIDGE_DELIVERY_TOKEN_SECRET`、`VERCEL_AUTOMATION_BYPASS_SECRET`。

### 12.1 插件侧后续小改(非阻塞,安全加固)

- **`/status` 支持用请求头传 BRIDGE_API_KEY**(如 `x-bridge-key` / `Authorization`),而不只是 query `?key=`。原因:GET 的 key 放 query 会进 Modal / 任何 TLS 终止代理的访问日志(经典「secret in URL」)。网站侧已确认该 key **不会**进 DB / 浏览器(fetchJson 错误不含请求 URL、落库错误已统一 sanitize),所以这纯粹是日志面加固。插件 `status_endpoint` 现在只读 query `key`;等它也认 header,网站 adapter 就切成 header(`run`/`cancel` 已经用 body `auth_key`,不受影响)。

---

## 附录 A：`aigc_delivery.deliver_one` 伪代码

```python
def deliver_one(job_id, position, output_ref, delivery):
    temp_file, size, sha256 = stream_output_to_temp(output_ref)  # 边写边算
    intake = post_json_with_retry(
        f"{AIGC_STUDIO_BASE_URL}/api/internal/asset-intake",
        {"job_id": job_id, "token": delivery["token"], "asset_type": output_ref["asset_type"],
         "position": position, "filename": safe_filename(output_ref["filename"]),
         "content_type": detect_content_type(output_ref["filename"]), "size_bytes": size},
        headers=website_headers())
    with open(temp_file, "rb") as src:
        resp = requests.put(intake["put_url"], data=src, headers=intake["required_headers"], timeout=UPLOAD_TIMEOUT)
        resp.raise_for_status()
    return {"asset_type": intake["asset_type"], "position": position, "r2_key": intake["r2_key"],
            "content_type": intake["content_type"], "size_bytes": size,
            "etag": resp.headers.get("ETag"), "checksum_sha256": sha256}
# 全部完成后:
post_json_with_retry(f"{AIGC_STUDIO_BASE_URL}/api/internal/job-complete",
    {"job_id": job_id, "token": delivery["token"], "provider_job_id": provider_job_id, "assets": assets})
```

## 附录 B：流式下载(替代整体进内存的 get_image_data)

```python
sha256 = hashlib.sha256(); size = 0
with requests.get(view_url, stream=True, timeout=60) as r:
    r.raise_for_status()
    with open(temp_path, "wb") as out:
        for chunk in r.iter_content(1024 * 1024):
            out.write(chunk); sha256.update(chunk); size += len(chunk)
```
