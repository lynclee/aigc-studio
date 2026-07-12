import { NextResponse } from "next/server"
import { appOrigin, createSupabaseAuthClient } from "@/lib/supabase/auth"

export async function GET(request: Request) {
  const origin = appOrigin(request)
  const code = new URL(request.url).searchParams.get("code")
  if (!code) return NextResponse.redirect(new URL("/?error=oauth_failed", origin))

  const supabase = await createSupabaseAuthClient()
  if (!supabase) return NextResponse.redirect(new URL("/?error=auth_unconfigured", origin))

  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    console.error("[auth] OAuth callback failed", { message: error.message })
    return NextResponse.redirect(new URL("/?error=oauth_failed", origin))
  }

  return NextResponse.redirect(new URL("/portal", origin))
}
