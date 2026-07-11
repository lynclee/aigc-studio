# AIGC Studio：本次改动与交叉验证交接说明

> 用途：把这份文件交给 Claude、GLM 或其他代码审查者，作为本轮改造的共同事实来源。先读本文件，再读 docs/HANDOFF.md 和相关源码；不要根据旧的“上传口令 / 手动上传作品”说明继续开发。
>
> 项目目录：/workspace/v0_banana/aigc-studio
>
> 参考工程：/workspace/v0_banana/v0-nano-banana-pro-playground
>
> 记录日期：2026-07-11
>
> 飞书部署手册：[从零上线一个自己的 AIGC 作品网站：给设计师和美术同学的部署手册](https://my.feishu.cn/docx/X9JddcFVpoLuOxxJAHCcqiClnSe)（本轮更新后为 revision 127）

---

## 1. 一句话结论

本工程已从“飞书登录后查看个人作品、由后台插件手工上传”的小型作品库，改为一个简化的 AIGC 创作网站：

    飞书登录
      → 图片 / 3D / 视频三张入口卡片
      → 选择预设工作流、填写 prompt
      → 云端服务后台生成
      → 网站与 Vercel 定时任务持续检查状态
      → 结果存到私有 R2
      → 用户在个人作品库查看、下载

它借鉴参考工程的工作流注册、provider 分发、任务状态、jobs / generations / assets 数据结构、结果落 R2 等主干；但刻意没有复制复杂工作台、积分系统、复杂侧栏和实验性功能。

## 2. 本轮已经冻结的产品决定

后续不要未经讨论改回这些决定：

1. 普通设计 / 美术用户只使用网站。他们不需要安装、打开或理解 ComfyUI，也看不到服务商、密钥、上传口令、target_open_id。
2. 前台只有三类入口：图片、3D、视频。每类只展示少量易懂的工作流名称；不是让用户挑模型、挑服务商的复杂控制台。
3. 用户看到的结果名称统一为“个人作品库”，不用“画廊”。
4. 图片服务由部署者配置为 Modal、OpenRouter、fal.ai 或自建 ComfyUI。这是 Vercel 环境变量中的后台选择，不是前台功能；推荐展示顺序是 Modal → OpenRouter → fal → ComfyUI。
5. 3D 和视频当前固定走 fal.ai；图片服务的选择不改变它们。
6. 不做站内积分、余额、扣费、退款或 credits 表。ComfyUI 的付费节点从部署者自己的 ComfyUI 账号扣 API 积分；这是外部服务费用，不是网站自己的计费功能。
7. 旧上传口令主流程已移除。普通用户提交 prompt 创建任务；不再依赖运营人员填写 target_open_id 把文件塞给某个用户。

## 3. 改造前后：本工程自身的变化

| 方面 | 改造前 | 现在 |
| --- | --- | --- |
| 用户体验 | 飞书登录后主要是看已有作品 | 登录后可直接提交图片、3D、视频任务，并查看状态和结果 |
| 主数据 | gallery_items：一条上传文件记录 | aigc_jobs、aigc_generations、aigc_assets 三层记录 |
| 作品如何进入库 | 后台插件使用 upload-token 上传，并可传 target_open_id 指定归属 | 用户提交任务后，以登录态 open_id 写入任务；完成后自动落 R2 和个人作品库 |
| 图片生成 | 没有站内提交主流程 | 部署者可选 Modal / OpenRouter / fal / 自建 ComfyUI |
| 3D、视频 | 没有第一类产品入口 | 均有入口、任务记录、状态检查和个人作品库结果 |
| 状态检查 | 无统一任务生命周期 | 提交后立即检查；前台刷新时检查；Vercel Cron 每天一次兜底检查未完成任务 |
| 文件保存 | R2 主要承接手工上传 | provider 结果必须先保存到私有 R2，才会被视为完成作品 |
| 面向美术的语言 | 有插件、上传口令等后台概念 | 只说工作流、提示词、云端后台生成、个人作品库 |

### 3.1 已删除或退出主流程的旧内容

- 删除 app/api/gallery/upload-token/route.ts
- 删除 app/api/gallery/upload-url/route.ts
- 删除 lib/upload-token.ts
- gallery_items 只保留为历史兼容数据，不是新功能主数据。
- README、CLAUDE、HANDOFF、env 示例不再把上传口令和 target_open_id 写成正式交付方式。

如果团队仍有“把外部文件人工分配给指定人”的真实需求，应另做一个受后台管理员权限保护的内部入口，并记录审计；不要恢复长期上传口令给普通用户。

## 4. 与 v0-nano-banana-pro-playground 的关键差别

参考工程不是被原样迁移，而是只抽取了适合本项目的骨架。

| 维度 | 参考 Playground | 当前 AIGC Studio | 本次取舍 |
| --- | --- | --- | --- |
| 产品定位 | 面向探索和实验的完整 Playground | 面向设计 / 美术团队的简单创作入口和作品交付 | 降低上手成本 |
| 页面结构 | 图片、编辑器、3D、视频、Explore、资产页和复杂 shell | 单一 /portal 工作台：三张入口卡片 + 任务 + 个人作品库 | 不复制复杂 UI 外壳 |
| 前端控制 | 细节面板、上传、编辑、历史轨道、观察器等 | 工作流选择、prompt、提交、刷新、查看结果 | 用户不需要工程控制台 |
| 引擎 | RunPod / Modal / fal / OpenRouter，含 fallback 思路 | 图片是 Modal / OpenRouter / fal / 自建 ComfyUI；3D/视频是 fal | RunPod 不在当前方案中 |
| 数据 | jobs 有 cost、incognito、取消意图；generation kernel 有 credit policy | 精简为 jobs / generations / assets，无成本和积分字段 | 本期不做商业收费 |
| ComfyUI | 参考的 Modal worker 已使用 extra_data.api_key_comfy_org | 本项目直接调用自建 ComfyUI HTTP API，并采用相同付费节点密钥方式 | 满足 GPT Image 等节点，不依赖 Comfy Cloud |

明确没有照搬：站内积分账本、复杂侧栏和编辑器、RunPod、自动 provider fallback、任意 workflow 输入、普通用户上传或操作 ComfyUI。这些不是遗漏，是当前版本边界。

## 5. 当前架构

~~~mermaid
flowchart TD
  U[设计 / 美术用户] -->|飞书登录| P[/portal 创作工作台]
  P -->|选择类别、工作流、输入 prompt| G[生成 API]
  G -->|图片：按部署环境选择| I{图片服务}
  G -->|3D| F3[fal 3D]
  G -->|视频| FV[fal 视频]
  I --> M[Modal]
  I --> OR[OpenRouter]
  I --> FF[fal]
  I --> CU[自建 ComfyUI]
  M --> J[(aigc_jobs)]
  FF --> J
  OR --> J
  CU --> J
  F3 --> J
  FV --> J
  J --> R[提交后 / 前台刷新 / Vercel Cron 检查]
  R --> S[接收生成结果]
  S --> R2[(私有 Cloudflare R2)]
  R2 --> DB[(aigc_generations + aigc_assets)]
  DB --> L[个人作品库]
  L --> U
~~~

### 5.1 任务生命周期

统一状态：queued（排队中）、running（生成中）、succeeded（完成）、failed（失败）、cancelled（已取消）。

1. 生成 API 先验证飞书会话、prompt 和工作流白名单，再创建 aigc_jobs。
2. 服务端提交给 provider，并保存 provider、provider_job_id 和 provider 返回信息。
3. 提交后会立刻执行一次 reconcile；前台读 /api/jobs 时也会检查自己的任务。
4. vercel.json 配置 /api/jobs/reconcile 每天 `03:30` 执行一次（`30 3 * * *`，适配 Vercel Hobby）。页面打开时的任务查询仍会即时检查；Cron 只负责用户离开页面后的兜底。它要求 Authorization: Bearer 加 CRON_SECRET，一次最多处理 50 个未完成任务。
5. 任务会被认领并获得 5 分钟 lease，避免多个前台请求和 Cron 重复检查同一任务。
6. provider 成功后，必须先把文件写入 R2，再创建 generation 和 asset；R2 失败则任务失败，不能把临时 provider URL 当正式作品。

### 5.2 为什么 jobs 必须保存 provider

lib/jobs/providers.ts 在提交新任务时读取 AIGC_IMAGE_PROVIDER；但检查和取消旧任务时，按数据库 aigc_jobs.provider 分发，而不是重新读取当前环境变量。

所以部署者把图片服务从 A 切到 B 后，已经提交给 A 的任务仍能继续检查。切换时必须保留旧服务地址和密钥，直到旧任务全部结束；provider 字段不保存密钥本身。

## 6. Provider 现状

| 用户类别 | 当前 provider | 关键配置 | 结果处理 | 取消 |
| --- | --- | --- | --- | --- |
| 图片 | modal-image | MODAL_ENDPOINT_BASE、MODAL_KEY、MODAL_SECRET | 下载 URL 后写入 R2 | 支持真实服务端取消 |
| 图片 | openrouter-image | OPENROUTER_API_KEY、OPENROUTER_IMAGE_MODEL | 同步拿图片字节，直接写 R2 | 不支持 |
| 图片 | fal-image | FAL_KEY、FAL_IMAGE_ENDPOINT；标准/细节可覆盖 | 下载 URL 后写入 R2 | 不支持 |
| 图片 | comfyui-image | COMFYUI_BASE_URL；收费节点另加 COMFY_ORG_API_KEY | 从 /view 下载图片字节，直接写 R2 | 不支持，避免影响同机其他队列 |
| 3D | fal-model3d | FAL_KEY，可用 FAL_MODEL3D_*_ENDPOINT 覆盖 | 下载 URL 后写 R2 | 不支持 |
| 视频 | fal-video | FAL_KEY，可用 FAL_VIDEO_ENDPOINT 覆盖 | 下载 URL 后写 R2 | 不支持 |

图片选择由部署端设置：

    AIGC_IMAGE_PROVIDER=modal
    可选值：modal、openrouter、fal、comfyui

前台不会出现 provider 下拉框。用户永远只看到“标准出图”“细节增强”。这些标签传给服务端工作流注册表，provider 只在部署层决定。推荐顺序是 Modal → OpenRouter → fal → ComfyUI，不是自动 fallback；部署者在 Vercel 修改唯一的 AIGC_IMAGE_PROVIDER 变量并重新部署，即可快速切换图片服务。

### 6.1 fal endpoint 的重要限制

fal endpoint 可以配置，但不同 fal 模型接受的字段、输出格式和等待方式可能不同。当前 adapter 用本项目已有的通用请求格式，不能据此认定“任何 fal endpoint 都兼容”。上线前必须对计划使用的真实 endpoint 跑一次提交、轮询、R2 入库测试；不兼容时应新增专属 adapter 或明确契约。

## 7. ComfyUI 付费节点：本轮最容易被误解的内容

### 7.1 正确的业务含义

这里不是 Comfy Cloud，也不是让普通用户调用 ComfyUI。

正确场景是：

1. 部署者拥有自己管理的云端 ComfyUI 服务。
2. 部署者在该服务中搭好工作流；它可以含 GPT Image 等收费 API 节点。
3. 从 ComfyUI 导出这条工作流的 API 格式 JSON。
4. AIGC Studio 把用户 prompt 填入 JSON 后，提交给自建 ComfyUI。
5. 只要 workflow 有收费节点，ComfyUI 需要部署者账号的 COMFY_ORG_API_KEY；节点会从该账号 API 积分扣费。

网站没有扣用户积分逻辑，不保存或展示账号余额。

### 7.2 当前代码请求契约

核心文件：lib/engines/comfyui-image.ts。

提交实际使用：

    POST <COMFYUI_BASE_URL>/prompt
    Content-Type: application/json

    {
      "prompt": { "...": "导出的 API workflow JSON" },
      "client_id": "随机 UUID",
      "extra_data": {
        "api_key_comfy_org": "COMFY_ORG_API_KEY"
      }
    }

- 只有设置 COMFY_ORG_API_KEY 时才会有 extra_data。
- 状态查询是 GET /history/<prompt_id>。
- 文件下载是 GET /view?filename=...&subfolder=...&type=...。
- 没有 COMFYUI_API_MODE，没有 COMFYUI_API_KEY，没有 Comfy Cloud URL，也没有 X-API-Key 请求头。
- 密钥只从 Vercel 服务端环境变量读取；不会进入浏览器、public API response 或跳转后的文件下载请求。

实现参考参考工程 modal/art_ai/_comfy_ws.py 的同类写法，也对齐 ComfyUI 的 [server routes](https://docs.comfy.org/development/comfyui-server/comms_routes) 与 [API key integration](https://docs.comfy.org/development/comfyui-server/api-key-integration)。

### 7.3 当前模板不是 GPT Image

当前模板文件：

- lib/workflows/templates/z_image_turbo.json
- lib/workflows/templates/flux2_klein.json

它们分别使用 Z-Image / FLUX 本地节点，不含 GPT Image 节点。因此要特别区分：

> ComfyUI adapter 已能把付费节点所需的账号密钥正确提交出去；但在拿到真正的 GPT Image API workflow JSON 前，网站不会凭空生成 GPT Image。

这不是缺少 key，而是缺少真正的 workflow 内容。

### 7.4 后续接入一条 GPT Image workflow 的正确步骤

1. 在目标 ComfyUI 版本中安装并确认 GPT Image 节点可运行。
2. 导出该服务实际可用的 API 格式 JSON；不要手写或猜节点 ID、节点字段。
3. 在 lib/workflows/templates/ 新增模板。当前渲染器要求最终结构有 input.workflow 这一层；导入裸 JSON 时按现有模板包装。
4. 在 lib/workflows/image-registry.ts 注册工作流 ID 与前台别名，并决定替换 standard、替换 detail，还是新增一个经过产品批准的选项。
5. 保持 image-registry、lib/jobs/input.ts 的白名单、组件工作流选项三处一致。
6. 测试 /prompt body 有 extra_data.api_key_comfy_org，但日志、数据库 provider_response、浏览器 response 中没有明文 key。
7. 确认 /history、/view、R2 写入和个人作品库完整成功。

不应做：把 key 写进 workflow JSON、做成浏览器环境变量、让用户填 key、误用 Comfy Cloud URL 或 X-API-Key header。

## 8. 数据模型、存储与所有权

迁移文件：supabase/migrations/0002_aigc_jobs_generations_assets.sql。

| 表 | 用途 | 关键点 |
| --- | --- | --- |
| aigc_jobs | 一次提交和 provider 状态 | user_open_id、kind、workflow_id、provider、provider_job_id、request、provider_response、lease |
| aigc_generations | 成功任务对应的一次结果 | job_id 唯一；记录 prompt、工作流、provider |
| aigc_assets | 一次结果中的实际文件 | R2 key、资产类型、顺序、文件类型和元数据 |

所有权与存储规则：

- 所有用户接口从签名飞书会话取得 open_id；客户端不能指定“作品属于谁”。
- service role 只在服务端 route handler 使用；浏览器不通过 Supabase anon key 直连。
- 查询、取消、作品库都带 user_open_id 过滤。
- migration 开启 RLS，但不创建 anon/authenticated 的直接访问 policy；安全边界在服务端会话校验和所有权过滤。
- 单用户限制：最多 3 个 queued/running 任务，60 秒最多 10 次提交。现在是查询计数，极端并发下仍应评估数据库级原子限流。
- Modal / fal 外部 URL 会经过 HTTPS、host allowlist、禁止 URL 凭据、DNS 拒绝内网、大小和媒体类型检查后流式写 R2。
- OpenRouter 与 ComfyUI 图片走直接字节写 R2，目前只接受 png/jpeg/webp/gif，最大 25 MB。
- R2 没有保存成功时，任务不可标记成功。

## 9. 前端与 API

### 9.1 前端

主要文件：components/portal-workbench.tsx、app/portal/page.tsx。

- 三张入口卡片：图片、3D、视频。
- 工作流文案：图片为“标准出图”“细节增强”；3D 为“标准模型”“游戏资产”；视频为“标准视频”。
- 每类输入 prompt；长度 1–4000。
- 任务状态显示为排队中、生成中、已完成、失败、已取消。
- 前端使用 /api/jobs 和 /api/library；活动任务定时查询单任务状态，完成后刷新作品库。
- 作品库展示图片、视频和 3D 下载入口；不展示 provider、密钥或 ComfyUI。

### 9.2 新 API

| 路由 | 用途 |
| --- | --- |
| POST /api/generate/image | 创建图片任务，provider 由部署配置决定 |
| POST /api/generate/model3d | 创建 fal 3D 任务 |
| POST /api/generate/video | 创建 fal 视频任务 |
| GET /api/jobs | 读取当前用户任务并尝试同步状态 |
| GET /api/jobs/:id | 读取当前用户一条任务 |
| POST /api/jobs/:id 与 /api/jobs/:id/cancel | 取消当前用户任务 |
| GET /api/jobs/reconcile | Vercel Cron 使用，要求 Bearer CRON_SECRET |
| GET /api/library | 返回当前用户个人作品库与 R2 签名 URL |

图片 route 设置了较长 maxDuration，以兼容 OpenRouter 同步返回图片。其余 provider 主要按异步任务处理。

## 10. 配置与部署

主要更新：.env.example、scripts/setup-env.sh、scripts/setup-r2-cors.mjs、vercel.json。

通用必填配置：

    LARK_APP_ID
    LARK_APP_SECRET
    LARK_REDIRECT_URI
    SESSION_SECRET
    CRON_SECRET
    NEXT_PUBLIC_SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    R2_ACCOUNT_ID
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET
    AIGC_IMAGE_PROVIDER
    FAL_KEY                  # 当前 3D、视频一定需要

按图片 provider 追加：

- Modal：MODAL_ENDPOINT_BASE、MODAL_KEY、MODAL_SECRET
- fal：FAL_IMAGE_ENDPOINT，可加标准 / 细节 endpoint 覆盖
- OpenRouter：OPENROUTER_API_KEY、OPENROUTER_IMAGE_MODEL
- 自建 ComfyUI：COMFYUI_BASE_URL；有收费节点再加 COMFY_ORG_API_KEY

部署前必须：

1. 执行 Supabase migration 0002_aigc_jobs_generations_assets.sql。
2. 在 Vercel 填实际变量；不要上传 .env.local 或 ~/.modal.toml。
3. 确认 R2 私有 bucket、CORS、服务端凭据可用。
4. 确认自建 ComfyUI 能被 Vercel 安全访问；Vercel 无法访问某个人本机或私有内网的 localhost / 内网地址。
5. 配好飞书 OAuth 回调地址。
6. 确认 Cron 读取 CRON_SECRET。
7. 对图片、3D、视频各跑至少一条真实完整链路。

## 11. 文档工作

仓库文档已更新：

- README.md：部署变量、provider 选择、切换提醒、ComfyUI 付费节点。
- .env.example：变量和密钥边界。
- CLAUDE.md：稳定架构、路由、数据、安全不变量。
- docs/HANDOFF.md：更细的文件索引和交接说明。

飞书部署手册仍保留两类读者：

- 部署 / 运营同学：GitHub、Vercel、飞书 OAuth、Supabase、R2、云端服务、变量和检查。
- 设计 / 美术使用同学：登录、选图片 / 3D / 视频入口、写 prompt、等云端生成、在个人作品库查看和下载。

手册明确普通用户不用操作 ComfyUI，使用“云端服务器在后台生成”这一说法，并保留图示 / 截图插入位置。本轮特别修正：COMFY_ORG_API_KEY 是部署者账号里有 API 积分的密钥；收费节点从该账号扣费；服务端把它写入 extra_data.api_key_comfy_org，浏览器拿不到。

## 12. 验证结果和验证边界

### 12.1 已完成

- npm run typecheck：通过。
- npm run build：在最终代码调整后通过；其后只改动了文档。
- git diff --check：通过。
- bash -n scripts/setup-env.sh、node --check scripts/setup-r2-cors.mjs：通过。
- provider 配置分发、旧任务按数据库 provider 检查、fal endpoint 覆盖、OpenRouter 请求/R2 落库、ComfyUI body 都做过本地 mock smoke check。
- ComfyUI mock 的关键断言：请求自建服务 /prompt；body 有 extra_data.api_key_comfy_org；无 X-API-Key header；后续路径是 /history/:id 和 /view。

### 12.2 尚未由本地 mock 证明

- 没有使用真实生产密钥对 Modal、fal、OpenRouter、ComfyUI 做端到端生成。
- 没有真实 GPT Image API workflow JSON，因此未证明内置两条模板会产生 GPT Image。
- 未在最终 Vercel 域名、真实 Supabase、真实 R2、真实飞书 OAuth 上完成上线演练。
- 临时 smoke check 尚未整理成仓库内可持续运行的回归测试。

所以不要把“构建通过”误读为“已商业上线”。真实部署和 provider E2E 仍是必须完成的下一阶段。

## 13. 推荐 Claude / GLM 的交叉验证分工

两边先独立审查，再比对结论。任何编辑都应小范围、可回滚、不写入真实密钥、不删除已有未提交改动。

### A. Claude：运行路径与产品一致性

1. 从 /portal 开始确认三张卡片调用正确 API，前台没有 provider、密钥、上传口令。
2. 跟踪 handleGeneratePost → providers.ts → provider adapter，确认 submit/status/failure/cancel 不会混淆 kind。
3. 审核 reconcile.ts 与 store.ts：只有 R2 成功后才完成任务；lease 能避免重复写 generation / asset。
4. 审核 jobs、library 和 cancel route 的 open_id 所有权过滤。
5. 检查桌面、窄屏、超长 prompt、失败状态、视频和 3D 无结果时的显示。
6. 对最终选定的 fal endpoint 确认真实字段契约；不兼容时做专属 adapter。

### B. GLM：安全、部署和 ComfyUI

1. 全仓搜索下列错误或过期概念：

    rg -n 'COMFYUI_API_KEY|COMFYUI_API_MODE|X-API-Key|Comfy Cloud|upload-token|target_open_id'

2. 审核 comfyui-image.ts：COMFY_ORG_API_KEY 只能进入 /prompt body 的 extra_data.api_key_comfy_org；不能写日志、写 public response 或进入浏览器。
3. 审核 COMFYUI_BASE_URL 的 HTTPS、反向代理和访问控制；不要为了让 Vercel 可访问而公开服务器或 key。
4. 审核 r2-store.ts 的 allowlist、DNS 内网拦截、文件大小限制、媒体类型和重定向。
5. 审核变量文档与 setup-env.sh 分支一致；脚本不可回显密钥、写入 git 或移除代理环境。
6. 审核 migration 可重复执行，且 service role / R2 凭据不会进客户端 bundle。

### C. 共同执行的验收

    npm run typecheck
    npm run build
    git diff --check
    bash -n scripts/setup-env.sh
    node --check scripts/setup-r2-cors.mjs

随后在测试环境：

1. 执行 migration。
2. 配置飞书、R2、Cron 和一个图片 provider。
3. 用两个不同飞书账号各提交任务，确认互相看不到作品。
4. 图片、3D、视频各提交一条，检查状态变化。
5. 确认成功结果在 R2，且只由归属用户的 /api/library 返回。
6. 切换图片 provider 前保留旧变量，确认旧任务仍能检查完成。
7. 用带收费节点的 ComfyUI workflow 确认账号积分被消耗，并用浏览器网络面板确认 key 不泄露。

## 14. 已知风险与后续决定

| 事项 | 当前事实 | 推荐动作 |
| --- | --- | --- |
| GPT Image workflow | adapter 已正确传密钥，内置模板不是 GPT Image | 提供真实导出的 API JSON，再决定替换 standard、detail 或新增产品入口 |
| provider E2E | 尚无生产调用验证 | 每个准备上线的 provider 都跑真实任务、状态检查、R2 入库 |
| fal 模型差异 | endpoint 可配置，不等于 payload 兼容 | 选定模型后加契约测试 / 专属 adapter |
| 并发限流 | 现在是查询计数，极端并发可能越过阈值 | 用户量变大前改数据库原子限流/RPC |
| ComfyUI 网络 | Vercel 要能访问自建服务 | 使用受控 HTTPS 域名或安全网关；不可填内网/localhost |
| ComfyUI 取消 | 当前不支持，以免 interrupt 影响同机任务 | 若需要，先设计每任务隔离或安全队列取消 |
| 旧人工导入作品 | 旧主流程已移除 | 真需要时另做有管理员权限和审计的后台 |
| 可观测性 | Cron 有计数和有限失败样本，无完整告警 | 上线后添加失败告警和 provider 健康检查 |
| 自动化测试 | mock smoke 尚未固化 | 把 provider、R2、所有权隔离写成可重复测试 |

## 15. 关键源码索引

| 目标 | 文件 |
| --- | --- |
| 三入口前端、任务和作品库显示 | components/portal-workbench.tsx |
| 门户服务端入口 | app/portal/page.tsx |
| 图片 / 3D / 视频提交 API | app/api/generate/*/route.ts |
| 提交与输入白名单 | lib/jobs/submit-route.ts、lib/jobs/input.ts |
| provider 选择与旧任务分发 | lib/jobs/providers.ts |
| 任务轮询、lease、完成入库 | lib/jobs/reconcile.ts、lib/jobs/store.ts |
| 自建 ComfyUI API adapter | lib/engines/comfyui-image.ts |
| Modal / OpenRouter / fal adapter | lib/engines/modal-image.ts、lib/engines/openrouter-image.ts、lib/engines/fal-image.ts、lib/engines/fal-http.ts |
| 图片 workflow 注册与变量注入 | lib/workflows/image-registry.ts、lib/workflows/render-template.ts |
| provider 文件下载和 R2 安全检查 | lib/assets/r2-store.ts、lib/assets/r2-direct.ts |
| 个人作品库 API | app/api/library/route.ts |
| Cron API | app/api/jobs/reconcile/route.ts、vercel.json |
| 数据库迁移 | supabase/migrations/0002_aigc_jobs_generations_assets.sql |
| 部署变量和脚本 | .env.example、scripts/setup-env.sh |
| 详细内部交接 | docs/HANDOFF.md |

## 16. 给后续执行者的底线

1. 不读取、不输出、不提交 .env.local、Vercel、R2、ComfyUI、Modal、fal、OpenRouter 的真实密钥。
2. 不把 COMFY_ORG_API_KEY 做成前端变量或浏览器可见 API 返回值。
3. 不把自建 ComfyUI 误接为 Comfy Cloud，也不要用 X-API-Key 代替 extra_data.api_key_comfy_org。
4. 不把普通设计 / 美术用户拉回上传口令、target_open_id 或 ComfyUI 操作流程。
5. 不为了通过构建而删除 R2 落库、所有权过滤、任务 provider 记录或 Cron。
6. 当前工作区存在一批未提交改造文件；审查时只添加必要改动，不执行 reset、clean 或批量删除。
