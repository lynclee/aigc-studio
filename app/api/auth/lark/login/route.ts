/**
 * GET /api/auth/lark/login
 * 生成随机 state(存 HttpOnly cookie 防 CSRF)→ 302 跳飞书授权页。
 * 回跳时 callback 会比对 cookie 里的 state。
 */

import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { buildAuthorizeUrl } from "@/lib/lark/oauth"

export const dynamic = "force-dynamic"

export const OAUTH_STATE_COOKIE = "lark_oauth_state"

export async function GET() {
  // 随机 state:32 bytes hex
  const stateBytes = new Uint8Array(32)
  crypto.getRandomValues(stateBytes)
  const state = Array.from(stateBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  const store = await cookies()
  store.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10, // 10 分钟够走完一次授权
  })

  return NextResponse.redirect(buildAuthorizeUrl(state))
}
