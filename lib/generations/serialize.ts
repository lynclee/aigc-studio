import { signGetUrl } from "@/lib/r2"
import type { AigcAssetRecord, AigcGenerationRecord } from "@/lib/aigc/types"

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
  generation: AigcGenerationRecord,
  assets: AigcAssetRecord[],
): Promise<Record<string, unknown>> {
  return {
    id: generation.id,
    job_id: generation.job_id,
    kind: generation.kind,
    prompt: generation.prompt,
    provider: generation.provider,
    created_at: generation.created_at,
    assets: await Promise.all(assets.map(serializeAsset)),
  }
}
