/**
 * R2 孤儿清理:删掉「Bridge 已传 R2、但从未落库」的对象(上传中 cancel / 核验失败 / job 已失败)。
 *
 * 孤儿来源:aigc-r2 交付是 Bridge 先经 asset-intake 传文件到 R2、再回调 job-complete 落库。
 * 若 job 在落库前进了终态(cancelled/failed),或核验没过,R2 对象就没进 aigc_assets = 孤儿。
 * aigc_job_uploads 台账记了这些 r2_key,清理靠它。
 *
 * 安全闸门:markUploadsRecorded 是 best-effort,可能给「已成功的 job」留下 pending 行,而那些
 * r2_key 其实是**活资产**。所以删对象前必查 aigc_assets:命中就补标 recorded、绝不删。
 *
 * 由 Vercel Cron(/api/jobs/reconcile)在对账后调用。
 */

import { assetExistsForKey } from "@/lib/jobs/store"
import { deleteObject } from "@/lib/r2"
import { stagingKeyForFinal } from "@/lib/delivery/asset-policy"
import { deleteUploadRow, listOrphanUploads, markUploadRecordedById } from "@/lib/delivery/uploads"

export interface OrphanCleanupResult {
  scanned: number
  deleted: number
  reconciled: number
  failed: number
}

export async function cleanupOrphanDeliveries(limit = 100): Promise<OrphanCleanupResult> {
  const orphans = await listOrphanUploads(limit)
  let deleted = 0
  let reconciled = 0
  let failed = 0

  for (const upload of orphans) {
    try {
      // 其实是活资产(final 已 Copy + materialize,只是台账没更新到)→ 补标 recorded,绝不删 final。
      // 但 staging 此时已冗余(reconcile 兜底路径不会删它)→ 清掉,防累积泄漏(F1)。
      if (await assetExistsForKey(upload.r2_key)) {
        await deleteObject(stagingKeyForFinal(upload.r2_key))
        await markUploadRecordedById(upload.id)
        reconciled += 1
        continue
      }
      // 真孤儿:删 staging(Bridge 上传目标)+ 可能的孤儿 final(partial copy 无 DB 记录);DELETE 幂等。
      const removedStaging = await deleteObject(stagingKeyForFinal(upload.r2_key))
      const removedFinal = await deleteObject(upload.r2_key)
      if (!removedStaging || !removedFinal) {
        failed += 1
        continue
      }
      await deleteUploadRow(upload.id)
      deleted += 1
    } catch {
      // 单条失败不阻断整批;计数后继续,下次 cron 再清。
      failed += 1
    }
  }

  return { scanned: orphans.length, deleted, reconciled, failed }
}
