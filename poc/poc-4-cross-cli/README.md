# PoC 4 — 跨 CLI 需求链路验证（P0）

验证 Requirement–Session–Stage Event 模型在 **Claude Code / Codex / OpenCode 多 CLI 混合**下的正确性：自动建卡、Session 关联、跨 CLI 阶段排序、手动修正、去重/重放/延迟旧事件抵抗、证据分级与持久化恢复。对照计划 `docs/kanban-desktop-v1-plan.md` §3/§4/§8.5/§9 PoC 4。

## 一条命令复现

```bash
cd poc/poc-4-cross-cli
node --test tracker/tracker.test.mjs   # ① 确定性规则测试（无 CLI 依赖，21 用例）
node run-e2e.mjs                       # ② 端到端混合流（三 CLI 真实源：Claude ×2 + Codex turn ×1 + OpenCode command ×1，≤6 次一句话级模型调用）
node run-e2e.mjs --verify-restart      # ③ 「退出重开」：新进程仅凭 SQLite 恢复并做重放注入（零模型调用，可重复运行）
```

② 会清空 `fixture/proj/hook-events.jsonl` 与 `runs/poc4.db` 后从零重放全链路；结果写 `runs/e2e-main.json`，③ 写 `runs/e2e-restart.json`。最终判定与证据见 `RESULT.md`。

## 目录结构

```text
poc-4-cross-cli/
├── lib/
│   ├── schema.mjs        # 归一化事件 schema：eventId/kind/sessionId/cli/skill/occurredAt/
│   │                     # receivedAt/seq/evidenceLevel(verified|self_reported|simulated)/source + 入口硬校验
│   ├── tracker.mjs       # 多 CLI Requirement Tracker（规则基线复制自 poc-2，扩展三级证据 + 关联同步 + 恢复）
│   ├── store.mjs         # SQLite 持久化（node:sqlite）：requirements / sessions / stage_events 三表
│   └── engine.mjs        # Engine：校验→状态机→落库；restore() 重启恢复
├── adapters/
│   ├── claude.mjs        # 真实 claude.exe 编程 spawn（stdin 传 prompt）+ hook-events.jsonl → verified 事件
│   ├── codex-client.mjs  # Codex app-server 客户端（复制自 poc-1，未改动逻辑）
│   ├── opencode.mjs      # 真实 opencode serve 客户端：XDG 隔离 + provider 只读注入（poc-3 模式）
│   │                     # + POST /command 执行阶段 skill + SSE 终态 → self_reported 事件
│   └── synth.mjs         # 合成事件生成器（simulated，仅规则注入用）与 GUI 动作事件
├── tracker/tracker.test.mjs  # 确定性测试（node:test，覆盖 5 场景全部规则分支 + 持久化往返）
├── run-e2e.mjs           # 端到端混合流运行器（main / --verify-restart）
├── fixture/proj/         # Claude stub skills（design-feature / implement-spec）+ hook 捕获（方案复制自 poc-2）
├── fixture/workdir/      # Codex thread/start 的工作目录
├── fixture/opencode/     # OpenCode 隔离 fixture：config/（运行时注入 provider，含密钥，git 排除）
│                         # + data/（运行时，git 排除）+ workdir/.opencode/skill/{pr,implement-spec} stub
└── runs/                 # 运行证据（JSON 报告 + hook 证据副本；*.db 不入库）
```

## 依赖

零 npm 依赖。Node ≥ 22.5（内置 `node:sqlite`；本验证用 v24.13.0，运行时有 ExperimentalWarning，不影响功能）。需要本机已认证的 `claude`（npm 全局）、`codex`（npm 全局）与 `opencode`（npm 全局 + 用户全局 opencode.json 中配置的 magpie provider，运行时只读复制注入隔离 fixture，密钥不入库不落日志）。

## 复用的前置成果

- poc-1：Codex app-server 客户端与协议结论（`adapters/codex-client.mjs` 原样复制；模型 `gpt-5.6-luna`）
- poc-2：tracker 规则基线、stub skill + 项目级 hook 捕获方案（`fixture/proj/`、`lib/tracker.mjs`）
- poc-3：OpenCode 隔离注入模式、command API 形状与 SSE 终态结论（`adapters/opencode.mjs`；magpie provider 模型切分）
