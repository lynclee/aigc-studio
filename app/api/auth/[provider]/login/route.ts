import type { Provider } from "@supabase/supabase-js"
import { NextResponse } from "next/server"
import { appOrigin, createSupabaseAuthClient, requestOrigin } from "@/lib/supabase/auth"

const SUPPORTED_PROVIDERS = new Set<Provider>(["github", "google"])

type RouteContext = { params: Promise<{ provider: string }> }

export async function GET(request: Request, context: RouteContext) {
  const { provider: rawProvider } = await context.params
  const provider = rawProvider.toLowerCase() as Provider
  const origin = appOrigin(request)
  const fallbackOrigin = requestOrigin(request)

  if (!origin) {
    return NextResponse.redirect(new URL("/?error=site_url_required", fallbackOrigin))
  }

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return NextResponse.redirect(new URL("/?error=oauth_failed", origin))
  }

  const supabase = await createSupabaseAuthClient()
  if (!supabase) {
    return NextResponse.redirect(new URL("/?error=auth_unconfigured", origin))
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: new URL("/api/auth/callback", origin).toString(),
      skipBrowserRedirect: true,
    },
  })

  if (error || !data.url) {
    console.error("[auth] OAuth start failed", { provider, message: error?.message ?? "missing redirect URL" })
    return NextResponse.redirect(new URL("/?error=oauth_failed", origin))
  }

  return NextResponse.redirect(data.url)
}
