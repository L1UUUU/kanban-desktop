# PoC 3 — OpenCode Adapter 验证（P0/P1）

复用 PoC 1 测试矩阵单独验证 OpenCode 1.19.5（Windows 11），核心增量：**默认 build agent 权限实证**与**显式 `ask` 审批链路**。结论见 `RESULT.md`，协议细节见 `NOTES.md`。

## 目录结构

```text
poc/poc-3-opencode/
├── client.mjs              # 统一驱动客户端（HTTP+SSE，零依赖，Node 18+）
├── fixture/
│   ├── config/opencode/    # 隔离全局配置（XDG_CONFIG_HOME 重定向）
│   │   ├── opencode.json   # 运行时生成：含 magpie provider+apiKey（从全局只读复制），不入库
│   │   └── opencode.json.template  # 无密钥入库模板
│   ├── data/               # 隔离数据目录（XDG_* 重定向；含 auth.json 只读副本，不入库）
│   └── workdir/            # 测试工作目录（含 .opencode/command、.opencode/skill fixture）
├── logs/                   # 运行日志与证据 JSON（不入库）
├── NOTES.md / RESULT.md    # 调研笔记 / 判定结果
└── .gitignore
```

## 前置条件

- opencode 1.19.5 全局安装；Node ≥18
- 可用模型凭据：用户全局 `~/.config/opencode/opencode.json` 配置 `magpie` provider（openai-compatible 本地网关；client.mjs 启动时**只读复制**该 provider 节点注入 fixture 配置，含 apiKey 的生成文件被 gitignore 排除，入库模板见 `opencode.json.template`）。`OC_MODEL` 可覆盖，默认 `magpie/192-168-4-61-3000/asw_glm-5.3`
- magpie 为本地网关无需代理（默认 `OC_PROXY=off`）；OpenAI 渠道才需 `OC_PROXY=on`（127.0.0.1:7897）
- `client.mjs` 内 `EXE` 变量指向 opencode.exe（可用 `OC_BIN` 覆盖）

## 一条命令复现（完整矩阵，约 11 次一句话级模型调用，其中 1 次被 abort 中止）

```bash
cd poc/poc-3-opencode
# 阶段 A：默认权限（关键验证一）
node client.mjs start-server default
node client.mjs perm-default
node client.mjs stop-server
# 阶段 B：显式 ask（关键验证二）+ 聊天/取消/并发
node client.mjs start-server ask
node client.mjs perm-ask-approve
node client.mjs perm-ask-deny
node client.mjs chat
node client.mjs cancel
node client.mjs concurrent
node client.mjs stop-server
# 阶段 C：重启恢复 + 原生 command 执行 + 异常 kill
node client.mjs start-server ask
node client.mjs resume
OC_RUN_COMMAND=1 node client.mjs commands
node client.mjs kill-server
node client.mjs start-server ask
node client.mjs crash-recover
node client.mjs stop-server
```

说明：

- 每步日志写入 `logs/<步骤名>.log`，证据 JSON 写入 `logs/<步骤名>.json`
- server 以 detached 方式常驻（pid 记录于 `logs/server.pid`），跨命令持续运行
- 模型默认 `magpie/192-168-4-61-3000/asw_glm-5.3`（`OC_MODEL` 可覆盖）
- 审批请求获取采用轮询 `GET /permission` + `permission.replied` SSE 确认（实测 /event 不推送审批请求事件，见 NOTES.md §10.2）
- `fixture/data/`、`logs/` 与含 apiKey 的 `fixture/config/opencode/opencode.json` 已被 `.gitignore` 排除

## 零成本子命令（无需有效凭据）

```bash
node client.mjs start-server default   # 启动隔离 server（日志验证配置隔离）
node client.mjs commands               # GET /command /skill 发现（不加 OC_RUN_COMMAND 不执行）
node client.mjs crash                  # kill server 观察客户端行为
node client.mjs crash-recover          # 重启后数据完整性
```
