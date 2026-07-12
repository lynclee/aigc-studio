import { redirect } from "next/navigation"
import { getSession } from "@/lib/session"

export const dynamic = "force-dynamic"

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49 0-.24-.01-1.04-.02-1.88-2.78.62-3.37-1.2-3.37-1.2-.46-1.2-1.11-1.51-1.11-1.51-.91-.64.07-.63.07-.63 1 .07 1.54 1.06 1.54 1.06.9 1.57 2.35 1.12 2.92.86.09-.67.35-1.12.64-1.38-2.22-.26-4.56-1.14-4.56-5.08 0-1.12.39-2.03 1.04-2.75-.1-.26-.45-1.3.1-2.71 0 0 .85-.28 2.75 1.05A9.3 9.3 0 0 1 12 7.2c.85 0 1.7.12 2.5.35 1.9-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.65.72 1.04 1.63 1.04 2.75 0 3.95-2.35 4.82-4.58 5.08.36.32.68.92.68 1.85 0 1.34-.01 2.42-.01 2.75 0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z" />
    </svg>
  )
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.72-.06-1.41-.19-2.07H12v3.92h5.38a4.6 4.6 0 0 1-2 3.02v2.55h3.24c1.9-1.79 2.98-4.43 2.98-7.42Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.91 6.62-2.35l-3.24-2.55c-.9.62-2.05.99-3.38.99-2.6 0-4.8-1.8-5.59-4.21H3.07v2.63A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.41 13.88A6.1 6.1 0 0 1 6.1 12c0-.65.11-1.28.31-1.88V7.49H3.07A10.2 10.2 0 0 0 2 12c0 1.63.39 3.17 1.07 4.51l3.34-2.63Z" />
      <path fill="#EA4335" d="M12 5.91c1.47 0 2.79.52 3.83 1.53l2.87-2.94C16.95 2.82 14.7 2 12 2a10 10 0 0 0-8.93 5.49l3.34 2.63C7.2 7.71 9.4 5.91 12 5.91Z" />
    </svg>
  )
}

/**
 * 登录失败错误码 → 固定中文文案。只渲染映射命中的文案,绝不回显 OAuth 原始 message。
 */
const ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: "登录失败,请重试",
  auth_unconfigured: "登录服务尚未配置,请联系部署同学",
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const session = await getSession()
  if (session) redirect("/portal")

  const { error } = await searchParams
  // 有 error 参数就显示固定文案;未知码回落到通用文案,不渲染原始字符串
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? "登录失败,请重试") : null

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6">
      {/* 背景光晕 */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/4 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-indigo-500/20 blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 h-[360px] w-[360px] rounded-full bg-fuchsia-500/10 blur-[120px]" />
      </div>

      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl backdrop-blur">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg">
            <span className="text-lg font-bold">A</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            AIGC Studio
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            给美术/设计同学的创作入口
          </p>
        </div>

        {errorMessage ? (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </div>
        ) : null}

        <a
          href="/api/auth/github/login"
          className="group flex w-full items-center justify-center gap-3 rounded-xl bg-white px-5 py-3 text-sm font-medium text-neutral-900 shadow-sm transition hover:bg-neutral-100 active:scale-[0.99]"
        >
          <GitHubIcon className="h-5 w-5 text-neutral-900" />
          使用 GitHub 登录
        </a>

        <a
          href="/api/auth/google/login"
          className="mt-3 flex w-full items-center justify-center gap-3 rounded-xl border border-white/15 bg-white/[0.04] px-5 py-3 text-sm font-medium text-white transition hover:bg-white/[0.08] active:scale-[0.99]"
        >
          <GoogleIcon className="h-5 w-5" />
          使用 Google / Gmail 登录
        </a>

        <p className="mt-6 text-center text-xs text-neutral-500">
          GitHub 登录优先；也可使用 Google / Gmail 登录
        </p>
      </div>

      <p className="absolute bottom-6 text-xs text-neutral-600">
        选择图片、3D 或视频预设,填写描述后提交,云端生成结果进入你的作品库
      </p>
    </main>
  )
}
