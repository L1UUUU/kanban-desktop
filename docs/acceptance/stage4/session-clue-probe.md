# 阶段 4 会话线索探针报告（#48，spec #40 G 节 / D2 / F11）

> 结论：**不达标，UI 不上线**。三 CLI 各 ≥10 真实样本已采集（判据一 ✅）；命中率门槛（≥80%）仅 Claude Code 与 Codex 达到，OpenCode 33.3%（判据二 ❌）。
> 「文件 ↔ 最近改动会话」虚线标注（原型 d1 session-tag）不落地，Diff 纯工作区视图即终态（#43 已交付形态不变）。
> 取证时间：2026-11-09；机器证据：[session-clue-probe-samples.json](./session-clue-probe-samples.json)（本报告表格由该 JSON 生成，无手工编造）。

## 结论一览

| CLI | 干净样本 | 命中 | 命中率 | ≥10 样本 | ≥80% 命中 | 判定 |
|---|---|---|---|---|---|---|
| Claude Code | 10 | 10 | **100.0%** | ✅ | ✅ | 达标 |
| Codex | 10 | 10 | **100.0%** | ✅ | ✅ | 达标 |
| OpenCode | 18 | 6 | **33.3%** | ✅ | ❌ | **不达标** |
| 判定口径 | | | | 三 CLI 各 ≥10 | **三 CLI 全部 ≥80% 才上线 UI** | **整体不达标** |

判定口径说明：标注 UI 不区分会话来自哪个 CLI，「最近改动会话」对任一 CLI 会话都需可信；任一 CLI 命中率不足即产生误导性标注，故门槛取「全部达标」（保守读法，与「不达标不上线」一致）。

## 判据与提取器

- **判据**（issue #48 原文）：三 CLI 各 ≥10 个真实工具事件样本（`tool_started.argsSummary` / `tool_completed.output` 中的文件路径提取），命中率 ≥80% 才实现标注 UI。
- **提取器**：`packages/cli-host/src/tool-path-extract.ts`（纯函数，无依赖）——JSON 语义键值（`file_path`/`filePath`/`path` 等）优先，其次 Windows/POSIX 绝对路径 token（剥 URL、剥引号），无绝对路径时相对路径 token 兜底；密封测试 `tool-path-extract.test.ts` 13 用例覆盖三 CLI 形状与边界。**不达标也留档**（本文件即其验收位置），达标路径上它就是 UI 数据源。
- **命中定义**：提取候选经归一化（win32 大小写不敏感、分隔符统一）或按会话 cwd 解析后与「该事件实际操作的文件」同一（存在时再经 `realpathSync.native` 消 8.3 短名/大小写差）。

## 采集方法（工程决策，如实记录）

- **形态**：B 类门控 e2e——`packages/cli-host/tests/e2e/session-clue-probe.e2e.test.ts`，主门 `KANBAN_E2E=1` + 二道细粒度门 `KANBAN_SESSION_PROBE=1`（先例 `KANBAN_PROTOCOL_PROBE`；一次性取证会真实花 token，不随 B 类例行重跑；已登记 docs/testing.md 门禁协议表）。
- **驱动**：三 CLI 各建一个 full 权限档会话（零审批干扰），四个 turn 发「带严格次数约束的编号指令」（read / write / edit / bash-echo 各一批，每条指令命名唯一目标文件与唯一 marker），捕获 ChatEvent 流中 `tool_started`/`tool_completed` 按 itemId 配对。
- **归因规则（预注册，不看事件内容、只看事件计数与文件系统验证，避免向提取器偏置）**：turn 内事件对数 == 指令条数才逐对按序归因；不等则整轮记 excluded（含零事件轮）。验证：read = 助手回复或输出含 marker；write/bash = 文件存在且含 marker。
- **成本控制**：codex `KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna`（白名单按序试探，全败报错不回退）+ effort low；opencode 经 e2e host 注入用户全局 magpie provider（内网网关 cost=0，XDG 隔离）；claude headless 真实调用（短提示控成本）。
- **两轮运行**：第一轮校准（发现 codex echo 轮被模型整轮跳过、opencode edit 轮被模型插入 read 事件、零事件轮未记录——修正探针：零事件留痕 + 编辑指令附内联原文 + 补样本量；第一轮数字：claude 12/12=100%、codex 8/8=100% 样本不足、opencode 6 干净 3 命中=50%）；第二轮为取证轮（下表），两轮 opencode write/edit 均结构性 miss，结论一致。

## 样本清单（事件摘要 → 提取结果 → 实际文件）

### claude-code

| # | turn | 工具 | 事件摘要 argsSummary（截断 100 字符） | 提取结果（截断 90 字符） | 实际操作文件 | 结果 |
|---|---|---|---|---|---|---|
| 1 | read | Read | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\r1.txt"}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\claude\r1.txt ; C:\\Users\\liuy\\App` | r1.txt | hit |
| 2 | read | Read | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\r2.txt"}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\claude\r2.txt ; C:\\Users\\liuy\\App` | r2.txt | hit |
| 3 | read | Read | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\r3.txt"}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\claude\r3.txt ; C:\\Users\\liuy\\App` | r3.txt | hit |
| 4 | write | Write | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\w1.txt","content"` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\claude\w1.txt ; C:\\Users\\liuy\\App` | w1.txt | hit |
| 5 | write | Write | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\w2.txt","content"` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\claude\w2.txt ; C:\\Users\\liuy\\App` | w2.txt | hit |
| 6 | write | Write | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\w3.txt","content"` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\claude\w3.txt ; C:\\Users\\liuy\\App` | w3.txt | hit |
| 7 | edit | Read | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\e1.txt"}` | `—` | — | excluded：事件对数 4 ≠ 指令数 2（无法无偏归因） |
| 8 | edit | Edit | `{"replace_all":false,"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claud` | `—` | — | excluded：事件对数 4 ≠ 指令数 2（无法无偏归因） |
| 9 | edit | Read | `{"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\e2.txt"}` | `—` | — | excluded：事件对数 4 ≠ 指令数 2（无法无偏归因） |
| 10 | edit | Edit | `{"replace_all":false,"file_path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claud` | `—` | — | excluded：事件对数 4 ≠ 指令数 2（无法无偏归因） |
| 11 | bash | Bash | `{"command":"echo MARK-B1 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b1` | `C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b1.txt\ ; C:\Users\li` | b1.txt | hit |
| 12 | bash | Bash | `{"command":"echo MARK-B2 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b2` | `C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b2.txt\ ; C:\Users\li` | b2.txt | hit |
| 13 | bash | Bash | `{"command":"echo MARK-B3 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b3` | `C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b3.txt\ ; C:\Users\li` | b3.txt | hit |
| 14 | bash | Bash | `{"command":"echo MARK-B4 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b4` | `C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\claude\\b4.txt\ ; C:\Users\li` | b4.txt | hit |

### codex

| # | turn | 工具 | 事件摘要 argsSummary（截断 100 字符） | 提取结果（截断 90 字符） | 实际操作文件 | 结果 |
|---|---|---|---|---|---|---|
| 1 | cmd-read | commandExecution | `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "type \"C:\\Users\\liuy\\AppData\\Local\\Temp\` | `C:\\Program ; \\PowerShell\\7\\pwsh.exe ; C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-p` | r1.txt | hit |
| 2 | cmd-read | commandExecution | `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "type \"C:\\Users\\liuy\\AppData\\Local\\Temp\` | `C:\\Program ; \\PowerShell\\7\\pwsh.exe ; C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-p` | r2.txt | hit |
| 3 | cmd-read | commandExecution | `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "type \"C:\\Users\\liuy\\AppData\\Local\\Temp\` | `C:\\Program ; \\PowerShell\\7\\pwsh.exe ; C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-p` | r3.txt | hit |
| 4 | cmd-write | commandExecution | `"C:\\WINDOWS\\system32\\cmd.exe" /c "echo MARK-B1 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue` | `—` | — | excluded：写验证未通过（文件缺失或无 marker） |
| 5 | cmd-write | commandExecution | `"C:\\WINDOWS\\system32\\cmd.exe" /c "echo MARK-B2 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue` | `—` | — | excluded：写验证未通过（文件缺失或无 marker） |
| 6 | cmd-write | commandExecution | `"C:\\WINDOWS\\system32\\cmd.exe" /c "echo MARK-B3 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue` | `—` | — | excluded：写验证未通过（文件缺失或无 marker） |
| 7 | cmd-write | commandExecution | `"C:\\WINDOWS\\system32\\cmd.exe" /c "echo MARK-B4 > \"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue` | `—` | — | excluded：写验证未通过（文件缺失或无 marker） |
| 8 | patch-edit | mcp:codey_fastctx/replace | `{"path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\codex\\e1.txt","pattern":"alph` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\e1.txt ; C:\\Users\\liuy\\AppD` | e1.txt | hit |
| 9 | patch-edit | mcp:codey_fastctx/replace | `{"path":"C:\\Users\\liuy\\AppData\\Local\\Temp\\kb-clue-probe-4aFkUl\\codex\\e2.txt","pattern":"alph` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\e2.txt ; C:\\Users\\liuy\\AppD` | e2.txt | hit |
| 10 | patch-create | fileChange | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w1.txt` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w1.txt ; C:\\Users\\liuy\\AppD` | w1.txt | hit |
| 11 | patch-create | fileChange | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w2.txt` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w2.txt ; C:\\Users\\liuy\\AppD` | w2.txt | hit |
| 12 | patch-create | fileChange | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w3.txt` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w3.txt ; C:\\Users\\liuy\\AppD` | w3.txt | hit |
| 13 | patch-create | fileChange | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w4.txt` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w4.txt ; C:\\Users\\liuy\\AppD` | w4.txt | hit |
| 14 | patch-create | fileChange | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w5.txt` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\codex\w5.txt ; C:\\Users\\liuy\\AppD` | w5.txt | hit |

### opencode

| # | turn | 工具 | 事件摘要 argsSummary（截断 100 字符） | 提取结果（截断 90 字符） | 实际操作文件 | 结果 |
|---|---|---|---|---|---|---|
| 1 | read | read | `{}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\opencode\r1.txt ; /path ; /type ; /c` | r1.txt | hit |
| 2 | read | read | `{}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\opencode\r2.txt ; /path ; /type ; /c` | r2.txt | hit |
| 3 | read | read | `{}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\opencode\r3.txt ; /path ; /type ; /c` | r3.txt | hit |
| 4 | read | read | `{}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\opencode\r4.txt ; /path ; /type ; /c` | r4.txt | hit |
| 5 | read | read | `{}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\opencode\r5.txt ; /path ; /type ; /c` | r5.txt | hit |
| 6 | read | read | `{}` | `C:\Users\liuy\AppData\Local\Temp\kb-clue-probe-4aFkUl\opencode\r6.txt ; /path ; /type ; /c` | r6.txt | hit |
| 7 | write | write | `{}` | `(空)` | w1.txt | MISS |
| 8 | write | write | `{}` | `(空)` | w2.txt | MISS |
| 9 | write | write | `{}` | `(空)` | w3.txt | MISS |
| 10 | write | write | `{}` | `(空)` | w4.txt | MISS |
| 11 | write | write | `{}` | `(空)` | w5.txt | MISS |
| 12 | edit | edit | `{}` | `(空)` | e1.txt | MISS |
| 13 | edit | edit | `{}` | `(空)` | e2.txt | MISS |
| 14 | edit | edit | `{}` | `(空)` | e3.txt | MISS |
| 15 | bash | bash | `{}` | `(空)` | b1.txt | MISS |
| 16 | bash | bash | `{}` | `(空)` | b2.txt | MISS |
| 17 | bash | bash | `{}` | `(空)` | b3.txt | MISS |
| 18 | bash | bash | `{}` | `(空)` | b4.txt | MISS |


## 三 CLI 形态发现（关键工程事实）

**Claude Code（claude 2.x，stream-json）——提取稳定。** `tool_started.argsSummary` = 完整工具入参 JSON（`claude-adapter.ts` `safeJson(block.input)`）：Read/Write/Edit 带 `file_path` 键，Bash 带 `command` 键（含引号包裹的绝对路径）。语义键值提取即可命中，与权限档/模型行为无关。

**Codex（codex-cli，app-server）——提取稳定。** 实测三类工具形态全部可提取：`commandExecution`（argsSummary = 裸命令串，pwsh/cmd 包装内的路径可提取）、`fileChange`（argsSummary = 绝对路径串；output = changes JSON 的 `path` 字段）、MCP 工具（本机配置了 codey_fastctx，`file_path`/`path` JSON 键）。注：MCP 形态依赖本机 server 配置，无 MCP 环境下 codex 走 commandExecution/fileChange，提取器对两者均有密封覆盖。两轮中 echo 写命令一轮被模型整轮跳过、一轮执行但文件未落盘（原因未深究，非提取器问题，均按验证规则 excluded）。

**OpenCode（opencode，server 事件流）——结构性不可提取，根因在 Adapter 发射时点。** `tool_started` 发射时 `state.input` 尚为空对象（OpenCode 流式工具入参晚于 part 出现），`describeToolArgs({})` 恒输出 `{}`——**argsSummary 对所有工具恒空**，与工具类型无关。output 侧只有 read 回显 `<path>…</path>` 可提取；write/edit/bash 的输出是 `"Wrote file successfully."` / `"Edit applied successfully."` / `"(no output)"`，不含任何路径。18 个干净样本中 read 6/6 命中、write 0/5、edit 0/3、bash 0/4——这不是提取器能力问题，是事件通道里没有该信息。

提取器精度备注（不影响命中判据，UI 若上线需治理）：read 输出的 `</path>` 闭合标签会产生 `/path`、`/type` 等噪声 token；claude JSON 摘要的转义形态会同时产出正/反斜杠两个候选。按序去重后首个候选均为正确路径，命中判据不受影响。

## 结论与处置

1. **UI 不上线**：Diff 文件行「最近改动会话」虚线标注（原型 d1 session-tag）不实现；#43 交付的纯工作区 Diff 视图即终态。原型 d1 中「会话线索为 best-effort 标注，提取不到则不显示」的整行不落地。
2. **提取器留档**：`packages/cli-host/src/tool-path-extract.ts` + 密封测试保留（claude/codex 形态已实证可用；未来 OpenCode 侧信息到位后无需重写）。
3. **探针套留档可重跑**：`KANBAN_E2E=1 KANBAN_SESSION_PROBE=1 KANBAN_CODEX_MODEL=gpt-6-luna,gpt-5.6-luna pnpm --filter @kanban/cli-host test tests/e2e/session-clue-probe.e2e.test.ts`，样本 JSON 覆写至本目录。

`shortcut: 会话线索标注 UI 未上线，适用界限 = OpenCode 的 tool_started 时刻 state.input 为空且 write/edit/bash 输出无路径，其工具事件结构性提不出文件路径；复查触发条件 = OpenCode Adapter 改为入参到达后补发摘要（或 output 携带路径）后重跑本探针，三 CLI 全部 ≥80% 即可按原型 d1 落地 UI（claude/codex 形态已达标且提取器已就位）。`

## 采集局限（如实标注）

- 工具事件不落库（spec #40 G 节现状），本探针样本全部来自当次运行的真实事件流；结论只覆盖「事件流内可提取性」，未评估跨重启历史。
- codex 的 MCP 工具形态样本依赖本机 codey_fastctx 配置；commandExecution/fileChange 形态有真实样本 + 密封覆盖。
- claude headless 与 codex（白名单模型）各 8 个 turn 的真实调用成本已发生；opencode magpie 内网网关 cost=0。
- 模型行为不确定性由归因规则吸收：不匹配轮整轮 excluded 并留痕（8 行），不计入命中率的分母分子。
