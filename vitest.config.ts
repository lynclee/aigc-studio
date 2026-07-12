import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// 解析 `@/` 路径别名(与 tsconfig paths 一致),让测试能 import "@/lib/...".
const root = fileURLToPath(new URL("./", import.meta.url)).replace(/\/$/, "")

export default defineConfig({
  resolve: { alias: { "@": root } },
  test: { environment: "node", include: ["lib/**/*.test.ts", "app/**/*.test.ts"] },
})
