/**
 * POST /api/auth/logout
 * 清会话 cookie → 302 回首页。
 */

import { NextResponse, type NextRequest } from "next/server"
import { clearSession } from "@/lib/session"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  await clearSession()
  return NextResponse.redirect(new URL("/", req.url))
}
