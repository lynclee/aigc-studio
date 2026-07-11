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
  cancelOpenRouterImage,
  ensureOpenRouterImageConfigured,
  getOpenRouterImageStatus,
  submitOpenRouterImage,
} from "@/lib/engines/openrouter-image"
import { ProviderConfigurationError, ProviderContractError } from "@/lib/engines/provider-utils"

// 图片服务的展示与部署优先顺序：Modal → OpenRouter → fal → ComfyUI。
// 这不是自动 fallback；实际使用哪一个只由 AIGC_IMAGE_PROVIDER 决定。
type ImageProvider = "modal-image" | "openrouter-image" | "fal-image" | "comfyui-image"

type ProviderName = ImageProvider | "fal-model3d" | "fal-video"

export function providerNameForKind(kind: AigcKind): ProviderName {
  if (kind === "image") return configuredImageProvider()
  if (kind === "model3d") return "fal-model3d"
  return "fal-video"
}

export function ensureProviderConfigured(kind: AigcKind): void {
  const provider = providerNameForKind(kind)
  if (provider === "modal-image") return ensureModalImageConfigured()
  if (provider === "openrouter-image") return ensureOpenRouterImageConfigured()
  if (provider === "fal-image") return ensureFalImageConfigured()
  if (provider === "comfyui-image") return ensureComfyUiImageConfigured()
  if (kind === "model3d" || kind === "video") return ensureFalStyleConfigured(kind)
  throw new ProviderConfigurationError(`No provider is available for ${kind}`)
}

export async function submitProvider(kind: AigcKind, request: SubmitRequest): Promise<ProviderSubmitResult> {
  const provider = providerNameForKind(kind)
  if (provider === "modal-image") return submitModalImage(request)
  if (provider === "openrouter-image") return submitOpenRouterImage(request)
  if (provider === "fal-image") return submitFalImage(request)
  if (provider === "comfyui-image") return submitComfyUiImage(request)
  if (kind === "model3d" || kind === "video") return submitFalStyle(kind, request)
  throw new ProviderConfigurationError(`No provider is available for ${kind}`)
}

export async function pollProviderStatus(job: AigcJobRecord): Promise<ProviderStatusResult> {
  switch (job.provider) {
    case "modal-image":
      assertProviderKind(job, "image")
      return getModalImageStatus(job)
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
  if (value === "openrouter") return "openrouter-image"
  if (value === "fal") return "fal-image"
  if (value === "comfyui") return "comfyui-image"
  throw new ProviderConfigurationError("AIGC_IMAGE_PROVIDER must be modal, openrouter, fal, or comfyui")
}

function assertProviderKind(job: AigcJobRecord, expected: AigcKind): void {
  if (job.kind !== expected) {
    throw new ProviderContractError(`provider '${job.provider}' cannot run ${job.kind} jobs`)
  }
}
