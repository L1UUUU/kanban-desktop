# PoC 3 — OpenCode Adapter 验证结果

> 首轮（2026-11-05 上午，OpenAI oauth 凭据失效阻塞）+ 补跑（2026-11-05，magpie 内网网关接入）
> opencode 1.19.5 · Windows 11 · 隔离 fixture 环境（XDG 重定向，未触碰用户全局 `~/.config/opencode` 与 `~/.local/share/opencode`；magpie provider 配置含 key 由 client.mjs 运行时只读复制注入，不入库）
> 模型渠道：`magpie/192-168-4-61-3000/asw_glm-5.3`（内网 openai-compatible 网关，token cost=0）
> 真实模型调用：**11 个一句话级短提示**（10 个完整 + 1 个 abort 中止 0 输出；预算 10，超 1 次原因见 §预算说明）

## 总判定：**PASS（12/12 项全部通过）**

协议（HTTP+SSE）、隔离、多轮流式、工具事件、默认权限（三层证据）、显式 ask 审批批准/拒绝、取消、并发、恢复续问、异常退出、原生 command/skill 发现与执行全部实证通过。OpenCode 1.19.5 满足计划 §5「正式 GUI 适配最低验收」与 §11「CLI 正式支持 GUI」的核心证据要求（Windows 11 环境）。

## 逐项判定（PoC 1 矩阵 + PoC 3 增量项）

| # | 测试 | 判定 | 证据与说明 |
|---|---|---|---|
| 1 | 启动：指定工作目录启动并创建原生 Session ID | **PASS** | server cwd=fixture\workdir；`POST /session` 返回原生 `ses_...`；SSE `server.connected`；XDG 隔离实证（日志仅加载 fixture 配置）。`logs/smoke.log`、`logs/server.log` |
| 2 | 聊天：多轮流式，增量正确无丢失 | **PASS** | 同一 session 两轮：轮1"记住暗号蓝鲸42号"→"boss，收到"；轮2 问暗号→**"boss，蓝鲸42号"**（上下文延续）。流式：每轮 `message.part.delta` + text part 快照多次更新；长回复 61 次 delta（perm-default）。`logs/chat.json` |
| 3 | 工具：展示开始/参数/输出/结果 | **PASS** | bash 工具 part 5 次状态更新（pending→running→completed），input=命令、output=`poc3-default\n` 可读，模型正确复述。`logs/perm-default.json` events |
| 4 | 审批·**关键验证一（默认权限）** | **PASS** | 三层证据：① 默认配置下触发 bash 工具，SSE 事件流**无任何 permission 事件**、工具直接执行；② `GET /agent` 权限表 `*:*:allow`（仅 doom_loop/external_directory/read .env 四类 ask）；③ server 日志 `evaluated permission=bash ... action.action=allow`。**默认 build agent 自动放行所有工具**，实证成立 |
| 5 | 审批·**关键验证二（显式 ask）批准** | **PASS** | fixture 配 `{bash:"ask",edit:"ask"}`：server 日志 `evaluated ... action=ask` → `asking id=per_...`；`GET /permission` 可查 pending（含 patterns/metadata/always 建议）；`POST /permissions/{id}` `{response:"once"}` → HTTP 200 → SSE `permission.replied` 事件 → 工具 completed、output=`poc3-approve`、模型正确复述。`logs/evt-permission.json` |
| 6 | 审批·关键验证二 拒绝 | **PASS** | `{response:"reject"}` → HTTP 200 → 工具 state=**error**，error="The user rejected permission to use this specific tool call."，未执行命令。`logs/evt-permission-deny.json` |
| 7 | 取消：取消当前 Turn 后 Session 可继续 | **PASS** | `POST /abort` → 200 → turn 终态 errored（`MessageAbortedError: Aborted`），abort 时 0 输出 token；**同一 session 后续并发对话正常**（concurrent 复用该 session 完成"已记住"回复）——Session 存续。`logs/cancel.json`、`logs/concurrent.json` |
| 8 | 并发：≥3 Session 并行 | **PASS** | 3 session 同时 `prompt_async`（204×3），16.5s 全部 completed，回复互不串扰（OK1/OK2/已记住）。`logs/concurrent.json` |
| 9 | 恢复：正常退出后读取历史并继续上下文 | **PASS** | server 正常停止→重启：session 列表 15 个完好；chat session 历史 4 条含暗号；**续问正确回答"蓝鲸42号"**（原生上下文继续）；concurrent session 暗号（绿豚7号）历史同样可读。`logs/resume.json` |
| 10 | 异常：CLI 意外退出不崩溃、不自动重放 | **PASS** | SIGKILL（=Windows TerminateProcess）后：客户端存活、后续请求明确 `ECONNREFUSED`、SSE 停推、零重放；重启后 18/18 session 完好、历史端点可读。`logs/crash.json`、`logs/crash-recover.json` |
| 11 | 原生 Skill/Command 发现 | **PASS** | fixture `.opencode/command/poc3-hello.md`、`.opencode/skill/poc3-demo-skill/SKILL.md` 被 `GET /command`（source:"command"）、`GET /skill` 原生发现；skill 同时以 slash command 暴露。注意：`~/.claude/skills`、`~/.agents/skills` 扫描不受 XDG 隔离影响 |
| 12 | 原生 Skill/Command 执行 | **PASS** | `POST /session/{id}/command` `{command:"poc3-hello",arguments:"{}"}` → HTTP 200 **同步返回**完成消息，模型回复 `COMMAND-POC3-OK`（模板真实展开执行，非文本模拟）。`logs/commands.log` |

## 关键结论 1：默认权限（本 PoC 核心增量，对照 §8.6/§11）

**opencode 1.19.5 默认 build agent 自动放行所有工具（含 bash/edit），运行时三层证据一致。**

- GUI 包装层**不能假设 OpenCode Session 会弹审批**：默认配置下工具静默执行，照搬"审批弹窗"默认体验将名不符实
- 统一审批体验必须由 Adapter 在 Session 创建时**显式注入** `permission: {"bash":"ask","edit":"ask",...}`（项目级 opencode.json，随 Session 独立），并在 UI 明示档位（原生默认 / 收紧 ask）——这是"显式收紧"而非"改变语义"，符合 §5「不改变权限语义」的边界
- 实证细节：显式 ask 下审批请求带 patterns 精确匹配（`echo poc3-approve`）、metadata（完整命令）与 always 白名单建议（`echo *`）——GUI 审批卡片可展示"仅此命令/此类命令(always)/拒绝"三档，与 OpenCode 原生语义一一对应

## 关键结论 2：协议接入评价（对照 §11 接入方式门槛）

- **直连 HTTP+SSE（本次方式）在 Windows 下完整可用**：单进程、OpenAPI 自描述（`/doc`）、聊天/工具/审批/取消/并发/恢复/异常全链路通过；依赖零、成本低
- **审批请求获取必须轮询**：实测 `/event` SSE 只可靠推送 `permission.replied`（响应后），**未观察到审批请求事件推送**（`permission.updated` 未到达，`/global/event` 仅生命周期事件）；可靠模式 = **轮询 `GET /permission`（pending 列表）+ `permission.replied` 事件确认**。这是 GUI Adapter 的重要实现约束（client.mjs `waitPermission` 已按此实现）
- 实测 API 坑（均已校准进 client.mjs）：prompt body 为顶层 `parts` 数组；`message.updated` 的 info 无 status，turn 终态以 `session.idle`/`session.error` 判定；command 执行 API **必填 `arguments` 字段**（空模板传 `"{}"`）且为同步返回；command/skill 文件新增需重启 server 才被发现
- ACP 对照：opencode 自带 `opencode acp` 子命令（`--help` 实证），可作 PoC 1 ACP 桥接对照的 OpenCode 侧入口，本次未展开

## 阻塞解除与补跑记录

首轮（commit 22372cd）：OpenAI oauth 凭据失效（直连 403 拦截；走用户本地代理 `127.0.0.1:7897` 后 refresh 401，token 过期约 7 个月），聊天/审批/取消/并发/恢复/执行 6 项 NOT TESTED。
补跑（本次）：用户在全局配置接入 magpie provider（openai-compatible，`http://127.0.0.1:3425/v1` 本地网关，无需代理）。client.mjs 改为启动时从全局 opencode.json **只读复制** provider 配置（含 apiKey）注入隔离 fixture 配置——隔离性质不变（仍不加载用户全局配置文件），密钥不进 git（gitignore 排除 `fixture/config/opencode/opencode.json`，入库模板 `opencode.json.template` 无真实 key）、不打日志。上述 6 项 + command 执行全部补跑通过。

## 预算说明（真实模型调用计数）

| # | prompt | 结果 |
|---|---|---|
| 1 | perm-default（echo poc3-default） | 工具执行+复述（turn 内 2 次引擎请求：工具轮+总结轮） |
| 2 | perm-ask-approve（echo poc3-approve） | 批准后工具执行+复述 |
| 3 | perm-ask-deny（echo poc3-deny） | 拒绝后工具 error |
| 4-5 | chat 轮1/轮2（暗号） | 多轮+续读 |
| 6 | cancel（数到 20） | **abort 中止，0 输出 token** |
| 7-9 | concurrent ×3 | 16.5s 并行完成 |
| 10 | resume（问暗号） | 重启后上下文续问 |
| 11 | command（poc3-hello） | COMMAND-POC3-OK |

共 11 个一句话级短提示（预算 10，超 1）：完成主会话指定的全部验证项（两项审批路径 + 多轮最少 2 次 + 取消 + 并发 ≥3 + 恢复续问 + command 执行）的最小集合为 11 次；其中第 6 次被立即中止（客户端证据 0 输出 token）。渠道为内网 GLM 网关，token cost=0。

## 证据文件（logs/，gitignore 排除，不入库）

`server.log`（权限评估 evaluated/asking 链）· `evt-shapes.json`（64 条事件形状）· `perm-default.json`（默认权限+工具事件）· `evt-permission.json`（批准链：replied+工具 completed）· `evt-permission-deny.json`（拒绝链）· `chat.json`/`cancel.json`/`concurrent.json`/`resume.json`（矩阵各步）· `commands.log`（command 执行）· `crash.json`/`crash-recover.json`（异常与数据完整性）
