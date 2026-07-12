import type { AigcKind } from "@/lib/aigc/types"
import { workflowDefinition } from "@/lib/workflows/definitions"

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

  const rules = new Map(definition.outputContract.map((rule) => [rule.assetType, rule]))
  for (const asset of assets) {
    if (!rules.has(asset.assetType)) throw new WorkflowOutputContractError("asset_type_not_allowed")
  }

  if (!assets.some((asset) => rules.get(asset.assetType)?.primary)) {
    throw new WorkflowOutputContractError("no_primary_asset")
  }

  for (const rule of definition.outputContract) {
    if (rule.required && !assets.some((asset) => asset.assetType === rule.assetType)) {
      throw new WorkflowOutputContractError("required_asset_missing")
    }
  }
}
