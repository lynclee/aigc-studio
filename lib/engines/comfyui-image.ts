import { randomUUID } from "node:crypto"
import type { AigcJobRecord, JobStatus, ProviderOutputAsset, ProviderStatusResult, ProviderSubmitResult, SubmitRequest } from "@/lib/aigc/types"
import { firstString, HttpJsonError, isRecord, MissingProviderEnvError, readJsonResponse, trimTrailingSlash } from "@/lib/aigc/http"
import { isSupportedImageContentType, MAX_INLINE_IMAGE_BYTES, storeImageBytesInR2 } from "@/lib/assets/r2-direct"
import { ProviderConfigurationError, ProviderContractError, UnsupportedCancelError } from "@/lib/engines/provider-utils"
import { renderImageWorkflow } from "@/lib/workflows/image-registry"
import type { WorkflowJobSnapshot } from "@/lib/workflows/revision"

const COMFYUI_REQUEST_TIMEOUT_MS = 60_000

export const COMFYUI_IMAGE_PROVIDER = "comfyui-image"

type ComfyUiConfig = {
  baseUrl: string
  accountApiKey?: string
}

type ComfyOutputFile = {
  filename: string
  subfolder: string
  type: string
  nodeId: string
}

export function ensureComfyUiImageConfigured(): void {
  getConfig()
}

export async function submitComfyUiImage(
  request: SubmitRequest,
  workflowSnapshot: WorkflowJobSnapshot,
): Promise<ProviderSubmitResult> {
  const config = getConfig()
  const rendered = renderImageWorkflow({
    prompt: request.prompt,
    input: request.input,
    workflowId: request.workflowId,
    provider: COMFYUI_IMAGE_PROVIDER,
    workflowSnapshot,
  })
  const response = await fetchComfyJson(config, "prompt", {
    method: "POST",
    body: JSON.stringify({
      prompt: rendered.workflow,
      client_id: randomUUID(),
      ...(config.accountApiKey ? { extra_data: { api_key_comfy_org: config.accountApiKey } } : {}),
    }),
  })
  const providerJobId = firstString(response.prompt_id, response.promptId, response.id, response.job_id)
  if (!providerJobId) {
    const nodeErrors = isRecord(response.node_errors) ? JSON.stringify(response.node_errors).slice(0, 500) : ""
    throw new ProviderContractError(`ComfyUI prompt response missing prompt_id${nodeErrors ? `: ${nodeErrors}` : ""}`)
  }

  return {
    provider: COMFYUI_IMAGE_PROVIDER,
    providerJobId,
    status: "queued",
    response: {
      prompt_id: providerJobId,
      uses_comfy_account_api_key: Boolean(config.accountApiKey),
      catalog_workflow_id: request.workflowId,
      execution_variant: rendered.id,
      template_version: rendered.templateVersion,
      settings: { width: rendered.width, height: rendered.height, seed: rendered.seed },
    },
  }
}

export async function getComfyUiImageStatus(job: AigcJobRecord): Promise<ProviderStatusResult> {
  if (job.kind !== "image") throw new Error(`unsupported ComfyUI job kind ${job.kind}`)
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")

  const readyAssets = r2AssetsFromResponse(job.provider_response)
  if (readyAssets.length > 0) {
    return { status: "succeeded", response: job.provider_response, assets: readyAssets }
  }

  const config = getConfig()
  const result = await getLocalStatus(config, job.provider_job_id)

  if (result.status !== "succeeded") {
    return {
      status: result.status,
      response: { ...job.provider_response, last_status: result.status },
      error: result.error,
      assets: [],
    }
  }

  const files = collectOutputFiles(result.outputs)
  if (files.length === 0) {
    return {
      status: "failed",
      response: { ...job.provider_response, last_status: "failed" },
      error: "ComfyUI completed without an image output",
      assets: [],
    }
  }

  const assets = await Promise.all(
    files.map(async (file, position) => {
      const downloaded = await downloadOutputImage(config, file)
      return storeImageBytesInR2({
        userId: job.user_id,
        providerJobId: job.provider_job_id as string,
        position,
        bytes: downloaded.bytes,
        contentType: downloaded.contentType,
        metadata: { filename: file.filename, subfolder: file.subfolder, type: file.type, node_id: file.nodeId },
      })
    }),
  )

  return {
    status: "succeeded",
    response: { ...job.provider_response, last_status: "succeeded", r2_assets: assets },
    assets,
  }
}

export async function cancelComfyUiImage(_job: AigcJobRecord): Promise<Record<string, unknown>> {
  throw new UnsupportedCancelError("ComfyUI cancellation is intentionally not exposed because an interrupt can affect other queued work")
}

function getConfig(): ComfyUiConfig {
  const rawBaseUrl = process.env.COMFYUI_BASE_URL?.trim()
  if (!rawBaseUrl) throw new MissingProviderEnvError(COMFYUI_IMAGE_PROVIDER, ["COMFYUI_BASE_URL"])

  let baseUrl: string
  try {
    const parsed = new URL(rawBaseUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol")
    }
    baseUrl = trimTrailingSlash(parsed.toString())
  } catch {
    throw new ProviderConfigurationError("COMFYUI_BASE_URL must be a valid http(s) URL")
  }

  return {
    baseUrl,
    accountApiKey: process.env.COMFY_ORG_API_KEY?.trim() || undefined,
  }
}

async function getLocalStatus(config: ComfyUiConfig, providerJobId: string): Promise<{
  status: JobStatus
  error?: string
  outputs: Record<string, unknown>
}> {
  const history = await fetchComfyJson(config, `history/${encodeURIComponent(providerJobId)}`, { method: "GET" })
  const record = isRecord(history[providerJobId]) ? history[providerJobId] : history
  const statusRecord = isRecord(record.status) ? record.status : {}
  const rawStatus = firstString(statusRecord.status_str, statusRecord.status, record.status)
  const status = normalizeComfyStatus(rawStatus, statusRecord.completed === true)
  return {
    status,
    error: status === "failed" ? comfyError(record) : undefined,
    outputs: isRecord(record.outputs) ? record.outputs : {},
  }
}

function normalizeComfyStatus(value: string | undefined, completed: boolean): JobStatus {
  const status = value?.trim().toLowerCase()
  if (["completed", "complete", "success", "succeeded"].includes(status ?? "") || completed) return "succeeded"
  if (["failed", "error", "execution_error"].includes(status ?? "")) return "failed"
  if (["cancelled", "canceled"].includes(status ?? "")) return "cancelled"
  if (["in_progress", "running", "executing"].includes(status ?? "")) return "running"
  return "queued"
}

function collectOutputFiles(outputs: Record<string, unknown>): ComfyOutputFile[] {
  const files: ComfyOutputFile[] = []
  for (const [nodeId, value] of Object.entries(outputs)) {
    if (!isRecord(value)) continue
    for (const collectionName of ["images", "gifs"]) {
      const collection = value[collectionName]
      if (!Array.isArray(collection)) continue
      for (const item of collection) {
        if (!isRecord(item)) continue
        const filename = firstString(item.filename, item.name)
        if (!filename) continue
        files.push({
          filename,
          subfolder: firstString(item.subfolder) ?? "",
          type: firstString(item.type) ?? "output",
          nodeId,
        })
      }
    }
  }
  return files
}

async function downloadOutputImage(config: ComfyUiConfig, file: ComfyOutputFile): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = comfyUrl(config, "view")
  url.searchParams.set("filename", file.filename)
  url.searchParams.set("subfolder", file.subfolder)
  url.searchParams.set("type", file.type)
  const initialResponse = await fetchWithTimeout(url.toString(), {
    redirect: "manual",
  })
  const response = await followOutputRedirect(initialResponse, url)
  if (!response.ok) throw new HttpJsonError(`ComfyUI output download failed (${response.status})`, response.status, {})
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
  if (!isSupportedImageContentType(contentType)) {
    throw new Error(`ComfyUI output used unsupported media type '${contentType || "unknown"}'`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES) {
    throw new Error("ComfyUI output exceeded the supported file-size limit")
  }
  return { bytes, contentType }
}

async function followOutputRedirect(response: Response, sourceUrl: URL): Promise<Response> {
  if (response.status < 300 || response.status >= 400) return response
  const location = response.headers.get("location")
  if (!location) throw new Error("ComfyUI output redirect was missing a location")

  let target: URL
  try {
    target = new URL(location, sourceUrl)
  } catch {
    throw new Error("ComfyUI output redirect was invalid")
  }
  if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password) {
    throw new Error("ComfyUI output redirect used an unsupported URL")
  }
  if (target.protocol === "http:" && target.origin !== sourceUrl.origin) {
    throw new Error("ComfyUI output redirect must use HTTPS outside the configured server")
  }

  // ComfyUI /view 可能跳到一次性文件地址；跳转请求不携带任何服务端密钥。
  return fetchWithTimeout(target.toString(), { redirect: "error" })
}

function r2AssetsFromResponse(response: Record<string, unknown>): ProviderOutputAsset[] {
  const assets = response.r2_assets
  if (!Array.isArray(assets)) return []
  return assets.flatMap((value, position) => {
    if (!isRecord(value)) return []
    const r2Key = firstString(value.r2Key, value.r2_key)
    const contentType = firstString(value.contentType, value.content_type)
    if (!r2Key || !contentType) return []
    return [{
      assetType: firstString(value.assetType, value.asset_type) ?? "image",
      position: typeof value.position === "number" ? value.position : position,
      r2Key,
      contentType,
      metadata: isRecord(value.metadata) ? value.metadata : undefined,
    }]
  })
}

async function fetchComfyJson(config: ComfyUiConfig, path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(comfyUrl(config, path).toString(), {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  })
  const body = await readJsonResponse(response)
  if (!response.ok) {
    throw new HttpJsonError(`ComfyUI request failed (${response.status}): ${comfyError(body)}`, response.status, body)
  }
  return body
}

function comfyUrl(config: ComfyUiConfig, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), `${config.baseUrl}/`)
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COMFYUI_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, cache: "no-store", signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function comfyError(value: unknown): string {
  if (!isRecord(value)) return "ComfyUI request failed"
  const error = value.error
  if (typeof error === "string") return error.slice(0, 500)
  if (isRecord(error)) return firstString(error.message, error.detail) ?? "ComfyUI request failed"
  return firstString(value.message, value.detail, value.status_message) ?? "ComfyUI request failed"
}
