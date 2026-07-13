import { signGetUrl } from "@/lib/r2"
import type { AigcAssetRecord, AigcGenerationWithWorkflowSnapshot } from "@/lib/aigc/types"
import { workflowOutputContractForGeneration } from "@/lib/workflows/revision"

export async function serializeAsset(asset: AigcAssetRecord): Promise<Record<string, unknown>> {
  const signedUrl = asset.r2_key ? await signGetUrl(asset.r2_key).catch(() => null) : null
  return {
    id: asset.id,
    generation_id: asset.generation_id,
    job_id: asset.job_id,
    kind: asset.kind,
    asset_type: asset.asset_type,
    position: asset.position,
    signed_url: signedUrl,
    url: signedUrl,
    content_type: asset.content_type,
    created_at: asset.created_at,
  }
}

export async function serializeGeneration(
  generation: AigcGenerationWithWorkflowSnapshot,
  assets: AigcAssetRecord[],
): Promise<Record<string, unknown>> {
  const primaryAssetTypes = workflowOutputContractForGeneration(generation)
    .filter((rule) => rule.primary)
    .map((rule) => rule.assetType)
  return {
    id: generation.id,
    job_id: generation.job_id,
    kind: generation.kind,
    workflow_id: generation.workflow_id,
    prompt: generation.prompt,
    created_at: generation.created_at,
    primary_asset_types: primaryAssetTypes,
    assets: await Promise.all(assets.map(serializeAsset)),
  }
}
