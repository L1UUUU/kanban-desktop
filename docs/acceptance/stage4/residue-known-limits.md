# 残留进程治理已知限制（#49，spec #40 阶段 4）

> 状态：随 #49 交付 · 日期：2026-11-09
> 范围：`apps/desktop/electron/main/residue-service.ts`（detectResidue / killResidue）的漏检面、误检面与明确非目标；判定规则见 spec #40 F 节。

## 判定规则回顾（引用 spec #40 F 节）

- exe 匹配粒度 = 三 CLI 解析链**全量候选路径并集**（config manualOverride / `KANBAN_*_BIN` / npm 全局 / `where` 多结果 / codex vendored 深路径 / opencode 原生安装位），不只匹配本次解析出的单一路径；
- 排除本应用活跃集合（#44 `CliHostClient.listChildPids` 上报）；
- 排除注册表核对通过、可无损接管的 OpenCode 孤儿 server（复用 `server-host` `verifyRegistryEntry` 四要素语义；恢复会话时 `tryAdopt` 自动接管）；
- 「无会话记录」默认不勾选（可能是用户手动打开的，防误杀）；清理全程确认式，无任何自动清理路径。

## 已知漏检面

1. **npm 升级 / 路径漂移后的旧位置进程（F10）**：候选并集来自**当前**解析链探测结果。npm 全局包升级（目录更名/迁移）或安装位置漂移后，旧位置不再出现在候选并集中——从旧位置启动且仍在运行的进程会**漏检**。Windows 下运行中的 exe 文件本身被锁不可删，但父目录可被移动的边缘场景同属此类。
2. **打包形态下的本地 node_modules 候选缺失**：codex 解析链第 4 步（`createRequire` 探测 monorepo/开发态本地安装）在 packaged 应用的 Main bundle 内无法解析 `@openai/codex`，该候选位在打包形态下恒为空（开发态正常）。
3. **候选只收「当前存在」的路径**：与 `resolve*Exe` 采纳条件一致（`existsSync` 才收）。已被删除的 manualOverride / env 覆盖路径不入并集——正常场景无影响（运行中的 exe 文件必存在），仅在覆盖路径指向网络位置/大小写敏感文件系统等异常环境可能漏检。

## 已知误检/误归属面

4. **会话归属是 best-effort**：claude 按命令行 `--session-id`/`--resume` 精确匹配；opencode 按注册表 pid→cwd 匹配；codex（命令行无会话标识）与匹配失败时**回落同 CLI 最近一条会话记录**（「上次运行遗留」语义）。用户手动打开的 CLI 进程在同 CLI 存在历史会话记录时会被标上关联记录——这不影响安全性（勾选状态才是清理依据），但「关联记录」列不构成精确的进程↔会话映射。
5. **注册表核对通过但 HTTP 不可达的 OpenCode 孤儿同样被排除**：排除条件对齐 `verifyRegistryEntry`（pid 存活 + exe/命令行/创建时间四要素），不做 HTTP 探活。若该 server 实际已不可接管，恢复会话时会走新 spawn，旧进程不被列为残留（宁可漏列不误杀；该进程可在下次核对失败后被检出）。

## 明确非目标（spec #40 D3 / Out of Scope）

6. **PTY 子树强杀残留治理（D3）**：PTY 由 node-pty 在 Main spawn、无 Job Object；shell（powershell/cmd）进程按 exe 名匹配的误检面过大（用户自己开的终端会被误列），不在治理范围。PTY 正常退出治理（killAll）见 #13；应用被强杀场景由 Job Object 兜底覆盖 CLI 子孙进程（门控 e2e 实证，见 `run-once-job.e2e.test.ts`）。
7. **残留进程自动清理**：仅确认式（通知条勾选 → `residue:kill`），无任何自动清理路径。

## 检测时机与测试隔离说明

- 每次启动**检测一次**（应用就绪后，`ready-to-show` 推送 `app:event`），不轮询；无结果不推送任何事件（无打扰）；「忽略本次」仅关闭本次通知，下次启动重新检测。
- 整机 e2e（`KANBAN_USER_DATA` 隔离环境）下默认**跳过**机器级进程枚举（否则开发机上他人打开的真实 CLI 进程会把非密封 banner 带进无关 e2e 断言）；预置 fake 检测结果经 `KANBAN_TEST_RESIDUE_JSON`（指向残留清单 JSON，逐条过 `residueProcessSchema` 校验）注入，参照 `memory-seed.ts` 预置思路。种子模式下 `residue:kill` 不执行真实终止，统一回报 killed 驱动 UI 流程。
