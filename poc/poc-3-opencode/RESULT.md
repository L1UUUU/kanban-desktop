# PoC 3 — OpenCode Adapter 验证结果

> 执行日期：2026-11-05 · opencode 1.19.5 · Windows 11 · 隔离 fixture 环境（XDG 重定向，未触碰用户全局 `~/.config/opencode` 与 `~/.local/share/opencode`）
> 模型渠道：OpenAI oauth（凭据已失效，见「阻塞」节）；失败调用未产生任何成功模型请求，真实模型调用消耗 **0/10**

## 总判定

**PARTIAL（环境阻塞）**：协议层、隔离层、事件流、API 形状、权限默认值（API 层）、command/skill 发现、异常退出全部实证通过；**需要真实模型调用的矩阵项（聊天/流式、工具事件、审批事件、取消、并发、恢复续问）被 OpenAI oauth 凭据失效阻塞**，客户端脚本已全部就绪并经失败路径校准，凭据恢复后按 README 一条命令序列补跑。

## 逐项判定（复用 PoC 1 矩阵 + PoC 3 增量项）

| # | 测试 | 判定 | 证据与说明 |
|---|---|---|---|
| 1 | 启动：指定工作目录启动并创建原生 Session ID | **PASS** | server cwd=fixture\workdir 启动；`POST /session` 返回原生 ID（`ses_e55f97b73ffeVKzUIMOG0ntUuB` 等）；SSE `server.connected` 正常。证据：`logs/smoke.log`、`logs/server.log` |
| 2 | 聊天：多轮流式，增量正确无丢失 | **NOT TESTED（阻塞）** | 凭据失效。事件形状已实测校准（text part 全量快照流式更新，`message.part.updated`）；`chat` 步骤脚本就绪 |
| 3 | 工具：展示开始/参数/输出/结果 | **NOT TESTED（阻塞）** | 同上；`toolParts` 解析逻辑就绪，`perm-*` 步骤将同时产出工具事件证据 |
| 4 | 审批（**关键验证一：默认权限**） | **PARTIAL** | 见下方「关键结论 1」。API 层决定性实证 + 官方文档互证；运行时事件级（默认配置下跑工具观察无 permission 事件）待凭据 |
| 5 | 审批（**关键验证二：显式 ask**）批准路径 | **NOT TESTED（阻塞）** | fixture 配置 `{permission:{bash:"ask",edit:"ask"}}` 与 `perm-ask-approve` 步骤（SSE permission 事件 → `POST /permissions/{id}` `{response:"once"}`）就绪 |
| 6 | 审批（关键验证二）拒绝路径 | **NOT TESTED（阻塞）** | `perm-ask-deny` 步骤就绪（`{response:"reject"}`） |
| 7 | 取消：取消当前 Turn 后 Session 可继续 | **NOT TESTED（阻塞）** | `abort` 端点 schema 实证；turn 终态判定（`session.idle`）实测校准；`cancel` 步骤就绪 |
| 8 | 并发：≥3 Session 并行 | **NOT TESTED（阻塞）** | 3 session 并行 `prompt_async` + 独立终态等待已实现；session 创建实证支持多开（本次已建 7 个） |
| 9 | 恢复：正常退出后读取历史并继续上下文 | **PARTIAL** | 历史读取 API 实证（`GET /session` 列表 + `GET /session/{id}/message` 均正常，crash 后重启 7/7 session 完好）；「继续上下文」（依赖上一轮问答）待凭据 |
| 10 | 异常：CLI 意外退出不崩溃、不自动重放 | **PASS** | SIGKILL server 后：客户端进程存活，后续请求明确 `ECONNREFUSED fetch failed`，SSE 停止推送，无任何自动重放；重启后 session 数据完好（7=7）、历史端点可读。证据：`logs/crash.json`、`logs/crash-recover.json` |
| 11 | 原生 Skill/Command 发现 | **PASS** | fixture `.opencode/command/poc3-hello.md` 与 `.opencode/skill/poc3-demo-skill/SKILL.md` 重启后被 `GET /command`（source:"command"）与 `GET /skill` 原生发现；skill 同时以 slash command 暴露。注意：用户全局 `~/.claude/skills`、`~/.agents/skills`（含 design-feature 等）也被扫描，XDG 隔离不影响 skill 发现 |
| 12 | 原生 Skill/Command 执行 | **NOT TESTED（阻塞）** | `POST /session/{id}/command` 端点实证存在；执行需模型调用 |

## 关键结论 1：默认权限（本 PoC 核心增量）

**实证结论：opencode 1.19.5 默认 build agent 自动放行所有工具。**

- `GET /agent` 返回的运行时权限表第一条即 `{"permission":"*","pattern":"*","action":"allow"}`，仅 `doom_loop`、`external_directory`、`read:*.env`、`read:*.env.*` 四类默认 `ask`（build/plan/general 相同；explore/summary/title/compaction 另加 `*:*:deny` 收紧）
- 与计划文档 §8.6「默认 build agent 自动放行所有工具，要让审批真正弹出必须显式把每个工具设为 ask」**一致**，与官方 permissions 文档互证
- 待凭据补充的运行时级证据：默认配置下触发 bash 工具，事件流中应无 `permission` 事件直接执行

**对 GUI 审批设计的直接影响（对照 §5/§11）：**

1. 包装层**不能假设 CLI 默认请求审批**——Kanban Desktop 若照搬"审批弹窗"默认体验，OpenCode Session 将永远不弹窗、工具静默执行，用户感知与 GUI 承诺不符
2. 若产品要统一的审批体验，Adapter 必须在 Session 创建时**主动注入显式权限配置**（fixture 项目级 `opencode.json` 设 `bash/edit/webfetch...: "ask"`）——这构成对 CLI 原生权限语义的「显式收紧」而非「改变」，但必须在 UI 上明示档位（原生默认 / 收紧 ask），避免违反「GUI 正确批准/拒绝 CLI 原生审批，不改变权限语义」
3. 权限档位应做成 OpenCode Adapter 的会话级配置项（写项目级 opencode.json，随 Session 独立），而非全局假设

## 关键结论 2：协议接入评价（对照 §11 接入方式门槛）

- 直连 HTTP+SSE（本次方式）：单进程、OpenAPI spec 自描述（`/doc`）、事件流完整（含 session busy/idle 生命周期、part 快照、permission）——**Windows 下无额外依赖，接入成本低**，SDK（`@opencode-ai/sdk@1.19.5`，与 CLI 同版本发布）可作类型化替代
- 已知坑（实测）：prompt body 为顶层 `parts` 数组（非旧文档的 `message:{build}` 形状）；`message.updated` 的 info 无 status 字段，turn 终态以 `session.idle`/`session.error` 判定；command/skill 发现需重启 server 才扫描新增文件
- ACP 对照路线：opencode 自带 `opencode acp` 子命令（`--help` 实证），可作为 PoC 1 ACP 桥接对照的 OpenCode 侧入口，本次未展开

## 阻塞记录（升级主会话）

**OpenAI oauth 凭据失效，需要用户操作恢复：**

- 根因链（全部实证）：直连 OpenAI 被网络拦截（curl 000/9ms）→ 用户日常经本地代理 `127.0.0.1:7897`（`opencode-proxy.cmd`）→ 加代理后 refresh 请求到达 OpenAI 但返回 **401**：access token 过期约 7 个月，refresh token 已失效
- 本机无替代路径：无 OPENAI_API_KEY / OPENCODE_API_KEY（zen）等环境凭据；无 ollama/LM Studio/本地推理服务；zen provider 在全局配置仅有模型 limit 定义、无凭据
- 恢复方式（任选其一，均为用户操作）：① 走代理执行 `opencode login`（OpenAI oauth，浏览器交互，会写 `~/.local/share/opencode/auth.json`）；② 向 fixture 提供 `OPENAI_API_KEY` 或 zen key（可只写 fixture 数据目录，不碰全局）
- 恢复后补跑：`cd poc/poc-3-opencode && node client.mjs start-server default && node client.mjs perm-default && node client.mjs stop-server && node client.mjs start-server ask && node client.mjs perm-ask-approve && node client.mjs perm-ask-deny && node client.mjs chat && node client.mjs cancel && node client.mjs concurrent && node client.mjs stop-server && node client.mjs start-server ask && node client.mjs resume && OC_RUN_COMMAND=1 node client.mjs commands && node client.mjs crash && node client.mjs start-server ask && node client.mjs crash-recover`（模型调用预算约 10 次，见 README）

## 证据文件

| 文件 | 内容 |
|---|---|
| `logs/server.log` | server 启动/运行日志（含配置加载路径=隔离证明、错误链 403→401） |
| `logs/evt-shapes.json` | 一次失败 turn 的完整 64 条 SSE 事件（事件形状实证） |
| `logs/crash.json` / `crash-recover.json` | 异常 kill 行为与数据完整性 |
| `logs/perm-default.json` | 默认权限步骤输出（失败 turn，permission 事件判定字段就绪） |
| `logs/client-*.log` | 各步骤客户端日志 |
| `providers.json` / `doc.json` | provider/model 清单与 OpenAPI spec 快照 |
