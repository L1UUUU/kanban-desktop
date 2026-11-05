# RESULT — T0-01 Worker 进程管理验证（issue #2）

> 验证日期：2026-11-05
> 环境：Windows 11 build 26200 / Node v24.13.0 / PowerShell 5.1（CIM + Add-Type C# P/Invoke）
> CLI：codex-cli 0.144.1（vendored codex.exe）/ Claude Code 2.1.317（bin/claude.exe）/ opencode 1.19.5（npm bin/opencode.exe），全部编程 spawn 直连真实 exe
> 成本：真实模型 turn 共 17 次（开发调试轮 T2×6、T3×2、T4×9 + 终轮 verification 重跑 T2×2、T3×1、T4×3），全部 gpt-5.6-luna effort=low 一句话级短提示；其余场景零模型调用
> 复现：见 `README.md`（每个脚本一条命令，退出码即判定；留档证据为 `logs/*-verify.json` 终轮 + `t1-result-full1.json` + `t5-bench.json` 复核轮）

## 1. 验收判定表（对照 issue #2 验收标准）

| # | 验收标准 | 判定 | 依据（命令 + 日志） |
|---|---|---|---|
| 1 | Windows Job Object + KILL_ON_JOB_CLOSE：宿主退出时全部 CLI 子进程（含孙进程）被 OS 终止，无孤儿 | **PASS** | `node t1-job-object.mjs` → `logs/t1-result-verify.json`（另留全量轮 `t1-result-full1.json`）三场景：**control**（无 Job）宿主 taskkill /F 后 6s，opencode server/合成子进程/孙进程全部存活成孤儿（复现 PoC 1 发现 #4），codex/claude 因 stdio 断管自退；**job**（有 Job）宿主 taskkill /F 后 ≤0.5s 全部成员（4 子进程 + 1 孙进程 + CLI 自派辅助进程共 18 个 Job 成员）被 OS 终止，guard 退出、零残留；**graceful** Job 内单杀 opencode 一个成员其余存活（Session 粒度不受 Job 干扰），宿主 stdin END 优雅退出 → Job 兜底全灭 |
| 2 | 取消 Turn 后 CLI 主进程存活、同一会话可继续下一轮 | **PASS** | `node t2-cancel-turn.mjs` → `logs/t2-result-verify.json`：codex 真实 turn 进行中（首批 delta 后）发 `turn/interrupt{threadId,turnId}` → CLI 回执 accepted，turn 终态 `interrupted`、中断后 0 新增 delta、**进程 pid 全程未变且存活**；同 thread 下一 turn「只回复两个字：收到」正常 `completed`。Claude/OpenCode 侧引用 poc-7 T2（interrupt → 0 delta → error_during_execution → 同会话轮 3 续答）与 poc-3（abort → 0 token → session 可继续），本 PoC 不重复计费验证 |
| 3 | 多会话并存按 Session 粒度逐会话有序终止，互不影响 | **PASS** | `node t3-session-granular.mjs` → `logs/t3-result-verify.json`：混合拓扑（codex 1 进程 2 thread + claude 2 进程会话 + opencode 2 server×1 session）按序终止 7 步全过：claude-A 优雅退出（stdin 关闭 exit 0）→ claude-B tiny turn 仍可用（「收到」）→ claude-B 强终止不影响其余 → codex t1 逻辑 dispose 后进程保留且 t2 可读（会话=thread 粒度）→ t2 dispose（最后会话）才停进程 → opencode s1 dispose 停 server1 后 server2 HTTP 正常且 s2 仍在 → s2 dispose 停 server2。有序序列完整记录于日志 |
| 4 | 孤儿 CLI「先核对再接管」策略验证（不重复接管、不重放副作用） | **PASS** | `node t4-orphan-adopt.mjs` → `logs/t4-result-verify.json`：**A** opencode 孤儿 server（宿主强杀后存活）按注册表核对（exe 路径 + `serve --port` 命令行签名 + 创建时间，实测 CIM 与注册 spawnAt 差 -54ms）→ 决策 reattach → 复用原 HTTP 建会话成功、进程数始终 1（无重复 spawn）、二次接管幂等（同 pid）；**B** codex turn 进行中宿主强杀 → 孤儿秒级窗口内核对通过 → 受控终止 → 新进程 `thread/resume` 同 id：崩溃前已完成 turn 全部在场、**无新增 completed turn（不重放）**（被中断数数轮以 `interrupted` 状态落盘）、暗号 `T4-XV1JVW` 精确复现（会话可用且上下文延续）；**C** 负例：死 pid / pid 存活但签名不符 / 创建时间偏差 1h（pid 复用形态）均拒绝接管 |
| 5 | CliHost 托管形态决策记录（utilityProcess vs 进程内 + 理由 + 实测数据）落 docs，并更新兼容性矩阵或架构文档 | **PASS** | `docs/adr/0001-clihost-hosting-utility-process.md`：**决策 utilityProcess**（Electron 42.11.18 实测：MessagePort 单向突发 72,848 events/s @~1KB、串行往返 p50 0.10ms / p95 0.29ms，阈值 5k events/s 与 p95≤10ms 双通过，不触发 C5 降级条件）；`docs/cli-compatibility-matrix.md` Windows 专项行与证据索引、`docs/architecture-proposal.md` §2/§7-1 已更新 |
| 6 | 复现步骤与日志证据留存；结论 PASS/PARTIAL/FAIL 如实标注 | **PASS** | `README.md` 复现命令；`logs/` 保留各测试最终通过轮与中间调试轮的 result JSON 与日志；调试期间的失败轮（模型 400、interrupt 缺 turnId、CIM 字段坑等）按「过程发现」如实记录，不粉饰 |

**总判定：6/6 PASS。**

## 2. 关键日志摘录

- T1 job：`job 成员=[host,codex,claude,opencode,tree,gc + CLI 自派辅助进程共 18 个] 期望缺失=[]` → `taskkill /F host → 成员全灭=true（轮询窗 1ms）guard 退出=true 非stdio成员被Job终止=true 残留=[]`
- T1 control：`6s 后存活: {opencode:true, tree:true, 孙进程:true, codex:false, claude:false}` + `stdio 自退情况: codex 已自行退出(EOF), claude 已自行退出(EOF)`
- T2：`turn/interrupt accepted {}` → `turn1 {turnStatus:"interrupted", deltasBeforeKill:2, deltasAfterEnd:0, procAliveAfterInterrupt:true}` → `turn2 {turnStatus:"completed", text:"收到"}`
- T3 有序序列：`["claude-A(graceful,exit=0)","claude-B(force,gone)","codex-t1(logical,process kept)","codex-t2(last→stop process)","opencode-s1(server1 stop)","opencode-s2(last→server2 stop)"]`
- T4 B：`{orphanAt1s:true, cimFound:true, diffMs:-54}` → `terminate-then-resume: 孤儿已终止` → `resume {sameThread:true, preTurns:1, postTurns:2, allPrePresent:true, noNewCompleted:true, postStatuses:["completed","interrupted"]}` → `暗号复现 {text:"T4-XV1JVW"}`
- T5（`logs/t5-bench.json` 复核轮）：`单向突发 34474.7 events/s / 串行往返 p50 0.11ms p95 0.58ms / 进程内直调 494628.3 events/s`（首轮 72848/0.10/0.29/747228，两轮均远超阈值，ADR-0001 双轮并记）

## 3. 过程发现（对产品实现直接有用）

1. **Job Object 是 Windows 退出治理的正解，且不影响 Session 粒度**：宿主持 Job 句柄（本 PoC 用 powershell guard 持句柄等待宿主死亡后退出实现，等价于「宿主死→句柄关→OS 全灭」语义），成员含 CLI 自派的所有辅助进程（实测 codex/claude/opencode 各自 spawn 的 helper 共 12 个额外成员自动继承入 Job）；Job 内 taskkill 单个成员不影响其他成员与宿主。产品可用原生 addon 由 Worker 直接持句柄简化 guard，语义不变。
2. **stdio 直连的 CLI 在宿主死亡后自退，孤儿风险集中在两类进程**：codex app-server（stdin EOF → 退出）与 claude stream-json（stdin 关闭 → 自然 exit 0，poc-7 T4 同款）在宿主死后秒级自退（T1 control 实测）；真正持久成孤儿的是 stdio=ignore 的 opencode server 与 CLI 派生的孙进程树——Job Object 恰好确定性覆盖这两类。T4-B 实测 codex「turn 进行中」的孤儿窗口为秒级（1s 时存活、~6-10s 内自退；退出中的进程 `kill(pid,0)` 仍返回 true 但 WMI 已移除其记录）。
3. **孤儿接管按可重连性分派**：opencode server（HTTP）→ 核对身份后直接复用（不重复 spawn、幂等）；codex/claude（stdio，无法重连另一进程的管道）→ 核对后受控终止 + 按原生历史 resume（快照一致=零重放，暗号复现）。身份核对四要素：pid 存活 + ExecutablePath 一致 + 命令行签名（`serve --port P` / `app-server`）+ 创建时间防 pid 复用。
4. **codex turn/interrupt 必须带 turnId**（`{threadId, turnId}`，turnId 取自 `turn/started` 事件），缺 turnId 报 `Invalid request: missing field 'turnId'`；且 thread/start 必须显式传本账号可用模型（gpt-5.6-luna），默认模型报 400（poc-1 发现 2 复现确认）。
5. **从未发过消息的 codex thread 不支持 `thread/read{includeTurns}`**（`thread is not materialized yet`）——无 turn 的会话用无 includeTurns 的 thread/read 验证可用性。
6. **被中断的 turn 会以 `interrupted` 状态持久化到原生历史**：T4-B 崩溃时进行中的数数 turn 在 resume 后以 interrupted 在场，不产生新 completed turn——GUI 恢复历史时应预期 interrupted 终态条目。
7. **opencode `POST /session` 响应字段是 `id`**（非 sessionID；含 slug/projectID/directory/cost 等），与 poc-3 用法一致。
8. **PowerShell 5.1 的三个坑（已绕开，产品不依赖 PS，记录供同类验证复用）**：无 BOM 的 UTF-8 .ps1 按 ANSI/GBK 解析（中文注释会破坏 param 块，本 PoC 的 .ps1 全 ASCII）；`Win32_Process.CreationDate` 经 ConvertTo-Json 序列化不可直接 `new Date()` 解析（需 `.ToString('o')` 转 ISO，否则时间核对退化为 NaN 恒真）；`JOBOBJECT_BASIC_PROCESS_ID_LIST` 的两个计数字段是 32 位 ULONG、pid 列表 8 字节步长（与直觉的 ULONG_PTR 头不一致）。
9. **undici keep-alive 复用被服务端关闭的空闲连接时 POST 不自动重试**（"fetch failed"），接管 HTTP server 的调用需带一次重试。
10. **本验证 harness 环境对非 detached 子进程有「随父强杀」的清理机制**（等效一种 Job 行为）：模拟「无 Job 的孤儿对照」必须 spawn 时 `detached: true`（poc-3 的 opencode server 正是如此存活）。产品（Electron 直接 spawn）不受此影响，但同环境复现本 PoC 时须沿用 `detached`（脚本已内置）。

## 4. 未尽事项（如实）

- Claude 侧「取消 Turn」未在本 PoC 重复实测（引用 poc-7 T2 实证：interrupt 确认 → 0 delta → error_during_execution 归类已取消 → 同会话继续）；OpenCode 侧引用 poc-3 abort 项。理由：避免重复计费，且两者协议路径与进程管理无耦合（进程级语义已由 T3 的 claude 双会话与 opencode 双 server 覆盖）。
- Job Object guard 以 PowerShell 进程实现（产品建议改原生 addon 或 Worker 自持句柄，语义等价，ADR-0001 已注明）。
- T5 bench 的管线往返（5000 并发在途）延迟含排队（avg 67.8ms），仅作参考；判定采用串行往返与单向突发两项（单命令延迟与事件流方向吞吐的真实口径）。
