# 阶段 1 验收报告（S1-13 / issue #14）

> 日期：2026-11-06 · 验收人：implementer subagent（issue #14）· 规范依据：spec issue #1 I/J/Testing 节 + 工单 #14 六条验收标准
> 环境：Windows 11（10.0.26200）· Node v24.13.0 · pnpm 10.32.1 · Electron 44.10.2 · 三 CLI 已装已认证（codex 0.144.1 / claude 2.1.x / opencode 1.19.5 npm exe）

## 0. 结论一览

| # | 验收标准 | 结论 |
|---|---|---|
| 1 | NSIS 安装包 + 便携版双产物可正常安装/解压运行 | **PASS**（静默装→冒烟→静默卸载干净；便携版自解压冒烟过） |
| 2 | 三 CLI 逐项过 spec §5 最低验收（七项） | **PASS**（3 CLI × 7 项 = 21/21，真实链路 KANBAN_E2E=1） |
| 3 | §6.1 生命周期表逐项核验记录 | **PASS**（#13 全表证据引用 + 打包形态复验关键 2 项） |
| 4 | PoC 场景回归套件（契约测试）全绿 | **PASS**（单测 343；真实套 170+130，1 条网关瞬态失败复跑过，如实记录） |
| 5 | 原型必须一致项对照（截图 + 交互记录） | **PASS**（7 项逐项，12 张状态截图 + 6 类交互实测） |
| 6 | 验收记录归档 docs，未达项如实标注 | **PASS**（本报告 + screenshots/；偏离与未尽如实列出） |

阶段 1 收口结论：**六条验收标准全部 PASS**。验收过程中发现并修复 1 个真实缺陷（二次重启后断开会话无法恢复，见 §8）。

---

## 1. 打包双产物（AC-1）

### 1.1 配置与生成命令

- 配置：`apps/desktop/electron-builder.yml`（NSIS oneClick + portable 双 target；`asar: true`；`asarUnpack: node-pty`；`npmRebuild: false`——node-pty 1.1.0 自带 N-API prebuilds，dev 形态 Electron 44 已实证加载，重编无必要且离线不可达）
- 生成命令：`pnpm --filter @kanban/desktop pack:win`（= `electron-vite build && electron-builder --win nsis portable`）
- 产物目录：`apps/desktop/dist/`（gitignore，不入库）

### 1.2 产物清单（最终构建，含 §8 修复）

| 产物 | 大小（字节） | sha256 |
|---|---|---|
| Kanban-Desktop-0.1.0-setup.exe | 125,400,047 | `2675db49f818389d67aa3267a9dfbffbe6e08e8cc8e09ed628d0061c01fc6215` |
| Kanban-Desktop-0.1.0-portable.exe | 112,187,461 | `9b686be0013608a011aa2c3dc64b97e2f5f2ed3f62d6e0edd4d35d27503d32ca` |

spec J 明确不做项：无自动更新（无 publish 配置）、无代码签名（构建日志 "signing is skipped"）、无遥测。

### 1.3 装包/解压运行验证（脚本化，可重复）

驱动脚本：`apps/desktop/scripts/packaged-smoke.cjs`（CDP 连接打包应用，驱动 Fake 会话全链 + PTY + userData 落盘 + worker 形态核验；`lifecycle` 模式含 marker 孤儿断言与重开恢复）。三种形态结果：

| 形态 | 命令 | 结果 |
|---|---|---|
| win-unpacked | `node scripts/packaged-smoke.cjs dist/win-unpacked/Kanban Desktop.exe win-unpacked` | PASS：Fake 会话全链（多轮流式+工具卡+回空闲）、utilityProcess 子进程在场（4 个同 exe 子进程）、回退告警未出现、PTY 创建 OK、config.json+kanban.db 落盘、正常退出 exit=0 |
| NSIS 静默装 | `setup.exe /S` → 同上冒烟（安装于 `%LOCALAPPDATA%\Programs\@kanbandesktop`） | PASS：冒烟全过；`Uninstall Kanban Desktop.exe /S` 静默卸载后注册表项与目录干净 |
| 便携版 | `node scripts/packaged-smoke.cjs dist/Kanban-Desktop-0.1.0-portable.exe portable` | PASS：自解压启动，冒烟全过（含正常退出） |

已知打包风险点核验（工单 #14 点名）：

1. **utilityProcess worker 多入口在 asar 内**：`app.asar` 含 `out/main/cli-host-worker.js`（asar 清单核对）；运行时 utilityProcess fork 成功（同 exe 子进程在场 + 无「回退进程内」告警 + Fake 会话真跑通，会话逻辑运行在 worker 内）。
2. **node-pty 原生模块**：落在 `resources/app.asar.unpacked/node_modules/node-pty/`（含 prebuilds/win32-x64 与 winpty/conpty 二进制）；打包形态真实 spawn PowerShell OK。

外观项（非 AC）：NSIS per-user oneClick 默认安装目录名由包名派生为 `@kanbandesktop`；未配置自定义图标（沿用 Electron 默认）。spec 未要求，如实记录。

---

## 2. 三 CLI × 七项最低验收矩阵（AC-2）

形态：**真实 CLI 链路**（dev 构建产物 + `KANBAN_E2E=1 pnpm test`，非打包形态；打包形态见 §3 复验）。证据为契约套（`packages/cli-host/src/adapter.contract.ts` 参数化，Fake + codex + claude + opencode 四实现）与各 CLI 专属真实套。

| 七项（spec §5 口径） | Codex | Claude | OpenCode | 证据（用例名） |
|---|---|---|---|---|
| 1 创建原生 Session | PASS | PASS | PASS | 契约套全部用例前置（thread/start / stdio spawn / HTTP session） |
| 2 多轮流式 | PASS | PASS | PASS | 不变量 1（sendTurn 提交+事件流）+ 不变量 3（增量拼接=终文、seq 单调）+ 不变量 6（忙态排队续发）×3 实现 |
| 3 工具调用展示 | PASS | PASS | PASS | 审批用例的工具事件状态流转 + full 档真实 bash 写文件（三 CLI 权限档位用例，输出/终态可观察） |
| 4 正确审批 | PASS | PASS | PASS | 审批 deny/allow-once/allow-always ×3 + suggestions 携带断言；opencode 补 always patterns 二连不问、codex 补 approval_expired（服务端终态） |
| 5 取消 Turn | PASS | PASS | PASS | 不变量 6：interrupt 幂等、中断后 0 新增 delta 且可继续 ×3；opencode 补 abort 归类 turn_interrupted 用例 |
| 6 历史读取与继续原生上下文 | PASS | PASS | PASS | 不变量 4：readHistory 快照+增量无缝拼接 ×3；lifecycle.e2e codex/claude dispose→新实例收养→原生历史在场→resume 暗号复现；opencode dispose→按需拉起回填→resume 暗号 + 跨实例收养 |
| 7 错误处理 | PASS | PASS | PASS | 非法时序（E_APPROVAL_EXPIRED / E_SESSION_NOT_FOUND）×3；codex dispose 后明确报错不重放；opencode 端口冲突明确报错；claude dispose 后新会话可再建 |

矩阵 21/21 PASS。真实套完整数字见 §4。

---

## 3. §6.1 生命周期表逐项核验（AC-3）

基础证据：**#13（commit 172efd5）已全表 PASS**（关单评论含逐项记录：统一退出序列幂等、退出后 0 孤儿 CIM 句柄级断言、三 CLI 恢复暗号复现、异常不重放等）——本表引用不重复核验。本工单补充：**对打包形态复验关键两项**（命令：`node scripts/packaged-smoke.cjs <exe> win-unpacked lifecycle`，结果 PASS）。

| §6.1 场景 | 结论 | 证据 |
|---|---|---|
| 切换页面/关闭聊天标签 → 不停止 CLI | PASS | #13 lifecycle.spec「切页不停止」（流式中切回增量无缝）+ Playwright 复跑 15/15 含此用例 |
| 停止当前回复 → 取消 Turn 保留 Session | PASS | #13 + fake-chat 取消用例（「本轮已取消」+可续聊）+ 三 CLI interrupt 契约不变量 6 |
| 正常退出应用 → 停止 CLI、无残留、不常驻 | PASS（含打包形态复验） | #13 CIM 断言 0 孤儿；**打包形态**：marker 长驻 PowerShell 在场 1 → 正常退出 exit=0 → marker 0（无孤儿） |
| 重开应用 → 恢复 + 按需读原生历史恢复上下文 | PASS（含打包形态复验 + 缺陷修复） | #13 三 CLI 暗号复现；**打包形态**：重开 → 断开会话 →「读取原生历史并恢复」→ 空闲可续聊；本工单修复二次重启收养缺陷（§8） |
| Worker/CLI 异常 → 先核对旧进程、不重复接管不重放 | PASS | #13 + opencode 孤儿接管同 pid 复用/受控终止用例 + codex dispose 不重放 |
| 中断中的工具调用 → 不自动继续、不宣称运行 | PASS | #13（运行中工具终态化）+ 三 CLI interrupt 后 0 新增 delta |

---

## 4. PoC 场景回归套件（契约测试）数字（AC-4）

全部命令在 worktree `feat/s1-13-packaging`（基线 172efd5 + 本工单改动）执行：

| 套件 | 命令 | 结果 |
|---|---|---|
| 构建 | `pnpm build` | PASS（main 多入口 + preload + renderer） |
| Lint | `pnpm lint` | 0 warnings 0 errors（126 files） |
| Typecheck | `pnpm typecheck` | 4/4 包 PASS |
| 单测（无 env） | `pnpm test` | ipc-schema 54 + tracker 46 + cli-host 115（56 e2e-gated skip）+ desktop 128（2 skip）= **343 passed / 0 failed** |
| Playwright E2E | `pnpm test:e2e` | **15/15**（13 既有 + 2 新增截图编排用例；lifecycle 4 条全过） |
| 真实契约套 | `KANBAN_E2E=1 pnpm test` | cli-host **170 passed / 1 failed / 1 skipped**；desktop **130 passed**（含真实 ConPTY 冒烟 2：PowerShell 回显+resize、claude TUI 进出+resize） |

唯一失败如实记录：`opencode 权限档位 auto：read 直接放行`——`driveIdle 超时（240s 无空闲）`，同套其余 20 项（含同形 ask/full 档位用例与全部契约不变量）全过；**单独复跑 PASS（25s）**。与 #13 记录的「网关瞬态超时」同类，判定为 magpie 网关瞬态挂起，非代码缺陷（复跑命令：`KANBAN_E2E=1 pnpm --filter @kanban/cli-host exec vitest run src/opencode-adapter.e2e.test.ts -t "权限档位 auto"`）。1 skipped 为 `KANBAN_PROTOCOL_PROBE` 门控用例（协议基线 diff，#8 已实证，非常规回归项）。

---

## 5. 原型必须一致项对照（AC-5）

原型：`docs/prototypes/stage1-desktop-ui.prototype.html`（变体 A）。截图编排：`apps/desktop/e2e/acceptance-screenshots.spec.ts`（Fake 链路注入目标状态，断言可见后才截图，可重复重跑刷新），产物存 `docs/acceptance/stage1/screenshots/`。

| # | 必须一致项 | 结论 | 截图 | 补充证据 |
|---|---|---|---|---|
| 1 | 三区布局（项目+会话列表分组 / 聊天区 / 顶栏项目名+设置） | 一致 | 01-empty-state / 03-layout-three-panes | window.spec 三区布局用例 |
| 2 | 项目行悬浮「＋」→ CLI 菜单（Codex/Claude/OpenCode/PTY 终端） | 一致 | 02-new-session-menu | 截图用例断言四菜单项在场 |
| 3 | 会话行徽标：CLI 色点 + 目录身份（主仓库绿/worktree 蓝）+ 活动状态 | 一致 | 06-session-badges-main / 06-session-badges-worktree | worktree 经 `.git` 文件形态真实判定；状态徽标（空闲/运行中/等待审批/已中断/已断开）见各状态截图 |
| 4 | 主仓库 ≥2 活跃并行冲突提示条（列会话名，仅提示） | 一致 | 04-conflict-banner | lifecycle.spec 冲突条用例（出现/消失/不阻止） |
| 5 | 聊天区：消息流 + 工具卡 + 审批卡 + 断开会话恢复入口 | 一致 | 05-chat-approval-card（审批卡+工具卡同屏）/ 07-disconnected-recovery | fake-chat 多轮+工具卡终态（时长/输出）；恢复入口见 07 |
| 6 | composer：统一容器 + 权限 chip 三档（含说明）+ 模型选择 + Running 态「⏹ 停止输出」 | 一致 | 10-composer-permission-menu / 09-composer-running-stop | OpenCode server 级说明在 chip 菜单内（原型一致） |
| 7 | 交互：切换不中断流式 / 审批即时生效 / 取消后「本轮已取消」 | 一致 | 08-interrupted-cancelled | 见下方交互记录 |

### 关键交互实测记录（spec I 验证要求）

| 交互 | 实测记录（命令/用例 + 结果） |
|---|---|
| 审批 | fake-chat「审批三键」：拒绝→工具被拒+道歉文本；允许一次→二次仍问；总是允许→同类跳过。真实链路：契约套审批三键 ×3 CLI PASS（§2 行 4） |
| 取消 | fake-chat「取消 Turn」：⏹→「本轮已取消，会话保留，可继续发消息」+已中断，续发完成；真实链路 interrupt 不变量 ×3 PASS |
| 切换 | lifecycle.spec「切页不停止」：A 流式中切 B 再切回，增量无缝、双会话完成无重复无丢失 |
| 恢复 | 07 截图用例：重开→已断开→「读取原生历史并恢复」→空闲→续聊完成（dev 形态）；打包形态同链路 PASS（§3） |
| 权限切换 | 截图用例：⚡自动→🔒请求→⚡自动 往返生效；真实档位差异三 CLI × 三档可观察（§2 行 3） |
| 新建 | 截图用例 + projects.spec：悬浮「＋」→菜单→新建会话/PTY；多项目并存与切换用例过 |

PTY 终端面板（可调整范围项）：11-pty-terminal.png（真实 ConPTY 回显）。

---

## 6. 归档说明（AC-6）

- 本报告：`docs/acceptance/stage1/report.md`；截图：`docs/acceptance/stage1/screenshots/`（12 张，UTF-8 命名编号对应 §5 表）。
- 未达项如实标注：**无 PARTIAL/FAIL**。唯一的测试波动（§4 网关瞬态）已复跑通过并记录复现命令。

---

## 7. spec 偏离汇总（验收必读）

| # | 偏离 | 内容与理由 | 来源 |
|---|---|---|---|
| 1 | Electron 42 → 44 | 42 已过支持窗口（2026-10-20）；42/44 同 Node 24 ABI 一致；#14 需打包分发，用受支持版本 | 主会话裁决 D1 |
| 2 | Codex 权限档位枚举 | spec 表 ask=on-request / auto=on-failure / full=never+full-access；实测 codex 0.144.1 **on-failure 已从 wire 枚举移除** → ask=untrusted / auto=on-request / full=never（映射不换写，按实测对位） | #8 commit |
| 3 | OpenCode allow-always | spec 标「未实测，capabilities 声明」→ **已实测转正**（patterns server 级持久、跨会话生效；契约套审批用例改独立 cwd/server 隔离） | #11 commit |
| 4 | OpenCode exe 探测顺序 | npm exe（1.19.5）优先——原生安装（1.15.7）对用户 DB migration 失败，e2e 前探针实证 | #11 commit |
| 5 | OpenCode 会话级权限 | **不存在**：权限档位为 server 级共享（同项目共享），UI 已按原型明示 | #11 结论（spec B 已预告，实证落定） |
| 6 | Claude ask 档实现 | default+permissions.ask 严格工具配置（真实用户环境 PowerShell 会被自动放行，需 ask 规则强制弹审批；E1-E5 隔离实验） | #10 commit |
| 7 | SQLite 实现 | spec J 留白「better-sqlite3 或 node:sqlite（实施定）」→ 定版 node:sqlite（Node 24 `DatabaseSync` 入口；#5 首日冒烟实证） | 裁决 D2（spec 授权范围内） |
| 8 | Codex acceptForSession 行为差异 | 不同目标文件的同类型命令仍会再问（原生会话级放行范围窄于语义；映射不换写，如实记录） | #8 commit |

新增过程性偏离（本工单）：安装工具链经本地 registry 代理完成（npmjs 与 registry.npmmirror 均不可达，github/unpkg/npmmirror-CDN 可达）——不影响依赖内容本身（tarball 同源 sha 校验），工具随库提交，见附录 A。

---

## 8. 验收中发现并修复的缺陷（RED→GREEN）

**二次重启后断开会话无法恢复**：`adoptRestoredSessions`（apps/desktop/electron/main/shutdown.ts）原只收养 `status !== "disconnected"` 的结构化会话；首次重开会把断开会话落库 disconnected，第二次重开时不再注册进 adapter，「读取原生历史并恢复」必报「会话不存在」。截图编排用例（双重启场景）复现后修复：启动收养**全部**结构化会话。

- 复现测试：`electron/main/shutdown.test.ts`「启动收养」用例改为断言含已断开条目（先 FAIL 后 PASS，5/5 过）
- 回归：Playwright 15/15（含 lifecycle 重开恢复）、打包形态 lifecycle 复验 PASS
- 产物重建：双产物以修复后 bundle 重新打包（§1.2 hash 为最终版），三形态冒烟复验 PASS

---

## 附录 A：受限网络下的 electron-builder 安装（过程记录）

本机当日 npmjs / registry.npmmirror 元数据接口不可达（TLS 可达性诊断：github.com、unpkg.com、cdn.npmmirror.com 白名单内）。已装依赖经 pnpm store 离线复用；electron-builder 26.18.0 及其依赖树经 `apps/desktop/scripts/registry-fallback-proxy.cjs` 安装：元数据按 unpkg.com 逐版本 range 解析、tarball 自 cdn.npmmirror.com 回填本地缓存并计算 sha512 integrity，pnpm 以 `--registry http://127.0.0.1:4781` 完成安装（tarball 与公网同源同校验和，lockfile 记录 integrity 不含本地地址，对其他机器无影响）。Electron 44.10.2 zip 与 NSIS 工具链分别取自本机 electron 缓存（sha256 校验）与 github releases。

## 附录 B：验收执行顺序（复现清单）

```bash
pnpm install                 # 正常网络直装；受限网络见附录 A
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e                # Playwright 15/15（截图写入 docs/acceptance/stage1/screenshots）
KANBAN_E2E=1 pnpm test       # 真实三 CLI + ConPTY
pnpm --filter @kanban/desktop pack:win
node apps/desktop/scripts/packaged-smoke.cjs <setup.exe 装后 exe> nsis-installed
node apps/desktop/scripts/packaged-smoke.cjs <portable.exe> portable
node apps/desktop/scripts/packaged-smoke.cjs <win-unpacked exe> win-unpacked lifecycle
```
