import type { AigcGenerationWithWorkflowSnapshot, AigcJobRecord, AigcKind, ProviderSubmitResult } from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"
import {
  resolveExecutionVariant,
  workflowDefinition,
  type WorkflowAssetCategory,
  type WorkflowAssetRule,
  type WorkflowProvider,
} from "@/lib/workflows/definitions"

const WORKFLOW_SNAPSHOT_SCHEMA_V1 = 1 as const
/** Version written for newly created Jobs. Historical parsers must never be replaced when this advances. */
export const WORKFLOW_SNAPSHOT_SCHEMA_VERSION = WORKFLOW_SNAPSHOT_SCHEMA_V1

/**
 * Immutable, server-authored authority for an individual Job.
 *
 * It deliberately pins only the execution identity and delivery contract. The
 * template body and provider endpoint remain versioned deployment artifacts;
 * this application has no automatic resubmit path that would need to replay
 * them after a deployment.
 */
export type WorkflowJobSnapshotV1 = Readonly<{
  schemaVersion: typeof WORKFLOW_SNAPSHOT_SCHEMA_V1
  definitionRevision: string
  kind: AigcKind
  workflowId: string
  provider: WorkflowProvider
  executionVariant: string
  templateVersion: string
  referenceCount: number
  outputContract: readonly WorkflowAssetRule[]
}>

/** Add future schema versions to this union; keep V1 parsing while any stored row may reference it. */
export type WorkflowJobSnapshot = WorkflowJobSnapshotV1

type WorkflowJobIdentity = Pick<AigcJobRecord, "kind" | "workflow_id" | "provider"> & {
  workflow_revision: unknown
  workflow_snapshot: unknown
}

const PROVIDERS: readonly WorkflowProvider[] = [
  "modal-image",
  "modal-bridge",
  "openrouter-image",
  "fal-image",
  "comfyui-image",
  "fal-video",
  "fal-model3d",
]
const CATEGORIES: readonly WorkflowAssetCategory[] = ["image", "video", "model", "output"]
const ASSET_TYPE_RE = /^[a-z0-9_-]{1,32}$/

export class WorkflowSnapshotError extends Error {
  readonly code = "invalid_workflow_snapshot"
  readonly status = 500
}

export function createWorkflowJobSnapshot(params: {
  kind: AigcKind
  workflowId: string
  provider: WorkflowProvider
  referenceCount?: number
}): WorkflowJobSnapshot {
  const definition = workflowDefinition(params.kind, params.workflowId)
  const resolved = resolveExecutionVariant(
    params.kind,
    params.workflowId,
    params.provider,
    params.referenceCount ?? 0,
  )
  if (!definition || !resolved) {
    throw new WorkflowSnapshotError(`Cannot snapshot unsupported workflow execution ${params.kind}/${params.workflowId}`)
  }

  return parseWorkflowSnapshot({
    schemaVersion: WORKFLOW_SNAPSHOT_SCHEMA_VERSION,
    definitionRevision: definition.revision,
    kind: definition.kind,
    workflowId: definition.id,
    provider: params.provider,
    executionVariant: resolved.variant,
    templateVersion: resolved.execution.templateVersion,
    referenceCount: params.referenceCount ?? 0,
    outputContract: definition.outputContract,
  })
}

export function referenceCountFromJobInput(input: Record<string, unknown>): number {
  return Array.isArray(input.images) ? input.images.length : 0
}

export function executionFromWorkflowSnapshot(
  snapshot: WorkflowJobSnapshot,
  expected: {
    kind: AigcKind
    workflowId: string
    provider: WorkflowProvider
    referenceCount: number
  },
): Readonly<{ variant: string; templateVersion: string }> {
  if (
    snapshot.kind !== expected.kind ||
    snapshot.workflowId !== expected.workflowId ||
    snapshot.provider !== expected.provider ||
    snapshot.referenceCount !== expected.referenceCount
  ) {
    throw new WorkflowSnapshotError("Pinned workflow execution does not match the submission")
  }
  return { variant: snapshot.executionVariant, templateVersion: snapshot.templateVersion }
}

/**
 * Returns null only for a genuine pre-migration Job (both columns absent/null).
 * A partially present, malformed, or identity-mismatched snapshot fails closed.
 */
export function workflowSnapshotForJob(job: WorkflowJobIdentity): WorkflowJobSnapshot | null {
  const rawRevision = job.workflow_revision
  const rawSnapshot = job.workflow_snapshot
  if (rawRevision == null && rawSnapshot == null) return null
  if (typeof rawRevision !== "string" || !rawRevision.trim() || !isRecord(rawSnapshot)) {
    throw new WorkflowSnapshotError("Workflow revision and snapshot must be present together")
  }

  const snapshot = parseWorkflowSnapshot(rawSnapshot)
  if (
    snapshot.definitionRevision !== rawRevision ||
    snapshot.kind !== job.kind ||
    snapshot.workflowId !== job.workflow_id ||
    snapshot.provider !== job.provider
  ) {
    throw new WorkflowSnapshotError("Workflow snapshot identity does not match its Job")
  }
  return snapshot
}

export function workflowOutputContractForJob(job: WorkflowJobIdentity): readonly WorkflowAssetRule[] {
  const snapshot = workflowSnapshotForJob(job)
  if (snapshot) return snapshot.outputContract
  const legacyDefinition = workflowDefinition(job.kind, job.workflow_id)
  if (!legacyDefinition) throw new WorkflowSnapshotError("Legacy Job references an unknown workflow")
  return legacyDefinition.outputContract
}

export function workflowAssetRuleForJob(
  job: WorkflowJobIdentity,
  assetType: string,
): WorkflowAssetRule | undefined {
  return workflowOutputContractForJob(job).find((rule) => rule.assetType === assetType)
}

/** Keep provider audit metadata bound to the exact execution selected before Job creation. */
export function assertSubmissionMatchesWorkflowSnapshot(
  job: WorkflowJobIdentity,
  submission: ProviderSubmitResult,
): void {
  const snapshot = workflowSnapshotForJob(job)
  if (!snapshot) return
  const response = submission.response
  if (
    submission.provider !== snapshot.provider ||
    response.catalog_workflow_id !== snapshot.workflowId ||
    response.execution_variant !== snapshot.executionVariant ||
    response.template_version !== snapshot.templateVersion
  ) {
    throw new WorkflowSnapshotError("Provider submission does not match the pinned workflow snapshot")
  }
}

export function workflowOutputContractForGeneration(
  generation: Pick<
    AigcGenerationWithWorkflowSnapshot,
    "kind" | "workflow_id" | "provider" | "workflow_revision" | "workflow_snapshot"
  >,
): readonly WorkflowAssetRule[] {
  const revision = generation.workflow_revision
  const snapshot = generation.workflow_snapshot
  if (revision != null || snapshot != null) {
    return workflowOutputContractForJob({
      kind: generation.kind,
      workflow_id: generation.workflow_id,
      provider: generation.provider,
      workflow_revision: revision,
      workflow_snapshot: snapshot,
    })
  }
  const legacyDefinition = workflowDefinition(generation.kind, generation.workflow_id)
  // Completed legacy rows predate snapshot pinning. Preserve the library's
  // asset-type fallback if their historical catalog entry no longer exists.
  return legacyDefinition?.outputContract ?? []
}

function parseWorkflowSnapshot(raw: Record<string, unknown>): WorkflowJobSnapshot {
  switch (raw.schemaVersion) {
    case WORKFLOW_SNAPSHOT_SCHEMA_V1:
      return parseWorkflowSnapshotV1(raw)
    default:
      throw new WorkflowSnapshotError("Unsupported workflow snapshot schema")
  }
}

function parseWorkflowSnapshotV1(raw: Record<string, unknown>): WorkflowJobSnapshotV1 {
  const definitionRevision = requiredString(raw.definitionRevision, "definitionRevision")
  const kind = parseKind(raw.kind)
  const workflowId = requiredString(raw.workflowId, "workflowId")
  const provider = parseProvider(raw.provider)
  const executionVariant = requiredString(raw.executionVariant, "executionVariant")
  const templateVersion = requiredString(raw.templateVersion, "templateVersion")
  const referenceCount = raw.referenceCount
  if (!Number.isInteger(referenceCount) || (referenceCount as number) < 0 || (referenceCount as number) > 32) {
    throw new WorkflowSnapshotError("Workflow snapshot has an invalid referenceCount")
  }
  const outputContract = parseOutputContract(raw.outputContract)
  return freezeSnapshot({
    schemaVersion: WORKFLOW_SNAPSHOT_SCHEMA_V1,
    definitionRevision,
    kind,
    workflowId,
    provider,
    executionVariant,
    templateVersion,
    referenceCount: referenceCount as number,
    outputContract,
  })
}

function parseOutputContract(value: unknown): readonly WorkflowAssetRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new WorkflowSnapshotError("Workflow snapshot has an invalid output contract")
  }
  const seen = new Set<string>()
  const rules = value.map((raw): WorkflowAssetRule => {
    if (!isRecord(raw)) throw new WorkflowSnapshotError("Workflow snapshot has an invalid output rule")
    const assetType = requiredString(raw.assetType, "assetType")
    if (!ASSET_TYPE_RE.test(assetType) || seen.has(assetType)) {
      throw new WorkflowSnapshotError("Workflow snapshot has a duplicate or invalid asset type")
    }
    seen.add(assetType)
    if (!CATEGORIES.includes(raw.category as WorkflowAssetCategory)) {
      throw new WorkflowSnapshotError("Workflow snapshot has an invalid asset category")
    }
    if (typeof raw.required !== "boolean" || typeof raw.primary !== "boolean") {
      throw new WorkflowSnapshotError("Workflow snapshot has invalid output flags")
    }
    return Object.freeze({
      assetType,
      category: raw.category as WorkflowAssetCategory,
      required: raw.required,
      primary: raw.primary,
    })
  })
  if (!rules.some((rule) => rule.primary)) {
    throw new WorkflowSnapshotError("Workflow snapshot output contract has no primary asset")
  }
  return Object.freeze(rules)
}

function cloneOutputContract(contract: readonly WorkflowAssetRule[]): readonly WorkflowAssetRule[] {
  return Object.freeze(contract.map((rule) => Object.freeze({ ...rule })))
}

function freezeSnapshot(snapshot: WorkflowJobSnapshot): WorkflowJobSnapshot {
  return Object.freeze({ ...snapshot, outputContract: cloneOutputContract(snapshot.outputContract) })
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new WorkflowSnapshotError(`Workflow snapshot has an invalid ${field}`)
  }
  return value
}

function parseKind(value: unknown): AigcKind {
  if (value === "image" || value === "video" || value === "model3d") return value
  throw new WorkflowSnapshotError("Workflow snapshot has an invalid kind")
}

function parseProvider(value: unknown): WorkflowProvider {
  if (PROVIDERS.includes(value as WorkflowProvider)) return value as WorkflowProvider
  throw new WorkflowSnapshotError("Workflow snapshot has an invalid provider")
}
