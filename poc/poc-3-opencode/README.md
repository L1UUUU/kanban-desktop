# PoC 3 — OpenCode Adapter 验证（P0/P1）

复用 PoC 1 测试矩阵单独验证 OpenCode 1.19.5（Windows 11），核心增量：**默认 build agent 权限实证**与**显式 `ask` 审批链路**。结论见 `RESULT.md`，协议细节见 `NOTES.md`。

## 目录结构

```text
poc/poc-3-opencode/
├── client.mjs              # 统一驱动客户端（HTTP+SSE，零依赖，Node 18+）
├── fixture/
│   ├── config/opencode/    # 隔离全局配置（XDG_CONFIG_HOME 重定向；按模式写入 permission）
│   ├── data/               # 隔离数据目录（XDG_* 重定向；含 auth.json 只读副本，不入库）
│   └── workdir/            # 测试工作目录（含 .opencode/command、.opencode/skill fixture）
├── logs/                   # 运行日志与证据 JSON（不入库）
├── NOTES.md / RESULT.md    # 调研笔记 / 判定结果
└── .gitignore
```

## 前置条件

- opencode 1.19.5 全局安装；Node ≥18
- `~/.local/share/opencode/auth.json` 存在且凭据**有效**（本次执行时 OpenAI oauth 已失效——阻塞记录见 RESULT.md）
- 访问 OpenAI 需本地代理 `127.0.0.1:7897`（与用户 `opencode-proxy.cmd` 一致；`OC_PROXY=off` 可关闭）
- `client.mjs` 内 `EXE` 变量指向 opencode.exe（可用 `OC_BIN` 覆盖）

## 一条命令复现（完整矩阵，约 10 次一句话级模型调用）

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
- 模型固定 `openai/gpt-5.4-mini-fast`（oauth 渠道 cost=0；`OC_MODEL` 可覆盖）
- `fixture/data/`（含凭据副本）与 `logs/` 已被 `.gitignore` 排除

## 零成本子命令（无需有效凭据）

```bash
node client.mjs start-server default   # 启动隔离 server（日志验证配置隔离）
node client.mjs commands               # GET /command /skill 发现（不加 OC_RUN_COMMAND 不执行）
node client.mjs crash                  # kill server 观察客户端行为
node client.mjs crash-recover          # 重启后数据完整性
```
