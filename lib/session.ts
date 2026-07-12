import type { User } from "@supabase/supabase-js"
import { createSupabaseAuthClient } from "@/lib/supabase/auth"

export interface SessionPayload {
  userId: string
  name: string
  avatar: string
  provider: "github" | "google" | "unknown"
}

/**
 * 当前登录态来自 Supabase Auth 的 HttpOnly cookie。服务端每次通过 getUser()
 * 验证用户，不接受浏览器传入的 user_id 作为所有权依据。
 */
export async function getSession(): Promise<SessionPayload | null> {
  const client = await createSupabaseAuthClient()
  if (!client) return null

  const { data, error } = await client.auth.getUser()
  if (error || !data.user) return null
  return sessionFromUser(data.user)
}

export async function clearSession(): Promise<void> {
  const client = await createSupabaseAuthClient()
  if (!client) return
  await client.auth.signOut({ scope: "local" })
}

function sessionFromUser(user: User): SessionPayload {
  const metadata = user.user_metadata ?? {}
  const appMetadata = user.app_metadata ?? {}
  const provider = appMetadata.provider === "github" || appMetadata.provider === "google"
    ? appMetadata.provider
    : "unknown"

  return {
    userId: user.id,
    name: firstString(metadata.full_name, metadata.name, metadata.user_name, user.email?.split("@")[0]) ?? "创作同学",
    avatar: firstString(metadata.avatar_url, metadata.picture) ?? "",
    provider,
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
