export type AigcKind = "image" | "model3d" | "video"
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface SubmitRequest {
  prompt: string
  workflowId: string
  input: Record<string, unknown>
  userId: string
}

export interface ProviderSubmitResult {
  provider: string
  providerJobId: string
  status: JobStatus
  statusUrl?: string
  response: Record<string, unknown>
}

export interface ProviderOutputAsset {
  assetType: string
  position: number
  url?: string
  r2Key?: string
  contentType?: string
  metadata?: Record<string, unknown>
}

export interface ProviderStatusResult {
  status: JobStatus
  response: Record<string, unknown>
  error?: string
  assets: ProviderOutputAsset[]
}

export interface AigcJobRecord {
  id: string
  user_id: string
  kind: AigcKind
  workflow_id: string
  workflow_revision: string | null
  workflow_snapshot: unknown | null
  status: JobStatus
  provider: string
  provider_job_id: string | null
  provider_status_url: string | null
  request: Record<string, unknown>
  provider_response: Record<string, unknown>
  error: string | null
  reconcile_token: string | null
  reconcile_lease_until: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface AigcGenerationRecord {
  id: string
  job_id: string
  user_id: string
  kind: AigcKind
  workflow_id: string
  prompt: string | null
  provider: string
  provider_job_id: string | null
  metadata: Record<string, unknown>
  created_at: string
  deleted_at: string | null
}

/** Generation row plus the immutable workflow authority joined from its Job. */
export interface AigcGenerationWithWorkflowSnapshot extends AigcGenerationRecord {
  workflow_revision: unknown
  workflow_snapshot: unknown
}

export interface AigcAssetRecord {
  id: string
  generation_id: string
  job_id: string
  user_id: string
  kind: AigcKind
  asset_type: string
  position: number
  r2_key: string | null
  source_url: string | null
  content_type: string | null
  metadata: Record<string, unknown>
  created_at: string
  state: "active" | "pending_delete" | "deleted" | "error"
  delete_requested_at: string | null
  delete_attempts: number
  delete_error: string | null
  delete_retry_after: string | null
  delete_claim_token: string | null
  delete_lease_until: string | null
  deleted_at: string | null
}
