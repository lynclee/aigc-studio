import type { AigcJobRecord, AigcKind, ProviderOutputAsset, ProviderStatusResult, ProviderSubmitResult, SubmitRequest } from "@/lib/aigc/types"
import { fetchJson, firstString, isRecord, MissingProviderEnvError } from "@/lib/aigc/http"
import {
  extractProviderAssets,
  providerErrorFrom,
  providerJobIdFrom,
  providerStatusFrom,
  providerStatusUrlFrom,
  ProviderConfigurationError,
  ProviderInputError,
  UnsupportedCancelError,
} from "@/lib/engines/provider-utils"
import { executionFromWorkflowSnapshot, type WorkflowJobSnapshot } from "@/lib/workflows/revision"

const FAL_QUEUE_BASE = "https://queue.fal.run"

const MODEL3D_WORKFLOWS: Record<string, { endpoint: string; textEndpoint: string; multiViewEndpoint?: string }> = {
  hunyuan3d: {
    endpoint: "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
    textEndpoint: "fal-ai/hunyuan-3d/v3.1/rapid/text-to-3d",
  },
  tripo3d: {
    endpoint: "tripo3d/h3.1/image-to-3d",
    textEndpoint: "tripo3d/h3.1/text-to-3d",
    multiViewEndpoint: "tripo3d/h3.1/multiview-to-3d",
  },
}

const DEFAULT_VIDEO_ENDPOINT = "fal-ai/wan-25-preview/text-to-video"

type FalKind = Exclude<AigcKind, "image">

type FalConfig = {
  kind: FalKind
  provider: "fal-model3d" | "fal-video"
  apiKey: string
}

export { ProviderInputError, UnsupportedCancelError }

function getConfig(kind: FalKind): FalConfig {
  const apiKey = process.env.FAL_KEY
  const provider = kind === "model3d" ? "fal-model3d" : "fal-video"
  if (!apiKey) throw new MissingProviderEnvError(provider, ["FAL_KEY"])
  return { kind, provider, apiKey }
}

function falHeaders(apiKey: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Key ${apiKey}` }
}

export function ensureFalStyleConfigured(kind: FalKind): void {
  getConfig(kind)
}

export async function submitFalStyle(
  kind: FalKind,
  request: SubmitRequest,
  workflowSnapshot: WorkflowJobSnapshot,
): Promise<ProviderSubmitResult> {
  const config = getConfig(kind)
  const { endpoint, body, execution } = kind === "model3d"
    ? buildModel3dSubmission(request, workflowSnapshot)
    : buildVideoSubmission(request, workflowSnapshot)
  const response = await fetchJson(`${FAL_QUEUE_BASE}/${endpoint}`, {
    method: "POST",
    headers: falHeaders(config.apiKey),
    body: JSON.stringify(body),
  })
  const providerJobId = providerJobIdFrom(response)
  const statusUrl = providerStatusUrlFrom(response)
  const responseUrl = firstString(response.response_url, response.responseUrl)
  if (!providerJobId || !statusUrl || !responseUrl) {
    throw new Error(`${config.provider} submit response missing request_id/status_url/response_url`)
  }
  const status = hasProviderStatus(response) ? providerStatusFrom(response) : "queued"
  return {
    provider: config.provider,
    providerJobId,
    status,
    statusUrl,
    response: {
      ...response,
      endpoint,
      response_url: responseUrl,
      catalog_workflow_id: request.workflowId,
      execution_variant: execution.variant,
      template_version: execution.templateVersion,
    },
  }
}

function hasProviderStatus(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, "status")
    || Object.prototype.hasOwnProperty.call(data, "state")
    || Object.prototype.hasOwnProperty.call(data, "phase")
}

export async function getFalStyleStatus(job: AigcJobRecord): Promise<ProviderStatusResult> {
  if (job.kind !== "model3d" && job.kind !== "video") throw new Error(`unsupported fal kind ${job.kind}`)
  const config = getConfig(job.kind)
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")
  const statusUrl = job.provider_status_url ?? firstString(job.provider_response?.status_url, job.provider_response?.statusUrl)
  if (!statusUrl) throw new Error("fal job missing status_url")

  const statusResponse = await fetchJson(statusUrl, { method: "GET", headers: falHeaders(config.apiKey) })
  const status = providerStatusFrom(statusResponse)
  const responseUrl = firstString(job.provider_response?.response_url, job.provider_response?.responseUrl, statusResponse.response_url, statusResponse.responseUrl)

  if (status !== "succeeded") {
    return {
      status,
      response: { ...job.provider_response, ...statusResponse, response_url: responseUrl },
      error: status === "failed" ? providerErrorFrom(statusResponse) ?? `${config.provider} job failed` : undefined,
      assets: [],
    }
  }

  if (!responseUrl) throw new Error("fal completed job missing response_url")
  const resultResponse = await fetchJson(responseUrl, { method: "GET", headers: falHeaders(config.apiKey) })
  const mergedResponse = { ...job.provider_response, ...statusResponse, output: resultResponse, response_url: responseUrl }
  const assets = extractFalResultAssets(job.kind, resultResponse)
  return {
    status: assets.length > 0 ? "succeeded" : "failed",
    response: mergedResponse,
    error: assets.length > 0 ? undefined : `${config.provider} completed without a usable output URL`,
    assets,
  }
}

export async function cancelFalStyle(_job: AigcJobRecord): Promise<Record<string, unknown>> {
  throw new UnsupportedCancelError("fal queue cancellation is not supported for this provider")
}

type FalSubmission = {
  endpoint: string
  body: Record<string, unknown>
  execution: Readonly<{ variant: string; templateVersion: string }>
}

function buildVideoSubmission(request: SubmitRequest, workflowSnapshot: WorkflowJobSnapshot): FalSubmission {
  const referenceCount = inputImagesFrom(request.input).length
  if (referenceCount > 0) {
    throw new ProviderInputError("reference_images_not_supported")
  }
  const execution = executionFromWorkflowSnapshot(workflowSnapshot, {
    kind: "video",
    workflowId: request.workflowId,
    provider: "fal-video",
    referenceCount,
  })
  return {
    endpoint: configuredVideoEndpoint(execution.variant),
    body: {
      prompt: request.prompt,
      ...dropInternalKeys(request.input, ["mediaType", "workflow", "workflowId"]),
    },
    execution,
  }
}

function configuredVideoEndpoint(variant: string): string {
  if (variant !== "fal-wan25-t2v") {
    throw new ProviderInputError(`unsupported video execution variant '${variant}'`)
  }
  return configuredFalEndpoint("FAL_VIDEO_ENDPOINT", DEFAULT_VIDEO_ENDPOINT)
}

function buildModel3dSubmission(request: SubmitRequest, workflowSnapshot: WorkflowJobSnapshot): FalSubmission {
  const images = inputImagesFrom(request.input)
  if (images.length > 4) throw new ProviderInputError("too_many_reference_images")
  const execution = executionFromWorkflowSnapshot(workflowSnapshot, {
    kind: "model3d",
    workflowId: request.workflowId,
    provider: "fal-model3d",
    referenceCount: images.length,
  })
  const endpoint = configuredModel3dEndpoint(execution.variant)
  return {
    endpoint,
    body: images.length === 0
      ? buildTextTo3dFalInput(endpoint, request)
      : buildModel3dFalInput(endpoint, images, request.input),
    execution,
  }
}

function configuredModel3dEndpoint(variant: string): string {
  switch (variant) {
    case "hunyuan3d":
      return configuredFalEndpoint("FAL_MODEL3D_STANDARD_ENDPOINT", MODEL3D_WORKFLOWS.hunyuan3d.textEndpoint)
    case "hunyuan3d-image":
      return configuredFalEndpoint("FAL_MODEL3D_STANDARD_IMAGE_ENDPOINT", MODEL3D_WORKFLOWS.hunyuan3d.endpoint)
    case "tripo3d":
      return configuredFalEndpoint("FAL_MODEL3D_GAME_ASSET_ENDPOINT", MODEL3D_WORKFLOWS.tripo3d.textEndpoint)
    case "tripo3d-image":
      return configuredFalEndpoint("FAL_MODEL3D_GAME_ASSET_IMAGE_ENDPOINT", MODEL3D_WORKFLOWS.tripo3d.endpoint)
    case "tripo3d-multiview":
      return configuredFalEndpoint(
        "FAL_MODEL3D_GAME_ASSET_MULTIVIEW_ENDPOINT",
        MODEL3D_WORKFLOWS.tripo3d.multiViewEndpoint as string,
      )
    default:
      throw new ProviderInputError(`unsupported model3d execution variant '${variant}'`)
  }
}

function configuredFalEndpoint(envName: string, fallback: string): string {
  const endpoint = process.env[envName]?.trim() || fallback
  if (!/^[A-Za-z0-9._/-]+$/.test(endpoint) || endpoint.includes("//")) {
    throw new ProviderConfigurationError(`${envName} must be a fal.ai endpoint path`)
  }
  return endpoint.replace(/^\/+|\/+$/g, "")
}

function inputImagesFrom(input: Record<string, unknown>): string[] {
  const rawImages = input.images ?? input.image_urls ?? input.imageUrls
  const fromArray = Array.isArray(rawImages)
    ? rawImages
        .map((item) => {
          if (typeof item === "string") return item.trim()
          if (isRecord(item)) return firstString(item.image, item.url, item.image_url, item.imageUrl)
          return undefined
        })
        .filter((value): value is string => Boolean(value))
    : []
  const single = firstString(input.image, input.image_url, input.imageUrl, input.input_image_url, input.inputImageUrl)
  return [...(single ? [single] : []), ...fromArray]
}

function buildTextTo3dFalInput(endpoint: string, request: SubmitRequest): Record<string, unknown> {
  const passthrough = dropInternalKeys(request.input, [
    "mediaType",
    "workflow",
    "workflowId",
    "workflow_id",
    "images",
    "image_urls",
    "imageUrls",
    "image",
    "image_url",
    "imageUrl",
    "input_image_url",
    "inputImageUrl",
  ])
  if (endpoint.toLowerCase().includes("tripo")) {
    return { prompt: request.prompt, pbr: true, ...passthrough }
  }
  return { prompt: request.prompt, enable_pbr: true, ...passthrough }
}

function buildModel3dFalInput(endpoint: string, images: string[], input: Record<string, unknown>): Record<string, unknown> {
  const ep = endpoint.toLowerCase()
  const passthrough = dropInternalKeys(input, [
    "mediaType",
    "workflow",
    "workflowId",
    "workflow_id",
    "images",
    "image_urls",
    "imageUrls",
    "image",
    "image_url",
    "imageUrl",
    "input_image_url",
    "inputImageUrl",
  ])
  if (ep.includes("tripo")) {
    const base = { pbr: true, orientation: "align_image", ...passthrough }
    if (ep.includes("multi")) {
      const ordered = [images[0], images[2], images[1], images[3]].filter((value): value is string => Boolean(value))
      return { image_urls: ordered, ...base }
    }
    return { image_url: images[0], ...base }
  }
  return {
    input_image_url: images[0],
    ...(images[1] ? { back_image_url: images[1] } : {}),
    ...(images[2] ? { left_image_url: images[2] } : {}),
    ...(images[3] ? { right_image_url: images[3] } : {}),
    enable_pbr: true,
    ...passthrough,
  }
}

function dropInternalKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const blocked = new Set(keys)
  return Object.fromEntries(Object.entries(input).filter(([key]) => !blocked.has(key)))
}

function extractFalResultAssets(kind: FalKind, result: Record<string, unknown>): ProviderOutputAsset[] {
  if (kind === "video") {
    const videoUrl = fileUrl(result.video) ?? fileUrl(result.output) ?? firstString(result.video_url, result.url, result.output_url)
    const thumbnailUrl = fileUrl(result.thumbnail) ?? firstString(result.thumbnail_url, result.preview_url)
    return [
      ...(videoUrl ? [{ assetType: "video", position: 0, url: videoUrl, metadata: result }] : []),
      ...(thumbnailUrl ? [{ assetType: "preview", position: 1, url: thumbnailUrl, metadata: result }] : []),
    ]
  }

  const modelUrls = isRecord(result.model_urls) ? result.model_urls : {}
  const modelUrl =
    fileUrl(result.model_glb) ??
    fileUrl(modelUrls.glb) ??
    [result.model_mesh, result.pbr_model, result.base_model, result.model, result.output]
      .map(fileUrl)
      .find((url) => !!url && /\.glb(\?|$)/i.test(url)) ??
    firstString(result.model_url, result.glb_url, result.url)
  const thumbnailUrl = fileUrl(result.thumbnail) ?? fileUrl(result.rendered_image) ?? firstString(result.thumbnail_url, result.preview_url)
  return [
    ...(modelUrl ? [{ assetType: "model", position: 0, url: modelUrl, metadata: result }] : []),
    ...(thumbnailUrl ? [{ assetType: "preview", position: 1, url: thumbnailUrl, metadata: result }] : []),
  ]
}

function fileUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (isRecord(value)) return firstString(value.url, value.file_url, value.download_url)
  return undefined
}
