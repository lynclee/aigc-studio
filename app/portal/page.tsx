import { redirect } from "next/navigation"
import { ImageIcon } from "lucide-react"
import { getSession } from "@/lib/session"
import { LogoutButton } from "@/components/logout-button"

export const dynamic = "force-dynamic"

export default async function PortalPage() {
  // 页面内 getSession 守卫:未登录跳首页
  const session = await getSession()
  if (!session) redirect("/")

  const initial = (session.name || "?").trim().charAt(0).toUpperCase()

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
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            作品画廊
          </h1>
          <p className="mt-1.5 text-sm text-neutral-400">
            你在 ComfyUI Desktop 插件里出的图会汇聚到这里
          </p>
        </div>

        {/* 占位:作品画廊区块 —— 产物接入方式待定(P1 后确认) */}
        <section className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-12">
          <div className="flex flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/[0.04] text-neutral-500">
              <ImageIcon className="h-7 w-7" />
            </div>
            <h2 className="text-base font-medium text-neutral-200">
              画廊即将上线
            </h2>
            <p className="mt-2 max-w-md text-sm text-neutral-500">
              产物接入方式待定(P1 后确认):作品来源可能为 Cloudflare R2
              对象存储,或经 comfyui_modal_bridge 回传。此区块为占位。
            </p>
          </div>

          {/* 占位骨架卡片网格,先把版式撑出来 */}
          <div className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="aspect-square animate-pulse rounded-xl border border-white/5 bg-white/[0.03]"
              />
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
