/**
 * aigc_job_uploads 表读写：在途上传台账。
 *
 * 主要作用是审计 + 状态追踪；幂等本身由 r2_key 的确定性推导（userId/jobId/
 * assetType/position）保证，job-complete 的权威核验走 HeadObject，不依赖本表。
 */

import { getSupabaseAdmin } from "@/lib/supabase/admin"
import { requireAigcAdmin } from "@/lib/jobs/store"

export interface AigcJobUploadRecord {
  id: string
  job_id: string
  user_id: string
  asset_type: string
  position: number
  r2_key: string
  content_type: string | null
  size_bytes: number | null
  etag: string | null
  checksum_sha256: string | null
  status: "pending" | "uploaded" | "recorded"
  created_at: string
  updated_at: string
}

export interface UploadIdentity {
  r2Key: string
  contentType: string | null
}

/**
 * 取或建台账行。**identity(r2_key/content_type)首次 intake 定死、后续不覆盖**:同一
 * (job, asset_type, position) 无论重试报什么 content_type,恒返首次的 r2_key —— 修 H3
 * (重试改 MIME 会换 key、留永久孤儿)。用 INSERT ... ON CONFLICT DO NOTHING + 回读实现,竞态安全。
 */
export async function getOrCreateUpload(params: {
  jobId: string
  userId: string
  assetType: string
  position: number
  r2Key: string
  contentType: string | null
  sizeBytes: number | null
}): Promise<UploadIdentity> {
  const admin = requireAigcAdmin()
  const { error: insertError } = await admin.from("aigc_job_uploads").upsert(
    {
      job_id: params.jobId,
      user_id: params.userId,
      asset_type: params.assetType,
      position: params.position,
      r2_key: params.r2Key,
      content_type: params.contentType,
      size_bytes: params.sizeBytes,
      status: "pending",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "job_id,asset_type,position", ignoreDuplicates: true },
  )
  if (insertError) throw new Error(`record upload intake failed: ${insertError.message}`)

  const { data, error } = await admin
    .from("aigc_job_uploads")
    .select("r2_key, content_type")
    .eq("job_id", params.jobId)
    .eq("asset_type", params.assetType)
    .eq("position", params.position)
    .single()
  if (error || !data) throw new Error(`load upload identity failed: ${error?.message ?? "row missing"}`)
  return { r2Key: (data as { r2_key: string }).r2_key, contentType: (data as { content_type: string | null }).content_type }
}

/** 按 (job, asset_type, position) 取台账行(job-complete/兜底核验拿权威 identity 用)。 */
export async function getUpload(
  jobId: string,
  assetType: string,
  position: number,
): Promise<AigcJobUploadRecord | null> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin
    .from("aigc_job_uploads")
    .select("*")
    .eq("job_id", jobId)
    .eq("asset_type", assetType)
    .eq("position", position)
    .maybeSingle()
  if (error) throw new Error(`load upload row failed: ${error.message}`)
  return (data as AigcJobUploadRecord | null) ?? null
}

// 孤儿判定的宽限期:job 进终态后至少等这么久才清,躲开极端的最终一致/时钟偏差。
const ORPHAN_GRACE_MS = 10 * 60_000

/**
 * 列出孤儿上传:仍是 pending(job-complete 从未把它确认进 aigc_assets)、且所属 job 已进终态一段时间。
 * pending + 终态 job = Bridge 传了 R2 但没落库(上传中 cancel / 核验失败 / job 已失败)。
 */
export async function listOrphanUploads(limit = 100): Promise<AigcJobUploadRecord[]> {
  const admin = requireAigcAdmin()
  const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString()
  const { data, error } = await admin
    .from("aigc_job_uploads")
    .select("*, aigc_jobs!inner(status, completed_at)")
    .eq("status", "pending")
    .in("aigc_jobs.status", ["failed", "cancelled", "succeeded"])
    .lt("aigc_jobs.completed_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(limit)
  if (error) throw new Error(`list orphan uploads failed: ${error.message}`)
  return ((data ?? []) as Array<AigcJobUploadRecord & { aigc_jobs?: unknown }>).map(
    ({ aigc_jobs: _aigcJobs, ...row }) => row as AigcJobUploadRecord,
  )
}

export async function deleteUploadRow(id: string): Promise<void> {
  const admin = requireAigcAdmin()
  const { error } = await admin.from("aigc_job_uploads").delete().eq("id", id)
  if (error) throw new Error(`delete upload row failed: ${error.message}`)
}

/** 补标 recorded(用于「其实是活资产、只是 markUploadsRecorded 之前失败了」的补偿)。 */
export async function markUploadRecordedById(id: string): Promise<void> {
  const admin = requireAigcAdmin()
  await admin
    .from("aigc_job_uploads")
    .update({ status: "recorded", updated_at: new Date().toISOString() })
    .eq("id", id)
}

/** 完成核验后把台账标记为 recorded；best-effort，失败不阻断落库。 */
export async function markUploadsRecorded(
  jobId: string,
  assets: { assetType: string; position: number; etag: string | null; sizeBytes: number | null }[],
): Promise<void> {
  const admin = getSupabaseAdmin()
  if (!admin) return
  const now = new Date().toISOString()
  await Promise.all(
    assets.map((asset) =>
      admin
        .from("aigc_job_uploads")
        .update({ status: "recorded", etag: asset.etag, size_bytes: asset.sizeBytes, updated_at: now })
        .eq("job_id", jobId)
        .eq("asset_type", asset.assetType)
        .eq("position", asset.position),
    ),
  ).catch(() => {
    // 审计更新失败不影响作品落库
  })
}
