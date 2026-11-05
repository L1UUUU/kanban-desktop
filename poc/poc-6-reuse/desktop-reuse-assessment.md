# Desktop 组件复用评估（PoC 6）

> 日期：2026-11-05
> 评估对象：[PI-Desktop](https://github.com/vastsa/PI-Desktop)（commit `983f840`，2026-11-05）、[旧 Kanban](https://github.com/L1UUUU/kanban)（commit `ec70efe`，2026-10-06）
> 证据等级：**代码级**（两仓库已 `--depth 1` clone 至 `repos/` 逐文件分析）+ **独立编译实测**（`component-demo/`，局部依赖，构建/逻辑/浏览器三重验证）
> 结论口径：直接复用 / 改造后复用 / 仅借鉴交互重写。**不能因代码存在就视为可复用**——每条结论附依赖、许可证与实测证据。

## 0. 结论速览

| 组件 | 来源 | 结论 | 关键理由 |
|---|---|---|---|
| terminal 渲染三件套（236 行） | 旧 Kanban | **直接复用** | 0 diff 抽离实测通过；仅依赖 xterm + 46 行 preload 契约 |
| PTY 宿主 + IPC 薄层（259+55 行） | 旧 Kanban | **直接复用** | 依赖注入设计，可单测；node-pty 为原生编译风险项 |
| project-switcher / git-viewer（346+164 行） | 旧 Kanban | **改造后复用** | 受控组件，仅剥离 `@kanban/core` 类型 |
| TurnChangesCard + 聚合 lib | PI-Desktop | **改造后复用**（附许可证条件） | 实测通过，6 处宿主耦合点改造；LGPL-3.0 传染 |
| tool-display 等纯函数 lib | PI-Desktop | **仅借鉴交互/算法重写**（除非接受 LGPL） | 零依赖但 LGPL 义务使重写更划算 |
| ToolRow / Sidebar / 聊天视图 | PI-Desktop | **仅借鉴交互** | store+IPC+plugin slots+i18n 深度耦合 |
| Markdown 渲染 | PI-Desktop | **仅借鉴**（自建） | 依赖链全 MIT，自组装成本低 |
| Rust Host Core / 插件系统 | PI-Desktop | **否决** | 计划文档 §8.2 已定不引入 |
| Go daemon 及其数据模型 feature | 旧 Kanban | **否决** | 计划文档明确不迁移 daemon 业务调度 |

---

## 1. 许可证分析

### 1.1 PI-Desktop — LGPL-3.0（重要约束）

- 证据：仓库根 `LICENSE` 为标准 **GNU LGPL 3.0** 全文（165 行），无 Classpath 例外、无商业附加条款；README License badge 与之一致。
- 对「抽代码进新仓库」的影响：
  - 源码级抽离 = 制作衍生作品，**被抽离文件必须以 LGPL-3.0+ 发布并提供源码**；
  - 新项目若为闭源/私有 → **源码抽离不可行**；
  - 新项目若为 MIT/Apache 等宽松开源 → 抽离部分需作为独立 LGPL 文件/模块隔离并标注，不能混入宽松许可文件；
  - 仅借鉴交互设计、数据结构思路（idea 层面，不复制表达）不受限制。
- 判定：**PI-Desktop 的 UI 代码只能在「新项目接受局部 LGPL 隔离」时源码复用；否则一律降级为仅借鉴设计。**这与计划文档 §13.5「不直接 Fork」一致。

### 1.2 旧 Kanban — 无 LICENSE 文件（需确权）

- 证据：仓库根及全目录 `find -name "LICENSE*"` 无结果（commit `ec70efe`）。
- 法律默认：无许可证 = 保留所有权利。但该仓库为本项目所有者的旧项目（`L1UUUU/kanban`，git log 主提交者单一），**同一权利人复用自有代码无法律障碍**。
- 判定：**在向用户确认「仓库全部贡献出自本人」后按直接复用处理**；若存在其他贡献者提交，需先取得授权。此项列为待确认事项，不阻塞技术结论。

### 1.3 依赖树许可证（npm registry 实查，2026-11-05）

| 依赖 | 用途 | License |
|---|---|---|
| react / react-dom / react-markdown / shiki / katex / mermaid / zustand / i18next / react-i18next / tailwindcss / rehype-katex / rehype-sanitize / remark-gfm | PI-Desktop 渲染层 | MIT |
| lucide-react | 图标 | ISC |
| dompurify | HTML 消毒 | MPL-2.0 OR Apache-2.0（双许可，任选） |
| @xterm/xterm / @xterm/addon-fit / node-pty | 旧 Kanban 终端 | MIT |

- **依赖树无 copyleft / 无高危项**。唯一 copyleft 来自 PI-Desktop 仓库自身代码。
- PI-Desktop 私有依赖 `@earendil-works/pi-ai` / `pi-mcp`（Pi 生态协议包）为 Pi 专属方向，与本新项目多 CLI 路线不符，不引入。

## 2. PI-Desktop 依赖图与组件结论

架构（pnpm monorepo）：`apps/desktop`（Electron + React 19 + Tailwind 4 渲染层）∥ `packages/shared`（32k 行类型与协议契约）∥ `packages/plugin-sdk` 等 ∥ `crates/host-core`（Rust，不评估引入）。

渲染层关键横向依赖：
- `lib/api.ts`：preload/Electron IPC 大边界，类型全部来自 `@pi-desktop/shared`；
- `stores/app-store.ts`：zustand，含 session/project/transcript/work-panel 等 9 个 slice；
- `react-i18next`、plugin renderer-slots（`useSlotSessionId`）、`components/ui.tsx`（855 行基础件）+ `icons.tsx`（lucide re-export）。

| 组件 | 行数 | 依赖清单 | 耦合强度 | 结论 |
|---|---|---|---|---|
| `lib/tool-display.ts` | 216 | 无（纯函数） | **无耦合可抽** | 仅借鉴重写（LGPL 使重写更划算；算法为工具名→动作分类、参数摘要，一小时内可自实现） |
| `lib/turn-changed-files.ts` | ~110 | shared 类型 + workspace-review | 无耦合可抽（类型可裁剪） | 改造后复用（随 TurnChangesCard） |
| `lib/workspace-review.ts`（reviewChangeFromMessage） | 192（裁剪 ~120） | shared 类型 | 无耦合可抽（类型可裁剪） | 改造后复用（review-change v1 解析：状态/根目录/hunks 校验） |
| `features/chat/transcript/TurnChangesCard.tsx` | 144 | shared 类型、ui/icons、i18n、zustand（2 个方法）、plugin slots、disclosure（244 行折叠系统）、review-focus、turn-changes.css（28 个 CSS 变量） | **需 mock 接口**（6 个宿主耦合点） | 改造后复用——**实测通过**（见 §4） |
| `components/ReviewFileIcon.tsx` | 30 | 无 | 无耦合可抽 | 改造后复用（原样实测通过） |
| `features/chat/transcript/ToolRow.tsx`（工具卡片） | 766 | app-store、api hooks、Markdown、plugin slots、subagent-topology、plan-history、generated-images、ContextMenu 等 15+ 模块 | **深度耦合不建议** | 仅借鉴交互：折叠/展开、参数摘要行、状态图标、delegate 生命周期行分组 |
| `components/Sidebar.tsx`（Session 导航） | 2900 | api、app-store、remote 层（远端项目目录/安全）、i18n、hover-card、拖拽重排、floating-menu | **深度耦合不建议** | 仅借鉴交互：项目分组、pinned 置顶、按日期分组、live 状态徽标、当前运行指示 |
| `components/Markdown.tsx` | 1059 | react-markdown + rehype/remark 链 + shiki + katex（全 MIT）+ 自家流式分块 lib | 中度（npm 依赖可装，自家 lib 需连带） | 仅借鉴：流式渲染分块上限（render-content-limits）、代码高亮策略；自组装同栈成本不高 |
| `components/HomeProjectSwitcher.tsx` | 412 | app-store、remote 层、shared、AnchoredMenu | 需 mock 接口 | 仅借鉴交互（与旧 Kanban ProjectSidebar 对比后取优） |
| `ui.tsx` / `icons.tsx` | 855/318 | react + portal lib + lucide | 轻度 | 仅借鉴（绑定 Tailwind 4 token 体系，新项目自带设计系统） |
| `packages/shared` 类型（UiMessage 等） | 32k | 独立包 | 类型可裁剪 | 借鉴消息契约设计（role/toolStatus/toolResult.review 结构），自行定义 |
| Rust `crates/host-core`、`packages/racp`/`plugin-*`/`agent-*`/`host-runtime` | — | Rust 工具链 + Pi 协议 | — | **否决**（计划文档 §8.2：不优先引入 Rust Host Core 与插件系统） |

## 3. 旧 Kanban 依赖图与组件结论

架构（pnpm monorepo）：`apps/desktop`（Electron 42 + React 19 + Vite）∥ `apps/daemon`（**Go 1.26 服务**，`go.mod` + sqlite + websocket）∥ `packages/core`（domain 类型）/`daemon-adapters`/`dos-engine`。渲染层经 `lib/daemon-client`（window 单例 + ws）连 daemon。

```text
Renderer (React)
  ├─ features/terminal ──→ window.terminalApi（preload 契约 46 行）──→ Electron ipc/terminal.ts ──→ main/terminal-host.ts ──→ node-pty   ← 不经 daemon
  ├─ features/project-switcher / git-viewer ──→ props 受控 + @kanban/core 纯类型；数据由容器层经 daemon-client 取   ← 类型可剥离
  └─ features/demand-board / agent-runs / commit-panel / node-workflow / knowledge-navigation ──→ daemon 数据模型（demand/node/stage）   ← 硬依赖 daemon，不迁移
```

| 组件 | 行数 | 依赖清单 | 耦合强度 | 结论 |
|---|---|---|---|---|
| `features/terminal/TerminalPanel.tsx` | 179 | @xterm/xterm + addon-fit + 本地 terminalApi | **无耦合可抽** | **直接复用——0 diff 实测通过**（见 §4）。自带 Windows/xterm 5.5 Viewport rAF 竞态修复注释 |
| `features/terminal/terminalApi.ts` | 46 | 无（类型 + getTerminalApi） | 无耦合可抽 | **直接复用**（上游特意设计为「renderer 不 import preload 模块」） |
| `features/terminal/model.ts` | 11 | terminalApi 类型 | 无耦合可抽 | 直接复用 |
| `electron/main/terminal-host.ts` | 259 | 自定义 `PtyLike` 接口（注入 pty/spawn/exe 探针/existsSync）+ 事件 sink；**不引用 Electron API** | 无耦合可抽（可单测） | **直接复用**（node-pty 为运行时依赖，见风险项） |
| `electron/ipc/terminal.ts` | 55 | electron ipcMain + `@kanban/core/ipc/channels` 常量 | 轻度（常量内联即可） | 直接复用（微改 channel 常量来源） |
| `features/project-switcher/`（ProjectSidebar/TopBar/model） | 346 | `@kanban/core/domain` 类型（Project/GateAutonomyMode）；props 受控 | 需 mock 接口（类型层） | 改造后复用：表单/冲突 toast 交互完整，换成新 Project 类型即可 |
| `features/git-viewer/`（GitDiffViewer/GitStatusPanel） | 164 | `@kanban/core/domain` 类型（FileDiff/DiffStat/GitStatusSnapshot）+ terminal 类型 | 需 mock 接口（类型层） | 改造后复用（只读两栏 diff 布局 + 注入终端按钮的交互可取） |
| `features/demand-board` 等 daemon 数据 feature | 数千 | daemon ws 客户端 + demand/node/stage 模型 | **深度耦合（daemon）不建议** | 否决迁移；仅可借鉴字段命名（与新项目 Requirement 语义冲突处以新计划为准） |
| `apps/daemon`（Go） | — | gorilla/websocket、sqlite 等 | — | **否决**（计划文档：不迁移 Go daemon 业务调度） |

**脱离 daemon 可独立用的能力**：terminal 全链路（渲染+IPC+host，仅 preload 拖走）、project-switcher/git-viewer 的 UI 层（数据源换新 IPC 即可）。
**硬依赖 daemon 的能力**：需求看板、agent-runs、commit-panel、node-workflow、knowledge-navigation 的全部数据与调度。

## 4. 独立编译实测（component-demo/）

最小 Vite 7 + React 19 + TS 工程（依赖仅装在 poc 目录内），从两仓库各抽 1 个组件：

### 4.1 PI-Desktop — TurnChangesCard（Diff 展示）改造抽离：**PASS**

- 原样带走：`turn-changed-files.ts`（仅改类型 import 路径）、`workspace-review.ts` 裁剪版（仅保留 reviewChangeFromMessage + parseHunks + 辅助，逻辑零改动）、`ReviewFileIcon.tsx`、`turn-changes.css`（152 行原样，另配 28 个 CSS 变量的浅色近似）。
- 6 处宿主耦合点改造：react-i18next → 本地中文串；zustand openWorkPanelTab* + requestReviewFocus + toolWorkPanelTab → `onOpenReview` 回调 props；plugin `useSlotSessionId` → 删除；244 行 disclosure 折叠系统 → 本地 `useState`（降级：折叠状态不跨卸载保留）；ui.tsx/icons.tsx → 本地最小件；类型 `@pi-desktop/shared` → 70 行本地保真 stub。
- 证据：
  - `tsc --noEmit` + `vite build` 通过（44 modules）；
  - `verify-logic.ts` 11 项断言全 PASS（合法 review 解析、忽略 error 消息、忽略非 Write/Edit 工具、非法 root 拒绝、同路径计数累加、快照收集、目录计数、空输入）；
  - 浏览器实测：卡片渲染（3 文件 / +37 −15 与输入数据一致）、展开列表（新增/修改状态、`../outside` 路径正确缩略为 `.../renamed-file.md`）、点击行触发 `openReview(snapshots=1, expand=true)` 回调。
- 结论：**改造后复用可行，改造面收敛在 6 个明确耦合点**（详见 `component-demo/src/pi-desktop/TurnChangesCard.tsx` 头注）。但受 §1.1 LGPL 约束——是否值得为 ~500 行代码引入局部 LGPL 隔离，由主会话决策；数据结构（review-change v1 契约）借鉴后自实现是零许可成本的替代路径。

### 4.2 旧 Kanban — TerminalPanel 原样抽离 + mock PTY：**PASS**

- `TerminalPanel.tsx` / `terminalApi.ts` 与上游 **0 diff**（diff 命令验证）；另配 `mock-terminal.ts` 在浏览器实现 terminalApi 契约（本地回显 shell，支持 clear/exit 生命周期）。
- 证据：同一工程构建通过；浏览器实测：xterm 初始化、mock PTY 启动横幅（`[mock PTY] shell=mock-sh cwd=...`）、`onStarted` 事件行、提示符渲染、StrictMode 下 `[错误] PTY 未运行` 错误事件链路全部工作（截图 `evidence/demo-page-screenshot.png`）。
- 结论：**「渲染层只依赖 46 行 preload 契约」的设计假设被证实——脱离 Electron、脱离 node-pty、脱离 Go daemon 均可运行**。真实 PTY 场景需 Electron main + node-pty（见风险项）。

### 4.3 复现方式

```bash
cd poc/poc-6-reuse/component-demo
npm install          # 局部安装（71 包）
npm run build        # tsc --noEmit + vite build
npx vite preview     # 浏览器打开 http://localhost:4173 交互验证
# 逻辑断言（无需浏览器）：
npx esbuild verify-logic.ts --bundle --format=esm --outfile=.v.mjs && node .v.mjs && rm .v.mjs
```

## 5. 风险项与未验证项

1. **node-pty 未实测**（两仓库共有）：原生模块，Windows 需 node-gyp + VS Build Tools 或 prebuilt。本次浏览器 demo 不含 node-pty；正式接入时须先在 Windows Electron 环境验证 `pnpm install` 能取到 prebuilt 或本地编译通过。旧 Kanban 同版本 `node-pty@^1.1.0` + `@xterm/xterm@^5.5.0` 曾在其项目中实际运行（含 Windows），风险中等偏低。
2. **PI-Desktop LGPL 传染**（§1.1）：任何源码级复用必须局部 LGPL 隔离并开源该部分；建议默认走「借鉴设计 + 自实现」。
3. **旧 Kanban 许可确权**（§1.2）：向用户确认全部提交出自本人后再执行直接复用。
4. **TurnChangesCard 的 disclosure 降级**：折叠状态不跨消息卸载保留（上游 244 行系统做了跨 pane 保留）；若新项目需要该行为，按需补一个轻量版，不必搬上游整套。
5. **CSS token 体系**：PI-Desktop 的组件样式依赖 `--ds-*` 设计 token（turn-changes.css 引用 28 个变量）；新项目需自带等价 token 层，否则样式失真（demo 中已用近似值验证可行）。

## 6. 可选补充：AionUi / desktop-cc-gui Adapter 层观察（30 分钟时间盒内）

- AionUi 当前（2026-11-05 API 级目录观察）正处于 **monorepo 大重构**：根下 `packages/{desktop,web-host,web-cli,mobile}`，desktop 包源码仅 `src/{common,preload,process,renderer}`；计划文档 §8.3 所述「utilityProcess per agent + ACP 桥接」的 agent adapter 目录在 desktop 包主进程（`process/{backend,bridge,services}`）未直接定位到，疑移至 renderer 或 web-host。
- 含义：AionUi 结构与 README 描述已漂移，**其 UI/Adapter 代码复用价值进一步下降**；维持 §8.3 结论——只把「每 agent 独立宿主进程 + ACP 桥接包依赖需评估 Windows 行为」作为 PoC 1 的对照路线，不做代码级引入。desktop-cc-gui（Tauri/Rust）未做源码观察，维持原「矩阵字段设计参考」定位。

## 7. 建议复用清单（供主会话决策）

1. **旧 Kanban terminal 全链路**（TerminalPanel + terminalApi + terminal-host + ipc/terminal，共 ~540 行）——直接复用；许可证确权后即可搬迁，node-pty 先做 Windows 构建验证。
2. **旧 Kanban project-switcher / git-viewer**（~510 行）——改造后复用：保留受控组件结构与交互，替换 `@kanban/core` 类型为新仓库 domain。
3. **PI-Desktop TurnChangesCard + turn-changed-files + workspace-review 解析**——两种路径二选一：(a) 接受局部 LGPL 隔离后按 §4.1 改造复用；(b) 借鉴 review-change v1 消息契约（`toolResult.details.review`：snapshotId/status/state/additions/deletions/hunks）自行实现。**推荐 (b)**：本次实测证明其逻辑仅 ~300 行，自实现成本低于许可证合规成本。
4. **仅借鉴交互/设计**（不搬代码）：PI-Desktop 工具卡片折叠与参数摘要、Session 侧栏分组与 pinned、disclosure 折叠保留、Markdown 流式分块上限、review-focus 请求模式；旧 Kanban 终端注入按钮（git status → terminal）。
5. **否决**：PI-Desktop Rust Host Core / 插件系统 / pi-ai·pi-mcp 依赖；旧 Kanban Go daemon 及 demand-board 等 daemon 数据 feature；两仓库整体 Fork。

## 附：本目录文件

- `repos/`（gitignore，不入库）：两参考仓库浅克隆
- `component-demo/`：实测工程（源码含逐文件来源与改造点注释）
- `evidence/demo-page-screenshot.png`：浏览器渲染截图
- `desktop-reuse-assessment.md`：本文档
