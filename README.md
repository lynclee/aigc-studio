# AIGC Studio

给美术同学的 AIGC 配套门户:飞书登录 + 作品画廊。出图不在网页里跑,由 ComfyUI Desktop 插件 **comfyui_modal_bridge** 分发到用户自己的 Modal,本门户只负责登录、展示与管理。

## 技术栈

- [Next.js](https://nextjs.org/)（App Router）
- TypeScript
- Tailwind CSS
- [Supabase](https://supabase.com/)（数据库 + Auth）
- Cloudflare R2（对象存储,作品画廊取产物）

## 本地开发

```bash
npm install                  # 安装依赖
cp .env.example .env.local   # 复制环境变量模板并填值
npm run dev                  # 启动开发服务器(默认 http://localhost:3000)
```

常用脚本:

```bash
npm run dev        # 开发服务器
npm run build      # 生产构建
npm run start      # 启动生产服务器
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
```

## 部署

待补(P2)。

## 环境变量

完整变量清单与分组说明见 [`.env.example`](./.env.example)。本地开发时复制为 `.env.local` 并填入实际值。
