/**
 * POST /api/internal/asset-intake —— Modal Bridge 每个输出文件调一次,换取 R2 预签名 PUT 地址。
 *
 * 机器对机器:**不走 getSession**。业务鉴权只看 delivery_token(HMAC,绑 job);请求可达由
 * Vercel Deployment Protection Bypass 负责,与此处解耦。
 *
 * 关键设计:签名的 PUT 指向 **staging key**(`.staging/…`),**最终作品 key 永不发放 PUT 权限**;
 * job-complete 核验 staging 后服务端 Copy 到 final,保证 succeeded 后作品不可被覆写(修 C1)。
 * identity(r2_key/content_type)首次 intake 定死、重试恒返同一份(修 H3)。
 * 预签名 PUT 只锁 content-type、不锁 Content-Length(锁死会 403)。
 */

import { NextResponse } from "next/server"
import { parseJsonObject } from "@/lib/jobs/api"
import { getOwnedJob, terminalStatus } from "@/lib/jobs/store"
import { verifyDeliveryToken } from "@/lib/delivery/token"
import { getOrCreateUpload } from "@/lib/delivery/uploads"
import { deliveryError, mapInternalError } from "@/lib/delivery/http"
import {
  categoryForKind,
  extForAsset,
  isAllowedAssetType,
  isAllowedContentType,
  isValidAssetType,
  maxBytesForCategory,
  normalizeContentType,
  parsePosition,
  parseSize,
  stagingKeyForFinal,
} from "@/lib/delivery/asset-policy"
import { getR2Env, signPutUrl } from "@/lib/r2"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PUT_URL_TTL_SECONDS = 300

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = await parseJsonObject(req)

    const jobId = typeof body.job_id === "string" ? body.job_id : ""
    const claims = verifyDeliveryToken(body.token)
    if (!jobId || claims.jobId !== jobId) return deliveryError(401, "invalid_delivery_token")

    const job = await getOwnedJob(jobId, claims.userId)
    if (!job) return deliveryError(401, "invalid_delivery_token")
    if (terminalStatus(job.status)) return deliveryError(409, "job_not_active")

    if (!isValidAssetType(body.asset_type) || !isAllowedAssetType(job.kind, body.asset_type)) {
      return deliveryError(400, "asset_type_not_allowed")
    }
    const assetType = body.asset_type
    const position = parsePosition(body.position)
    if (position === null) return deliveryError(400, "invalid_position")

    const contentType = normalizeContentType(typeof body.content_type === "string" ? body.content_type : null)
    if (!contentType) return deliveryError(400, "invalid_content_type")
    const category = categoryForKind(job.kind)
    if (!isAllowedContentType(category, contentType)) return deliveryError(400, "content_type_not_allowed")

    const sizeBytes = parseSize(body.size_bytes)
    if (sizeBytes === null) return deliveryError(400, "invalid_size")
    if (sizeBytes > maxBytesForCategory(category)) return deliveryError(400, "size_too_large")

    if (!getR2Env()) return deliveryError(503, "storage_unconfigured")

    const filename = typeof body.filename === "string" ? body.filename : null
    const ext = extForAsset(category, contentType, filename)
    const candidateKey = `aigc/${job.user_id}/${job.id}/${assetType}-${position}.${ext}`

    // identity 不可变:首次 intake 定 key/content_type,重试恒返首次那份(修 H3)。
    const identity = await getOrCreateUpload({
      jobId: job.id,
      userId: job.user_id,
      assetType,
      position,
      r2Key: candidateKey,
      contentType,
      sizeBytes,
    })

    // 只对 staging key 发放可重复 PUT;final key 从不签 PUT(修 C1)。
    const stagingKey = stagingKeyForFinal(identity.r2Key)
    const signed = await signPutUrl(stagingKey, identity.contentType ?? contentType, PUT_URL_TTL_SECONDS)
    if (!signed) return deliveryError(503, "storage_unconfigured")

    return NextResponse.json({
      r2_key: identity.r2Key,
      asset_type: assetType,
      content_type: identity.contentType ?? contentType,
      put_url: signed.url,
      required_headers: signed.requiredHeaders,
      expires_in: PUT_URL_TTL_SECONDS,
    })
  } catch (error) {
    return mapInternalError(error)
  }
}
