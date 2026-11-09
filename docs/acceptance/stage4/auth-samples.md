# 阶段 4 认证失效（AUTH_EXPIRED）报错样本矩阵（#41）

> 用途：`session_error.code = AUTH_EXPIRED` 协议级检测的实证留证（spec #40 B 节 / F3 处置）。
> 每条样本标注：触发方式、协议层报错原文、Adapter 归类结果。真实触发的样本附取证环境；构造样本如实标注「构造样本，未真实触发」。
> 检测实现：`packages/cli-host/src/session-error.ts`（文本标记）+ 各 Adapter 结构化字段判定（状态码优先，文本兜底）。

## 归类规则（Adapter 侧协议级，非 renderer 消息启发式）

| 判定输入 | 优先级 | 归类 |
|---|---|---|
| claude result `api_error_status` = 401/403 | 结构化字段 | AUTH_EXPIRED |
| opencode HTTP 响应 `status` = 401/403 | 结构化字段 | AUTH_EXPIRED |
| 协议错误文本命中认证标记（`session-error.ts` AUTH_TEXT_MARKERS） | 文本兜底 | AUTH_EXPIRED |
| opencode 传输不可达（server 请求失败 / fetch failed / ECONNREFUSED 等） | 文本兜底 | PROTOCOL_DISCONNECT |
| 其余已知来源错误（turn 执行失败 / 提交失败 / 网关错误） | 兜底 | INTERNAL |

INTERNAL vs PROTOCOL_DISCONNECT 的归类依据：INTERNAL = 请求已到达 server / CLI 并得到明确失败响应（turn 执行失败、HTTP 4xx/5xx 响应体、网关 500）；PROTOCOL_DISCONNECT = 请求根本不可达（本地 server 进程退出 / 端口不可达 / 连接被对端关闭），对应 US 12「恢复会话时按需重新拉起 server」。codex/claude 的进程级死亡不归 session_error（既有 session_exit 通道，renderer 侧由 S4-02 映射 CLI_EXIT），故两 CLI 无 PROTOCOL_DISCONNECT 发射点。

## Claude Code（claude 2.1.317，stream-json）——真实触发 ✅

**触发方式**：环境变量注入无效 API key 后发一轮消息（不落盘、不改任何已存登录态）：

```bash
ANTHROPIC_API_KEY="sk-ant-invalid-kb41-probe" claude --print --output-format stream-json --verbose \
  --input-format stream-json --permission-prompt-tool stdio --model claude-sonnet-4-5
# stdin: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
```

**重试中间态原文**（每轮间隔递增，共 10 次，约 190s 耗尽；此时段内无任何 assistant 输出）：

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":595,
 "error_status":401,"error":"authentication_failed","session_id":"…","uuid":"…"}
```

**终态 result 原文**（重试耗尽后；注意 `subtype` 仍为 `"success"`，靠 `is_error`/`api_error_status` 区分——本票 Adapter 检测点）：

```json
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,
 "terminal_reason":"api_error","total_cost_usd":0,
 "result":"Failed to authenticate. API Error: 401 无效的令牌 (request id: 202611090807431834704041NFEVlSp)",
 "duration_ms":189622,…}
```

**归类结果**：`AUTH_EXPIRED`（检测点：`claude-adapter.ts` handleResult —— `subtype==="success" && is_error===true` 分支，`api_error_status=401` 结构化判定优先；无结构化状态时以 `isAuthFailureText(result)` 文本兜底，`Failed to authenticate` / `API Error: 401` 均在标记清单内）。
非认证类 `result`（如 `error_max_turns` 超限）→ `INTERNAL`。

## Codex（codex-cli 0.167.0，app-server JSON-RPC）——真实触发未果，构造样本 ⚠️

**已尝试的真实触发**（2026-11-09 取证）：

1. 空 `CODEX_HOME`（登出态，`codex login status` 输出 `Not logged in`）：`thread/start` 成功、`turn/start` 成功返回 inProgress，此后 ≥35s 无 `error` 通知、turn 无终态（静默挂起）。
2. `CODEX_HOME` 内伪造形状合法但内容无效的 `auth.json`（模拟 token 过期）：同上，turn 记录 userMessage 后挂起 ≥35s，无错误浮出。

**结论**：0.167.0 在 app-server 形态下认证失效不向协议层快速浮出（等待登录/静默重试），真实协议报错原文未能捕获；归类依赖下方构造样本。

**构造样本（未真实触发）**，覆盖三个发射点：

| 发射点（codex-adapter.ts） | 构造报错原文 | 归类 |
|---|---|---|
| `turn/start` 提交失败（JSON-RPC error） | `rpc 401: Not logged in. Please log in with ChatGPT.` | AUTH_EXPIRED（`please log in` / `not logged in` / `log in with chatgpt` 标记） |
| `error` 通知（willRetry=false） | `Please log in with ChatGPT to continue` | AUTH_EXPIRED（同上） |
| `error` 通知（willRetry=false） | `401 Unauthorized: ChatGPT login expired` | AUTH_EXPIRED（`unauthorized` / `401`） |
| `turn/completed` failed 终态 | `model_not_found` | INTERNAL（无认证标记） |

## OpenCode（opencode-ai 1.15.x，HTTP+SSE）——HTTP 状态码检测 + 构造文本样本 ⚠️

**真实触发尝试**（2026-11-09 取证）：临时目录 `opencode serve` + `OPENCODE_CONFIG` 覆盖 anthropic provider `apiKey` 为无效值（并隔离 HOME），`prompt_async` 返回 204 后 assistant 消息为空（parts: []、0 tokens），未浮出 session.error 认证报错 → provider 认证失败原文未能真实捕获。**但同链路真实捕获了 `session.error` SSE 帧形状**（用不存在的 model id 触发）：

```json
{"id":"evt_…","type":"session.error","properties":{"sessionID":"ses_…",
 "error":{"name":"UnknownError","data":{"message":"Model not found: anthropic/claude-sonnet-4-…"}}}}
```

（注意 `message` 嵌在 `data` 内、无顶层 `message`——Adapter 的 `handleSessionError` 已兼容此形状。）

**检测点与构造样本（未真实触发）**：

| 发射点（opencode-adapter.ts） | 构造报错原文 | 归类 |
|---|---|---|
| `prompt_async`/`command` HTTP 响应 | `HTTP 401 invalid x-api-key` | AUTH_EXPIRED（结构化 `status===401` 判定，无需文本） |
| `command` HTTP 响应 | `command 执行失败：HTTP 403 …` | AUTH_EXPIRED（结构化 `status===403`） |
| `session.error`（idle 终态报出） | `AiSdkError: 401 Unauthorized: API key invalid` | AUTH_EXPIRED（`unauthorized` / `invalid api key` 标记） |
| `prompt_async` 传输异常 | `opencode server 请求失败（POST /session/…/prompt_async）：fetch failed` | PROTOCOL_DISCONNECT（`server 请求失败` / `fetch failed`，client.ts 抛错原文） |
| `session.error`（idle 终态报出） | `AiSdkError: gateway 500` | INTERNAL |

## FakeAdapter（演示脚本）

`ERROR_SCRIPT`（输入含「错误/异常」触发）原 `E_FAKE_CRASH` → 归类 `CLI_EXIT`（语义：Fake CLI 进程意外退出）；`ScriptStep.error.code` 收紧为六成员枚举直通（S4 错误演示的确定性入口，枚举外值编译期拒绝）。
