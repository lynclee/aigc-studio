import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

export async function createSupabaseAuthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) return null

  const cookieStore = await cookies()
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(values) {
        for (const { name, value, options } of values) {
          cookieStore.set(name, value, options)
        }
      },
    },
  })
}

export function appOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin
    } catch {
      // Fall through to the request origin. Deployment validation will expose a bad setting.
    }
  }

  return new URL(request.url).origin
}
