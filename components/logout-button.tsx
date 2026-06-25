"use client"

import { LogOut } from "lucide-react"

/**
 * 登出按钮:用一个隐藏的 form POST 到 /api/auth/logout(route 内 clearSession + 302 回首页)。
 * 用原生 form 提交而非 fetch —— 这样浏览器会直接跟随 302 跳转,无需手动 router.push。
 */
export function LogoutButton() {
  return (
    <form action="/api/auth/logout" method="post">
      <button
        type="submit"
        className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-neutral-300 transition hover:bg-white/[0.07] hover:text-white"
      >
        <LogOut className="h-4 w-4" />
        登出
      </button>
    </form>
  )
}
