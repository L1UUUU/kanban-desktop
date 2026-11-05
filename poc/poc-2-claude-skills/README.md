# PoC 2 — Claude Code 原生 Skill 调用与事件观察验证

验证 Kanban Desktop v1 计划 §9 PoC 2 的核心问题：GUI 侧触发的是原生 Skill 而非文本模拟；hook/事件能可靠区分真调用与普通提及；自动建卡与阶段规则（去重、旧事件不覆盖、手动修正可被新事件覆盖）逻辑正确。

完整验收判定与证据见 [RESULT.md](./RESULT.md)。

## 环境

- Windows 11 (build 26200)，Git Bash（注意 MSYS 路径转换会改写 `/` 开头的参数与环境变量值）
- claude CLI 2.1.317（全局，认证走用户级 settings 的 `ANTHROPIC_BASE_URL` 网关 + `ANTHROPIC_AUTH_TOKEN`，不走官方 OAuth）
- Node v24.13.0 / npm 11.6.2
- @anthropic-ai/claude-agent-sdk 0.3.318 / 0.2.141（bundled claude.exe 2.1.318）——在 Windows 上 pre-spawn abort，见 RESULT「路径 b」一节

## 目录

```text
poc/poc-2-claude-skills/
├── fixture/proj/                 # 测试项目（作为 CLI/协议会话的 cwd）
│   ├── .claude/skills/…/SKILL.md # 最小占位 skill（design-feature / implement-spec，输出固定文案）
│   ├── .claude/settings.json     # UserPromptSubmit + PreToolUse(*) + PostToolUse(*) hooks
│   └── hook-capture.mjs          # hook 捕获脚本：事件 JSON + 本地时间戳 → hook-events.jsonl
├── tracker/
│   ├── tracker.mjs               # Requirement Tracker 状态机（§3/§4 规则）
│   └── tracker.test.mjs          # node:test 用例（15 个，全覆盖乱序/重放/并发/手动修正等）
├── sdk/
│   ├── run-sdk.mjs               # 官方 SDK 触发脚本（Windows 失败复现入口）
│   ├── run-sdk-minimal.mjs       # SDK 最小复现（裸 query）
│   ├── run-sdk-proxy.mjs         # spawnClaudeCodeProcess 透明代理（证明 pre-spawn abort）
│   ├── spawn-repro.mjs           # Node 直 spawn 判别实验（证明 exe 与协议本身正常）
│   └── protocol-client.mjs       # stream-json 协议直连客户端（SDK 等价传输层，Windows 可用）
├── compare/ccst/                 # cc-skill-trace 3.0.0 对照（npm i cc-skill-trace 后 npx）
├── scripts/replay.mjs            # 真实 hook-events.jsonl → tracker 端到端回放
├── scripts/summarize-runs.mjs    # 原始 stream 压缩为关键事件摘要
└── runs/                         # 全部证据文件（stream、hook 事件、回放结果、对照导出）
```

## 一条命令复现

```bash
cd poc/poc-2-claude-skills

# B 部分：tracker 状态机全部用例（确定性，无模型调用）
cd tracker && node --test

# 端到端回放：真实捕获的 hook 事件喂给 tracker
cd ../scripts && node replay.mjs

# A 部分：CLI 非交互 slash 触发（消耗 1 次模型调用；经 stdin 传 prompt 避免 MSYS 改写）
cd ../fixture/proj && echo "/design-feature" | claude -p --output-format stream-json --verbose \
  --permission-mode default > ../../runs/repro-slash.jsonl && cat hook-events.jsonl

# A 部分：协议直连（SDK 等价传输层，消耗 1 次模型调用）
cd ../../sdk && npm install @anthropic-ai/claude-agent-sdk && \
  POC2_PROMPT="/design-feature" node protocol-client.mjs

# 对照：cc-skill-trace 回溯扫描 CLI 原生 transcripts（无模型调用）
cd ../compare/ccst && npm install cc-skill-trace && npx cc-skill-trace scan --dry-run
```

## 成本

本次验证共消耗真实模型调用 9 次（上限 10）：CLI 路径 7 次（含反例 1 次）、协议直连 2 次。skill 均为「输出一句固定文案」的最小占位实现。
