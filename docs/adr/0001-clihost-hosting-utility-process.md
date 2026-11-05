# ADR 0001 — CliHost 托管形态：Electron utilityProcess

> 状态：已接受（依据 spec C5 决策规则 + T0-01 实测数据）· 日期：2026-11-05
> 数据来源：`poc/t0-01-worker/bench/`（Electron 42.11.18 / Node 24.19 / Windows 11 build 26200 / ~1KB JSON 载荷）
> 关联：`poc/t0-01-worker/RESULT.md`、spec 冻结契约 C5（issue #1）

## 背景

CliHost（`command(cmd) / subscribe(handler) / shutdown({reason})`，纯 Node 无 Electron 依赖）可由两种形态承载：

- **A. Electron utilityProcess**（spec 默认）：Worker 崩溃隔离 + Windows Job Object 与宿主绑定（`poc/t0-01-worker` T1 已实测 KILL_ON_JOB_CLOSE 全灭无孤儿）；代价是事件经 MessagePort 结构化克隆跨进程。
- **B. Main 进程内**：零跨进程开销，但 Worker 内未捕获异常可拖垮 Main（窗口/IPC/SQLite 同进程），且 Job Object 生命周期需与 Main 绑定。

spec C5 规则：**默认 utilityProcess；若 MessagePort 事件吞吐/序列化实测有问题则降级 Main 进程内**。本 ADR 记录实测与判定。

## 决策

**采用 A：utilityProcess 托管 CliHost。** Renderer 与 Adapter 均不感知该选择（seam 在消息边界）。

## 实测数据（2026-11-05，本机，两轮：首轮 + 复核轮）

| 基准（载荷 ~1KB AdapterEvent 形状 JSON） | 首轮吞吐 | 复核轮吞吐 | 延迟（首轮 / 复核轮） |
|---|---|---|---|
| utilityProcess MessagePort 单向突发（worker→main，事件流方向） | **72,848 events/s** | 34,475 events/s | 首事件 0.4ms |
| utilityProcess MessagePort 串行往返（单命令口径，n=200） | 5,797 events/s | 4,917 events/s | p50 **0.10/0.11ms** / p95 **0.29/0.58ms** / max 4.2/5.9ms |
| utilityProcess MessagePort 管线往返（5000 并发在途） | 37,683 events/s | 49,523 events/s | avg 67.8ms（含排队，仅参考） |
| 对照：Main 进程内直调（引用传递） | 747,228 events/s | 494,628 events/s | ~1μs |
| 对照：Main 进程内 + JSON 序列化往返 | 220,900 events/s | 148,341 events/s | ~4μs |
| 对照：Main 进程内 EventEmitter 单向突发 | 976,358 events/s | 712,073 events/s | — |

（复核轮与首轮同机同日，绝对值受机器负载影响波动，量级一致；两轮数据均留存于 `poc/t0-01-worker/logs/t5-bench.json`（复核轮）与本 ADR 记录。）

## 判定阈值与结论

- 事件流方向（worker→main）需求估算：最热模型流式 delta ≈ 100–1000 events/s；阈值 ≥5,000 events/s。两轮实测 72,848 / 34,475 —— **复核轮仍有约 34× 余量，通过**。
- 命令往返（用户触发 sendTurn/审批/取消，人速率）：阈值 p95 ≤10ms。两轮实测 p95 0.29 / 0.58ms —— **不可感知，通过**。
- 与进程内直调差距约 10×，绝对值远超需求；结构化克隆（V8 serializer）对 ~1KB JSON 载荷无异常退化。

两项阈值均通过，不满足降级条件 → 维持默认 utilityProcess。

## 后果

- Main 获得崩溃隔离：Adapter/Worker 未捕获异常不拖垮窗口与 SQLite（阶段 1 需在 shutdown 路径上落实「停止新请求 → 有序取消 → 有限等待 → 受控终止」，Job Object 兜底）。
- Windows 退出治理（T1 实测）：Worker 自建 Job Object（KILL_ON_JOB_CLOSE）并绑定自身生命周期，宿主/Worker 任何方式死亡 → OS 终止全部 CLI 子/孙进程，无孤儿。
- 若未来出现单事件大载荷（>100KB）或 >10k events/s 的持续事件流需求，重跑 `bench/` 复核阈值；届时再评估降级 Main。
