import { isRecord } from "@/lib/aigc/http"
import type { AigcAssetRecord } from "@/lib/aigc/types"
import { safeDirectR2Segment } from "@/lib/assets/r2-direct"
import { stagingKeyForFinal } from "@/lib/delivery/asset-policy"
import { BackendStoreError, requireAigcAdmin } from "@/lib/jobs/store"
import { deleteObject } from "@/lib/r2"

const DELETE_BATCH_LIMIT = 25
const DELETE_LEASE_SECONDS = 300
const DELETE_CONCURRENCY = 4

export interface TombstoneGenerationResult {
  found: boolean
  generationId: string
  pendingAssets: number
  deletedAssets: number
  errorAssets: number
}

export interface AssetDeleteCleanupResult {
  scanned: number
  deadlettered: number
  deleted: number
  retained: number
  failed: number
  exhausted: number
  conflicted: number
}

type ClaimedAsset = AigcAssetRecord & {
  r2_key: string
  delete_claim_token: string
}

type DeleteOutcome = "deleted" | "retained" | "failed" | "exhausted" | "conflicted"
type DeleteAuthority = { legacyProviderJobId: string | null }

/** Atomically hide an owned Generation and queue every physical Asset. */
export async function tombstoneGenerationAssets(
  generationId: string,
  userId: string,
): Promise<TombstoneGenerationResult> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin.rpc("tombstone_generation_assets", {
    p_generation_id: generationId,
    p_user_id: userId,
  })
  if (error) throw new BackendStoreError(`queue generation deletion failed: ${error.message}`)
  return parseTombstoneResult(data, generationId)
}

/**
 * Process one fenced deletion batch. Each row is isolated so a provider/R2/DB
 * failure cannot block the remaining rows. R2 DELETE itself is idempotent.
 */
export async function processPendingAssetDeletes(
  limit = DELETE_BATCH_LIMIT,
): Promise<AssetDeleteCleanupResult> {
  const deadlettered = await deadletterExpiredAssetDeletes(limit)
  const claimed = await claimPendingAssetDeletes(limit)
  const totals: AssetDeleteCleanupResult = {
    scanned: claimed.length,
    deadlettered,
    deleted: 0,
    retained: 0,
    failed: 0,
    exhausted: 0,
    conflicted: 0,
  }

  for (let offset = 0; offset < claimed.length; offset += DELETE_CONCURRENCY) {
    const outcomes = await Promise.all(
      claimed.slice(offset, offset + DELETE_CONCURRENCY).map(processClaimedAsset),
    )
    for (const outcome of outcomes) totals[outcome] += 1
  }

  return totals
}

async function deadletterExpiredAssetDeletes(limit: number): Promise<number> {
  const admin = requireAigcAdmin()
  const safeLimit = safeBatchLimit(limit)
  const { data, error } = await admin.rpc("deadletter_expired_asset_deletes", {
    p_limit: safeLimit,
  })
  if (error) throw new BackendStoreError(`deadletter expired asset deletions failed: ${error.message}`)
  if (typeof data !== "number" || !Number.isInteger(data) || data < 0) {
    throw new BackendStoreError("deadletter expired asset deletions returned malformed data")
  }
  return data
}

/** Final object plus its delivery staging sibling. Preview/alternate outputs are
 * first-class aigc_assets rows and are therefore claimed independently. */
export function deletionKeysForAsset(r2Key: string): string[] {
  return Array.from(new Set([r2Key, stagingKeyForFinal(r2Key)]))
}

export function assetKeyBelongsToRecord(
  asset: Pick<AigcAssetRecord, "user_id" | "job_id">,
  r2Key: string,
  legacyProviderJobId: string | null = null,
): boolean {
  const currentPrefixes = [
    `aigc/${asset.user_id}/${asset.job_id}/`,
    `${safeDirectR2Segment(asset.user_id)}/${safeDirectR2Segment(asset.job_id)}/`,
  ]
  const legacyPrefix = legacyProviderJobId
    ? `${safeDirectR2Segment(asset.user_id)}/${safeDirectR2Segment(legacyProviderJobId)}/`
    : null
  return currentPrefixes.some((prefix) => r2Key.startsWith(prefix))
    || (legacyPrefix !== null && r2Key.startsWith(legacyPrefix))
}

async function claimPendingAssetDeletes(limit: number): Promise<ClaimedAsset[]> {
  const admin = requireAigcAdmin()
  const safeLimit = safeBatchLimit(limit)
  const { data, error } = await admin.rpc("claim_pending_asset_deletes", {
    p_limit: safeLimit,
    p_lease_seconds: DELETE_LEASE_SECONDS,
  })
  if (error) throw new BackendStoreError(`claim asset deletion batch failed: ${error.message}`)
  if (!Array.isArray(data)) throw new BackendStoreError("claim asset deletion batch returned malformed data")
  return data.map(parseClaimedAsset)
}

function safeBatchLimit(limit: number): number {
  return Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : DELETE_BATCH_LIMIT
}

async function processClaimedAsset(asset: ClaimedAsset): Promise<DeleteOutcome> {
  try {
    const authority = await loadDeleteAuthority(asset)
    if (!authority) {
      return failClaim(asset, "asset_delete_authority_mismatch")
    }
    if (!assetKeyBelongsToRecord(asset, asset.r2_key, authority.legacyProviderJobId)) {
      return failClaim(asset, "asset_delete_key_ownership_mismatch")
    }
    if (await hasOtherActiveReference(asset.id, asset.r2_key)) {
      // The current logical row is deleted, but the shared physical object must
      // remain for the other active Generation (including another user).
      const completion = await completeClaim(asset, true)
      return completion.completed ? "retained" : "conflicted"
    }

    const results = await Promise.all(deletionKeysForAsset(asset.r2_key).map((key) => deleteObject(key)))
    if (results.some((removed) => !removed)) {
      return failClaim(asset, "r2_delete_failed")
    }

    const completion = await completeClaim(asset, true)
    return completion.completed ? "deleted" : "conflicted"
  } catch {
    return failClaim(asset, "asset_delete_exception")
  }
}

async function loadDeleteAuthority(asset: ClaimedAsset): Promise<DeleteAuthority | null> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin
    .from("aigc_generations")
    .select("id, job_id, user_id, provider_job_id, deleted_at, aigc_jobs!inner(user_id)")
    .eq("id", asset.generation_id)
    .maybeSingle()
  if (error) throw new BackendStoreError(`validate asset deletion authority failed: ${error.message}`)
  if (!isRecord(data) || typeof data.deleted_at !== "string" || !data.deleted_at) return null
  if (data.id !== asset.generation_id || data.job_id !== asset.job_id || data.user_id !== asset.user_id) return null
  const joinedJob = Array.isArray(data.aigc_jobs) ? data.aigc_jobs[0] : data.aigc_jobs
  if (!isRecord(joinedJob) || joinedJob.user_id !== asset.user_id) return null
  if (data.provider_job_id !== null && typeof data.provider_job_id !== "string") return null
  return { legacyProviderJobId: data.provider_job_id }
}

/** Cross-user by design: any visible active reference prevents physical delete. */
async function hasOtherActiveReference(assetId: string, r2Key: string): Promise<boolean> {
  const admin = requireAigcAdmin()
  const { count, error } = await admin
    .from("aigc_assets")
    .select("id, aigc_generations!inner(deleted_at)", { count: "exact", head: true })
    .eq("r2_key", r2Key)
    .neq("id", assetId)
    .eq("state", "active")
    .is("deleted_at", null)
    .is("aigc_generations.deleted_at", null)
  if (error) throw new BackendStoreError(`check active asset references failed: ${error.message}`)
  return (count ?? 0) > 0
}

async function failClaim(asset: ClaimedAsset, errorCode: string): Promise<DeleteOutcome> {
  try {
    const completion = await completeClaim(asset, false, errorCode)
    if (!completion.completed) return "conflicted"
    return completion.state === "error" ? "exhausted" : "failed"
  } catch {
    // The lease/token remains the recovery mechanism if even the fenced DB
    // completion fails. A later worker can retry idempotently after expiry.
    return "failed"
  }
}

async function completeClaim(
  asset: ClaimedAsset,
  succeeded: boolean,
  errorCode?: string,
): Promise<{ completed: boolean; state: string | null }> {
  const admin = requireAigcAdmin()
  const { data, error } = await admin.rpc("complete_asset_delete", {
    p_asset_id: asset.id,
    p_claim_token: asset.delete_claim_token,
    p_succeeded: succeeded,
    p_error_code: errorCode ?? null,
  })
  if (error) throw new BackendStoreError(`complete asset deletion failed: ${error.message}`)
  if (!isRecord(data) || typeof data.completed !== "boolean") {
    throw new BackendStoreError("complete asset deletion returned malformed data")
  }
  const state = typeof data.state === "string" ? data.state : null
  if (data.completed && succeeded && state !== "deleted") {
    throw new BackendStoreError("complete asset deletion returned an invalid success state")
  }
  if (data.completed && !succeeded && state !== "pending_delete" && state !== "error") {
    throw new BackendStoreError("complete asset deletion returned an invalid retry state")
  }
  return {
    completed: data.completed,
    state,
  }
}

function parseTombstoneResult(data: unknown, generationId: string): TombstoneGenerationResult {
  if (
    !isRecord(data)
    || typeof data.found !== "boolean"
    || (typeof data.generation_id !== "string" && data.generation_id !== undefined)
    || !isNonNegativeInteger(data.pending_assets)
    || !isNonNegativeInteger(data.deleted_assets)
    || !isNonNegativeInteger(data.error_assets)
  ) {
    throw new BackendStoreError("queue generation deletion returned malformed data")
  }
  if (data.found && data.generation_id !== generationId) {
    throw new BackendStoreError("queue generation deletion returned a mismatched generation")
  }
  return {
    found: data.found,
    generationId: typeof data.generation_id === "string" ? data.generation_id : generationId,
    pendingAssets: data.pending_assets,
    deletedAssets: data.deleted_assets,
    errorAssets: data.error_assets,
  }
}

function parseClaimedAsset(data: unknown): ClaimedAsset {
  if (
    !isRecord(data)
    || typeof data.id !== "string"
    || typeof data.generation_id !== "string"
    || typeof data.job_id !== "string"
    || typeof data.user_id !== "string"
    || typeof data.r2_key !== "string"
    || !data.r2_key
    || typeof data.delete_claim_token !== "string"
    || !data.delete_claim_token
    || data.state !== "pending_delete"
    || !Number.isInteger(data.delete_attempts)
    || (data.delete_attempts as number) < 1
    || (data.delete_attempts as number) > 5
    || typeof data.delete_lease_until !== "string"
    || !data.delete_lease_until
  ) {
    throw new BackendStoreError("claim asset deletion batch returned malformed row")
  }
  return data as unknown as ClaimedAsset
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}
