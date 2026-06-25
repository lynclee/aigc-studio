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

  if (!code) {
    return redirectHome(req, "授权被取消或未返回 code")
  }
  if (!state || !savedState || state !== savedState) {
    return redirectHome(req, "state 校验失败,请重试登录")
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
    const message = err instanceof Error ? err.message : "登录失败"
    return redirectHome(req, message)
  }
}
