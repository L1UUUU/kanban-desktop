# T0-03 RESULT：node-pty 在 Windows Electron 的原生编译/加载验证（issue 4）

> 日期：2026-11-05 · 环境：Windows 11 (10.0.26200) / Node v24.13.0 / pnpm 10.32.1 / Git Bash
> 工单：#4 [S1-03]（spec issue #1 Testing seam 5 / 架构提案 §7-3）· 判定依据全部来自本机真实运行，日志见 `evidence/`

## 0. 总判定：**PASS**

**最终版本组合（建议锁定）：Node 24.x · Electron 44.10.2 · node-pty 1.1.0（随包 N-API prebuilt，无需编译、无需 @electron/rebuild）**

| 验证项 | 结果 | 证据 |
|---|---|---|
| node-pty 在 Electron 44 下加载（ABI 149） | ✅ PASS | `evidence/verify-electron44.log`（main 进程 require 成功 + 版本行） |
| 最小 Electron 窗口 spawn PowerShell + 输入回显 + xterm 显示 | ✅ PASS | 同上（renderer result 全 true）+ `evidence/electron-smoke-44.png` + `evidence/electron-smoke-result-44.json` |
| 纯 Node ABI 137 下加载 + 回显（单测环境可用性） | ✅ PASS | 同上（STEP node-abi-smoke） |
| Electron 42.11.18 对照（ABI 146） | ✅ PASS | `evidence/verify-electron42.log` + `evidence/electron-smoke-42.png` |
| 源码编译回退路线（VS BuildTools + node-gyp） | ✅ PASS（需禁用 Spectre 开关，见 §3） | `evidence/srcbuild-node-abi-route.log` |

**版本裁决记录**：工单原目标 Electron 42；主会话于实施中裁决改为 **44**（42 已于 2026-10-20 过 EOL，43/44 在支持窗口内；42/44 同为 Node 24 系、同为 N-API 不敏感 ABI）。42 的全量结论保留作对照，44 为最终结论。

## 1. 环境与工具链

- Node v24.13.0（本机，ABI 137）；Electron 44.10.2 内嵌 Node 24.22.2（ABI 149）、Chromium 152.0.7977.169；Electron 42.11.18 内嵌 Node 24.19.0（ABI 146）
- VS BuildTools 两套：`C:/Program Files (x86)/Microsoft Visual Studio/18`（MSVC v180，node-gyp 12.4 自动选中）与 `2022`（MSVC 14.44.35207）；Python 3.13.12
- 网络：npm registry 走 `~/.npmrc` 的 npmmirror；**github.com 与 electronjs.org 直连不通**，Electron 二进制须 `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`

## 2. 路线 A（推荐，已验证）：随包 N-API prebuilt

node-pty 1.1.0 的 npm 包内直接携带 `prebuilds/<platform>-<arch>/` 原生产物（win32-x64 含 conpty.node / pty.node / winpty 全套 + ConPTY 1.23.251008001 的 dll/OpenConsole.exe），基于 node-addon-api（N-API，唯一运行时依赖 `node-addon-api@^7.1.0`）。**N-API 二进制跨 ABI**：同一份文件在 Node ABI 137、Electron ABI 146（42）与 149（44）下全部加载成功——Electron 升级不需要重编 node-pty，也不需要 `@electron/rebuild`。

安装步骤（坑都在这）：

1. **pnpm 10 默认拦截依赖构建脚本**：`pnpm install` 后报 `Ignored build scripts: node-pty@1.1.0`，prebuild 检查与 ConPTY dll 复制均不会执行，运行时报 `Failed to load native module`。须在 package.json 声明 `"pnpm": { "onlyBuiltDependencies": ["electron", "node-pty"] }` 后 `pnpm rebuild`（正式工程同样需要）。
2. **Electron 二进制下载**：`node node_modules/electron/install.js` 默认走 github.com（本网络 000 超时），须 `ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/`。此为环境问题非 node-pty 问题。
3. 之后 `require('node-pty')` 即可用（加载顺序 `build/Release` → `prebuilds/win32-x64`）。

## 3. 路线 B（回退，已验证）：源码编译（node-gyp + VS BuildTools）

在隔离副本（`.srcbuild/`，已清理，不影响 pnpm store）实测 `node-gyp rebuild` 全部三个目标编译成功（pty.node / conpty.node / conpty_console_list.node）并完成 spawn 回显冒烟。踩坑三条：

1. **MSB8040 Spectre 缓解库缺失**：本机两套 BuildTools 均未装「Spectre 缓解库」组件，而 node-pty 的 `binding.gyp` 与 `deps/winpty/src/winpty.gyp` 共 3 处硬编码 `'SpectreMitigation': 'Spectre'`，直接编译必失败。正式回退路线需二选一：VS Installer 装 Spectre 组件，或改这 3 处为 `'false'`（本 PoC 用后者验证编译链可用）。
2. **node headers 下载**：nodejs.org 直连不通，须 `--dist-url=https://cdn.npmmirror.com/binaries/node`。
3. **node-addon-api 须可解析**：binding.gyp 在 configure 阶段执行 `node -p "require('node-addon-api').include_dir"`，脱离包管理器手动编译时要保证该包在解析路径上。
4. Electron 头文件编译路线（`npm_config_runtime=electron` + electronjs.org/headers）在本网络不可达（000/404 已实测）；但 N-API prebuilt 已实证跨 ABI 加载，该路线对本依赖**非必需**，仅在未来 prebuilt 失效且须源码重编时才需要（届时须解决 headers 网络或用 ELECTRON 便携头文件包）。

## 4. 冒烟设计（可重复，退出码即判定）

`pnpm verify`（= `node verify.mjs`）串两步，任一失败整体退出码非 0：

1. **STEP node-abi-smoke**（`verify-node-abi.mjs`）：纯 Node require node-pty → spawn `powershell.exe -NoLogo -NoProfile` → 断言收到首个 PTY 数据（提示符）→ 程序化写 `echo T0NODEABI` → 断言回显往返 → `exit` 干净退出。
2. **STEP electron-window-smoke**（`electron smoke-main.js` + preload + `smoke-renderer.html`）：BrowserWindow（contextIsolation，preload 暴露最小 `terminalApi`，模拟正式 IPC 边界）→ main 进程 node-pty spawn PowerShell，`pty:data` 转发渲染层 → xterm 5.5 + fit addon 渲染 → 断言三连：首数据到达 / 回显往返（raw 流含 token）/ **xterm 缓冲区行文本含 token**（证明真正写入显示层）→ `webContents.capturePage` 截图 → 按 PASS/FAIL `app.exit(0/1)`。

已知无害噪音：`pty.kill()` 后偶发 `conpty_console_list_agent.js` 抛 `AttachConsole failed` 到 stderr（node-pty 1.1.0 的 console 进程清点辅助进程在宿主已脱离控制台时的表现，不影响主流程与退出判定；#12 集成时不要把该 stderr 当失败信号）。

## 5. 复现步骤

```bash
cd poc/t0-03-node-pty
pnpm install                          # 读 package.json 的 onlyBuiltDependencies，构建脚本已放行
ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ \
  node node_modules/electron/install.js   # 仅当 pnpm 未自动下载 Electron 二进制时（网络不通 github 时必做）
pnpm verify                           # Node ABI + Electron 44 窗口冒烟，OVERALL PASS 退出码 0
```

（源码编译路线复现：拷贝 `node_modules/.pnpm/node-pty@1.1.0/node_modules/{node-pty,node-addon-api}` 到隔离目录，3 处 SpectreMitigation 改 'false' 后 `npx node-gyp rebuild --dist-url=https://cdn.npmmirror.com/binaries/node && node scripts/post-install.js`。）

## 6. 对工单 #12（TerminalPanel/PTY 集成）的实施建议

1. 直接锁 `node-pty@1.1.0`（与旧 Kanban 基线一致）+ `@xterm/xterm@^5.5.0`；Electron 44 下**不需要** electron-rebuild / postinstall 编译环节，仅须 pnpm `onlyBuiltDependencies` 放行 node-pty 的 install 脚本（ConPTY dll 复制）。
2. 旧 Kanban 的注入式 `terminal-host.ts`（自定义 PtyLike 接口）在单测里继续用 mock PTY（PoC 6 已实证 0 diff），真实 PTY 只在 Electron main 装配——本 PoC 的 preload 契约形状（spawn/write/onData/onExit + terminalId 参数化）可直接参考。
3. spawn 目标用 `powershell.exe -NoLogo -NoProfile` 起步（首屏快、无 profile 干扰）；ConPTY 模式为默认（winpty 仅作 fallback）。
4. 规格化 ConPTY 真实冒烟（claude TUI 进出 + resize）属于 #11/#12 验收项，本 PoC 的窗口冒烟脚手架（断言三连 + 截图 + 退出码）可直接扩展。
5. CI/他机复现注意：Electron 二进制与（回退路线的）headers 都依赖 npmmirror 镜像环境变量，建议进工程 `.npmrc`/CI env 统一管理，避免硬编码在脚本里。

## 7. 证据清单（evidence/）

| 文件 | 内容 |
|---|---|
| `verify-electron44.log` | 最终全量验证日志（Node ABI PASS + Electron 44 窗口冒烟 PASS，OVERALL PASS） |
| `verify-electron42.log` | Electron 42 对照全量日志（OVERALL PASS） |
| `electron-smoke-44.png` / `electron-smoke-42.png` | 窗口内 xterm 实显 PowerShell 回显的截图 |
| `electron-smoke-result-44.json` / `-42.json` | 渲染层断言结果（firstDataReceived/echoReceived/bufferHasToken 全 true） |
| `srcbuild-node-abi-route.log` | 源码编译路线：node-gyp 构建输出 + 源码版模块 spawn 回显 PASS |
