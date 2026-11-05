# NOTES — Codex app-server 协议调研结论

> 调研日期：2026-11-05
> CLI 版本：codex-cli 0.144.1（`codex --version`）
> 安装方式：npm 全局 `@openai/codex@0.144.1`（Windows x64，bin shim 为 `C:\Users\liuy\AppData\Roaming\npm\codex.cmd`）

## 1. 权威本地证据来源（不依赖网络文档）

codex 0.144.1 自带协议生成器（`codex app-server generate-ts --help` 输出确认）：

```text
codex app-server generate-ts --out protocol/ts          # 生成 TS 类型绑定（本目录 protocol/ts/）
codex app-server generate-json-schema --out <DIR>       # 生成 JSON Schema（可选）
```

本 PoC 用 `generate-ts` 在本机生成了完整协议类型（约 470 个 .ts 文件，见 `protocol/ts/`，顶层 + v2/ 命名空间）。
**这是与已安装二进制严格同版本的协议真相，优于任何 GitHub 文档。** 后续版本可重复此命令做协议漂移探测。

## 2. 传输与分帧

- 传输：JSON-RPC 2.0 over stdio，`codex app-server` 默认 `--listen stdio://`（`codex app-server --help` 输出确认）。
- 分帧：每行一个 JSON 对象，LF（`\n`）结尾。计划文档 §8.6 所述 2 MiB 行缓冲上限在本测试的短消息场景未触及（已知限制：超长 diff 输出需注意）。
- 三种消息形状需解复用（均有 id 字段时为请求/响应；有 method 无 id 为通知；id + method 从服务端发来则为服务端发起请求）。

## 3. 客户端 → 服务端方法（`protocol/ts/ClientRequest.ts`，关键子集）

| 方法 | 参数（关键） | 用途 |
|---|---|---|
| `initialize` | `{clientInfo:{name,title,version}, capabilities?}` | 握手，必须最先调用 |
| `thread/start` | `{cwd?, approvalPolicy?, sandbox?, model?, ...}` | 创建原生会话，响应含 `thread.id`（UUIDv7）、`thread.path`（rollout 文件磁盘路径） |
| `thread/resume` | `{threadId, cwd?, approvalPolicy?, ...}` | 恢复历史会话（优先 threadId） |
| `thread/read` | `{threadId, includeTurns?}` | 读回历史（含完整 turns/items） |
| `thread/list` / `thread/fork` / `thread/archive` / `thread/rollback` | — | 会话管理 |
| `turn/start` | `{threadId, input:[{type:"text",text,...}], approvalPolicy?, cwd?, ...}` | 发起新轮次，响应含 `turn.id` |
| `turn/interrupt` | `{threadId, turnId}` | 取消当前轮次 |
| `turn/steer` | `{threadId, ...}` | 运行中转向（未测） |

`UserInput` 形状：`{type:"text", text, text_elements:[]}`（text_elements 必填，可为空数组）。

## 4. 审批策略枚举（`AskForApproval.ts`）

```text
"untrusted" | "on-request" | {granular:{sandbox_approval,rules,skill_approval,request_permissions,mcp_elicitations}} | "never"
```

按 turn 粒度覆盖：`turn/start` 的 `approvalPolicy` 字段「覆盖本轮及后续轮次」。SandboxMode：`read-only | workspace-write | danger-full-access`。

**实测补充（2026-11-05）：** `sandbox=read-only + approvalPolicy=on-request` 下，纯读命令（pwsh `echo`）在沙箱内直接放行、不触发审批；**写文件命令（`echo x > f.txt`）必然触发** `item/commandExecution/requestApproval`。GUI 审批测试须用越权操作命令。

## 5. 服务端 → 客户端请求（`ServerRequest.ts`，审批/交互）

| 方法 | 参数 → 响应 |
|---|---|
| `item/commandExecution/requestApproval` | `{threadId,turnId,itemId,command,cwd,commandActions,...}` → `{decision}` |
| `item/fileChange/requestApproval` | 文件改动审批 → FileChangeApprovalDecision |
| `item/tool/requestUserInput` | 动态工具问询 |
| `mcpServer/elicitation/request` | MCP elicitation |
| `item/permissions/requestApproval` | 权限档位变更审批 |
| （legacy）`execCommandApproval` / `applyPatchApproval` | 旧版审批，v2 客户端不期望出现 |

`CommandExecutionApprovalDecision`：`accept | acceptForSession | {acceptWithExecpolicyAmendment} | {applyNetworkPolicyAmendment} | decline | cancel`。
服务端请求响应必须带与请求相同的 id，形如 `{id, result:{decision}}` 或 `{id, error}`（JSON-RPC 标准形状）。

## 6. 服务端 → 客户端通知（`ServerNotification.ts`，关键子集）

生命周期：
- `thread/started`、`thread/status/changed`（`ThreadStatus`: notLoaded/idle/systemError/active）
- `turn/started`、`turn/completed`（`TurnStatus`: inProgress/completed/interrupted/failed；turn 对象含完整 items 快照）
- `error`（`{error:{message,...}, willRetry, threadId, turnId}`）

条目事件（item 生命周期，item 对象自带 id）：
- `item/started` / `item/completed`（item 类型：`userMessage | agentMessage | reasoning | plan | commandExecution | fileChange | mcpToolCall | webSearch | ...`，`commandExecution` 含 command/cwd/aggregatedOutput/exitCode/status）
- `item/agentMessage/delta`（流式增量：`{threadId,turnId,itemId,delta}`）
- `item/reasoning/textDelta`、`item/reasoning/summaryTextDelta`
- `item/commandExecution/outputDelta`（命令流式输出）、`item/fileChange/patchUpdated`
- `serverRequest/resolved`（审批请求已被处理的通知）

## 7. Turn/Thread 数据形状

- `Turn = {id, items:[ThreadItem], itemsView, status, error, startedAt, completedAt, durationMs}`
- `Thread = {id, sessionId, cwd, path(rollout 落盘路径), status, turns:[...](仅 resume/read includeTurns 时填充), cliVersion, source, ...}`
- thread/start 响应的 `thread.turns` 为空数组；读历史用 `thread/read{includeTurns:true}`。

## 8. Windows 启动要点

- npm shim 为 `.cmd`：Node spawn 需 `shell:true` 或直接 spawn 真实二进制
  `$(npm root -g)/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`（bin/codex.js 中的解析逻辑证实）。
- 直接 spawn .exe 更稳（避免 shell 引入的信号/引号问题）；.cmd 路径作为回退。
- stdout 为 LF 分帧 JSON；stderr 为人类可读日志（非协议）。

## 9. 跨源对照

- `codex-agent-sdk-go`（计划文档 §8.6 提及）的 ThreadStart/RunStreamed/approval callback/turn interrupt 与上述方法一一对应（README 级，未运行）。
- 本地 `generate-ts` 产物即 SDK 所封装的同一 Rust 协议类型（ts-rs 生成，文件头标注 GENERATED CODE）。

## 10. 版本漂移风险

- 协议带 v2 命名空间且标注 experimental（generate-ts help 文案）。GUI 适配时应锁定 codex 版本并在启动时用 `initialize` + 版本探针（`--version` 输出）校验，失败即降级提示。
