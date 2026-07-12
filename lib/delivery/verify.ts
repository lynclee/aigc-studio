/**
 * 交付资产核验 + 固化(job-complete push 路径 与 modal-bridge /status 兜底路径共用)。
 *
 * 对 manifest 里每个 asset:
 *  1. 校验 asset_type 属该 kind、position、无重复 (type,pos);**强制** manifest 带 size_bytes/etag(H2)。
 *  2. 从台账取**权威 identity**(首次 intake 定死的 r2_key/content_type,修 H3)。
 *  3. HEAD **staging** 对象(Bridge 上传目标),核验:存在 / size 在上下限且 == 上报 / **etag == 上报**。
 *  4. 服务端 **Copy staging → final**(带 ETag 前置条件);final key 从不发 PUT,固化后不可被覆写(修 C1)。
 * 只信 R2 实际 size + ETag,不信上报 sha256(仅存 metadata)。
 *
 * 抛出约定:
 *   - DeliveryVerifyError(code, status):manifest / 对象本身有问题,不重试。
 *   - DeliveryStorageUnconfiguredError:R2 未配置(503)。
 *   - 其它(HeadObject/Copy 瞬时错误、CopyPreconditionError):原样抛出,caller 视为可重试。
 */

import type { AigcJobRecord, ProviderOutputAsset } from "@/lib/aigc/types"
import { isRecord } from "@/lib/aigc/http"
import { copyObject, getR2Env, headObject } from "@/lib/r2"
import { getUpload } from "@/lib/delivery/uploads"
import {
  isValidAssetType,
  maxBytesForCategory,
  normalizeContentType,
  normalizeEtag,
  parsePosition,
  parseSize,
  stagingKeyForFinal,
} from "@/lib/delivery/asset-policy"
import { assetRuleForWorkflow, workflowDefinition } from "@/lib/workflows/definitions"
import {
  validateWorkflowOutputs,
  WorkflowOutputContractError,
} from "@/lib/workflows/output-contract"

export class DeliveryVerifyError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 400,
  ) {
    super(code)
  }
}

export class DeliveryStorageUnconfiguredError extends Error {
  readonly status = 503
  constructor() {
    super("R2 is not configured")
  }
}

export interface VerifiedAsset {
  output: ProviderOutputAsset
  etag: string | null
  sizeBytes: number
  stagingKey: string
}

const MAX_MANIFEST_ASSETS = 32

export async function verifyDeliveredAssets(
  job: AigcJobRecord,
  manifest: unknown[],
  options: { beforeCopy?: () => Promise<void> } = {},
): Promise<VerifiedAsset[]> {
  if (!getR2Env()) throw new DeliveryStorageUnconfiguredError()
  if (!Array.isArray(manifest) || manifest.length === 0) throw new DeliveryVerifyError("empty_manifest")
  if (manifest.length > MAX_MANIFEST_ASSETS) throw new DeliveryVerifyError("manifest_too_large")

  const seen = new Set<string>()

  // 阶段 1:全部 asset 先做校验 + HEAD staging(纯读,无副作用)。任一失败即抛,尚未 Copy(M8)。
  type Plan = {
    assetType: string
    position: number
    finalKey: string
    stagingKey: string
    contentType: string | undefined
    stagingEtag: string
    stagingRawEtag: string
    size: number
    primary: boolean
    sha256?: string
  }
  const plans: Plan[] = []
  for (const raw of manifest) {
    if (!isRecord(raw)) throw new DeliveryVerifyError("invalid_asset")
    if (!isValidAssetType(raw.asset_type)) {
      throw new DeliveryVerifyError("asset_type_not_allowed")
    }
    const assetType = raw.asset_type
    const assetRule = assetRuleForWorkflow(job.kind, job.workflow_id, assetType)
    if (!assetRule) throw new DeliveryVerifyError("asset_type_not_allowed")
    const position = parsePosition(raw.position)
    if (position === null) throw new DeliveryVerifyError("invalid_position")

    const dedupKey = `${assetType}-${position}`
    if (seen.has(dedupKey)) throw new DeliveryVerifyError("duplicate_asset")
    seen.add(dedupKey)

    // H2:size_bytes / etag 必填,与实际对象严格比对。
    const reportedSize = parseSize(raw.size_bytes)
    if (reportedSize === null) throw new DeliveryVerifyError("size_required")
    const reportedEtag = normalizeEtag(raw.etag)
    if (!reportedEtag) throw new DeliveryVerifyError("etag_required")

    // H3:权威 identity 来自台账(intake 时定死),不信 manifest 自造。
    const upload = await getUpload(job.id, assetType, position)
    if (!upload) throw new DeliveryVerifyError("asset_not_intaked", 422)
    const finalKey = upload.r2_key
    if (typeof raw.r2_key === "string" && raw.r2_key !== finalKey) throw new DeliveryVerifyError("invalid_r2_key")

    // C1:HEAD staging(Bridge 上传目标),核验实际字节。
    const stagingKey = stagingKeyForFinal(finalKey)
    const head = await headObject(stagingKey) // 瞬时错误抛出(非 DeliveryVerifyError)→ 可重试
    if (!head) throw new DeliveryVerifyError("asset_not_found", 422)
    if (head.size <= 0 || head.size > maxBytesForCategory(assetRule.category)) {
      throw new DeliveryVerifyError("asset_size_invalid", 422)
    }
    if (head.size !== reportedSize) throw new DeliveryVerifyError("asset_size_mismatch", 422)
    const stagingEtag = normalizeEtag(head.etag)
    if (!stagingEtag || stagingEtag !== reportedEtag) throw new DeliveryVerifyError("asset_etag_mismatch", 422)

    plans.push({
      assetType,
      position,
      finalKey,
      stagingKey,
      contentType: normalizeContentType(upload.content_type) ?? undefined,
      stagingEtag,
      stagingRawEtag: head.etag ?? "",
      size: head.size,
      primary: assetRule.primary,
      ...(typeof raw.checksum_sha256 === "string" ? { sha256: raw.checksum_sha256 } : {}),
    })
  }

  // M5:完整输出集合由 workflow output contract 声明,不依赖 asset_type 命名约定。
  try {
    validateWorkflowOutputs(job.kind, job.workflow_id, plans)
  } catch (error) {
    if (error instanceof WorkflowOutputContractError) {
      throw new DeliveryVerifyError(error.code, error.status)
    }
    throw error
  }

  // 阶段 2:全部核验通过后再统一 Copy staging → final(final 从不发 PUT → 不可覆写)。
  const results: VerifiedAsset[] = []
  for (const plan of plans) {
    await options.beforeCopy?.()
    const copied = await copyObject({
      sourceKey: plan.stagingKey,
      destKey: plan.finalKey,
      sourceIfMatch: plan.stagingRawEtag || undefined,
    })
    if (!copied) throw new DeliveryVerifyError("asset_not_found", 422)
    const finalEtag = normalizeEtag(copied.etag) ?? plan.stagingEtag
    results.push({
      output: {
        assetType: plan.assetType,
        position: plan.position,
        r2Key: plan.finalKey,
        contentType: plan.contentType,
        metadata: {
          etag: finalEtag,
          size_bytes: plan.size,
          ...(plan.sha256 ? { checksum_sha256: plan.sha256 } : {}),
        },
      },
      etag: finalEtag,
      sizeBytes: plan.size,
      stagingKey: plan.stagingKey,
    })
  }

  return results
}
