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

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
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

/**
 * 对一个 R2 对象 key 签一个预签名 PUT URL,供 Modal Bridge 直传产物。
 * **只把 content-type 纳入签名,不锁精确 Content-Length**(锁死会 403 且难查)。
 * @returns { url, requiredHeaders };env 缺失或签名失败返回 null(调用方回 503)
 */
export async function signPutUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 300,
): Promise<{ url: string; requiredHeaders: Record<string, string> } | null> {
  const r2 = getR2Client()
  if (!r2) return null
  try {
    const command = new PutObjectCommand({ Bucket: r2.bucket, Key: key, ContentType: contentType })
    const url = await getSignedUrl(r2.client, command, { expiresIn: expiresInSeconds })
    return { url, requiredHeaders: { "Content-Type": contentType } }
  } catch {
    return null
  }
}

export interface R2ObjectHead {
  size: number
  etag: string | null
  contentType: string | null
}

/**
 * HeadObject 核验一个 R2 对象。用于 job-complete 确认 Bridge 已真正上传。
 * - 对象确实不存在(404) → 返回 null(调用方视为核验失败,不入库)。
 * - env 缺失或瞬时错误 → 抛出(调用方回 5xx,可重试),不与「对象缺失」混淆。
 */
export async function headObject(key: string): Promise<R2ObjectHead | null> {
  const r2 = getR2Client()
  if (!r2) throw new Error("R2 is not configured")
  try {
    const res = await r2.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }))
    return {
      size: typeof res.ContentLength === "number" ? res.ContentLength : 0,
      etag: res.ETag ?? null,
      contentType: res.ContentType ?? null,
    }
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return name === "NotFound" || name === "NoSuchKey" || statusCode === 404
}

/**
 * 删除一个 R2 对象(孤儿清理用)。DELETE 幂等:对象不存在也算成功。
 * @returns true 删除成功(或对象本就不存在);false 表示 env 缺失或删除失败(调用方可稍后重试)。
 */
export async function deleteObject(key: string): Promise<boolean> {
  const r2 = getR2Client()
  if (!r2) return false
  try {
    await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }))
    return true
  } catch (error) {
    if (isNotFoundError(error)) return true
    return false
  }
}

export class CopyPreconditionError extends Error {
  constructor() {
    super("R2 copy source changed (ETag precondition failed)")
  }
}

/**
 * 服务端 Copy(staging → final)。final key 从不发放预签名 PUT,因此 Copy 出来的作品**不可被
 * Bridge 覆写**——这是「succeeded 后作品不可静默变更」不变量的实现。
 * @param sourceIfMatch 源对象 ETag 前置条件:源在 Copy 前被改动则抛 CopyPreconditionError(可重试)。
 * @returns { etag };源不存在返回 null;env 缺失返回 null。
 */
export async function copyObject(params: {
  sourceKey: string
  destKey: string
  sourceIfMatch?: string
}): Promise<{ etag: string | null } | null> {
  const r2 = getR2Client()
  if (!r2) return null
  try {
    const res = await r2.client.send(
      new CopyObjectCommand({
        Bucket: r2.bucket,
        Key: params.destKey,
        CopySource: `${r2.bucket}/${params.sourceKey}`,
        ...(params.sourceIfMatch ? { CopySourceIfMatch: params.sourceIfMatch } : {}),
        MetadataDirective: "COPY",
      }),
    )
    return { etag: res.CopyObjectResult?.ETag ?? null }
  } catch (error) {
    if (isPreconditionFailed(error)) throw new CopyPreconditionError()
    if (isNotFoundError(error)) return null
    throw error
  }
}

function isPreconditionFailed(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  return name === "PreconditionFailed" || statusCode === 412
}
