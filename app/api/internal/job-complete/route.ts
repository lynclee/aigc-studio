/**
 * POST /api/internal/job-complete —— Modal Bridge 全部文件上传完成后调一次。
 *
 * 机器对机器:不走 getSession,业务鉴权看 delivery_token。
 *
 * 并发安全(Codex review C1/H2):**先领 reconcile 租约,再做任何 R2 副作用(HEAD/Copy)**。
 * 只有租约持有者才会把 staging Copy 到 final —— 关闭「并发/晚到 callback 用 Copy 覆盖已
 * succeeded 作品」的窗口。claim 失败的请求绝不 Copy,直接读回真实状态返回。
 * finalize RPC 返回 null(fence 失败/租约过期)时不假 ACK succeeded,读回真实状态。
 */

import { NextResponse } from "next/server"
import { parseJsonObject } from "@/lib/jobs/api"
import { claimJobForReconcile, finalizeJobWithAssets, getOwnedJob, releaseClaimedJob, renewClaimedJobLease, terminalStatus } from "@/lib/jobs/store"
import { verifyDeliveryToken } from "@/lib/delivery/token"
import { markUploadsRecorded } from "@/lib/delivery/uploads"
import { deliveryError, mapInternalError } from "@/lib/delivery/http"
import { DeliveryStorageUnconfiguredError, DeliveryVerifyError, verifyDeliveredAssets } from "@/lib/delivery/verify"
import { deleteObject, getR2Env } from "@/lib/r2"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = await parseJsonObject(req)

    const jobId = typeof body.job_id === "string" ? body.job_id : ""
    const claims = verifyDeliveryToken(body.token)
    if (!jobId || claims.jobId !== jobId) return deliveryError(401, "invalid_delivery_token")

    const job = await getOwnedJob(jobId, claims.userId)
    if (!job) return deliveryError(401, "invalid_delivery_token")
    if (job.status === "succeeded") return NextResponse.json({ ok: true, status: "succeeded" })
    if (terminalStatus(job.status)) return deliveryError(409, "job_not_active")

    const manifest = Array.isArray(body.assets) ? body.assets : []
    if (manifest.length === 0) return deliveryError(400, "empty_manifest")
    if (!getR2Env()) return deliveryError(503, "storage_unconfigured")

    // 先领租约,再做 R2 副作用:只有持有者才 Copy(C1)。claim 失败 → 不 Copy,读回状态。
    const claimed = await claimJobForReconcile(job)
    if (!claimed) return await resolveNonClaim(jobId, claims.userId)

    let verified
    try {
      verified = await verifyDeliveredAssets(claimed, manifest, {
        beforeCopy: () => renewClaimedJobLease(claimed),
      })
    } catch (error) {
      await releaseClaimedJob(claimed).catch(() => {})
      if (error instanceof DeliveryStorageUnconfiguredError) return deliveryError(503, "storage_unconfigured")
      if (error instanceof DeliveryVerifyError) return deliveryError(error.status, error.code)
      throw error // HeadObject/Copy 瞬时错误 → 500 可重试
    }

    let finalized
    try {
      finalized = await finalizeJobWithAssets(claimed, verified.map((v) => v.output))
    } catch (error) {
      await releaseClaimedJob(claimed, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error
    }

    // fence 失败(租约在 verify 期间过期、被别人接管)→ 不假 ACK,读回真实状态(H2)。
    if (!finalized) return await resolveNonClaim(jobId, claims.userId)

    await markUploadsRecorded(
      job.id,
      verified.map((v) => ({ assetType: v.output.assetType, position: v.output.position, etag: v.etag, sizeBytes: v.sizeBytes })),
    )
    await Promise.all(verified.map((v) => deleteObject(v.stagingKey))).catch(() => {})
    return NextResponse.json({ ok: true, status: "succeeded" })
  } catch (error) {
    return mapInternalError(error)
  }
}

// claim / finalize 未成功时,按 job 真实状态返回,绝不假 ACK succeeded。
async function resolveNonClaim(jobId: string, userId: string): Promise<NextResponse> {
  const fresh = await getOwnedJob(jobId, userId)
  if (fresh?.status === "succeeded") return NextResponse.json({ ok: true, status: "succeeded" })
  if (fresh && terminalStatus(fresh.status)) return deliveryError(409, "job_not_active")
  return deliveryError(409, "reconcile_in_progress") // 有并发 reconcile 持租约,可重试
}
