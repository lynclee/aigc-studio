/**
 * modal-bridge —— 通过 comfyui_modal_bridge 的 aigc-r2 交付模式生成(图片/视频/3D 通用)。
 *
 * 提交:POST <base>-run.modal.run,body 带 auth_key + needs_gpu/gpu_class +
 *   delivery{mode:"aigc-r2", job_id, token}。token 是 Vercel 现签的 HMAC(绑本 job)。
 *   工作流按 kind 由 renderWorkflow 选(image 已就绪;video/3D 待部署同学提供 ComfyUI JSON)。
 * 完成:正常由 Bridge push 到 /api/internal/job-complete 落库;本 adapter 的 /status 仅作兜底 ——
 *   completed 时读 delivery.assets manifest,经 verifyDeliveredAssets(HeadObject 核验)恢复落库。
 *   status/verify/cancel 全按 job.kind 通用,image/video/3D 共用一套。
 *
 * ⚠ 绝不把请求 body(含 delivery.token)写进 provider_response;只存 Bridge 回的干净元数据。
 */

import type {
  AigcJobRecord,
  AigcKind,
  ProviderStatusResult,
  ProviderSubmitResult,
  SubmitRequest,
} from "@/lib/aigc/types"
import { fetchJson, firstString, isRecord, MissingProviderEnvError, trimTrailingSlash } from "@/lib/aigc/http"
import { providerErrorFrom, providerJobIdFrom } from "@/lib/engines/provider-utils"
import { renderWorkflow } from "@/lib/workflows/registry"
import { signDeliveryToken } from "@/lib/delivery/token"
import { DeliveryVerifyError, verifyDeliveredAssets } from "@/lib/delivery/verify"

export const MODAL_BRIDGE_PROVIDER = "modal-bridge"

type BridgeConfig = { base: string; key: string }

function getConfig(): BridgeConfig {
  const base = process.env.MODAL_BRIDGE_ENDPOINT_BASE
  const key = process.env.MODAL_BRIDGE_API_KEY
  const missing = [
    !base ? "MODAL_BRIDGE_ENDPOINT_BASE" : null,
    !key ? "MODAL_BRIDGE_API_KEY" : null,
  ].filter((value): value is string => Boolean(value))
  if (missing.length) throw new MissingProviderEnvError(MODAL_BRIDGE_PROVIDER, missing)
  return { base: trimTrailingSlash(base as string), key: key as string }
}

function bridgeUrl(config: BridgeConfig, action: "run" | "status" | "cancel"): string {
  return `${config.base}-${action}.modal.run`
}

export function ensureModalBridgeConfigured(): void {
  getConfig()
}

export async function submitModalBridge(
  kind: AigcKind,
  request: SubmitRequest,
  ctx: { jobId: string },
): Promise<ProviderSubmitResult> {
  const config = getConfig()
  const rendered = renderWorkflow(kind, { prompt: request.prompt, input: request.input })
  const token = signDeliveryToken({ jobId: ctx.jobId, userId: request.userId })
  const images = bridgeImagesFrom(request.input)

  const response = await fetchJson(bridgeUrl(config, "run"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workflow: rendered.workflow,
      auth_key: config.key,
      needs_gpu: rendered.needsGpu ?? true,
      gpu_class: rendered.gpuClass ?? "primary",
      ...(images ? { images } : {}),
      delivery: { mode: "aigc-r2", job_id: ctx.jobId, token },
    }),
  })
  if (typeof response.error === "string" && response.error) {
    throw new Error(`Modal Bridge run rejected: ${response.error}`)
  }

  const providerJobId = providerJobIdFrom(response) ?? ctx.jobId
  return {
    provider: MODAL_BRIDGE_PROVIDER,
    providerJobId,
    status: "running",
    // 只存干净元数据;Bridge 的 /run 响应是 {id,status,gpu},不含 token。绝不存请求 body。
    response: {
      id: providerJobId,
      catalog_workflow_id: request.workflowId,
      execution_variant: rendered.id,
      template_version: rendered.templateVersion,
      gpu: firstString(response.gpu) ?? null,
      settings: { width: rendered.width ?? null, height: rendered.height ?? null, seed: rendered.seed ?? null },
    },
  }
}

export async function getModalBridgeStatus(
  job: AigcJobRecord,
  beforeAssetCopy?: () => Promise<void>,
): Promise<ProviderStatusResult> {
  const config = getConfig()
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")
  const response = await fetchJson(
    `${bridgeUrl(config, "status")}?job_id=${encodeURIComponent(job.provider_job_id)}&key=${encodeURIComponent(config.key)}`,
    { method: "GET" },
  )
  return mapBridgeStatus(job, response, beforeAssetCopy)
}

export async function cancelModalBridge(job: AigcJobRecord): Promise<Record<string, unknown>> {
  const config = getConfig()
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")
  return fetchJson(bridgeUrl(config, "cancel"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: job.provider_job_id, auth_key: config.key }),
  })
}

async function mapBridgeStatus(
  job: AigcJobRecord,
  response: Record<string, unknown>,
  beforeAssetCopy?: () => Promise<void>,
): Promise<ProviderStatusResult> {
  const raw = (firstString(response.status) ?? "").toLowerCase()

  // job_state 被 TTL 清掉 / 从未存在:push 是主路径,这里保守当作仍在跑,不误判失败。
  if (!raw && typeof response.error === "string") {
    return { status: "running", response, assets: [] }
  }
  if (raw === "queued" || raw === "running" || raw === "delivering") {
    return { status: "running", response, assets: [] }
  }
  if (raw === "failed") {
    return { status: "failed", response, error: providerErrorFrom(response) ?? "Modal Bridge job failed", assets: [] }
  }
  if (raw === "cancelled") {
    return { status: "cancelled", response, assets: [] }
  }
  if (raw === "completed") {
    const delivery = isRecord(response.delivery) ? response.delivery : null
    const manifest = delivery && Array.isArray(delivery.assets) ? delivery.assets : []
    if (manifest.length === 0) {
      return { status: "failed", response, error: "Modal Bridge completed without a delivery manifest", assets: [] }
    }
    try {
      const verified = await verifyDeliveredAssets(job, manifest, { beforeCopy: beforeAssetCopy })
      return { status: "succeeded", response, assets: verified.map((v) => v.output) }
    } catch (error) {
      // manifest 本身有问题(shape/前缀/size/类型)→ 永久失败。
      if (error instanceof DeliveryVerifyError) {
        return { status: "failed", response, error: `delivery verification failed: ${error.code}`, assets: [] }
      }
      // 当前 reconciler 已失去 fencing lease：必须交回上层读真实状态，不能伪装成
      // provider 仍在 running，否则后续 updateClaimedJob 会制造无意义的 DB 错误噪音。
      if ((error as { code?: unknown })?.code === "reconcile_lease_lost") throw error
      // R2 未配置 / HeadObject 瞬时错误 → 保守当作仍在跑,让下次轮询重试,不误判。
      return { status: "running", response, assets: [] }
    }
  }
  // 未知状态:保守当作仍在跑(backstop)。
  return { status: "running", response, assets: [] }
}

function bridgeImagesFrom(input: Record<string, unknown>): unknown[] | undefined {
  const raw = input.images ?? input.image_urls ?? input.imageUrls
  if (Array.isArray(raw) && raw.length > 0) return raw
  const image = firstString(input.image, input.image_url, input.imageUrl, input.input_image_url, input.inputImageUrl)
  return image ? [{ name: "image1", image }] : undefined
}
