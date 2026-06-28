/**
 * upload-token —— 绑 open_id 的「长期上传凭证」,给 comfyui_modal_bridge 插件用。
 *
 * 用途:美术同学在门户(portal)登录后复制一串 upload-token 填进插件。出图时插件拿这串
 * token 调 `POST /api/gallery/upload-url` 换一张「限定到自己 open_id 前缀、短过期」的 R2
 * 预签名 PUT URL,直接把图 PUT 上 R2 —— **插件不碰 R2 凭据,open_id 由服务端从 token 推导**
 * (客户端无法伪造他人 open_id)。
 *
 * 机制:复用会话同一把 `SESSION_SECRET` 做 HMAC-SHA256。payload `{ open_id, type:"upload" }`
 * (JSON → base64url)与签名拼成 `<payload>.<sig>`。**无 exp,长期有效** —— 轮换靠换
 * `SESSION_SECRET`(换后所有旧 upload-token 一并失效,用户重登 portal 复制新的即可)。
 *
 * 注意:这是「签名信封」不是加密 —— payload 可被解读,但 HMAC 签名保证客户端无法篡改
 * (伪造 open_id / 改 type)。不要往里塞敏感密钥。与 lib/session.ts 并行实现、零新依赖。
 */

import { createHmac, timingSafeEqual } from "node:crypto"

/** upload-token 的 payload 结构。`type` 固定 "upload",用于和会话 cookie 区分,杜绝串用。 */
interface UploadTokenPayload {
  open_id: string
  type: "upload"
}

/** 读 SESSION_SECRET,缺失抛错(签名场景:无密钥无法签)。 */
function getSecret(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error("SESSION_SECRET 未配置:upload-token 无法签名")
  }
  return secret
}

/**
 * 对 `{ open_id, type:"upload" }` 签名,返回 `<payload>.<sig>` 字符串(base64url,长期有效)。
 * 只在已确认登录(有会话 → SESSION_SECRET 必然已配)的前提下调用。
 */
export function signUploadToken(openId: string): string {
  const payload: UploadTokenPayload = { open_id: openId, type: "upload" }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = createHmac("sha256", getSecret()).update(payloadB64).digest("base64url")
  return `${payloadB64}.${sig}`
}

/**
 * 验签 + 校验 `type === "upload"` 且 open_id 非空,通过返回 openId,否则返回 null。
 * 用 `timingSafeEqual` 常量时间比较签名,避免时序侧信道。
 * SESSION_SECRET 缺失 / 签名不匹配 / payload 非法 一律返回 null(= 未授权)。
 */
export function verifyUploadToken(token: string): string | null {
  const secret = process.env.SESSION_SECRET
  if (!secret) return null

  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const payloadB64 = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  if (!payloadB64 || !sigB64) return null

  try {
    const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url")
    const sigBuf = Buffer.from(sigB64)
    const expBuf = Buffer.from(expected)
    // 先比长度(不等长 timingSafeEqual 会抛),再常量时间比内容
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

    const json = Buffer.from(payloadB64, "base64url").toString("utf8")
    const parsed = JSON.parse(json) as Partial<UploadTokenPayload>
    if (parsed.type !== "upload") return null
    if (typeof parsed.open_id !== "string" || !parsed.open_id) return null
    return parsed.open_id
  } catch {
    return null
  }
}
