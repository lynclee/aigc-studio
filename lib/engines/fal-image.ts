import type { AigcJobRecord, ProviderStatusResult, ProviderSubmitResult, SubmitRequest } from "@/lib/aigc/types"
import { fetchJson, firstString, MissingProviderEnvError } from "@/lib/aigc/http"
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

export const FAL_IMAGE_PROVIDER = "fal-image"

type FalImageConfig = {
  apiKey: string
}

function getConfig(): FalImageConfig {
  const apiKey = process.env.FAL_KEY
  if (!apiKey) throw new MissingProviderEnvError(FAL_IMAGE_PROVIDER, ["FAL_KEY"])
  return { apiKey }
}

function falHeaders(apiKey: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Key ${apiKey}` }
}

export function ensureFalImageConfigured(): void {
  getConfig()
  const hasDefault = Boolean(process.env.FAL_IMAGE_ENDPOINT?.trim() || process.env.FAL_IMAGE_STANDARD_ENDPOINT?.trim())
  if (!hasDefault) {
    throw new MissingProviderEnvError(FAL_IMAGE_PROVIDER, ["FAL_IMAGE_ENDPOINT or FAL_IMAGE_STANDARD_ENDPOINT"])
  }
}

export async function submitFalImage(
  request: SubmitRequest,
  workflowSnapshot: WorkflowJobSnapshot,
): Promise<ProviderSubmitResult> {
  const config = getConfig()
  const referenceCount = Array.isArray(request.input.images) ? request.input.images.length : 0
  const pinned = executionFromWorkflowSnapshot(workflowSnapshot, {
    kind: "image",
    workflowId: request.workflowId,
    provider: FAL_IMAGE_PROVIDER,
    referenceCount,
  })
  if (referenceCount > 0) throw new ProviderInputError("reference_images_not_supported")
  const endpoint = endpointForVariant(pinned.variant)
  const response = await fetchJson(`${FAL_QUEUE_BASE}/${endpoint}`, {
    method: "POST",
    headers: falHeaders(config.apiKey),
    body: JSON.stringify({ prompt: request.prompt }),
  })
  const providerJobId = providerJobIdFrom(response)
  const statusUrl = providerStatusUrlFrom(response)
  const responseUrl = firstString(response.response_url, response.responseUrl)
  if (!providerJobId || !statusUrl || !responseUrl) {
    throw new Error(`${FAL_IMAGE_PROVIDER} submit response missing request_id/status_url/response_url`)
  }

  return {
    provider: FAL_IMAGE_PROVIDER,
    providerJobId,
    status: hasProviderStatus(response) ? providerStatusFrom(response) : "queued",
    statusUrl,
    response: {
      ...response,
      endpoint,
      response_url: responseUrl,
      catalog_workflow_id: request.workflowId,
      execution_variant: pinned.variant,
      template_version: pinned.templateVersion,
    },
  }
}

export async function getFalImageStatus(job: AigcJobRecord): Promise<ProviderStatusResult> {
  const config = getConfig()
  if (job.kind !== "image") throw new Error(`unsupported fal image job kind ${job.kind}`)
  if (!job.provider_job_id) throw new Error("job missing provider_job_id")
  const statusUrl = job.provider_status_url ?? firstString(job.provider_response?.status_url, job.provider_response?.statusUrl)
  if (!statusUrl) throw new Error("fal image job missing status_url")

  const statusResponse = await fetchJson(statusUrl, { method: "GET", headers: falHeaders(config.apiKey) })
  const status = providerStatusFrom(statusResponse)
  const responseUrl = firstString(
    job.provider_response?.response_url,
    job.provider_response?.responseUrl,
    statusResponse.response_url,
    statusResponse.responseUrl,
  )

  if (status !== "succeeded") {
    return {
      status,
      response: { ...job.provider_response, ...statusResponse, response_url: responseUrl },
      error: status === "failed" ? providerErrorFrom(statusResponse) ?? `${FAL_IMAGE_PROVIDER} job failed` : undefined,
      assets: [],
    }
  }

  if (!responseUrl) throw new Error("fal image completed job missing response_url")
  const resultResponse = await fetchJson(responseUrl, { method: "GET", headers: falHeaders(config.apiKey) })
  const assets = extractProviderAssets("image", resultResponse)
  return {
    status: assets.length > 0 ? "succeeded" : "failed",
    response: { ...job.provider_response, ...statusResponse, output: resultResponse, response_url: responseUrl },
    error: assets.length > 0 ? undefined : `${FAL_IMAGE_PROVIDER} completed without a usable output URL`,
    assets,
  }
}

export async function cancelFalImage(_job: AigcJobRecord): Promise<Record<string, unknown>> {
  throw new UnsupportedCancelError("fal queue cancellation is not supported for this provider")
}

function endpointForVariant(variant: string): string {
  const generic = process.env.FAL_IMAGE_ENDPOINT?.trim()
  const standard = process.env.FAL_IMAGE_STANDARD_ENDPOINT?.trim()
  const detail = process.env.FAL_IMAGE_DETAIL_ENDPOINT?.trim()
  if (variant !== "fal-image-standard" && variant !== "fal-image-detail") {
    throw new ProviderConfigurationError(`Unsupported Fal image execution variant '${variant}'`)
  }
  const requested = variant === "fal-image-detail" ? detail ?? generic ?? standard : standard ?? generic
  if (!requested) throw new MissingProviderEnvError(FAL_IMAGE_PROVIDER, ["FAL_IMAGE_ENDPOINT"])
  if (!/^[A-Za-z0-9._/-]+$/.test(requested) || requested.includes("//")) {
    throw new ProviderConfigurationError("Fal image endpoint must be a fal.ai endpoint path")
  }
  return requested.replace(/^\/+|\/+$/g, "")
}

function hasProviderStatus(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, "status")
    || Object.prototype.hasOwnProperty.call(data, "state")
    || Object.prototype.hasOwnProperty.call(data, "phase")
}
