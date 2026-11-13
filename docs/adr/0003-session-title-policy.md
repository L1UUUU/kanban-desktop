# ADR 0003 — 会话标题策略：四态状态机与单一写者门控

> 状态：已接受（用户 2026-11-13 确认范围与四项决策）· 日期：2026-11-13
> 关联：spec #82（交互系统性修复）、issue #82 讨论记录；参考 PI-Desktop ADR 0143（手动重命名权威）/ 0186（main 拥有 one-shot 摘要、失败静默）/ 0323（摘要能力可插拔后置）
> 现状基线：`sessions` 表已有 `title` 列与 `SessionStore.updateTitle`（半成品，无 IPC 无 UI）；新建默认标题「新会话 · {CLI}」堆积不可辨识

## 背景

侧栏会话行标题全部为默认值「新会话 · Codex」等，发十条消息后无法辨识。PI-Desktop 的同题演化（截断 fallback → 手动重命名 → one-shot 摘要 → 摘要插件化）给出三段式方案；其核心教训是 **manualTitle 权威**（自动机制不得覆盖手动标题）与 **摘要失败不得阻塞对话**。kanban 无自有 runtime，摘要能力对应到 CLI 适配层。

## 决策

**1. 四态单向状态机 `title_source`**（`sessions` 新列，schema_migrations v5，`TEXT NOT NULL DEFAULT 'default'`）：

```text
default ──首条 user ChatEvent──► derived ──首轮摘要成功──► summarized
   │                                │                          │
   └───────── 用户重命名（任意时刻）──┴──────────────────────────┘ → manual（终态权威）
```

升级路径单向；`manual` 吸收一切前态，其后自动机制不再触碰该行标题。

**2. 派生挂 IPC 层（main 持有首条 user 文本的确切位置），三条写路径全经 SessionStore 单一写者 + source 门控**（对齐 #70 C2 唯一写者原则）：

- **手动**：新 IPC `session:rename` → `renameTitle(id, title)` → `manual`。renderer 请求-响应后本地刷新（单窗口，无推送）。
- **fallback 派生**：挂在 main 拿得到首条 user 文本的两处 IPC——`session:create` 携带 `firstMessage` 时 insert 前派生（标题随行原子落库，首条消息发送失败的回滚链路天然一致）；`session:send` 在 `sendTurn` 成功后用请求文本派生（失败不派生，不留"来自未发出消息"的标题）。派生条件：`kind='structured'` 且 `source='default'`，经纯函数 `deriveTitle`（去首尾空白、压连续空白、**按 Unicode 码点**截 24 加省略号）置 `derived`。两处 IPC 响应均带回新标题，renderer 无需事件推送。
  *（不挂 `applyEvent`：现行 `chatEventSchema` 为 13 成员冻结 union，无 user 消息事件类型——user 文本由 renderer 本地回显，main 侧事件流永远等不到；为此新增事件类型还会引发恢复回放的重复派生问题。）*
- **摘要**：`adapter-events` 接线层（deps 新增 adapter 注入，装配处 index.ts 提供）在 `applyEvent !== "dropped"`（天然挡归档/删除行）且收到 `session_status→idle`、store 中 `source='derived'`、本进程未尝试过（内存 Set，免新列）时，异步调用 `CliAdapter.summarizeTitle(sessionId)`；返回非 null 且此刻 `get(id)` 仍存在且为 `derived` 才写入 `summarized`，并经**独立轻量通道 `session:event`**（`{type:"title", sessionId, title}`，`createValidatedSender` 同款模式）推送 renderer 刷新侧栏——不进 ChatEvent（`chatEventBase.seq` 是 session 内单调递增不变量，main 合成事件无从取值，不得破坏）。
- **PTY 豁免**：`kind='pty'` 永不进状态机——PTY 的 `updateTitle`（终端 · shell 回写，#60）保持无条件写，source 恒为 `default` 且无行为影响。

**3. `CliAdapter` 契约扩展 `summarizeTitle(sessionId): Promise<string | null>`**（三处同步：契约接口 / `CliHostClient` 命令 kind / worker 路由）：fake 返回固定值（整机 e2e 可测）；claude 在适配层内 spawn 一次性 `claude -p`（会话当前模型，喂截断的最近对话文本，不污染会话上下文，复用 adapter 既有进程基建，超时独立设定不沿用 run-once 300s 缺省）；codex 同理 `codex exec`；opencode 返回 `null` 降级保留 fallback。CLI 命令行知识不出适配层。

**4. UI 入口**：侧栏结构化会话行 hover 铅笔 → 行内编辑（Enter/blur 提交、Esc 还原），与看板卡片（#84）同款交互。PTY 终端行无重命名入口、无派生、无摘要。

**5. 迁移与存量**：v5 迁移存量行回填 `'default'`——老会话恢复后发送下一条消息即触发派生覆盖默认标题（期望行为，PTY 行无此路径）。回归面：`db.ts` SCHEMA_VERSION/直建 SQL/迁移函数、`session-store` 的 COLS/SELECT_COLS/rowToRecord 三处列清单、`chat.test.ts` 冻结 union 断言（不新增成员则不变）、renderer `applyEvent`/`applySnapshot` 测试。

## 后果

- 侧栏可辨识性三段递进：即时（截断 fallback，零成本）→ 智能（摘要，异步一次性）→ 用户主权（重命名，终态）。
- 手动标题跨重启权威（DB 单一事实源，无 renderer 本地状态）。
- 摘要不阻塞对话、不污染会话上下文（独立一次性进程）。
- 新增独立 `session:event` 轻量推送通道（仅摘要异步完成时使用）；ChatEvent 冻结契约不动（13 成员 union 与 seq 不变量保持）。
- opencode 会话长期停留在截断 fallback——其 prompt API 需会话上下文，一次性摘要不适用；待其能力变化再评估。
