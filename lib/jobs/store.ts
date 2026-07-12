import { randomUUID } from "node:crypto"
import type { SupabaseClient } from "@supabase/supabase-js"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import type {
  AigcAssetRecord,
  AigcGenerationRecord,
  AigcJobRecord,
  AigcKind,
  JobStatus,
  ProviderOutputAsset,
  ProviderStatusResult,
  ProviderSubmitResult,
  SubmitRequest,
} from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"
import { storeProviderAssetsInR2 } from "@/lib/assets/r2-store"

export class BackendStoreError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message)
  }
}

export class JobCancelConflictError extends Error {
  readonly status = 409
  readonly code = "job_cancel_conflict"
  readonly exposeMessage = true

  constructor(message = "Job cancellation conflicted with current job state. Retry later.") {
    super(message)
  }
}

export function requireAigcAdmin(): SupabaseClient {
  const admin = getSupabaseAdmin()
  if (!admin) throw new BackendStoreError("Supabase deployment env missing", 503)
  return admin
}

export async function createQueuedJob(params: {
  userId: string
  kind: AigcKind
  provider: string
  request: SubmitRequest
}): Promise<AigcJobRecord> {
  const admin = requireAigcAdmin()
  await assertOwnerCanCreateJob(params.userId)
  const { data, error } = await admin
    .from("aigc_jobs")
    .insert({
      user_id: params.userId,
      kind: params.kind,
      workflow_id: params.request.workflowId,
      status: "queued",
      provider: params.provider,
      request: params.request,
    })
    .select("*")
    .single()
  if (error) throw new BackendStoreError(`create job failed: ${error.message}`)
  return data as AigcJobRecord
}

export async function assertOwnerCanCreateJob(userId: string): Promise<void> {
  const admin = requireAigcAdmin()
  const { count: activeCount, error: activeError } = await admin
    .from("aigc_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["queued", "running"])
  if (activeError) throw new BackendStoreError(`check active job limit failed: ${activeError.message}`)
  if ((activeCount ?? 0) >= 3) {
    throw new BackendStoreError("owner job limit exceeded: max 3 queued/running jobs", 429)
  }

  const since = new Date(Date.now() - 60_000).toISOString()
  const { count: recentCount, error: recentError } = await admin
    .from("aigc_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since)
  if (recentError) throw new BackendStoreError(`check recent job limit failed: ${recentError.message}`)
  if ((recentCount ?? 0) >= 10) {
    throw new BackendStoreError("owner rate limit exceeded: max 10 jobs per 60 seconds", 429)
  }
}

export async function attachProviderSubmission(
  jobId: string,
  submission: ProviderSubmitResult,
): Promise<AigcJobRecord> {
  const admin = requireAigcAdmin()
  const now = new Date().toISOString()
  const terminal = terminalStatus(submission.status) && submission.status !== "succeeded"
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      status: submission.status === "succeeded" ? "running" : submission.status,
      provider: submission.provider,
      provider_job_id: submission.providerJobId,
      provider_status_url: submission.statusUrl ?? null,
      provider_response: submission.response,
      updated_at: now,
      completed_at: terminal ? now : null,
    })
    .eq("id", jobId)
    .select("*")
    .single()
  if (error) throw new BackendStoreError(`update provider job failed: ${error.message}`)
  return data as AigcJobRecord
}

export type ClaimedAigcJobRecord = AigcJobRecord & {
  reconcile_token: string
  reconcile_lease_until: string
}

const RECONCILE_LEASE_MS = 5 * 60_000

export async function claimJobForReconcile(job: AigcJobRecord): Promise<ClaimedAigcJobRecord | null> {
  if (terminalStatus(job.status) || !job.provider_job_id) return null

  const admin = requireAigcAdmin()
  const now = new Date()
  const token = randomUUID()
  const leaseUntil = new Date(now.getTime() + RECONCILE_LEASE_MS).toISOString()
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      reconcile_token: token,
      reconcile_lease_until: leaseUntil,
      updated_at: now.toISOString(),
    })
    .eq("id", job.id)
    .in("status", ["queued", "running"])
    .or(`reconcile_token.is.null,reconcile_lease_until.is.null,reconcile_lease_until.lt.${now.toISOString()}`)
    .select("*")
    .maybeSingle()
  if (error) throw new BackendStoreError(`claim job failed: ${error.message}`)
  return (data as ClaimedAigcJobRecord | null) ?? null
}

export async function updateClaimedJobFromProviderStatus(
  job: ClaimedAigcJobRecord,
  statusResult: ProviderStatusResult,
): Promise<ClaimedAigcJobRecord> {
  const admin = requireAigcAdmin()
  const now = new Date().toISOString()
  const terminal = terminalStatus(statusResult.status) && statusResult.status !== "succeeded"
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      status: statusResult.status === "succeeded" ? "running" : statusResult.status,
      provider_response: statusResult.response,
      error: statusResult.error ?? null,
      updated_at: now,
      completed_at: terminal ? job.completed_at ?? now : null,
      reconcile_token: terminal ? null : job.reconcile_token,
      reconcile_lease_until: terminal ? null : job.reconcile_lease_until,
    })
    .eq("id", job.id)
    .eq("reconcile_token", job.reconcile_token)
    .select("*")
    .single()
  if (error) throw new BackendStoreError(`update claimed job status failed: ${error.message}`)
  return data as ClaimedAigcJobRecord
}

export async function releaseClaimedJob(job: ClaimedAigcJobRecord, errorMessage?: string): Promise<AigcJobRecord> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      error: errorMessage ? sanitizeStoredError(errorMessage) : job.error,
      updated_at: new Date().toISOString(),
      reconcile_token: null,
      reconcile_lease_until: null,
    })
    .eq("id", job.id)
    .eq("reconcile_token", job.reconcile_token)
    .select("*")
    .single()
  if (error) throw new BackendStoreError(`release claimed job failed: ${error.message}`)
  return data as AigcJobRecord
}

export async function failClaimedJob(job: ClaimedAigcJobRecord, errorMessage: string): Promise<AigcJobRecord> {
  const admin = requireAigcAdmin()
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      status: "failed",
      error: errorMessage,
      updated_at: now,
      completed_at: now,
      reconcile_token: null,
      reconcile_lease_until: null,
    })
    .eq("id", job.id)
    .eq("reconcile_token", job.reconcile_token)
    .select("*")
    .single()
  if (error) throw new BackendStoreError(`fail claimed job failed: ${error.message}`)
  return data as AigcJobRecord
}

export async function completeClaimedJob(job: ClaimedAigcJobRecord): Promise<AigcJobRecord> {
  const admin = requireAigcAdmin()
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      status: "succeeded",
      error: null,
      updated_at: now,
      completed_at: job.completed_at ?? now,
      reconcile_token: null,
      reconcile_lease_until: null,
    })
    .eq("id", job.id)
    .eq("reconcile_token", job.reconcile_token)
    .select("*")
    .single()
  if (error) throw new BackendStoreError(`complete claimed job failed: ${error.message}`)
  return data as AigcJobRecord
}

function sanitizeStoredError(message: string): string {
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500)
}

export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  const admin = requireAigcAdmin()
  await admin
    .from("aigc_jobs")
    .update({
      status: "failed",
      error: errorMessage,
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId)
}

export async function getOwnedJob(jobId: string, userId: string): Promise<AigcJobRecord | null> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin
    .from("aigc_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new BackendStoreError(`load job failed: ${error.message}`)
  return (data as AigcJobRecord | null) ?? null
}

export async function listOwnedJobs(userId: string, limit = 25): Promise<AigcJobRecord[]> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin
    .from("aigc_jobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit)
  if (error) throw new BackendStoreError(`list jobs failed: ${error.message}`)
  return (data ?? []) as AigcJobRecord[]
}

export async function listActiveJobs(limit = 50): Promise<AigcJobRecord[]> {
  const admin = requireAigcAdmin()
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from("aigc_jobs")
    .select("*")
    .in("status", ["queued", "running"])
    .not("provider_job_id", "is", null)
    .or(`reconcile_token.is.null,reconcile_lease_until.is.null,reconcile_lease_until.lt.${now}`)
    .order("updated_at", { ascending: true })
    .limit(limit)
  if (error) throw new BackendStoreError(`list active jobs failed: ${error.message}`)
  return (data ?? []) as AigcJobRecord[]
}

export async function materializeCompletedJob(
  job: AigcJobRecord,
  assets: ProviderOutputAsset[],
): Promise<{ generation: AigcGenerationRecord; assets: AigcAssetRecord[] }> {
  const admin = requireAigcAdmin()
  const storedAssets = await storeProviderAssetsInR2({
    userId: job.user_id,
    jobId: job.id,
    kind: job.kind,
    assets,
  })

  if (storedAssets.length === 0) {
    throw new BackendStoreError("materialize assets failed: provider completed without any persistable assets")
  }
  for (const asset of storedAssets) {
    if (!asset.r2Key) {
      throw new BackendStoreError("materialize assets failed: every provider asset must have an R2 key before DB materialize")
    }
  }

  const request = isRecord(job.request) ? job.request : {}
  const prompt = typeof request.prompt === "string" ? request.prompt : null
  const { data: generation, error: generationError } = await admin
    .from("aigc_generations")
    .upsert(
      {
        job_id: job.id,
        user_id: job.user_id,
        kind: job.kind,
        workflow_id: job.workflow_id,
        prompt,
        provider: job.provider,
        provider_job_id: job.provider_job_id,
        metadata: { provider_response: job.provider_response },
      },
      { onConflict: "job_id" },
    )
    .select("*")
    .single()
  if (generationError) {
    throw new BackendStoreError(`materialize generation failed: ${generationError.message}`)
  }

  const generationRecord = generation as AigcGenerationRecord
  const rows = storedAssets.map((asset, index) => ({
    generation_id: generationRecord.id,
    job_id: job.id,
    user_id: job.user_id,
    kind: job.kind,
    asset_type: asset.assetType || "output",
    position: asset.position ?? index,
    r2_key: asset.r2Key as string,
    source_url: null,
    content_type: asset.contentType ?? null,
    metadata: asset.metadata ?? {},
  }))

  const { data: assetRows, error: assetError } = await admin
    .from("aigc_assets")
    .upsert(rows, { onConflict: "job_id,asset_type,position" })
    .select("*")
  if (assetError) {
    await admin.from("aigc_generations").delete().eq("id", generationRecord.id)
    throw new BackendStoreError(`materialize assets failed: ${assetError.message}`)
  }

  const persistedAssets = (assetRows ?? []) as AigcAssetRecord[]
  if (persistedAssets.length === 0 || persistedAssets.some((asset) => !asset.r2_key)) {
    await admin.from("aigc_generations").delete().eq("id", generationRecord.id)
    throw new BackendStoreError("materialize assets failed: persisted assets missing required R2 keys")
  }

  return { generation: generationRecord, assets: persistedAssets }
}

export async function getGenerationForJob(jobId: string, userId: string): Promise<{
  generation: AigcGenerationRecord | null
  assets: AigcAssetRecord[]
}> {
  const admin = requireAigcAdmin()
  const { data: generation, error } = await admin
    .from("aigc_generations")
    .select("*")
    .eq("job_id", jobId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new BackendStoreError(`load generation failed: ${error.message}`)
  if (!generation) return { generation: null, assets: [] }

  const { data: assets, error: assetError } = await admin
    .from("aigc_assets")
    .select("*")
    .eq("generation_id", (generation as AigcGenerationRecord).id)
    .eq("user_id", userId)
    .not("r2_key", "is", null)
    .order("position", { ascending: true })
  if (assetError) throw new BackendStoreError(`load assets failed: ${assetError.message}`)
  return { generation: generation as AigcGenerationRecord, assets: (assets ?? []) as AigcAssetRecord[] }
}

export async function listUserLibrary(userId: string): Promise<{
  generations: AigcGenerationRecord[]
  assets: AigcAssetRecord[]
}> {
  const admin = requireAigcAdmin()
  const { data: generations, error } = await admin
    .from("aigc_generations")
    .select("*, aigc_jobs!inner(status)")
    .eq("user_id", userId)
    .eq("aigc_jobs.status", "succeeded")
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new BackendStoreError(`load library failed: ${error.message}`)

  const rawGenerationRows = (generations ?? []) as Array<AigcGenerationRecord & { aigc_jobs?: unknown }>
  if (rawGenerationRows.length === 0) return { generations: [], assets: [] }

  const ids = rawGenerationRows.map((row) => row.id)
  const { data: assets, error: assetError } = await admin
    .from("aigc_assets")
    .select("*")
    .eq("user_id", userId)
    .in("generation_id", ids)
    .not("r2_key", "is", null)
    .order("created_at", { ascending: false })
    .order("position", { ascending: true })
  if (assetError) throw new BackendStoreError(`load library assets failed: ${assetError.message}`)

  const assetRows = (assets ?? []) as AigcAssetRecord[]
  const generationIdsWithAssets = new Set(assetRows.map((asset) => asset.generation_id))
  const generationRows = rawGenerationRows
    .filter((row) => generationIdsWithAssets.has(row.id))
    .map(({ aigc_jobs: _aigcJobs, ...generation }) => generation as AigcGenerationRecord)
  const visibleGenerationIds = new Set(generationRows.map((row) => row.id))
  return {
    generations: generationRows,
    assets: assetRows.filter((asset) => visibleGenerationIds.has(asset.generation_id)),
  }
}

export async function markJobCancelled(job: AigcJobRecord, response: Record<string, unknown>): Promise<AigcJobRecord> {
  const admin = requireAigcAdmin()
  const now = new Date().toISOString()
  const { data, error } = await admin
    .from("aigc_jobs")
    .update({
      status: "cancelled",
      provider_response: response,
      updated_at: now,
      completed_at: job.completed_at ?? now,
      reconcile_token: null,
      reconcile_lease_until: null,
    })
    .eq("id", job.id)
    .in("status", ["queued", "running"])
    .or(`reconcile_token.is.null,reconcile_lease_until.is.null,reconcile_lease_until.lt.${now}`)
    .select("*")
    .maybeSingle()
  if (error) throw new BackendStoreError(`cancel job failed: ${error.message}`)
  if (!data) {
    throw new JobCancelConflictError("Job cannot be cancelled because its status changed or a reconcile lease is active.")
  }
  return data as AigcJobRecord
}

export function terminalStatus(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled"
}
