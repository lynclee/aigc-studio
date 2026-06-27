/**
 * GET /api/auth/lark/callback?code=&state=
 * 校验 state(防 CSRF)→ code 换 user_access_token → 拿 userinfo → setSession → 302 回门户。
 * 任何失败:清 state cookie,302 回首页带 ?error= 提示。
 */

import { NextResponse, type NextRequest } from "next/server"
import { cookies } from "next/headers"
import { exchangeCodeForToken, fetchUserInfo } from "@/lib/lark/oauth"
import { setSession } from "@/lib/session"
import { OAUTH_STATE_COOKIE } from "../login/route"

export const dynamic = "force-dynamic"

function redirectHome(req: NextRequest, error?: string) {
  const url = new URL("/", req.url)
  if (error) url.searchParams.set("error", error)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get("code")
  const state = searchParams.get("state")

  const store = await cookies()
  const savedState = store.get(OAUTH_STATE_COOKIE)?.value
  // 用完即清,无论成功失败
  store.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 })

  // 失败一律回有限错误码(不把飞书/异常的原始 message 反射进 URL),真实细节进 server log
  if (!code) {
    console.error("[lark] callback missing code")
    return redirectHome(req, "oauth_failed")
  }
  if (!state || !savedState || state !== savedState) {
    console.error("[lark] callback state mismatch")
    return redirectHome(req, "state_mismatch")
  }

  try {
    const token = await exchangeCodeForToken(code)
    const user = await fetchUserInfo(token)
    await setSession({
      open_id: user.open_id,
      name: user.name,
      avatar: user.avatar_url,
    })
    return NextResponse.redirect(new URL("/portal", req.url))
  } catch (err) {
    console.error("[lark] oauth callback failed:", err)
    return redirectHome(req, "oauth_failed")
  }
}
