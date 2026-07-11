import { redirect } from "next/navigation"
import { getSession } from "@/lib/session"

export const dynamic = "force-dynamic"

/** 飞书图标(简化版本,内联 SVG 避免依赖) */
function LarkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 3c-1.1 2.6-3 4.9-5.4 6.6C4.4 11 2.6 11.8 1 12c2.4 1.1 4.6 2.7 6.4 4.7C9.2 18.7 10.4 21 11 23c.9-2.6 2.4-4.9 4.4-6.7 2-1.8 4.3-3 6.6-3.6-2.6-.6-5-1.9-7-3.7C13.2 7.2 12.3 5.2 12 3Z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * 登录失败错误码 → 固定中文文案。只渲染映射命中的文案,绝不回显 URL 里的任意 error 文本,
 * 避免反射飞书/异常的原始 message(信息泄露 / 反射型注入面)。
 */
const ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: "登录失败,请重试",
  state_mismatch: "登录态校验失败,请重新登录",
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
          href="/api/auth/lark/login"
          className="group flex w-full items-center justify-center gap-3 rounded-xl bg-white px-5 py-3 text-sm font-medium text-neutral-900 shadow-sm transition hover:bg-neutral-100 active:scale-[0.99]"
        >
          <LarkIcon className="h-5 w-5 text-[#00D6B9]" />
          用飞书登录
        </a>

        <p className="mt-6 text-center text-xs text-neutral-500">
          登录即代表同意通过飞书获取你的姓名与头像
        </p>
      </div>

      <p className="absolute bottom-6 text-xs text-neutral-600">
        选择图片、3D 或视频预设,填写描述后提交,云端生成结果进入你的作品库
      </p>
    </main>
  )
}
