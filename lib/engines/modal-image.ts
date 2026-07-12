import type { AigcJobRecord, ProviderStatusResult, ProviderSubmitResult, SubmitRequest } from "@/lib/aigc/types"
import { fetchJson, firstString, isRecord, MissingProviderEnvError, trimTrailingSlash } from "@/lib/aigc/http"
import {
  extractProviderAssets,
  providerErrorFrom,
  providerJobIdFrom,
  providerStatusFrom,
} from "@/lib/engines/provider-utils"
import { renderImageWorkflow } from "@/lib/workflows/image-registry"

export const MODAL_IMAGE_PROVIDER = "modal-image"

type ModalConfig = { base: string; key: string; secret: string }

function getConfig(): ModalConfig {
  const base = process.env.MODAL_ENDPOINT_BASE
  const key = process.env.MODAL_KEY
  const secret = process.env.MODAL_SECRET
  const missing = [
    !base ? "MODAL_ENDPOINT_BASE" : null,
    !key ? "MODAL_KEY" : null,
    !secret ? "MODAL_SECRET" : null,
  ].filter((value): value is string => Boolean(value))
  if (missing.length) throw new MissingProviderEnvError(MODAL_IMAGE_PROVIDER, missing)
  return { base: trimTrailingSlash(base as string), key: key as string, secret: secret as string }
}

function modalUrl(config: ModalConfig, action: "run" | "status" | "cancel"): string {
  return `${config.base}-${action}.modal.run`
}

function headers(config: ModalConfig): HeadersInit {
  return {
    "Content-Type": "application/json",
    "Modal-Key": config.key,
    "Modal-Secret": config.secret,
  }
}

export function ensureModalImageConfigured(): void {
  getConfig()
}

export async function submitModalImage(request: SubmitRequest): Promise<ProviderSubmitResult> {
  const config = getConfig()
  const rendered = renderImageWorkflow({ prompt: request.prompt, input: request.input })
  const response = await fetchJson(modalUrl(config, "run"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(buildModalRunBody(request, rendered)),
  })
  const providerJobId = providerJobIdFrom(response)
  if (!providerJobId) throw new Error("Modal image response missing provider job id")
  return {
    provider: MODAL_IMAGE_PROVIDER,
    providerJobId,
    status: providerStatusFrom(response),
    response: {
      ...response,
      workflow_id: rendered.id,
      settings: { width: rendered.width, height: rendered.height, seed: rendered.seed },
    },
  }
}

function buildModalRunBody(
  request: SubmitRequest,
  rendered: ReturnType<typeof renderImageWorkflow>,
): Record<string, unknown> {
  const gpu = firstString(request.input.gpu) ?? rendered.gpu
  const images = modalImagesFrom(request.input)
  return {
    workflow: rendered.workflow,
    user_id: request.userId,
    ...(gpu ? { gpu } : {}),
    ...(images ? { images } : {}),
    prompt: request.prompt,
    settings: {
      workflow: rendered.id,
      width: rendered.width,
      height: rendered.height,
      seed: rendered.seed,
      ...metadataSettingsFrom(request.input),
    },
  }
}

function modalImagesFrom(input: Record<string, unknown>): unknown[] | undefined {
  const raw = input.images ?? input.image_urls ?? input.imageUrls
  if (Array.isArray(raw) && raw.length > 0) return raw
  const image = firstString(input.image, input.image_url, input.imageUrl, input.input_image_url, input.inputImageUrl)
  return image ? [{ name: "image1", image }] : undefined
}

function metadataSettingsFrom(input: Record<string, unknown>): Record<string, unknown> {
  const settings = isRecord(input.settings) ? input.settings : {}
  return {
    ...settings,
    ...(firstString(input.aspectRatio, input.aspect_ratio) ? { aspectRatio: firstString(input.aspectRatio, input.aspect_ratio) } : {}),
  }
}

export async function getModalImageStatus(job: AigcJobRecord): Promise<ProviderStatusResult> {
  const config = getConfig()
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")
  const response = await fetchJson(`${modalUrl(config, "status")}?job_id=${encodeURIComponent(job.provider_job_id)}`, {
    method: "GET",
    headers: headers(config),
  })
  const status = providerStatusFrom(response)
  return {
    status,
    response,
    error: status === "failed" ? providerErrorFrom(response) ?? "Modal image job failed" : undefined,
    assets: status === "succeeded" ? extractProviderAssets("image", response) : [],
  }
}

export async function cancelModalImage(job: AigcJobRecord): Promise<Record<string, unknown>> {
  const config = getConfig()
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")
  return fetchJson(modalUrl(config, "cancel"), {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({ job_id: job.provider_job_id }),
  })
}
