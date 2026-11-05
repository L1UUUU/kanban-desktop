# PoC 7 — Claude Code 补验（审批回调 / 取消 Turn / 跨重启 resume / hook 会话级注入）

对 PoC 1-6 遗留的四项无证据能力做真实运行补验，产物仅验证型脚本与证据，不含产品代码。结果判定与发现见 `RESULT.md`。

## 环境

- Windows 11 build 26200，claude CLI 2.1.317（npm 全局 `@anthropic-ai/claude-code/bin/claude.exe`，编程 spawn 直连、不经 shell）
- 认证：真实用户 `~/.claude/settings.json` 的 env（内网网关 + token，模型 `glm-5.3[1m]` 映射）
- 测试前提：本机真实 `~/.claude/settings.json` 含 skill-hub telemetry 等 hook，不满足 T5 干净前提且不可改动用户文件；全部测试用 `CLAUDE_CONFIG_DIR` 重定向到 `logs/home-<label>/`（由 `lib/common.mjs prepareCleanHome()` 运行时从真实用户 settings 仅提取 env+model 生成，无 hooks/permissions 等，不入库防密钥泄漏）

## 复现命令

```bash
cd poc/poc-7-claude-gaps
npm install @anthropic-ai/claude-agent-sdk@0.3.318 --no-save   # 可选：仅作 wire 协议文档级参考（已 gitignore）

node run-t1t2.mjs          # T1 持久多轮 + T2 interrupt 取消 Turn（单进程 3 轮）
node analyze-t1t2.mjs      # 从 raw 流重算 T1/T2 判定（无模型调用）
node run-t3.mjs            # T3 审批：--permission-prompt-tool=stdio 下 can_use_tool accept/deny
POC7_T3_NOFLAG=1 node run-t3.mjs   # T3 对照：不带 flag（默认自动拒绝）
node run-t4.mjs            # T4 跨进程 --resume 续问暗号（A/B 两进程）
node run-t5t6.mjs          # T5+T6：--settings 会话级 hook 注入 + 认证叠加（正例+反例）
node run-t5t6-retry.mjs    # T5 正例重试（强提示促使 Skill 工具真调用，首轮模型未调工具）
```

## 目录

```text
lib/client.mjs        持久 stream-json 双向会话客户端（多轮 / interrupt / can_use_tool 应答 / 原始流落盘）
lib/common.mjs        claude.exe 解析、干净 CLAUDE_CONFIG_DIR 生成、注入 settings 生成、hook 事件读取
run-t*.mjs            各验收项实测脚本（spawn 直连真实 claude.exe，prompt 全部经 stdin 协议传入）
fixture/proj/         项目 fixture（stub skill + hook 捕获脚本；无 .claude/settings.json——T5 干净前提）
logs/                 全部证据（原始流 *.jsonl、判定 *.json、注入 settings、运行时干净 home 目录）
```

证据优先级：`logs/*-raw-stream.jsonl`（CLI 原始输出流，含 stdin 发送记录 `__sent`）> `logs/*-result.json`（脚本归一化判定）。
