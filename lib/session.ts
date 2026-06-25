/**
 * 轻量会话:用「签名 cookie」存最小用户身份,不引入任何 auth 库 / 数据库。
 *
 * 机制:payload(JSON → base64url)与 HMAC-SHA256 签名拼成 `<payload>.<sig>`,
 * 用 Web Crypto(globalThis.crypto.subtle)做 HMAC,密钥读 env `SESSION_SECRET`。
 * cookie 属性:HttpOnly + Secure(生产)+ SameSite=Lax + Path=/。
 * SameSite=Lax 允许飞书 callback 这种顶层 GET 导航带上 cookie。
 *
 * 注意:这是「会话信封」,不是加密 —— payload 用 base64url 仅编码、可被解读,
 * 但 HMAC 签名保证客户端无法篡改(伪造 open_id 等)。不要往里塞敏感密钥。
 */

import { cookies } from "next/headers"

export const SESSION_COOKIE = "aigc_session"
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 天

export interface SessionPayload {
  open_id: string
  name: string
  avatar: string
}

function getSecretKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error("SESSION_SECRET 未配置:会话 cookie 无法签名")
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 常量时间比较,避免时序侧信道。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 把 payload 编码并签名成 `<payload>.<sig>` 字符串。 */
export async function signSession(payload: SessionPayload): Promise<string> {
  const key = await getSecretKey()
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64))
  const sigB64 = base64UrlEncode(new Uint8Array(sigBuf))
  return `${payloadB64}.${sigB64}`
}

/** 校验签名并解析 payload;任何不合法返回 null。 */
export async function verifySession(token: string): Promise<SessionPayload | null> {
  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  if (!payloadB64 || !sigB64) return null

  try {
    const key = await getSecretKey()
    const expectedBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payloadB64),
    )
    const expectedB64 = base64UrlEncode(new Uint8Array(expectedBuf))
    if (!timingSafeEqual(sigB64, expectedB64)) return null

    const json = new TextDecoder().decode(base64UrlDecode(payloadB64))
    const parsed = JSON.parse(json) as Partial<SessionPayload>
    if (typeof parsed.open_id !== "string" || !parsed.open_id) return null
    return {
      open_id: parsed.open_id,
      name: typeof parsed.name === "string" ? parsed.name : "",
      avatar: typeof parsed.avatar === "string" ? parsed.avatar : "",
    }
  } catch {
    return null
  }
}

/** 读取当前会话(server component / route handler 用)。无 / 非法返回 null。 */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySession(token)
}

/** 写入会话 cookie(route handler 内调用)。 */
export async function setSession(payload: SessionPayload): Promise<void> {
  const token = await signSession(payload)
  const store = await cookies()
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  })
}

/** 清除会话 cookie(登出)。 */
export async function clearSession(): Promise<void> {
  const store = await cookies()
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  })
}
