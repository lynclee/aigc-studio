# HANDOFF — aigc-studio 交接总结(2026-07-02)

> 写给在本仓库单开的 Claude Code 会话。上一段工作在 v0-nano-banana-pro-playground 的会话里完成
> (代码 8 个 commit + 飞书部署手册),那个会话的项目 memory **不会**带到这里,所以适用的经验
> 教训都已写进本文档。架构事实见 `CLAUDE.md`(自动加载),本文档放:当前状态、任务清单、
> 从 playground 抽取的资产清单、已知 gap。

## 一、当前状态

- **代码**:8 个 commit,本地 `main`,工作区干净;typecheck + build 已实测全绿(2026-07-02);
  **还没有 remote** —— 等用户建好 GitHub 私仓发地址,push 前核 `git status` 确认无密钥
- **部署**:未部署。用户即将按部署手册(见 CLAUDE.md 链接,已终审与代码逐项一致)自己开
  5 个账号(GitHub / 飞书开放平台 / Supabase / Cloudflare R2 / Vercel)走 8 步上线
- **文件全景**(共 ~20 个源文件,半小时能通读一遍,建议新会话先通读):

| 文件 | 职责 |
|---|---|
| `app/page.tsx` | 登录页(错误码→固定文案映射) |
| `app/portal/page.tsx` | 门户主页:PluginConfig(token 复制)+ 画廊 grid + 三态(待配置/空/内容) |
| `app/api/auth/lark/{login,callback}` `logout` | OAuth 三件套(state 防 CSRF) |
| `app/api/gallery/upload-url/route.ts` | presigned-PUT 核心(防冒名两道闸) |
| `app/api/gallery/upload-token/route.ts` | token 签发备用入口 |
| `lib/session.ts` / `lib/upload-token.ts` | HMAC 签名 cookie / 长期上传凭证(共用 SESSION_SECRET) |
| `lib/lark/oauth.ts` / `lib/r2.ts` / `lib/supabase/admin.ts` | 三个外部服务封装,env 缺失全部优雅降级 |
| `scripts/setup-env.sh` | 交互式填 .env.local(敏感值不回显) |
| `scripts/push-env-to-vercel.sh` / `setup-r2-cors.mjs` | Vercel env 批量推 / R2 CORS 一键配 |
| `supabase/migrations/0001_gallery_items.sql` | 唯一迁移(单表 + 索引 + RLS 零 policy) |

## 二、任务清单(按优先级)

### T1 · 部署上线(用户主导,会话支持)

用户按飞书手册走;会话侧的活:
1. 用户发 GitHub 仓库地址 → `git remote add origin ...` + push(git 走全局代理规则,见下方「环境事实」)
2. 部署中遇到问题按手册排查;手册若发现错漏,用 lark-cli(`--as user`)原地更新文档,别新建
3. 上线后跑一遍验证:飞书登录 → portal → 复制 token → 用 curl 模拟插件调 upload-url → PUT 一张图 → 刷新画廊可见

### T2 · 网页模板 + UI 验证流程(用户点名要的)

目的:后续加页面/功能时有统一骨架可套、且每次 UI 改动能快速自验。**方案(在新会话实施)**:

1. **抽 `PageShell` 布局组件**:把 `app/portal/page.tsx` 里的顶栏(logo + 用户信息 + 登出)
   提成 `components/layout/page-shell.tsx`,portal 改用它;新页面照套。门户暂时单页,
   **不要**上完整侧边栏壳(playground 的 `components/layout/app-layout.tsx` 可作未来多 Tab 时的参考,现在过重)
2. **固化三态范式**:待配置态 / 空态 / 内容态(portal 已示范)是每个数据页的标准结构,模板页照抄
3. **建 `/ui-verify` 简化版 skill**(`.claude/skills/ui-verify/SKILL.md`):参考 playground 同名 skill,
   但 aigc-studio 没有双列 stackVertical 分支,验证点改为:
   - 桌面 1920×1080:画廊 4 列、顶栏完整(含用户名)
   - 移动 390×844:画廊 2 列、顶栏用户名隐藏(`hidden sm:inline`)
   - 流程:`browser_resize` → navigate → snapshot 断言,两视口各一次
4. 可选:dev-only 模板示例页,展示 PageShell + 三态 + 常用件的用法 —— 只在觉得有必要时做,简单优先

### T3 · 画廊媒体类型渲染 gap(review 发现的真 bug 前置)

`upload-url` 的 ext 白名单允许 **mp4 / glb**,但 `portal/page.tsx` 画廊一律 `<img>` —— 美术传视频或模型后卡片必裂。方案:
- 按 `r2_key` 后缀分流(key 是服务端生成的,后缀可信,不用加库字段):
  `mp4` → `<video muted loop playsInline preload="metadata">`;`glb` → 先渲染占位卡(标注"3D 模型"),
  后续要预览再抽 playground 的 `components/ai-mesh/mesh-viewer.tsx` 简化版(three.js GLB 查看器,别急着搬)

### T4 · 幽灵索引兜底(review 发现的架构 gap)

`upload-url` 是**先写索引行、再返回 PUT URL** —— 若插件最终没 PUT 成功(网络断/放弃),
库里留下一行索引但 R2 无对象 → 画廊出现**永久裂图卡**(预签名 GET 对不存在的对象照样能签出 URL,GET 时才 404)。

- **短期(先做,几行代码)**:画廊 `<img>` 加 `onError` 隐藏整张卡片(需要把卡片提成小 client
  component;或 SSR 阶段 HEAD 探测——别,60 张探测太贵)。呼应 playground 的经验:**历史/画廊只留成功项,失败不留痕**
- **长期(可选)**:插件 PUT 成功后回调一个 confirm 接口,索引行加 `confirmed` 字段,画廊只查 confirmed。
  等插件侧联调时再评估,别提前做

### T5 · 下载原图(功能价值明确,插件联调通了再做)

抽 playground 的 **key 模式下载**(零 Vercel 出口流量、浏览器直连 R2):
- 参考 `v0-nano-banana-pro-playground/app/api/download-image/route.ts`(103 行)+ `lib/download-asset.ts`(35 行)
- aigc-studio 适配更简单:所有权校验就是 `r2_key.startsWith(session.open_id + "/")`(不用查表),
  然后 `signGetUrl` 时钉 `ResponseContentDisposition: attachment; filename=...`,客户端 `<a>` 触发

### T6 · 删除作品(有真实需求了再做)

playground 的 tombstone + `pending_delete` 队列 + daily cron 是多写入方/异步孤儿场景的方案,
**aigc-studio 别搬**(单写入方、量小)。同步删即可:验 open_id 前缀 → 删 `gallery_items` 行(用户视角立即消失)→
best-effort `DeleteObjectCommand`;删对象失败就留着(无索引不可见,可接受)。

### T7 · 工程门禁补齐(顺手做)

补 ESLint(`eslint-config-next`)进 `package.json` scripts 与 CI;参考 playground 的
`npm run verify`(typecheck + lint + build)。当前只有 typecheck + build。

## 三、从 v0-nano-banana-pro-playground 抽取清单

> playground 仓库在 `/workspace/v0_banana/v0-nano-banana-pro-playground`,新会话可直接读它的文件。
> 原则:**抽模式不抽实现**,aigc-studio 的场景几乎都比 playground 简单一个量级,照搬就是过度工程。

### 值得抽的

| 资产 | playground 位置 | aigc-studio 场景 | 时机 |
|---|---|---|---|
| UI 双视口验证 skill | `.claude/skills/ui-verify/SKILL.md` | T2 简化版(桌面+移动) | 现在 |
| key 模式下载(attachment 预签名 + 浏览器直连) | `app/api/download-image/route.ts`、`lib/download-asset.ts` | T5 | 插件联调后 |
| GLB 查看器 | `components/ai-mesh/mesh-viewer.tsx` | T3 的 glb 预览(简化版) | 有 3D 作品需求时 |
| 空态/加载态/三态页面范式 | `components/layout/processing-content.tsx` 等 | T2 模板 | 现在 |
| R2 CORS + 直连经验 | 项目 CLAUDE.md「R2 直连与 GLB 加载」节 | 换自定义域名时必须同步更新桶 CORS,否则直连回退失败 | 换域名时 |

### 规模大了再抽(当前不需要,记下防重复发明)

| 资产 | playground 位置 | 触发条件 |
|---|---|---|
| 客户端签名缓存(user-scoped localStorage + in-flight 去重 + 并发上限) | `components/image-combiner/signed-url-cache.ts`(411 行) | 画廊改客户端分页/无限滚动时。当前 server 端签 60 张,presign 是本地计算不走网络,**没有**签名瓶颈 |
| 批量签名 POST 路由 + micro-batch | `app/api/r2-sign/route.ts` | 同上。playground 的瓶颈是**每次单签都要过 Auth + 所有权 DB 查询**(~769ms/次);aigc-studio 所有权是前缀字符串比较,零 DB 往返,天然没这个问题 |
| 懒签 + onError 重签 + IntersectionObserver | `components/image-combiner/history-image.tsx` | 画廊超过一屏且首屏时间可感知时 |

### 明确不抽(理由写死,防新会话被 playground 带偏)

- **generation kernel / jobs 状态机 / credit_events 账本** —— 门户不跑算力、不扣费,整个域不存在
- **image-engine 抽象层(RunPod/Modal adapter)** —— 算力在美术同学插件侧,门户零算力代码
- **usePersistentHistory 三层数据流(localStorage L1 + Supabase L2 + 签名 L3)** —— 画廊是 server component 直出,没有本地历史
- **i18n LanguageProvider** —— 内部工具,全中文
- **Supabase Auth 相关一切** —— 自管 HMAC session,别引入

## 四、适用的踩坑经验(从 playground memory 搬运,那边 memory 这边读不到)

1. **模糊报错先复现视觉**:用户报"页面报错"等含糊描述时,先 Playwright 打开看实际渲染,别先翻 server 代码
2. **给了截图/证据就直接做**:别连环 AskUserQuestion;歧义大才问,一次问够
3. **transform 破坏 fixed 定位**:含 popover/fixed 子元素的容器别留 transform;入场动画 fill 用 `backwards` 别用 `both`
4. **布局对齐从几何根源消除**:别堆 snap/padding 补偿,让量恒定或整除
5. **列表 merge/dedupe 按稳定 id,绝不按 URL**:预签名 URL 会漂移(重签/过期),按 URL 去重必出 ghost
6. **画廊/历史只留成功项**:失败/取消即时移除不留痕,进行中用 spinner 不用裂图(T4 的设计依据)
7. **小改动别本地 build**:className/文案类改动靠 typecheck + CI/Vercel 构建;大改才本地 build
8. **`pkill -f` 会 self-match**:用 PID 或方括号 trick `'[p]attern'`,否则 bash 把自己杀了(exit 144)

## 五、环境事实(容器级,新会话直接可用)

- **全局代理规则**在 `/home/node/.claude/CLAUDE.md`(自动加载):外网走 relay `127.0.0.1:18000`,
  git push 也走 relay;浏览器一律 firefox-esr;**严禁 unset 代理 env**
- **lark-cli** 已装且已授权:文档操作 `--api-version v2`,**创建/更新给用户看的文档必须 `--as user`**;
  部署手册文档 id `QmyFdqheWoMnoExJpGicbE1Nnth`
- **Playwright**:优先 plugin 版 MCP;MCP 不便时用 node 直接驱动 playwright-core(firefox-1522 已装,
  走 relay + bypass localhost)
- **密钥纪律**(用户逐字原话,长期有效):"搞一下 .env 我填或者其他的比如命令行方式,也先避免 mcp 和 cli
  提交这些 token" —— `.env.local` 用户自己填,Claude 不读它、不经手任何生产密钥,push 前核 git status
- **文档纪律**:给用户的文档一律飞书格式(用户原话"后续都应该是飞书格式的、飞书能看的文档")

## 六、与 playground 会话的分工

- 本仓库(aigc-studio)的一切开发在**这里的会话**做
- v0-nano-banana-pro-playground 的会话继续专注 playground 自身
- 跨仓库要抽代码时:直接读 playground 的文件(路径见第三节),抽完在本仓库落地,不改动 playground
