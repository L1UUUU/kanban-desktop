# PoC 3 — OpenCode Adapter 协议调研笔记

> 调研日期：2026-11-05 · opencode 1.19.5 · Windows 11 · Git Bash · Node v24.13.0
> 证据等级标注：`[实证]` = 本机实际运行观察到；`[文档]` = opencode.ai 官方文档；`[推断]` = 未验证的推断

## 1. 版本与环境

| 项 | 值 | 证据 |
|---|---|---|
| CLI 版本 | opencode 1.19.5（npm 包 `opencode-ai`，bin 为 Bun 编译的 `opencode.exe`） | [实证] `opencode --version`、npm 包 package.json |
| 认证 | 仅 1 条 OpenAI oauth 凭据（`~/.local/share/opencode/auth.json`，2172B） | [实证] `opencode auth list`（只读） |
| SDK | `@opencode-ai/sdk@1.19.5` 与 CLI 同版本发布（本次未安装，直接用 HTTP API） | [实证] `npm view @opencode-ai/sdk` |
| server 模式 | `opencode serve --port <p> --hostname 127.0.0.1 --print-logs --log-level DEBUG`；默认 port=0（随机） | [实证] `opencode serve --help` 与实际启动 |

## 2. HTTP API（server 模式）

`[实证]` `GET /doc` 返回完整 OpenAPI 3.1 spec（本次已保存 `doc.json`），所有端点形状以它为准。核心端点：

| 端点 | 用途 | 实测要点 |
|---|---|---|
| `POST /session` body `{title}` | 创建 session | 200 返回 `{id: "ses_..."}` 原生 Session ID |
| `GET /session` | session 列表 | 返回 `{items:[...]}` |
| `GET /session/{id}/message?limit=N` | 读取原生历史 | `{items:[{info, parts}]}` |
| `POST /session/{id}/prompt_async` | 异步发消息（GUI 主路径） | 204；body `{parts:[{type:"text",text}], model:{providerID,modelID}}`——注意 `parts` 在顶层，**不是** SDK 时代的 `message:{build:[...]}` 形状（实测 400 校准所得） |
| `POST /session/{id}/message` | 同步发消息（阻塞到 turn 结束） | 未使用（GUI 用 async + SSE） |
| `POST /session/{id}/abort` | 取消当前 turn | 端点存在 `[实证 /doc]` |
| `POST /session/{id}/permissions/{permissionID}` body `{response:"once"\|"always"\|"reject"}` | 响应审批 | `[实证 /doc]` schema 确认枚举 |
| `GET /event` | SSE 全局事件流 | `[实证]` 首帧 `server.connected`，之后为 bus 事件 |
| `GET /command` / `GET /skill` / `GET /agent` | 原生 command/skill/agent 发现 | `[实证]` 见 §5 |
| `POST /session/{id}/command` body `{command}` | 执行原生 slash command | `[实证 /doc]` 端点确认，执行待凭据 |
| `GET /config/providers` | 可用 provider/model 列表 | `[实证]` 含 default 指向 |

## 3. SSE 事件形状（实测）

订阅 `GET /event`，帧格式 `data: {"id","type","properties"}`。本次实测捕获的事件类型：

- `session.created` / `session.updated` / `session.diff`：会话元数据
- `session.status` `{status:{type:"busy"|"idle"}}`：turn 开始/结束信号
- `session.error` `{error:{name,data}}`：turn 失败（本次凭据 401 触发，捕获到 `Token refresh failed: 401`）
- `session.idle`：turn 终止信号——**1.19.5 的 `message.updated` 的 info 不含 status 字段**，turn 终态判定以 `session.idle`/`session.error` 为准（实测两次 120s 超时后校准）
- `message.updated` `{sessionID, info}`：info 含 role/modelID/tokens/cost/time，无 status
- `message.part.updated` `{sessionID, part}`：part 顶层含 `id/messageID/sessionID/type`；text part 为**全量快照**（同一 part 多次更新实现流式），非增量 delta
- `permission`：审批请求事件（含 permissionID）——`[文档]`，事件级实证待凭据
- `plugin.added` / `catalog.updated` / `server.heartbeat`：杂项

## 4. 权限系统（本 PoC 关键）

### 4.1 默认权限（API 层实证，决定性证据）

`[实证]` `GET /agent` 返回 build agent 的运行时 permission 表，默认配置下：

```json
[
  {"permission":"*","pattern":"*","action":"allow"},        // 全部工具自动放行
  {"permission":"doom_loop","pattern":"*","action":"ask"},
  {"permission":"external_directory","pattern":"*","action":"ask"},
  {"permission":"read","pattern":"*.env","action":"ask"},
  {"permission":"read","pattern":"*.env.*","action":"ask"}
]
```

即：**默认 build agent 自动放行所有工具，仅 doom_loop / external_directory / 读 .env 默认弹出审批**。这与计划文档 §8.6 的论断一致，并与官方 permissions 文档（"By default, opencode allows most operations without requiring explicit approval"）互证。其余 agent：plan/general 同 build；explore/summary/title/compaction 额外带 `*:*:deny` 覆盖（禁写类工具）。

要让审批真正弹出，必须显式配置，例如 fixture 中：

```json
{"permission": {"bash": "ask", "edit": "ask"}}
```

### 4.2 审批交互

- 事件：SSE `permission` 事件携带请求详情与 permissionID
- 响应：`POST /session/{id}/permissions/{permissionID}` `{response:"once"|"always"|"reject"}` `[实证 /doc]`
- `--auto` CLI 标志：自动批准未显式 deny 的请求（危险，GUI 不用）`[实证 --help]`

## 5. 原生 command / skill / agent 发现（实证）

fixture 工作目录放入 `.opencode/command/poc3-hello.md` 与 `.opencode/skill/poc3-demo-skill/SKILL.md` 后（需重启 server 扫描）：

- `GET /command`：48 项（基线 46 + fixture 2），fixture 项 `source:"command"` 被发现
- `GET /skill`：45 项（基线 44 + fixture 1）
- **skill 同时出现在 /command 列表**（`poc3-demo-skill`，source:"skill"）——skill 以 slash command 形式暴露
- 基线 command/skill 全部来自**用户全局目录**（`~/.claude/skills`、`~/.agents/skills` 等，含 design-feature/implement-spec/pr/retro 等）——注意：**skill/command 发现不受 XDG_CONFIG_HOME 隔离影响**，opencode 仍扫描 `~/.claude/skills`、`~/.agents/skills`（server 日志有 "duplicate skill name" WARN 为证）。GUI 包装层须意识到这一点。
- `GET /agent`：7 个原生 agent（build/compaction/explore/general/plan/summary/title）

## 6. 配置隔离方式（实证）

- **合并语义**：配置分层为 global → `OPENCODE_CONFIG`(env，自定义路径) → 项目 `opencode.json` → `.opencode/` 目录 → `OPENCODE_CONFIG_CONTENT`(env，内联 JSON，最高)。`OPENCODE_CONFIG` **不能排除**全局配置，只能覆盖字段 `[文档]`
- **本次采用**：`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` 四个环境变量整体重定向到 fixture 内目录。`[实证]` 启动日志仅加载 `fixture\config\opencode\*.json`，未触碰 `~/.config/opencode`；`GET /config` 返回体不含用户全局的 provider 定义
- auth.json 以只读副本放入 `fixture/data/opencode/`，运行时刷新只写 fixture 副本
- 遗留：`~/.claude/skills` 等目录的 skill 扫描不受上述隔离影响（见 §5）

## 7. 网络与凭据（阻塞根因记录）

1. `[实证]` 本机直连 OpenAI 被拦截（curl 000，9ms 快速失败）；用户日常经 `~/.config/opencode/opencode-proxy.cmd` 设置 `HTTP(S)_PROXY=http://127.0.0.1:7897` 启动 opencode
2. `[实证]` 给 server 进程加同款代理变量后，错误从 `Token refresh failed: 403`（直连，请求未到 OpenAI）变为 `401`（经代理到达 OpenAI，认证被拒）
3. `[实证]` auth.json 中 access token 过期约 7 个月（expires 2026-04-13 vs 当前 2026-11-05），refresh token 已失效 → **需要交互式重新 `opencode login`（且须走代理），属用户操作，subagent 不代做**
4. `[实证]` 无本地推理服务（11434/1234/8000/8080 均关闭）；无 OPENAI_API_KEY/OPENCODE_API_KEY 等环境凭据；无 ollama/LM Studio 安装
5. 数据目录 `~/.local/share/opencode/opencode.json` 仅为 MCP 配置（work-pilot），无凭据 `[实证 只读]`

## 8. Windows 进程观察

- `[实证]` server 为单进程 `opencode.exe`；Node `child.kill()`/`process.kill(pid)` 在 Windows 即 TerminateProcess（SIGTERM/SIGKILL 等价），无优雅终止信号——opencode 数据为 turn 级落盘，kill 后 session 数据完好（见 RESULT.md 异常项）
- `[实证]` kill 后客户端 SSE 不发送显式断开帧（连接硬断），后续请求得 `ECONNREFUSED`；GUI 层需自带心跳/超时判定（`server.heartbeat` 事件可作活性信号）

## 9. SDK 备注

- npm 包名：`@opencode-ai/sdk`（非 `opencode-ai`，后者是 CLI 二进制分发包）`[实证]`
- SDK 提供类型化封装（`createOpencodeClient`、`event.callback`、`session.prompt/permissions` 等）`[文档]`；本次客户端直接用 HTTP+SSE（零依赖，且事件形状已实测校准），SDK 接入可等价替换

## 10. 补跑新增发现（2026-11-05，magpie 接入后）

### 10.1 magpie provider 隔离接入模式 `[实证]`

- provider 定义（openai-compatible，`npm:"@ai-sdk/openai-compatible"`，`options.baseURL=http://127.0.0.1:3425/v1`，apiKey 内嵌）位于用户全局 opencode.json；**client.mjs 在 start-server 时只读复制该 provider 节点注入 fixture 配置**，保持"不加载用户全局配置"的隔离性质，密钥不进 git/日志（gitignore 排除动态生成的 `fixture/config/opencode/opencode.json`，入库模板 `.template` 无真实 key）
- magpie 模型 ID 自带斜杠（`192-168-4-61-3000/asw_glm-5.3`），`modelID` 解析必须按第一个斜杠切分、余下合并；prompt API 的 `model:{providerID,modelID}` 两字段结构不受影响
- 本地网关无需代理（`OC_PROXY` 默认 off；OpenAI 场景才需 `OC_PROXY=on` 走 127.0.0.1:7897）

### 10.2 审批请求事件的推送限制（GUI Adapter 重要约束）`[实证]`

- `/event` SSE 在审批**响应**后推送 `permission.replied {sessionID, requestID, reply}`（实测捕获）
- 但审批**请求**产生时（server 日志 `asking id=per_...`），`/event` 未观察到推送 `permission.updated`（两次订阅先于 prompt 的测试均未收到）；`/global/event` 仅推 server 生命周期事件
- **可靠获取审批请求的模式 = 轮询 `GET /permission`（pending 列表，含 id/sessionID/permission/patterns/metadata/always 建议）+ `permission.replied` 事件确认**；client.mjs `waitPermission` 已按此实现（500ms 轮询 + SSE 兜底）

### 10.3 审批语义细节 `[实证]`

- 显式 `bash:"ask"` 下，server 日志链：`evaluated permission=bash pattern="echo poc3-approve" action.action=ask` → `asking id=per_... patterns=["echo poc3-approve"]`
- pending 请求的 `patterns` 精确到具体命令，`always` 给出通配建议（如 `echo *`）——GUI 三档审批（once/always/reject）与原生语义一一对应
- reject 后工具 part state=**error**，error="The user rejected permission to use this specific tool call."；模型会继续生成说明文本（turn 正常完成）

### 10.4 command 执行 API 细节 `[实证]`

- `POST /session/{id}/command` body `{command, arguments, model}`：**`arguments` 必填**（缺省 400 `Missing key at ["arguments"]`），空模板传 `"{}"`
- 该 API 为**同步返回**（HTTP 200 直接携带完成的 assistant 消息 info，含 time.completed），与 prompt_async 的异步模式不同
- command 模板经模型真实执行（回复 COMMAND-POC3-OK），非文本展开模拟

### 10.5 GLM（asw_glm-5.3）网关下的行为观察 `[实证]`

- 首 token 延迟约 10-12s，随后 burst 输出：短回复通常 1-2 次 `message.part.delta`；长回复 61 次 delta——流式粒度取决于网关分块，GUI 渲染须同时消费 delta 事件与 part 全量快照
- 工具调用 turn 内产生多次引擎请求（工具轮 + 总结轮，assistant 消息分多条）；预算/用量统计应以 turn 或 prompt 计，不应假设 1 prompt = 1 请求
- abort 语义：`POST /abort` → turn errored（`MessageAbortedError`），abort 早于首 token 时 0 输出 token；session 无损可继续
- reasoning part（GLM 思考链）作为独立 part 类型出现在事件流（`type:"reasoning"`），GUI 可选择展示或折叠
