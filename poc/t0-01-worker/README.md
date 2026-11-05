# PoC T0-01 — Worker 进程管理验证（Job Object / 取消粒度 / Session 粒度终止 / 孤儿接管 / CliHost 托管决策）

对 issue #2（[S1-01] T0 前置验证）的四件事 + 一个决策做真实 Windows 环境实测。产物仅验证型脚本与证据，不含产品代码。结果判定与发现见 `RESULT.md`；CliHost 托管形态决策见 `docs/adr/0001-clihost-hosting-utility-process.md`。

## 环境

- Windows 11 build 26200 / Node v24.13.0 / PowerShell 5.1（CIM + Add-Type P/Invoke）
- 三 CLI 真实 exe（spawn 直连，不经 .cmd shim）：
  - codex-cli 0.144.1：npm shim `codex.cmd` → node 脚本 `bin/codex.js` → 真实原生 exe `<npm root -g>/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`
  - Claude Code 2.1.317：npm shim 直接指向 `<npm root -g>/@anthropic-ai/claude-code/bin/claude.exe`（原生 exe，无 node 中间层）
  - opencode 1.19.5：`<npm root -g>/opencode-ai/bin/opencode.exe`（另有安装器版 `LocalAppData/Programs/opencode/opencode.exe` 为 1.15.7，未采用）
- exe 路径均可经环境变量覆盖：`T0_CODEX_BIN` / `T0_CLAUDE_BIN` / `T0_OPENCODE_BIN`；codex 模型 `T0_CODEX_MODEL`（默认 gpt-5.6-luna，poc-1 发现 2：账号默认模型不可用）
- bench 子目录自带 package.json（electron 42.11.18，`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm install`）

## 复现命令

```bash
cd poc/t0-01-worker
node t1-job-object.mjs            # T1 Job Object 三场景（无模型调用；--only control|job|graceful 可单跑）
node t2-cancel-turn.mjs           # T2 取消 Turn ≠ 杀 Session（codex 真实 2 turns，gpt-5.6-luna/effort low）
node t3-session-granular.mjs      # T3 多会话 Session 粒度有序终止（claude 1 tiny turn；T0_T3_NO_TURN=1 可关）
node t4-orphan-adopt.mjs          # T4 孤儿先核对再接管（codex 真实 3 turns：埋暗号/被中断数数/复现）
cd bench && ./node_modules/.bin/electron .   # T5 utilityProcess MessagePort benchmark（零模型调用）
```

每个脚本退出码即判定（0=PASS）；证据落 `logs/t<N>-result-*.json` 与同名 `.log`。

## 目录

```text
lib/exe-paths.mjs      三 CLI 真实 exe 解析（npm root -g 动态探测 + env 覆盖 + 版本记录）
lib/procs.mjs          CIM/Win32_Process 枚举（CreationDate 转 ISO）、存活检查、taskkill 强杀/树杀
lib/job-guard.ps1      Job Object 守护：创建命名 Job(KILL_ON_JOB_CLOSE)+挂入宿主 pid+等待宿主死亡后退出
                       （纯 ASCII：PS 5.1 把无 BOM 的 .ps1 按 ANSI/GBK 解析，中文注释会破坏 param 块）
lib/job-query.ps1      按名打开 Job 并列出成员 pid（计数为 32 位 ULONG、pid 列表 8 字节步长，winnt.h 布局）
lib/host-runner.mjs    模拟宿主：按计划 spawn 三真实 CLI（detached）+合成孙进程树，可选自建 Job 守护
lib/tree-child.mjs     合成孙进程树（child → grandchild，两级 pid 上报）
lib/codex-client.mjs   codex app-server 最小 JSON-RPC/stdio 客户端（自 poc-1 client.mjs 演进精简）
lib/claude-client.mjs  claude stream-json 最小会话客户端（自 poc-7 lib/client.mjs 演进精简）
lib/host-b-turn.mjs    T4 宿主 B'：detached codex + 埋暗号 turn + 进行中长 turn（供外层强杀制造孤儿）
lib/orphan.mjs         孤儿「先核对再接管」策略库：spawn 注册表 + 身份核对（exe/命令行签名/创建时间防 pid 复用）+ 决策（reattach / terminate-then-resume / none）
bench/                 T5 Electron benchmark（main.cjs + worker.cjs，独立 package.json）
```
