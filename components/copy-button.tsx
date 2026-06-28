"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"

/**
 * 复制按钮:点击把 `value` 写入剪贴板,短暂显示「已复制」反馈后复位。
 * 客户端组件 —— navigator.clipboard 只在浏览器可用。
 */
export function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // 剪贴板不可用(非 https / 权限拒绝)时静默,不打断用户
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-white/[0.08] hover:text-white"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald-400" />
          已复制
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          {label}
        </>
      )}
    </button>
  )
}
