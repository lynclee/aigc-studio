import type { AigcKind, JobStatus, ProviderOutputAsset } from "@/lib/aigc/types"
import { firstString, isRecord, jsonRecord } from "@/lib/aigc/http"

const RUNNING = new Set(["queued", "queue", "pending", "in_queue", "running", "processing", "started", "submitted"])
const SUCCEEDED = new Set(["succeeded", "success", "completed", "complete", "done", "finished"])
const FAILED = new Set(["failed", "failure", "error", "errored"])
const CANCELLED = new Set(["cancelled", "canceled", "aborted"])

export class ProviderContractError extends Error {
  readonly status = 502
  readonly code = "provider_contract_error"
  readonly publicMessage = "Provider returned an unsupported response."

  constructor(message: string) {
    super(message)
  }
}

export class ProviderConfigurationError extends Error {
  readonly status = 503
  readonly code = "invalid_provider_config"
  readonly publicMessage = "Provider is not configured."

  constructor(message: string) {
    super(message)
  }
}

export class ProviderInputError extends Error {
  readonly status = 400
  readonly code = "invalid_provider_input"
  readonly exposeMessage = true
}

export class UnsupportedCancelError extends Error {
  readonly status = 409
  readonly code = "unsupported_cancel"
  readonly publicMessage = "Cancellation is not supported for this provider."

  constructor(message = "Cancellation is not supported for this provider.") {
    super(message)
  }
}

export function normalizeProviderStatus(value: unknown): JobStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (SUCCEEDED.has(raw)) return "succeeded"
  if (FAILED.has(raw)) return "failed"
  if (CANCELLED.has(raw)) return "cancelled"
  if (RUNNING.has(raw)) {
    if (raw === "queued" || raw === "queue" || raw === "pending" || raw === "in_queue") {
      return "queued"
    }
    return "running"
  }
  throw new ProviderContractError(raw ? `unknown provider status '${raw}'` : "provider status missing")
}

export function providerJobIdFrom(data: Record<string, unknown>): string | undefined {
  return firstString(data.id, data.job_id, data.jobId, data.request_id, data.requestId, data.task_id, data.taskId)
}

export function providerStatusUrlFrom(data: Record<string, unknown>): string | undefined {
  return firstString(data.status_url, data.statusUrl, data.urls && isRecord(data.urls) ? data.urls.status : undefined)
}

export function providerStatusFrom(data: Record<string, unknown>): JobStatus {
  return normalizeProviderStatus(firstString(data.status, data.state, data.phase))
}

export function providerErrorFrom(data: Record<string, unknown>): string | undefined {
  const error = data.error
  if (typeof error === "string") return error
  if (isRecord(error)) return firstString(error.message, error.detail)
  return firstString(data.message, data.detail)
}

export function extractProviderAssets(kind: AigcKind, response: Record<string, unknown>): ProviderOutputAsset[] {
  const output = jsonRecord(response.output)
  const data = jsonRecord(response.data)
  const candidates: ProviderOutputAsset[] = []

  addAssetArray(candidates, kind, output.assets ?? data.assets ?? response.assets)
  addUrlArray(candidates, kind, "image", output.images ?? data.images ?? response.images)
  addUrlArray(candidates, kind, "video", output.videos ?? data.videos ?? response.videos)
  addUrlArray(candidates, kind, "model", output.models ?? data.models ?? response.models)

  addUrl(candidates, kind, inferredAssetType(kind), firstString(
    output.url,
    output.output_url,
    output.file_url,
    data.url,
    data.output_url,
    data.file_url,
    response.url,
    response.output_url,
    response.file_url,
  ))
  addUrl(candidates, kind, "image", firstString(output.image_url, data.image_url, response.image_url))
  addUrl(candidates, kind, "video", firstString(output.video_url, data.video_url, response.video_url))
  addUrl(candidates, kind, "model", firstString(output.model_url, data.model_url, response.model_url))

  return candidates.map((asset, index) => ({ ...asset, position: asset.position ?? index }))
}

function inferredAssetType(kind: AigcKind): string {
  if (kind === "image") return "image"
  if (kind === "video") return "video"
  return "model"
}

function addAssetArray(target: ProviderOutputAsset[], kind: AigcKind, value: unknown): void {
  if (!Array.isArray(value)) return
  value.forEach((item, index) => {
    if (typeof item === "string") {
      addUrl(target, kind, inferredAssetType(kind), item, index)
      return
    }
    if (!isRecord(item)) return
    const url = firstString(item.url, item.download_url, item.file_url, item.image_url, item.video_url, item.model_url)
    if (!url) return
    const assetType = firstString(item.asset_type, item.type, item.kind) ?? inferredAssetType(kind)
    const contentType = firstString(item.content_type, item.mime_type, item.mimeType)
    target.push({
      assetType,
      position: typeof item.position === "number" ? item.position : index,
      url,
      contentType,
      metadata: item,
    })
  })
}

function addUrlArray(target: ProviderOutputAsset[], kind: AigcKind, assetType: string, value: unknown): void {
  if (!Array.isArray(value)) return
  value.forEach((item, index) => {
    if (typeof item === "string") {
      addUrl(target, kind, assetType, item, index)
      return
    }
    if (!isRecord(item)) return
    const url = firstString(item.url, item.download_url, item.file_url)
    if (!url) return
    target.push({
      assetType,
      position: typeof item.position === "number" ? item.position : index,
      url,
      contentType: firstString(item.content_type, item.mime_type, item.mimeType),
      metadata: item,
    })
  })
}

function addUrl(
  target: ProviderOutputAsset[],
  kind: AigcKind,
  assetType: string,
  url: string | undefined,
  position?: number,
): void {
  if (!url) return
  target.push({ assetType, position: position ?? target.length, url, metadata: { kind } })
}
