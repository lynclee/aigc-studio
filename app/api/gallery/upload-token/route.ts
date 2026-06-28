/**
 * GET /api/gallery/upload-token —— 签发当前登录用户的 upload-token(绑其 open_id)。
 *
 * 需登录:从会话 cookie 取 open_id,无会话 → 401。返回 `{ token }`,token 长期有效
 * (轮换靠换 SESSION_SECRET)。门户 portal 页直接 server 端 signUploadToken 展示给用户复制,
 * 这个 route 留作「用 cookie 程序化拉 token」的备用入口(与 portal 同源同会话)。
 *
 * 拿到 token 的插件用它去 `POST /api/gallery/upload-url` 换 R2 预签名 PUT URL 直传。
 */

import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { signUploadToken } from "@/lib/upload-token"

// node runtime:读 SESSION_SECRET + node:crypto HMAC
export const runtime = "nodejs"

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 })
  }
  return NextResponse.json({ token: signUploadToken(session.open_id) })
}
