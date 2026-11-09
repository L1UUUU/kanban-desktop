# 强杀实证记录：Job Object（KILL_ON_JOB_CLOSE）兜底全灭 CLI 子孙进程（#45 / spec #40 US23）

> 日期：2026-11-09 · 驱动形态：门控 e2e（B 类）`packages/cli-host/tests/e2e/force-kill-job.e2e.test.ts`（`KANBAN_E2E=1` + win32 双门禁）· 环境：Windows 11（10.0.26200）、Node v24.13.0、PowerShell 5.1 · 真实 CLI：claude（npm 全局 `@anthropic-ai/claude-code/bin/claude.exe`）、opencode（npm 全局 `opencode-ai/bin/opencode.exe`）
> 结论先行：**taskkill /F 强杀宿主（无 /T）后，Job Object 兜底终止全部 CLI 子孙进程（含 CLI 自身 spawn 的 MCP server 孙进程），CIM 进程清单归零、无孤儿**。实证过程发现并修复了生产 guard 的一个 P0 缺陷（KILL_ON_JOB_CLOSE 从未布防，见 §4）。

## 1. 编排说明

对齐 `run-once-job.e2e.test.ts` 先例（node 宿主 + 生产 JOB_GUARD_PS + vite 打包的真实 CliHost worker），角色映射：

```text
vitest（测试编排）
  └─ 宿主 host.mjs（node，detached；角色等价 Electron main）
       ├─ worker.mjs（node，等价 utilityProcess worker，入 job 后才建会话）
       │    ├─ claude.exe（真实 Claude 会话 ×1，--settings 指向测试根目录 → marker 可见）
       │    │    └─ cmd/node（claude 按用户全局配置拉起的 MCP server 孙进程）
       │    ├─ opencode.exe serve --port A（真实 OpenCode 会话，项目 cwd-1 独立 server）
       │    └─ opencode.exe serve --port B（真实 OpenCode 会话，项目 cwd-2 独立 server）
       └─ guard.ps1（生产 JOB_GUARD_PS：建命名 job（KILL_ON_JOB_CLOSE）→ 绑 worker → 等宿主死亡）
```

- 会话选择：**Claude ×1 + OpenCode server-per-project ×2**（两个独立 cwd → 两个独立 server 进程，最暴露孤儿面）。≥2 个 CLI 会话、≥1 个 OpenCode server 的票面要求满足；两 CLI 类型混合更全面。
- 成本：**全程零 token**——Claude 只 spawn + initialize 握手（不发 turn），OpenCode 只 server 拉起 + `POST /session`（无模型调用）；不经 codex。
- worker 就绪门：先以 `IsProcessInJob` 探针确认自身已入 job 才开始建会话（消除 guard Add-Type 编译期竞态；#45 实测本机裸进程也在运行器 job 内，该门只作编排就绪信号，机制证明见 §3）。
- 观察面（双口径）：
  - **CIM 快照对照**：`Win32_Process` 全量快照（PID/PPID/Name/CommandLine）。marker = 测试根目录名（命中宿主/guard/worker/claude 的 `--settings`）+ 两个 `--port N`（命中 opencode）；另按 PPID 传递闭包求 worker 全部后代树（Windows 不重挂父，孤儿仍指向已死 worker，可抓获无 marker 的孙进程）。
  - **Job Object 机制级查询**：guard 创建的命名 job 按 `OpenJobObject` 打开，`QueryInformationJobObject` 读 `JobObjectBasicLimitInformation.LimitFlags`（布防证明）与 `JobObjectBasicProcessIdList`（成员清单）。

## 2. 强杀前后进程清单对照（实测输出样本）

强杀前（`KANBAN_E2E=1` 真跑，2026-11-09 16:42，修复后 guard）：

```text
[fkjob] 我方 job kanban-fkjob-e2e-1794213757889：LimitFlags=0x2000（含 KILL_ON_JOB_CLOSE），成员 17 个（含 worker + 全部 CLI 子孙）
[fkjob] 强杀前进程清单（worker=35256 后代 17 个；marker 命中 6）：
  pid=55928 ppid=35256 name=conhost.exe cmd=\??\C:\WINDOWS\system32\conhost.exe 0x4
  pid=55548 ppid=35256 name=claude.exe cmd=...claude.exe --print --output-format stream-json --verbose --input-format stream-json --settings <根目录>\hooks\s-xxxx\settings.json --session-id ...
  pid=57768 ppid=55548 name=conhost.exe ...
  pid=24700 ppid=55548 name=cmd.exe cmd=cmd /c npx -y @z_ai/mcp-server
  pid=54440 ppid=55548 name=cmd.exe cmd=cmd /c "node.exe" ...codegraph\npm-shim.js serve --mcp
  pid=57396 ppid=54440 name=node.exe cmd=...npm-shim.js serve --mcp
  pid=16632 ppid=57396 name=node.exe cmd=...codegraph-win32-x64\node.exe --liftoff-only ...
  pid=37536 ppid=24700 name=node.exe cmd=...npx-cli.js -y @z_ai/mcp-server
  pid=49752 ppid=16632 name=node.exe cmd=...codegraph-win32-x64\node.exe -e ...
  pid=50912 ppid=35256 name=opencode.exe cmd=...opencode.exe serve --port 59268 --hostname 127.0.0.1 --print-logs --log-level INFO
  pid=51496 ppid=50912 name=conhost.exe ...
  pid=49472 ppid=35256 name=opencode.exe cmd=...opencode.exe serve --port 54722 --hostname 127.0.0.1 --print-logs --log-level INFO
  pid=2428  ppid=49472 name=conhost.exe ...
  pid=36188 ppid=37536 name=cmd.exe cmd=cmd.exe /d /s /c zai-mcp-server
  pid=57576 ppid=36188 name=node.exe cmd=...npm-cache\_npx\...@z_ai\mcp-server\build\index.js
```

`taskkill /F /PID <宿主>`（无 /T）之后：

```text
[fkjob] 强杀后进程清单：worker 后代 0 个，marker 命中 0 个（强杀前 3 个 CLI 子孙 + 宿主/guard/worker 全部消失）
```

断言链（全部通过）：guard 观察宿主死亡退出 → 命名 job 名字消失（job 随 guard 退出销毁）→ worker 死亡 → 每个 CLI pid（claude + 两 opencode）死亡 → `expect.poll` worker 后代树归零 + marker 计数归零。**注意后代树包含 CLI 自身拉起的 MCP server 孙进程（npx/codegraph/z_ai 链）与 conhost——全部随 job 销毁消失，无需逐个登记。**

## 3. Job Object 兜底结论

机制链每一环都有独立断言，与运行环境自身的 job 无关（只看我方命名 job）：

1. guard 用生产 `JOB_GUARD_PS` 创建命名 job 并把 worker 绑入（worker `IsProcessInJob` 确认后才建会话）；
2. **布防证明**：按名查询 `LimitFlags=0x2000`（含 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）；
3. **成员证明**：`ProcessIdList` 17 个成员，断言含 worker pid 与全部 CLI pid（worker 内 spawn 的子孙进程按 Windows 语义自动继承 job 成员身份）；
4. **触发证明**：taskkill /F 只杀宿主（无 /T）→ guard `WaitForSingleObject` 返回退出（唯一 job 句柄关闭）→ 命名 job 消失；
5. **效果证明**：job 全部成员（worker + claude + 两 opencode server + 各自孙进程）被 OS 终止，CIM 双口径归零。

**结论：宿主被强杀（模拟应用被 taskkill /F）时，Job Object（KILL_ON_JOB_CLOSE）兜底成立，无孤儿 CLI 进程。**

## 4. 实证过程中的重要发现：生产 guard 曾从未布防（已修复）

编排初版只断言「强杀后归零」时，在无 guard / 去标志的对照组中进程树**依然全灭**——进一步实验发现本开发运行环境自身把测试进程树放入了另一个 job（裸 node 进程 `IsProcessInJob` 即 INJOB），环境 job 的清场掩盖了结果，使「归零」断言在本机可能空转绿。为此引入 §3 的机制级断言（布防 + 成员 + 销毁三证明），并顺带实锤：

- **缺陷**：`JOB_GUARD_PS` 中 `$info.B.LimitFlags = 0x2000` 是 PowerShell 5.1 嵌套 struct 赋值的经典静默无效（读取 `$info.B` 副本上改，改动随副本丢弃）。#29 修复的是字段名不一致导致的 `PropertyAssignmentException`（崩溃），但修完后赋值变成静默 no-op——**guard 从未布防 KILL_ON_JOB_CLOSE**。本机实证（生产脚本原文 + 独立 job 查询探针）：job 创建成功、成员指派成功，但 `LimitFlags` 读回 `0x0`，短命宿主死亡 guard 退出后**成员存活**。在无环境 job 干净场景（真实用户桌面）下，这意味着应用被强杀后 CLI 子孙进程会全部成为孤儿。
- **修复**（`packages/cli-host/src/host/job-guard.ts`）：副本改完整体拷回——`$__b = $info.B; $__b.LimitFlags = 0x2000; $info.B = $__b`。修复后实证：`LimitFlags=0x2000`、job 销毁成员全灭；`run-once-job.e2e.test.ts` 回归通过（此前在本机通过依赖环境 job 清场，属于侥幸绿）。
- **回归锚点**：密封测试 `job-guard.test.ts` 增加「拷回模式在场 + 嵌套直赋值不在场」断言；本 e2e 的布防/成员断言是机制级回归。

## 5. 已知限制：PTY 子树不在覆盖范围（spec #40 D3 非目标）

- PTY 终端由 node-pty 在 **Electron Main 进程** spawn（`pty-host.ts`），**不经 CliHost worker、不在本 Job Object 绑定范围**；Main 被强杀时 PTY 子进程（shell 及其子孙）不受 Job 兜底，属于残留治理的已知限制（D3：shell 进程匹配误检面过大，明确非目标）。
- 正常退出路径的 PTY 治理由既有 C 类 `lifecycle.spec.ts`「正常退出无孤儿（§6.1）」覆盖（killAll 主动终止，非 Job 兜底）。
- 本测试的覆盖边界 = **CliHost worker 内 spawn 的全部结构化 CLI 子孙进程**（三 CLI Adapter 的会话进程与 OpenCode server，含其孙进程）。

## 6. 复现命令

```bash
KANBAN_E2E=1 KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna pnpm --filter @kanban/cli-host exec vitest run tests/e2e/force-kill-job.e2e.test.ts
```

（全程零 token：不发 turn、无模型调用；`KANBAN_CODEX_MODEL` 仅为命令惯例，本测试不经 codex。）
