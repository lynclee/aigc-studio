import { redirect } from "next/navigation"
import { ImageIcon, Sparkles } from "lucide-react"
import { getSession } from "@/lib/session"
import { LogoutButton } from "@/components/logout-button"
import { getSupabaseAdmin } from "@/lib/supabase/admin"
import { getR2Env, signGetUrl } from "@/lib/r2"

export const dynamic = "force-dynamic"

/** 一条画廊作品(已签好预签名 URL)。 */
interface GalleryCard {
  id: string
  url: string | null
  prompt: string | null
  createdAt: string
}

/** 简单相对时间(中文),给画廊卡片角标用。 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return "刚刚"
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month} 个月前`
  return `${Math.floor(month / 12)} 年前`
}

/**
 * 读取当前登录用户的画廊数据。
 * 返回 `null` 表示「env 未配置」(R2 或 Supabase 缺失)→ 渲染待配置态;
 * 返回数组(可能为空)表示已配置,正常读取。
 */
async function loadGallery(openId: string): Promise<GalleryCard[] | null> {
  const admin = getSupabaseAdmin()
  const r2 = getR2Env()
  // 任一未配置都视为「画廊待配置」
  if (!admin || !r2) return null

  const { data, error } = await admin
    .from("gallery_items")
    .select("id, r2_key, prompt, created_at")
    .eq("user_open_id", openId)
    .order("created_at", { ascending: false })
    .limit(60)

  // 查询出错(表不存在 / 网络等)按空画廊处理,不让页面崩;但先打日志,别静默吞
  if (error || !data) {
    if (error) console.error("[gallery] query failed:", error)
    return []
  }

  // 并行对每条 r2_key 签预签名 URL
  return Promise.all(
    data.map(async (row) => ({
      id: row.id as string,
      url: await signGetUrl(row.r2_key as string),
      prompt: (row.prompt as string | null) ?? null,
      createdAt: (row.created_at as string) ?? "",
    })),
  )
}

export default async function PortalPage() {
  // 页面内 getSession 守卫:未登录跳首页
  const session = await getSession()
  if (!session) redirect("/")

  const initial = (session.name || "?").trim().charAt(0).toUpperCase()
  const cards = await loadGallery(session.open_id)

  return (
    <div className="min-h-screen bg-neutral-950">
      {/* 顶栏 */}
      <header className="sticky top-0 z-10 border-b border-white/10 bg-neutral-950/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-sm font-bold text-white">
              A
            </div>
            <span className="text-sm font-semibold tracking-tight text-white">
              AIGC Studio
            </span>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              {session.avatar ? (
                // 飞书头像为外链,next.config 已 images.unoptimized,直接用 <img>
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.avatar}
                  alt={session.name}
                  className="h-8 w-8 rounded-full border border-white/10 object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/30 text-sm font-medium text-indigo-200">
                  {initial}
                </div>
              )}
              <span className="hidden text-sm text-neutral-200 sm:inline">
                {session.name || "飞书用户"}
              </span>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>

      {/* 主区 */}
      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white">
              作品画廊
            </h1>
            <p className="mt-1.5 text-sm text-neutral-400">
              你在 ComfyUI 里用 Modal Bridge 出的图会汇聚到这里
            </p>
          </div>
          {cards && cards.length > 0 && (
            <span className="hidden text-sm text-neutral-500 sm:inline">
              共 {cards.length} 件作品
            </span>
          )}
        </div>

        {cards === null ? (
          <UnconfiguredState />
        ) : cards.length === 0 ? (
          <EmptyState />
        ) : (
          <GalleryGrid cards={cards} />
        )}
      </main>
    </div>
  )
}

/** 响应式作品网格。 */
function GalleryGrid({ cards }: { cards: GalleryCard[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {cards.map((card) => (
        <figure
          key={card.id}
          className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] transition hover:border-white/20"
        >
          <div className="aspect-square w-full overflow-hidden bg-white/[0.03]">
            {card.url ? (
              // R2 预签名 URL 为外链,next.config 已 images.unoptimized,直接用 <img>
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={card.url}
                alt={card.prompt ?? "作品"}
                loading="lazy"
                className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-neutral-600">
                <ImageIcon className="h-7 w-7" />
              </div>
            )}
          </div>

          {/* 底部渐变信息条:prompt 截断 + 相对时间 */}
          <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-8">
            {card.prompt && (
              <p className="line-clamp-2 text-xs leading-snug text-neutral-200">
                {card.prompt}
              </p>
            )}
            <p className="mt-1 text-[11px] text-neutral-400">
              {relativeTime(card.createdAt)}
            </p>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

/** 空态:已配置但还没作品。 */
function EmptyState() {
  return (
    <section className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-12">
      <div className="flex flex-col items-center justify-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-neutral-500">
          <Sparkles className="h-7 w-7" />
        </div>
        <h2 className="text-base font-medium text-neutral-200">还没有作品</h2>
        <p className="mt-2 max-w-md text-sm text-neutral-500">
          在 ComfyUI 里用 Modal Bridge 出图,带上门户的{" "}
          <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[12px] text-neutral-300">
            BRIDGE_API_KEY
          </code>{" "}
          回写,作品会自动出现在这里。
        </p>
      </div>
    </section>
  )
}

/** env 未配置态:R2 或 Supabase 缺失。 */
function UnconfiguredState() {
  return (
    <section className="rounded-2xl border border-dashed border-amber-400/20 bg-amber-400/[0.03] p-12">
      <div className="flex flex-col items-center justify-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-400/[0.08] text-amber-300/80">
          <ImageIcon className="h-7 w-7" />
        </div>
        <h2 className="text-base font-medium text-neutral-200">画廊待配置</h2>
        <p className="mt-2 max-w-md text-sm text-neutral-500">
          需要配置 Cloudflare R2(对象存储)与 Supabase(作品索引)的环境变量后,
          画廊才能读取并展示作品。
        </p>
      </div>
    </section>
  )
}
