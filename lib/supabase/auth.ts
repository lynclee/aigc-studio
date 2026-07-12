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
      setAll(values, _headers) {
        try {
          for (const { name, value, options } of values) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Server Components cannot write cookies. proxy.ts refreshes tokens
          // before rendering and writes the refreshed values to the response.
        }
      },
    },
  })
}

/**
 * OAuth redirects must use a stable, allowlisted production origin. Local
 * development may use the request origin; production must set NEXT_PUBLIC_SITE_URL.
 */
export function appOrigin(request: Request): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin
    } catch {
      // Fall through to the request origin. Deployment validation will expose a bad setting.
    }
  }

  const requestOrigin = new URL(request.url).origin
  return isLocalOrigin(requestOrigin) ? requestOrigin : null
}

export function requestOrigin(request: Request): string {
  return new URL(request.url).origin
}

function isLocalOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  } catch {
    return false
  }
}
