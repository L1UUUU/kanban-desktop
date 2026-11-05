# PoC 1 — Codex app-server 直连结构化 GUI 验证

> 目的：验证 Windows 上通过 `codex app-server`（JSON-RPC 2.0 over stdio）实现 GUI 所需的全部核心能力：启动、多轮流式聊天、工具展示、审批、取消、并发、恢复、异常处理。
> 对应计划：`docs/kanban-desktop-v1-plan.md` §5 / §8.6 / §9 PoC 1 / §11。

## 环境

- Windows 11（10.0.26200），Node v24.13.0
- codex-cli 0.144.1（npm 全局安装），`~/.codex/auth.json` 已认证（ChatGPT 账号）
- 本 PoC 零第三方依赖（纯 Node 内置模块）

## 文件说明

| 文件 | 用途 |
|---|---|
| `client.mjs` | 最小 app-server 客户端：spawn codex.exe、LF 行分帧、JSON-RPC 请求/通知/服务端请求解复用、按 thread 串行化 turn |
| `run.mjs` | 8 项验收测试运行器（a 启动 / b 聊天 / c 工具 / d 审批 / e 取消 / f 并发 / g 恢复 / h 异常） |
| `analyze-logs.mjs` | 离线复核 b 项：解析协议日志校验 delta 拼接与最终文本一致（零模型调用） |
| `list-models.mjs` | 零成本探测：`initialize` + `model/list`（不发起 turn） |
| `protocol/ts/` | 用 `codex app-server generate-ts` 在本机生成的协议 TS 绑定（协议真相，见 NOTES.md） |
| `fixture/workdir/` | 会话工作目录（无害 fixture 文件） |
| `logs/` | 每项测试的 JSONL 协议日志 + 汇总 |
| `NOTES.md` | 协议调研结论（方法/事件/参数枚举 + 证据来源） |
| `RESULT.md` | 验收判定表与结论 |

## 复现

```bash
cd poc/poc-1-codex-appserver

# 全量 8 项（消耗真实模型调用 ≤9 次，一句话级短提示）
node run.mjs

# 单项子集（a 不消耗模型调用）
node run.mjs --only a
node run.mjs --only b,c
node run.mjs --only d

# 指定模型（默认 gpt-5.6-luna；注意：config.toml 默认模型与 model/list 多数条目在本账号报 400）
node run.mjs --model gpt-5.6-luna

# 零成本协议探测
node list-models.mjs
```

判定输出示例（`logs/run-console.txt` 同步留档）：

```text
[PASS] a 启动：指定 cwd thread/start 拿原生 id — threadId=... cwd=... path=...
[PASS] b 聊天：≥2 轮流式无重复丢失 — ...
==== 汇总 ====
...
真实模型 turn 调用次数：9（上限 10）
```

## 关键实现点（给后续 GUI Adapter 的交接说明）

1. **启动**：直接 spawn 真实 `codex.exe`（从 `npm root -g` 解析），不用 `.cmd` shim + shell 链——后者在 Windows 上 kill 时会残留孤儿进程（本 PoC 实测发现）。
2. **协议**：`initialize` → `thread/start{cwd}` → `turn/start{threadId,input,approvalPolicy?}`；事件按 `threadId` 过滤即可多会话并发；同一 thread 内 turn 需串行。
3. **审批**：服务端以 JSON-RPC **请求**（带 id）发 `item/commandExecution/requestApproval`，客户端回 `{id, result:{decision}}`；`decline` 即拒绝执行。
4. **模型选择陷阱**：`model/list` 返回已知模型≠账号可用；本机 `~/.codex/config.toml` 默认模型在本账号实际报 400。GUI 必须提供模型探测/回退，不能信任全局默认。
5. **成本控制**：`turn/start` 的 `effort` 参数可按 turn 覆盖推理档位（本机全局配置为 max，短任务用 low）。
