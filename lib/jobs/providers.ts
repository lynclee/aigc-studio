import type { AigcJobRecord, AigcKind, ProviderStatusResult, ProviderSubmitResult, SubmitRequest } from "@/lib/aigc/types"
import {
  cancelComfyUiImage,
  ensureComfyUiImageConfigured,
  getComfyUiImageStatus,
  submitComfyUiImage,
} from "@/lib/engines/comfyui-image"
import { cancelFalImage, ensureFalImageConfigured, getFalImageStatus, submitFalImage } from "@/lib/engines/fal-image"
import { cancelFalStyle, ensureFalStyleConfigured, getFalStyleStatus, submitFalStyle } from "@/lib/engines/fal-http"
import { cancelModalImage, ensureModalImageConfigured, getModalImageStatus, submitModalImage } from "@/lib/engines/modal-image"
import {
  cancelModalBridge,
  ensureModalBridgeConfigured,
  getModalBridgeStatus,
  submitModalBridge,
} from "@/lib/engines/modal-bridge"
import {
  cancelOpenRouterImage,
  ensureOpenRouterImageConfigured,
  getOpenRouterImageStatus,
  submitOpenRouterImage,
} from "@/lib/engines/openrouter-image"
import { ProviderConfigurationError, ProviderContractError } from "@/lib/engines/provider-utils"

// 各创作类型的后端优先/默认:图片 Modal → OpenRouter → fal;视频/3D 目前默认 fal,可切 modal-bridge。
// 这不是自动 fallback;实际用哪个只由对应的 AIGC_*_PROVIDER 决定。
// modal-bridge = 通过 comfyui_modal_bridge 的 aigc-r2 交付,图片/视频/3D 通用(视频/3D 待工作流 JSON)。
type ImageProvider = "modal-image" | "modal-bridge" | "openrouter-image" | "fal-image" | "comfyui-image"
type VideoProvider = "modal-bridge" | "fal-video"
type Model3dProvider = "modal-bridge" | "fal-model3d"

type ProviderName = ImageProvider | VideoProvider | Model3dProvider

/** 提交时的服务端上下文；modal-bridge 用 jobId 现签 delivery_token,其它 provider 忽略。 */
export interface SubmitContext {
  jobId: string
}

export function providerNameForKind(kind: AigcKind): ProviderName {
  if (kind === "image") return configuredImageProvider()
  if (kind === "video") return configuredVideoProvider()
  return configuredModel3dProvider()
}

export function ensureProviderConfigured(kind: AigcKind): void {
  const provider = providerNameForKind(kind)
  switch (provider) {
    case "modal-image":
      return ensureModalImageConfigured()
    case "modal-bridge":
      return ensureModalBridgeConfigured()
    case "openrouter-image":
      return ensureOpenRouterImageConfigured()
    case "fal-image":
      return ensureFalImageConfigured()
    case "comfyui-image":
      return ensureComfyUiImageConfigured()
    case "fal-model3d":
      return ensureFalStyleConfigured("model3d")
    case "fal-video":
      return ensureFalStyleConfigured("video")
    default:
      throw new ProviderConfigurationError(`No provider is available for ${kind}`)
  }
}

export async function submitProvider(
  kind: AigcKind,
  request: SubmitRequest,
  ctx: SubmitContext,
): Promise<ProviderSubmitResult> {
  const provider = providerNameForKind(kind)
  switch (provider) {
    case "modal-image":
      return submitModalImage(request)
    case "modal-bridge":
      return submitModalBridge(kind, request, ctx)
    case "openrouter-image":
      return submitOpenRouterImage(request)
    case "fal-image":
      return submitFalImage(request)
    case "comfyui-image":
      return submitComfyUiImage(request)
    case "fal-model3d":
    case "fal-video":
      if (kind === "model3d" || kind === "video") return submitFalStyle(kind, request)
      throw new ProviderConfigurationError(`No provider is available for ${kind}`)
    default:
      throw new ProviderConfigurationError(`No provider is available for ${kind}`)
  }
}

export async function pollProviderStatus(
  job: AigcJobRecord,
  ctx: { beforeAssetCopy?: () => Promise<void> } = {},
): Promise<ProviderStatusResult> {
  switch (job.provider) {
    case "modal-image":
      assertProviderKind(job, "image")
      return getModalImageStatus(job)
    case "modal-bridge":
      // kind 通用(image/video/model3d),按 job.kind 核验,不限定单一 kind。
      return getModalBridgeStatus(job, ctx.beforeAssetCopy)
    case "openrouter-image":
      assertProviderKind(job, "image")
      return getOpenRouterImageStatus(job)
    case "fal-image":
      assertProviderKind(job, "image")
      return getFalImageStatus(job)
    case "comfyui-image":
      assertProviderKind(job, "image")
      return getComfyUiImageStatus(job)
    case "fal-model3d":
      assertProviderKind(job, "model3d")
      return getFalStyleStatus(job)
    case "fal-video":
      assertProviderKind(job, "video")
      return getFalStyleStatus(job)
    default:
      throw new ProviderContractError(job.provider ? `unknown provider '${job.provider}'` : "job provider missing")
  }
}

export async function cancelProviderJob(job: AigcJobRecord): Promise<Record<string, unknown>> {
  switch (job.provider) {
    case "modal-image":
      assertProviderKind(job, "image")
      return cancelModalImage(job)
    case "modal-bridge":
      return cancelModalBridge(job)
    case "openrouter-image":
      assertProviderKind(job, "image")
      return cancelOpenRouterImage(job)
    case "fal-image":
      assertProviderKind(job, "image")
      return cancelFalImage(job)
    case "comfyui-image":
      assertProviderKind(job, "image")
      return cancelComfyUiImage(job)
    case "fal-model3d":
      assertProviderKind(job, "model3d")
      return cancelFalStyle(job)
    case "fal-video":
      assertProviderKind(job, "video")
      return cancelFalStyle(job)
    default:
      throw new ProviderContractError(job.provider ? `unknown provider '${job.provider}'` : "job provider missing")
  }
}

function configuredImageProvider(): ImageProvider {
  const value = (process.env.AIGC_IMAGE_PROVIDER ?? "modal").trim().toLowerCase()
  if (value === "modal") return "modal-image"
  if (value === "modal-bridge") return "modal-bridge"
  if (value === "openrouter") return "openrouter-image"
  if (value === "fal") return "fal-image"
  if (value === "comfyui") return "comfyui-image"
  throw new ProviderConfigurationError("AIGC_IMAGE_PROVIDER must be modal, modal-bridge, openrouter, fal, or comfyui")
}

function configuredVideoProvider(): VideoProvider {
  const value = (process.env.AIGC_VIDEO_PROVIDER ?? "fal").trim().toLowerCase()
  if (value === "modal-bridge") return "modal-bridge"
  if (value === "fal") return "fal-video"
  throw new ProviderConfigurationError("AIGC_VIDEO_PROVIDER must be fal or modal-bridge")
}

function configuredModel3dProvider(): Model3dProvider {
  const value = (process.env.AIGC_MODEL3D_PROVIDER ?? "fal").trim().toLowerCase()
  if (value === "modal-bridge") return "modal-bridge"
  if (value === "fal") return "fal-model3d"
  throw new ProviderConfigurationError("AIGC_MODEL3D_PROVIDER must be fal or modal-bridge")
}

function assertProviderKind(job: AigcJobRecord, expected: AigcKind): void {
  if (job.kind !== expected) {
    throw new ProviderContractError(`provider '${job.provider}' cannot run ${job.kind} jobs`)
  }
}
