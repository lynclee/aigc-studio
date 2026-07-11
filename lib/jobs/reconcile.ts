import type { AigcAssetRecord, AigcGenerationRecord, AigcJobRecord, ProviderStatusResult } from "@/lib/aigc/types"
import { FetchJsonTimeoutError, HttpJsonError } from "@/lib/aigc/http"
import { pollProviderStatus } from "@/lib/jobs/providers"
import {
  claimJobForReconcile,
  completeClaimedJob,
  failClaimedJob,
  getGenerationForJob,
  materializeCompletedJob,
  releaseClaimedJob,
  terminalStatus,
  updateClaimedJobFromProviderStatus,
} from "@/lib/jobs/store"

export type ReconcileResult = {
  job: AigcJobRecord
  generation: AigcGenerationRecord | null
  assets: AigcAssetRecord[]
  changed: boolean
}

export async function reconcileJob(job: AigcJobRecord): Promise<ReconcileResult> {
  if (terminalStatus(job.status)) {
    if (job.status === "succeeded") {
      const { generation, assets } = await getGenerationForJob(job.id, job.user_open_id)
      return { job, generation, assets, changed: false }
    }
    return { job, generation: null, assets: [], changed: false }
  }

  if (!job.provider_job_id) {
    return { job, generation: null, assets: [], changed: false }
  }

  const claimedJob = await claimJobForReconcile(job)
  if (!claimedJob) {
    return { job, generation: null, assets: [], changed: false }
  }

  let providerStatus: ProviderStatusResult
  try {
    providerStatus = await pollProviderStatus(claimedJob)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isTransientProviderPollError(error)) {
      const currentJob = await releaseClaimedJob(claimedJob, message)
      return { job: currentJob, generation: null, assets: [], changed: true }
    }

    const failedJob = await failClaimedJob(claimedJob, message)
    return { job: failedJob, generation: null, assets: [], changed: true }
  }

  const currentJob = await updateClaimedJobFromProviderStatus(claimedJob, providerStatus)

  if (providerStatus.status === "succeeded") {
    let materialized: Awaited<ReturnType<typeof materializeCompletedJob>>
    try {
      materialized = await materializeCompletedJob(currentJob, providerStatus.assets)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedJob = await failClaimedJob(currentJob, message)
      return { job: failedJob, generation: null, assets: [], changed: true }
    }

    try {
      const completedJob = await completeClaimedJob(currentJob)
      return { job: completedJob, generation: materialized.generation, assets: materialized.assets, changed: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        const releasedJob = await releaseClaimedJob(currentJob, message)
        return { job: releasedJob, generation: null, assets: [], changed: true }
      } catch {
        return { job: currentJob, generation: null, assets: [], changed: true }
      }
    }
  }

  if (terminalStatus(providerStatus.status)) {
    return { job: currentJob, generation: null, assets: [], changed: true }
  }

  const releasedJob = await releaseClaimedJob(currentJob)
  return { job: releasedJob, generation: null, assets: [], changed: true }
}

function isTransientProviderPollError(error: unknown): boolean {
  if (error instanceof FetchJsonTimeoutError) return true
  if (error instanceof HttpJsonError) return error.status === 408 || error.status === 429 || error.status >= 500
  if (!(error instanceof Error)) return false
  return error.name === "AbortError" || error instanceof TypeError
}
