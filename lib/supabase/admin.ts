/**
 * Supabase service_role 客户端(仅服务端)。
 *
 * 本项目不用 Supabase Auth —— 用飞书 OAuth + 自管 cookie session(见 lib/session.ts)。
 * 因此一律用 service_role 在服务端访问 Supabase,不依赖 RLS auth.uid()。
 * AIGC 读写经 route handler 按 user_open_id 做 owner guard。
 * 旧 gallery_items 表开了 RLS 但零 policy,只有 service_role(绕过 RLS)能读写。
 *
 * ⚠️ env 缺失返回 null(不抛),调用方据此降级到「作品库待配置」,避免 build / 占位 env 崩。
 * ⚠️ service_role key 拥有完全权限,**只能在服务端**(server component / route handler)
 *    import,绝不可泄露到客户端 bundle。
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let cachedAdmin: SupabaseClient | null = null

/** 懒构建并缓存 service_role 客户端;env 缺失返回 null。 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (cachedAdmin) return cachedAdmin

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return null

  cachedAdmin = createClient(url, serviceRoleKey, {
    auth: {
      // 服务端无浏览器会话,关掉自动刷新 / 持久化
      autoRefreshToken: false,
      persistSession: false,
    },
  })
  return cachedAdmin
}
