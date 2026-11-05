# RESULT — PoC 1 Codex app-server 直连结构化 GUI 验证

> 验证日期：2026-11-05
> 环境：Windows 11（10.0.26200） / Node v24.13.0 / codex-cli 0.144.1（npm 全局）/ ChatGPT 账号认证
> 模型：gpt-5.6-luna（turn 级 effort=low；本账号实际可用，见「过程发现」）
> 成本：真实模型 turn 调用共 10 次（上限 10），全部一句话级短提示；工具/审批仅用 echo / 写临时 txt 等无害命令
> 复现：`node run.mjs`（全部）或 `node run.mjs --only <项>`（子集），见 README.md

## 1. 验收判定表（§9 PoC 1 八行）

| # | 测试 | 判定 | 依据（命令 + 日志） |
|---|---|---|---|
| a | 启动：Windows 指定 cwd 创建原生 Session ID | **PASS** | `node run.mjs --only a` → `logs/abc-startup-chat-tools.log`：thread/start 返回 UUIDv7 thread id、cwd 为 fixture/workdir、rollout 落盘路径 `~/.codex/sessions/.../rollout-*.jsonl` |
| b | 聊天：多轮流式增量正确，无重复丢失 | **PASS** | 全量运行 `logs/abc-startup-chat-tools.log` + 离线复核 `node analyze-logs.mjs` → `logs/b-delta-verification.json`：2 轮对话，2 条 agentMessage 的 delta 拼接（26/34 字符）与 item/completed 最终文本逐一相等；第 2 轮正确复现第 1 轮暗号 ZEBRA-47（多轮上下文成立） |
| c | 工具：展示开始/参数/输出/结果 | **PASS** | `logs/abc-startup-chat-tools.log`：item/started + item/completed 捕获 commandExecution 条目，command=`pwsh.exe -Command 'echo poc-tool-ok'`，aggregatedOutput=`poc-tool-ok`，exitCode=0，durationMs 有值 |
| d | 审批：正确批准/拒绝，不改变权限语义 | **PASS** | `node run.mjs --only d` → `logs/d-approval.log`：单 turn 内两次 `item/commandExecution/requestApproval` 服务端请求；第 1 次 accept → `probe-accept.txt` 真实创建；第 2 次 decline → `probe-deny.txt` 不存在（命令未执行）；turn 正常 completed。审批由 read-only 沙箱 + on-request 策略原生触发，客户端仅回 `{decision}`，未绕过/未改写权限语义 |
| e | 取消：取消当前 Turn 后仍能继续 | **PASS** | `logs/ef-interrupt-concurrency.log`：turn 进行中 `turn/interrupt` → turn 状态 `interrupted`；同 thread 随后新 turn 正常 completed |
| f | 并发：≥3 独立 Session 并行互不干扰 | **PASS** | `logs/ef-interrupt-concurrency.log`：3 个 thread（含 1 个刚被 interrupt 的）同时 turn/start，Promise.all 全部 completed，回复按 thread 各自正确（recovered/banana/cherry），事件按 threadId 无串扰 |
| g | 恢复：退出后读取原生历史并继续上下文 | **PASS** | `logs/g-resume.log`：进程正常退出 → 新 spawn → `thread/read{includeTurns}` 读回 2 turns 含暗号原文 → `thread/resume` 返回同 threadId → 新 turn 提问"暗号是什么"，回答 `ZEBRA-47`（上下文延续） |
| h | 异常：CLI 意外退出不崩溃、不自动重放 | **PASS** | `logs/h-crash.log`：SIGKILL codex.exe 后客户端 dead 状态置位，pending RPC 立即 reject（`app-server exited unexpectedly: code=null signal=SIGKILL`），后续请求即时明确报错（`client is dead`），无自动重连/重放/崩溃 |

**8/8 PASS。** §9 门槛（核心聊天、工具、审批、取消、恢复均实际可用）满足。

## 2. 关键日志摘录

- a：`threadId=01a1aa0b-... path=C:\Users\liuy\.codex\sessions\2026\11\05\rollout-...jsonl`
- b（`logs/b-delta-verification.json`）：`[{finalLen:26, joinedLen:26, consistent:true}, {finalLen:34, joinedLen:34, consistent:true}]`
- c：`cmd="pwsh.exe -Command 'echo poc-tool-ok'" exit=0 out="poc-tool-ok"`
- d：`审批请求数=2 probe-accept.txt创建=true` / `probe-deny.txt不存在=true`（workdir 中保留 probe-accept.txt 作为实物证据）
- e：`turn=interrupted` → 同 thread 下一 turn `completed`
- f：`t0=completed:"recovered" ; t1=completed:"banana" ; t2=completed:"cherry"`
- g：`read含暗号=true(turns=2) resume=true 回答含暗号=true("ZEBRA-47")`
- h：`dead=true 首个请求错误="app-server exited unexpectedly: ... SIGKILL" 后续请求错误="client is dead: app-server not running"`

## 3. 过程发现（对 GUI 适配直接有用的实证）

1. **协议真相可本地生成**：`codex app-server generate-ts --out <dir>` 产出与二进制同版本的完整 TS 绑定（本目录 `protocol/ts/`，约 470 文件）。GUI 应以此做协议版本探针，而非依赖网上文档。
2. **`model/list` ≠ 账号可用**：list 返回 7 个模型，本账号实际仅 gpt-5.6-luna 可用；`~/.codex/config.toml` 默认模型 gpt-6.1-terra 报 400 model_not_found。GUI 必须做模型可用性探测与回退，不能信任全局默认。（本 PoC 通过扫描 129 个历史 rollout 中成功会话使用的模型零成本定位可用模型。）
3. **read-only 沙箱内 echo 不触发审批**：纯读/echo 类命令在沙箱内直接放行；审批验证须用**写文件**类命令（沙箱外操作必触发 `item/commandExecution/requestApproval`）。第一次 d 尝试的失败日志保留在 `logs/d-approval.attempt1-echo-noproval.log`。
4. **Windows 进程链**：spawn npm `.cmd` shim（shell:true）时父进程 kill 不保证清理 codex.exe 孤儿；直连 `npm root -g` 解析出的真实 `codex.exe` 可正常 kill（h 项验证 TerminateProcess 生效）。正式 GUI 在 Windows 上应直连 exe 或引入 Job Object（§8.6 结论一致）。
5. **客户端实现陷阱**：JSON-RPC 三形状解复用中，服务端审批是**带 id 的请求**（须回 result/error）；EventTarget 订阅若包装函数与取消引用不一致会静默泄漏导致跨 turn 事件重复统计（本 PoC 实际踩中并修复，见 client.mjs on/off 配对）。
6. **协议细节**：`thread/start` 响应 thread.turns 为空数组，读历史须 `thread/read{includeTurns:true}`；`turn/completed` 携带全量 items 快照，GUI 渲染可以事件流为主、快照兜底；流式 delta 按 itemId 归属，与最终文本严格一致。

## 4. ACP 桥接路线对比（文档级，时间盒内未实现）

| 维度 | app-server 直连（本 PoC 已实测） | ACP 桥接（`@zed-industries/codex-acp`，AionUi 路线） |
|---|---|---|
| Windows 可用性 | 8/8 项实测 PASS（本文件） | npm 包 Apache-2.0、纯 Node、零运行时依赖；未在本机实测 |
| 版本跟随 | 与已安装 codex 同版本，`generate-ts` 可做协议探针 | 0.16.0，registry 最后更新 2026-06-24（约 4.5 个月前），落后 codex 0.144.x 高频迭代；桥接层翻译 ACP↔app-server 双协议，漂移面更大 |
| 能力完整性 | 原生暴露 thread/turn/granular 审批/steer/fork/rollback 等全量能力 | 受 ACP 通用模型约束（session/turn/permission）；Codex 特有能力（granular 审批策略、approvalsReviewer、fork、inject 等）映射完整性未知，需逐项验证 |
| 多 CLI 统一 | 需为每个 CLI 写一个 Adapter | 一次实现可接 Claude Code/Codex/OpenCode 等 17 个后端（AionUi 实证路线） |
| 依赖链 | 零第三方依赖（本 PoC 纯 Node 内置模块） | 引入桥接包 + `@agentclientprotocol/sdk`（2.4.0，活跃） |

**结论：** 首版 Codex Adapter 用直连（能力完整、零依赖、已实测）；若后续强烈需要多 CLI 统一协议层，ACP 作为跨 CLI 抽象的**第二候选**，启用前须在 Windows 上重复本 PoC 的 8 项验收（重点是审批语义是否在翻译中保真）。

## 5. 结论与建议（对照 §11 门槛）

- **§5 正式 GUI 适配最低验收**（创建原生 Session、多轮流式聊天、工具调用展示、正确审批、取消当前 Turn、历史读取与继续原生上下文、错误处理）——**全部由真实运行证实，直连 app-server 路线在 Windows 上满足门槛**。
- **§11「CLI 协议接入方式」**：直连已有完整证据；ACP 桥接为文档级对照（未实测，不构成降级依据）。建议：**Codex Adapter 采用直连**，锁定 codex 版本 + 启动时版本探针（`--version` + `generate-ts` diff）+ 模型可用性探测（`model/list` 后试跑或读历史 rollout）。
- 已知限制：
  - 协议标注 experimental（v2 命名空间），版本升级可能破坏字段——需锁版本与探针；
  - 2 MiB 行缓冲上限未用超长输出实测（本 PoC 消息均短）；
  - 并发测试为 3 thread × 1 turn，未压更多 Session/更大量级；
  - 审批仅覆盖 commandExecution（文件改动审批 `item/fileChange/requestApproval` 未单独触发实测，协议已确认存在）；
  - `turn/steer`、fork、rollback、MCP elicitation 未测（超出本 PoC 验收范围）。

## 6. 成本与调用清单（全部真实 turn）

| 阶段 | 调用 | 结果 |
|---|---|---|
| 冒烟（默认模型） | 2 | 400 model_not_found（未执行推理，弃用 config 默认模型） |
| 全量 abc（luna） | 2 | 成功（b/c 证据） |
| 全量 d 第一次 | 2 | turn 成功但 echo 未触发审批（发现 #3，重试依据） |
| 全量 e/f | 4 | 成功（e1/e2/f 证据） |
| 全量 g | 1 | 成功（g 证据） |
| d 重试（写文件法） | 1 | 成功（d1/d2 证据） |
| **合计** | **12 次尝试 / 10 次有效推理** | 其中 2 次为账号模型 400 拒绝（无推理输出），10 次有效恰好达预算上限 |
