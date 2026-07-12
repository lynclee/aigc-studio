/**
 * Modal Bridge aigc-r2 交付：delivery_token（HMAC，无状态）。
 *
 * token 绑 job 生命周期：签发即有效，`exp` 取 job 最大生命周期（默认 2h）。
 * 真正短 TTL 的是 R2 PUT URL（见 lib/r2.ts:signPutUrl），两者分离，
 * 避免异步生成耗时把固定短 TTL 的 token 熬过期。
 *
 * 载荷 = base64url(JSON{j:jobId,u:userId,e:exp})，签名 = HMAC-SHA256。
 * 校验无状态：重算签名 + 常量时间比较 + 检查未过期。
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export const DELIVERY_TOKEN_SECRET_ENV = "BRIDGE_DELIVERY_TOKEN_SECRET"
export const DELIVERY_TOKEN_TTL_MS = 2 * 60 * 60 * 1000 // 2h

export class DeliveryTokenConfigError extends Error {
  readonly status = 503
  constructor() {
    super(`${DELIVERY_TOKEN_SECRET_ENV} is not configured`)
  }
}

export class DeliveryTokenError extends Error {
  readonly status = 401
  readonly code = "invalid_delivery_token"
  constructor(message = "invalid or expired delivery token") {
    super(message)
  }
}

export interface DeliveryTokenClaims {
  jobId: string
  userId: string
  exp: number // epoch ms
}

function getSecret(): string {
  const secret = process.env.BRIDGE_DELIVERY_TOKEN_SECRET
  if (!secret) throw new DeliveryTokenConfigError()
  return secret
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

export function signDeliveryToken(
  claims: { jobId: string; userId: string },
  ttlMs: number = DELIVERY_TOKEN_TTL_MS,
): string {
  const secret = getSecret()
  const exp = Date.now() + ttlMs
  const payload = Buffer.from(
    JSON.stringify({ j: claims.jobId, u: claims.userId, e: exp }),
  ).toString("base64url")
  return `v1.${payload}.${sign(payload, secret)}`
}

export function verifyDeliveryToken(token: unknown): DeliveryTokenClaims {
  const secret = getSecret()
  if (typeof token !== "string") throw new DeliveryTokenError()
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== "v1") throw new DeliveryTokenError()
  const [, payload, providedSig] = parts

  const expectedSig = sign(payload, secret)
  if (!constantTimeEqual(providedSig, expectedSig)) throw new DeliveryTokenError()

  let decoded: { j?: unknown; u?: unknown; e?: unknown }
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    throw new DeliveryTokenError()
  }
  const jobId = typeof decoded.j === "string" ? decoded.j : ""
  const userId = typeof decoded.u === "string" ? decoded.u : ""
  const exp = typeof decoded.e === "number" ? decoded.e : 0
  if (!jobId || !userId || !exp) throw new DeliveryTokenError()
  if (Date.now() > exp) throw new DeliveryTokenError("delivery token expired")

  return { jobId, userId, exp }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
