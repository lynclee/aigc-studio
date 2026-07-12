import type { AigcAssetRecord, AigcGenerationRecord, AigcJobRecord, ProviderStatusResult } from "@/lib/aigc/types"
import { FetchJsonTimeoutError, HttpJsonError } from "@/lib/aigc/http"
import { deleteObject } from "@/lib/r2"
import { stagingKeyForFinal } from "@/lib/delivery/asset-policy"
import { pollProviderStatus } from "@/lib/jobs/providers"
import {
  claimJobForReconcile,
  failClaimedJob,
  finalizeJobWithAssets,
  getGenerationForJob,
  getOwnedJob,
  releaseClaimedJob,
  renewClaimedJobLease,
  terminalStatus,
  updateClaimedJobFromProviderStatus,
} from "@/lib/jobs/store"

export type ReconcileResult = {
  job: AigcJobRecord
  generation: AigcGenerationRecord | null
  assets: AigcAssetRecord[]
  changed: boolean
}

// job 最大运行时长兜底(M7):超时仍未终态 → 明确失败,不让任何 job 永久 running 占配额。
// 取 3h:略大于 delivery_token 的 2h 生命周期,过期后本也换不到新上传地址。
const MAX_JOB_AGE_MS = 3 * 60 * 60 * 1000

function isPastMaxAge(job: AigcJobRecord): boolean {
  const created = Date.parse(job.created_at)
  return created > 0 && Date.now() - created > MAX_JOB_AGE_MS
}

export async function reconcileJob(job: AigcJobRecord): Promise<ReconcileResult> {
  if (terminalStatus(job.status)) {
    if (job.status === "succeeded") {
      const { generation, assets } = await getGenerationForJob(job.id, job.user_id)
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
    providerStatus = await pollProviderStatus(claimedJob, {
      beforeAssetCopy: () => renewClaimedJobLease(claimedJob),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isTransientProviderPollError(error)) {
      // M4:瞬时错误也受最大时长约束,否则持续瞬时失败会永久 running、占满配额。
      if (isPastMaxAge(claimedJob)) {
        const failedJob = await failClaimedJob(claimedJob, "job exceeded maximum runtime (persistent provider errors)")
        return { job: failedJob, generation: null, assets: [], changed: true }
      }
      const currentJob = await releaseClaimedJob(claimedJob, message)
      return { job: currentJob, generation: null, assets: [], changed: true }
    }

    const failedJob = await failClaimedJob(claimedJob, message)
    return { job: failedJob, generation: null, assets: [], changed: true }
  }

  const currentJob = await updateClaimedJobFromProviderStatus(claimedJob, providerStatus)

  if (providerStatus.status === "succeeded") {
    let finalized: Awaited<ReturnType<typeof finalizeJobWithAssets>>
    try {
      finalized = await finalizeJobWithAssets(currentJob, providerStatus.assets)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedJob = await failClaimedJob(currentJob, message)
      return { job: failedJob, generation: null, assets: [], changed: true }
    }

    // fence 失败(别人已落库 / 租约失效 / 已被取消)→ 读回真实状态,幂等。
    if (!finalized) {
      const fresh = await getOwnedJob(currentJob.id, currentJob.user_id)
      if (fresh?.status === "succeeded") {
        const { generation, assets } = await getGenerationForJob(fresh.id, fresh.user_id)
        return { job: fresh, generation, assets, changed: true }
      }
      return { job: fresh ?? currentJob, generation: null, assets: [], changed: true }
    }

    const succeededJob = (await getOwnedJob(currentJob.id, currentJob.user_id)) ?? currentJob
    // F1:兜底路径也删 staging(job-complete 走 :80 删;这里补上),否则要等到下次 cleanup 才清。
    await Promise.all(
      finalized.assets.filter((a) => a.r2_key).map((a) => deleteObject(stagingKeyForFinal(a.r2_key as string))),
    ).catch(() => {})
    return { job: succeededJob, generation: finalized.generation, assets: finalized.assets, changed: true }
  }

  if (terminalStatus(providerStatus.status)) {
    return { job: currentJob, generation: null, assets: [], changed: true }
  }

  // 仍在跑但已超最大时长(state 丢失/永久错误/卡死)→ 明确失败,不无限徘徊(M7)。
  if (isPastMaxAge(currentJob)) {
    const failedJob = await failClaimedJob(currentJob, "job exceeded maximum runtime")
    return { job: failedJob, generation: null, assets: [], changed: true }
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
