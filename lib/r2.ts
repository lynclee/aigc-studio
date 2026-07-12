/**
 * Cloudflare R2 访问层(S3 兼容)。
 *
 * R2 暴露 S3 兼容 API,用 @aws-sdk/client-s3 当客户端,endpoint 指向
 * `https://<account_id>.r2.cloudflarestorage.com`,region 固定 "auto"。
 *
 * 生成完成后,服务端会将提供商产物保存进私有 R2 bucket。个人作品库只持有
 * r2_key,展示时用 `signGetUrl` 现签一个 S3 预签名 GET URL(默认 1 小时有效)。
 *
 * ⚠️ env 缺失时优雅降级:`getR2Client` 返回 null、`signGetUrl` 返回 null,
 * **绝不在模块加载期抛错** —— 这些只在运行时(请求处理中)被调用,
 * build / 占位 env 下不能让进程崩。
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export interface R2Env {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

/** 读 R2_* env,任一缺失返回 null(调用方据此降级到「作品库待配置」)。 */
export function getR2Env(): R2Env | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null
  return { accountId, accessKeyId, secretAccessKey, bucket }
}

let cachedClient: S3Client | null = null
let cachedClientKey: string | null = null

/** 懒构建并缓存 R2 S3Client;env 缺失返回 null。 */
export function getR2Client(): { client: S3Client; bucket: string } | null {
  const env = getR2Env()
  if (!env) return null

  // env 变化(理论上罕见)时重建,否则复用
  const key = `${env.accountId}:${env.accessKeyId}`
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.accessKeyId,
        secretAccessKey: env.secretAccessKey,
      },
    })
    cachedClientKey = key
  }
  return { client: cachedClient, bucket: env.bucket }
}

/**
 * 对一个 R2 对象 key 签一个预签名 GET URL。
 * @param key R2 对象 key(不含 bucket)
 * @param expiresInSeconds 有效期秒数,默认 1 小时
 * @returns 预签名 URL;env 缺失或签名失败返回 null(调用方渲染占位)
 */
export async function signGetUrl(
  key: string,
  expiresInSeconds = 60 * 60,
): Promise<string | null> {
  const r2 = getR2Client()
  if (!r2) return null
  try {
    const command = new GetObjectCommand({ Bucket: r2.bucket, Key: key })
    return await getSignedUrl(r2.client, command, { expiresIn: expiresInSeconds })
  } catch {
    // 签名失败(凭据错 / key 非法等)不抛,返回 null 让 UI 降级
    return null
  }
}
