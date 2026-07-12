import { randomUUID } from "node:crypto"
import type { AigcJobRecord, ProviderStatusResult, ProviderSubmitResult, SubmitRequest } from "@/lib/aigc/types"
import { fetchJson, firstString, isRecord, MissingProviderEnvError } from "@/lib/aigc/http"
import { isSupportedImageContentType, MAX_INLINE_IMAGE_BYTES, storeImageBytesInR2 } from "@/lib/assets/r2-direct"
import { ProviderConfigurationError, UnsupportedCancelError } from "@/lib/engines/provider-utils"

const OPENROUTER_IMAGES_URL = "https://openrouter.ai/api/v1/images"
const OPENROUTER_IMAGE_TIMEOUT_MS = 240_000

export const OPENROUTER_IMAGE_PROVIDER = "openrouter-image"

type OpenRouterImageConfig = {
  apiKey: string
  defaultModel: string
  standardModel?: string
  detailModel?: string
  resolution?: string
  aspectRatio?: string
  quality?: string
  outputFormat?: "png" | "jpeg" | "webp"
  background?: "auto" | "transparent" | "opaque"
  siteUrl?: string
  appName?: string
}

type StoredOpenRouterImage = {
  r2Key: string
  contentType: string
  providerJobId: string
  model: string
  usage: Record<string, unknown>
}

export function ensureOpenRouterImageConfigured(): void {
  getConfig()
}

export async function submitOpenRouterImage(request: SubmitRequest): Promise<ProviderSubmitResult> {
  const config = getConfig()
  const model = modelForWorkflow(config, request.workflowId)
  const response = await fetchJson(
    OPENROUTER_IMAGES_URL,
    {
      method: "POST",
      headers: openRouterHeaders(config),
      body: JSON.stringify(buildRequestBody(config, model, request.prompt)),
    },
    OPENROUTER_IMAGE_TIMEOUT_MS,
  )
  const stored = await persistImage({
    image: parseImage(response, config.outputFormat),
    userId: request.userId,
    model,
    response,
  })

  return {
    provider: OPENROUTER_IMAGE_PROVIDER,
    providerJobId: stored.providerJobId,
    status: "succeeded",
    response: {
      model: stored.model,
      r2_key: stored.r2Key,
      content_type: stored.contentType,
      usage: stored.usage,
      completed_synchronously: true,
    },
  }
}

export async function getOpenRouterImageStatus(job: AigcJobRecord): Promise<ProviderStatusResult> {
  if (job.kind !== "image") throw new Error(`unsupported OpenRouter job kind ${job.kind}`)
  const r2Key = firstString(job.provider_response?.r2_key, job.provider_response?.r2Key)
  const contentType = firstString(job.provider_response?.content_type, job.provider_response?.contentType)
  if (!r2Key || !contentType) {
    throw new Error("OpenRouter image job is missing its persisted R2 result")
  }
  return {
    status: "succeeded",
    response: job.provider_response,
    assets: [{ assetType: "image", position: 0, r2Key, contentType, metadata: { model: job.provider_response?.model } }],
  }
}

export async function cancelOpenRouterImage(_job: AigcJobRecord): Promise<Record<string, unknown>> {
  throw new UnsupportedCancelError("OpenRouter image generation finishes during submission and cannot be cancelled")
}

function getConfig(): OpenRouterImageConfig {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim()
  const defaultModel = process.env.OPENROUTER_IMAGE_MODEL?.trim()
  const missing = [!apiKey ? "OPENROUTER_API_KEY" : null, !defaultModel ? "OPENROUTER_IMAGE_MODEL" : null].filter(
    (value): value is string => Boolean(value),
  )
  if (missing.length > 0) throw new MissingProviderEnvError(OPENROUTER_IMAGE_PROVIDER, missing)

  return {
    apiKey: apiKey as string,
    defaultModel: defaultModel as string,
    standardModel: nonEmptyEnv("OPENROUTER_IMAGE_STANDARD_MODEL"),
    detailModel: nonEmptyEnv("OPENROUTER_IMAGE_DETAIL_MODEL"),
    resolution: nonEmptyEnv("OPENROUTER_IMAGE_RESOLUTION"),
    aspectRatio: nonEmptyEnv("OPENROUTER_IMAGE_ASPECT_RATIO"),
    quality: nonEmptyEnv("OPENROUTER_IMAGE_QUALITY"),
    outputFormat: outputFormatFromEnv(),
    background: backgroundFromEnv(),
    siteUrl: nonEmptyEnv("OPENROUTER_SITE_URL"),
    appName: nonEmptyEnv("OPENROUTER_APP_NAME"),
  }
}

function nonEmptyEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

function outputFormatFromEnv(): "png" | "jpeg" | "webp" | undefined {
  const value = nonEmptyEnv("OPENROUTER_IMAGE_OUTPUT_FORMAT")?.toLowerCase()
  if (!value) return undefined
  if (value === "png" || value === "jpeg" || value === "webp") return value
  throw new ProviderConfigurationError("OPENROUTER_IMAGE_OUTPUT_FORMAT must be png, jpeg, or webp")
}

function backgroundFromEnv(): "auto" | "transparent" | "opaque" | undefined {
  const value = nonEmptyEnv("OPENROUTER_IMAGE_BACKGROUND")?.toLowerCase()
  if (!value) return undefined
  if (value === "auto" || value === "transparent" || value === "opaque") return value
  throw new ProviderConfigurationError("OPENROUTER_IMAGE_BACKGROUND must be auto, transparent, or opaque")
}

function modelForWorkflow(config: OpenRouterImageConfig, workflowId: string): string {
  if (workflowId === "detail") return config.detailModel ?? config.defaultModel
  return config.standardModel ?? config.defaultModel
}

function openRouterHeaders(config: OpenRouterImageConfig): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
    ...(config.siteUrl ? { "HTTP-Referer": config.siteUrl } : {}),
    ...(config.appName ? { "X-Title": config.appName } : {}),
  }
}

function buildRequestBody(config: OpenRouterImageConfig, model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    prompt,
    n: 1,
    ...(config.resolution ? { resolution: config.resolution } : {}),
    ...(config.aspectRatio ? { aspect_ratio: config.aspectRatio } : {}),
    ...(config.quality ? { quality: config.quality } : {}),
    ...(config.outputFormat ? { output_format: config.outputFormat } : {}),
    ...(config.background ? { background: config.background } : {}),
  }
}

function parseImage(
  response: Record<string, unknown>,
  configuredFormat: OpenRouterImageConfig["outputFormat"],
): { bytes: Buffer; contentType: string } {
  const data = Array.isArray(response.data) ? response.data : []
  const first = data.find(isRecord)
  const base64 = first && firstString(first.b64_json)
  if (!base64) throw new Error("OpenRouter image response contained no image data")
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("OpenRouter image response contained invalid base64 data")
  }

  const bytes = Buffer.from(base64, "base64")
  if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error("OpenRouter image output exceeded the supported file-size limit")
  }

  const mediaType = firstString(first.media_type) ?? contentTypeForFormat(configuredFormat)
  if (!isSupportedImageContentType(mediaType)) {
    throw new Error(`OpenRouter image output used unsupported media type '${mediaType}'`)
  }
  return { bytes, contentType: mediaType }
}

async function persistImage(params: {
  image: { bytes: Buffer; contentType: string }
  userId: string
  model: string
  response: Record<string, unknown>
}): Promise<StoredOpenRouterImage> {
  const providerJobId = randomUUID()
  const asset = await storeImageBytesInR2({
    userId: params.userId,
    providerJobId,
    position: 0,
    bytes: params.image.bytes,
    contentType: params.image.contentType,
    metadata: { provider: OPENROUTER_IMAGE_PROVIDER, model: params.model },
  })
  if (!asset.r2Key || !asset.contentType) throw new Error("OpenRouter image persistence returned an incomplete asset")

  return {
    r2Key: asset.r2Key,
    contentType: asset.contentType,
    providerJobId,
    model: params.model,
    usage: safeUsage(params.response.usage),
  }
}

function safeUsage(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    ["prompt_tokens", "completion_tokens", "total_tokens", "cost"].flatMap((key) =>
      typeof value[key] === "number" ? [[key, value[key]]] : [],
    ),
  )
}

function contentTypeForFormat(format: OpenRouterImageConfig["outputFormat"]): string {
  if (format === "jpeg") return "image/jpeg"
  if (format === "webp") return "image/webp"
  return "image/png"
}
