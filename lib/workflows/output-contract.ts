import type { AigcJobRecord, AigcKind } from "@/lib/aigc/types"
import { workflowDefinition, type WorkflowAssetRule } from "@/lib/workflows/definitions"
import { workflowOutputContractForJob } from "@/lib/workflows/revision"

export type WorkflowOutputLike = Readonly<{ assetType: string }>

export class WorkflowOutputContractError extends Error {
  readonly status = 422

  constructor(readonly code: string) {
    super(code)
  }
}

/**
 * Validate a complete provider output set before any persistence/finalization.
 * Individual MIME/size checks are category-specific and happen in the storage
 * or aigc-r2 verification layer; this function owns workflow-level completeness.
 */
export function validateWorkflowOutputs(
  kind: AigcKind,
  workflowId: string,
  assets: readonly WorkflowOutputLike[],
): void {
  const definition = workflowDefinition(kind, workflowId)
  if (!definition) throw new WorkflowOutputContractError("unknown_workflow")

  validateOutputContract(definition.outputContract, assets)
}

/** Validate against an immutable Job snapshot, with current-catalog fallback only for legacy Jobs. */
export function validateJobWorkflowOutputs(
  job: Pick<AigcJobRecord, "kind" | "workflow_id" | "workflow_revision" | "workflow_snapshot" | "provider">,
  assets: readonly WorkflowOutputLike[],
): void {
  validateOutputContract(workflowOutputContractForJob(job), assets)
}

export function validateOutputContract(
  outputContract: readonly WorkflowAssetRule[],
  assets: readonly WorkflowOutputLike[],
): void {
  const rules = new Map(outputContract.map((rule) => [rule.assetType, rule]))
  for (const asset of assets) {
    if (!rules.has(asset.assetType)) throw new WorkflowOutputContractError("asset_type_not_allowed")
  }

  if (!assets.some((asset) => rules.get(asset.assetType)?.primary)) {
    throw new WorkflowOutputContractError("no_primary_asset")
  }

  for (const rule of outputContract) {
    if (rule.required && !assets.some((asset) => asset.assetType === rule.assetType)) {
      throw new WorkflowOutputContractError("required_asset_missing")
    }
  }
}
