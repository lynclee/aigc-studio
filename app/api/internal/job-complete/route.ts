/**
 * POST /api/internal/job-complete —— Modal Bridge 全部文件上传完成后调一次。
 *
 * 机器对机器:不走 getSession,业务鉴权看 delivery_token。
 * 核验走共享的 verifyDeliveredAssets(HeadObject 核验存在 / 权威 size / r2_key 前缀 /
 * content-type),只信 R2 实际 size + ETag,不信 Bridge 上报 sha256(仅存 metadata)。
 *
 * 并发:落库走 reconcile 的租约机制(claim → materialize → complete),让 push 与
 * reconcile 轮询互斥、并挡住上传中 cancel,避免孤儿资产与双写。
 * push 主导:正常完成由本 endpoint 落库;push 丢失时 reconcile 从 /status manifest 兜底。
 * 幂等:已 succeeded 直接返回;已 failed/cancelled 拒绝;materialize 用 upsert。
 */

import { NextResponse } from "next/server"
import { parseJsonObject } from "@/lib/jobs/api"
import {
  claimJobForReconcile,
  finalizeJobWithAssets,
  getOwnedJob,
  releaseClaimedJob,
  terminalStatus,
} from "@/lib/jobs/store"
import { verifyDeliveryToken } from "@/lib/delivery/token"
import { markUploadsRecorded } from "@/lib/delivery/uploads"
import { deliveryError, mapInternalError } from "@/lib/delivery/http"
import { DeliveryStorageUnconfiguredError, DeliveryVerifyError, verifyDeliveredAssets } from "@/lib/delivery/verify"
import { deleteObject } from "@/lib/r2"

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

    let verified
    try {
      verified = await verifyDeliveredAssets(job, manifest)
    } catch (error) {
      if (error instanceof DeliveryStorageUnconfiguredError) return deliveryError(503, "storage_unconfigured")
      if (error instanceof DeliveryVerifyError) return deliveryError(error.status, error.code)
      throw error // HeadObject 瞬时错误 → 500 可重试
    }

    // 领租约:与 reconcile 互斥,并挡住上传中 cancel(cancel 需租约空闲)。
    const claimed = await claimJobForReconcile(job)
    if (!claimed) {
      const fresh = await getOwnedJob(jobId, claims.userId)
      if (fresh?.status === "succeeded") return NextResponse.json({ ok: true, status: "succeeded" })
      if (fresh && terminalStatus(fresh.status)) return deliveryError(409, "job_not_active")
      return deliveryError(409, "reconcile_in_progress") // 有并发 reconcile 持租约,可重试
    }

    try {
      // assets 已带 r2Key(verify 已 Copy 到 final)→ 原子落库 + fence(finalize RPC)。
      // 返回 null 表示 fence 失败(别人已落库/租约失效)→ 仍算成功,幂等。
      await finalizeJobWithAssets(claimed, verified.map((v) => v.output))
    } catch (error) {
      await releaseClaimedJob(claimed, error instanceof Error ? error.message : String(error)).catch(() => {})
      throw error // 存储/DB 瞬时错误 → 500 可重试
    }

    await markUploadsRecorded(
      job.id,
      verified.map((v) => ({ assetType: v.output.assetType, position: v.output.position, etag: v.etag, sizeBytes: v.sizeBytes })),
    )
    // 作品已 Copy 到 final,staging 是临时对象,删掉不留垃圾(best-effort,失败由孤儿清理兜底)。
    await Promise.all(verified.map((v) => deleteObject(v.stagingKey))).catch(() => {})
    return NextResponse.json({ ok: true, status: "succeeded" })
  } catch (error) {
    return mapInternalError(error)
  }
}
