# T0-02 结果 — Agent SDK Windows 跟进：正式弃用，协议直连为唯一传输层基线

> 日期：2026-11-05 · 执行人：T0-02 subagent · 工单 #3 · 规范依据：spec G（issue #1）§7-2 / 架构提案 §7-2 / PoC 2 发现 #4、#5 · 对照基线：PoC 7（协议直连全能力实证）

## 0. 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 build 26200，win32-x64，Git Bash 驱动 |
| Node / npm | v24.13.0 / 11.6.2 |
| 被测 SDK | @anthropic-ai/claude-agent-sdk 0.3.318（latest）、0.3.309、0.2.141；win32-x64 捆绑包同版本号 |
| 对照 exe | 全局 claude CLI 2.1.317（PoC 7 协议直连已实证可用） |
| 认证 | 用户级 settings env（内网网关），`settingSources:["user"]` |
| 成本 | **0 次模型调用**（全部失败发生在 system/init 之前，\$0） |

## 1. 上游状态（2026-11-05 实查：gh api + npm view）

| 项 | 状态 |
|---|---|
| npm 最新版 | 0.3.318（2026-11-03 发布）；dist-tags latest=next=0.3.318；无更高预发布通道。**与 PoC 2 实测失败版本相同，其后无新版本** |
| [#359](https://github.com/anthropics/claude-agent-sdk-typescript/issues/359) Stream closed after first tool call on Windows; disappears when debug:true | **open**，0 评论，最后更新 2026-06-30（SDK 0.3.196 时代报告） |
| [#444](https://github.com/anthropics/claude-agent-sdk-typescript/issues/444) Query.interrupt() after init segfaults claude.exe on Windows (0xC0000005) | **open**，0 评论，最后更新 2026-09-04（SDK 0.2.120 时代报告） |
| CHANGELOG Windows 修复 | 0.3.309 bunfs 解压目录 / 0.3.271 网络盘 session / 0.3.261 插件经 stdin 投递修 Windows 启动失败 / 0.3.193 控制台闪烁 / 0.2.101 temp 泄漏 / 0.1.71 控制台窗口——**均非本类「子进程 init 前静默秒退」** |

两 issue 均未指明修复版本；上游无可跟进的修复发布。

## 2. 复测矩阵（真实运行：全部 0 消息 / stderr 空 / init 前失败）

| 版本 | T1 最小 query | 耗时 | 错误文案 | 证据 |
|---|---|---|---|---|
| 0.3.318（latest） | **FAIL** | 5.0s / 7.0s（两轮） | `Error: Operation aborted`（栈：ChildProcess onexit → SDK o3） | runs/check-0.3.318.json |
| 0.3.309（最近 Windows 修复版） | **FAIL** | 9.3s | `Error: Operation aborted` | runs/check-0.3.309.json |
| 0.2.141（旧线，PoC 2 同款） | **FAIL** | 2.5s | `Claude Code process aborted by user` | runs/check-0.2.141.json |

check.mjs 三段设计：T1 最小 query（判定传输层可用）→ T2 interrupt 存活（#444 场景）+ T3 canUseTool 审批（PoC 2 发现 5 缺口）。T1 失败即跳过 T2/T3（传输层不可用无从谈起）。退出码：0=SDK 可用、1=不可用——**本复测的期望退出码是 1 且两轮重跑一致（可复现）**。

## 3. 失败层定位（隔离实验链，逐步排除）

```text
SDK query() ──spawn──> 捆绑 claude.exe（CIM 抓到的 args 与手动直连成功时逐字一致）
                          │  存活 2.5~9s，stdout/stderr 均 0 输出，静默退出
                          v
              SDK 把子进程退出翻译为 "Operation aborted" / "aborted by user"
```

| # | 实验 | 结果 | 排除 / 锁定 |
|---|---|---|---|
| E1 | CIM 轮询抓真实 spawn（diag-run.mjs + PowerShell Get-CimInstance） | 捆绑 exe，`--output-format stream-json --verbose --input-format stream-json`（仅此 3 组 flag），存活 ~3.4s 后退出 | spawn 参数与 PoC 2 手动直连成功时**逐字一致** → 排除参数差异 |
| E2 | `pathToClaudeCodeExecutable`=全局 2.1.317（PoC 7 实证可用） | 同样秒退失败 | **排除捆绑 exe 本身**（diag-variants.mjs 变体 B） |
| E3 | `settingSources:[]`（不加载任何 settings/插件） | 同样秒退失败 | **排除 settings/插件加载与认证依赖**（变体 C） |
| E4 | 手动 spawn 同 exe+args+SDK env（ENTRYPOINT=sdk-ts、SDK 版本、checkpointing、删 NODE_OPTIONS，M1-M3） | 三个变体全部存活 ≥10s 并正确回 initialize control_response | **排除 exe、args、env**（diag-manual-spawn.mjs） |
| E5 | `debug:true`（CLI 自写排障输出） | 仍秒退且 stderr 0 字节 | CLI 连自身日志都未写出 → 死在极早期（diag-debug.mjs） |
| E6 | Windows Application 事件日志（Id=1000，近 2h） | 无任何 claude 相关崩溃记录 | 非 WER 级崩溃（与 #444 的 0xC0000005 表现不同源但同族：静默即死） |

**结论**：失败收敛到 **SDK 自身对子进程的传输/生命周期管理层**（剩余差异仅为 SDK 写入 stdin 的 initialize 载荷内容与进程管理时序；字节级触发点未定位，属上游排障范围）。E4 证明同一 exe、同一 env、同一参数以 SDK 之外的方式拉起完全正常——**不存在可锁的配置组合**。

## 4. 决策

**正式弃用 @anthropic-ai/claude-agent-sdk（Windows）；确认 stream-json 协议直连为唯一传输层基线。**

理由（四条独立证据链）：

1. **无版本可锁**：latest 0.3.318 / 近端 0.3.309 / 旧线 0.2.141 今日全部同样失败（§2）；
2. **上游无修复**：#359/#444 均 open、0 评论、无修复版本指明，changelog 无本类修复，latest 自 PoC 2 后未动（§1）；
3. **失败在 SDK 传输层且与 exe/settings/env/args 全部无关**（§3 E1-E4），换「已知可用」的 exe 也救不了 → 不存在规避配置；
4. **协议直连已覆盖全部所需能力**（PoC 7 T1-T6：持久多轮 / interrupt 取消 / 审批 allow-deny / 跨重启 resume / `--settings` 会话级 hook 注入 / 认证叠加），SDK 无任何独有能力——保留备选路径只是保留一条不可用分支。

### 对 Claude Adapter（工单 #10）的指导

- 传输层按 poc-7 `lib/client.mjs` 演进（poc-2 protocol-client.mjs 谱系），**不留 SDK 备选路径**；
- 审批：显式 `--permission-prompt-tool=stdio` + Adapter 启动自检 fail-fast（漏带=静默全拒绝，PoC 7 T3）；
- 中断：`control_request{interrupt}`，`result(subtype=error_during_execution)` 归类「已取消」（PoC 7 T2）；
- 会话级注入用 `--settings`（叠加语义），禁用 `--setting-sources`（排除用户级会切断认证 env，PoC 2 发现 4）。

`shortcut: Agent SDK 在 Windows 正式弃用；复查触发条件：上游 #359/#444 关闭或 CHANGELOG 出现子进程启动/中断类 Windows 修复时，跑 bash run.sh <最新版> 复测，T1-T3 全 PASS 才重新评估引入。`

## 5. 复现

```bash
cd poc/t0-02-sdk
bash run.sh 0.3.318        # 复测任一版本（期望 verdict: SDK-UNUSABLE，退出码 1）
node diag-variants.mjs     # E2/E3 隔离（换全局 exe / 禁 settings，期望全 THREW）
node diag-manual-spawn.mjs # E4 手动 spawn 对照（期望 M1-M3 全部存活 10s）
node diag-debug.mjs        # E5 debug 模式（期望秒退且 stderr 0 字节）
```

依赖只装在本目录（node_modules / package-lock 已 gitignore），每次 check 写 `runs/check-<version>.json`（含版本、耗时、完整错误栈、消息计数）。

## 6. 成本台账

0 次真实模型调用（全部失败发生在 system/init 之前）；上游查询走 gh api / npm view（免费）。
