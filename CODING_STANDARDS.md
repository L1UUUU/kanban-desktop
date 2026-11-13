# 编码标准（CODING_STANDARDS.md）

> 本文只放**需要判断**的规则，供 `code-review` 的 Standards 轴与 review agent 读取。
> 机械性违规一律由确定性检查拦截，不写进本文：见下方「门禁」与 `docs/testing.md`。

## 门禁（机械性，勿人工判）

以下命令由 `.githooks/pre-commit` 与 `.github/workflows/checks.yml` 强制执行，验收时只报告结果，不再作为 review 发现项：

| 检查 | 命令 | 拦什么 |
|---|---|---|
| 严格 lint | `pnpm lint:strict`（oxlint `--deny-warnings`） | 孤儿 import、未使用变量、其它 warning 级违规 |
| 类型 | `pnpm typecheck` | 类型错误、重复声明、include 漏覆盖 |
| 密封测试 | `pnpm test` | A 类回归 |
| 门禁契约 | `pnpm check:gates` | `.e2e.test.ts` 缺 `KANBAN_E2E`、`workspacePackages` 漏包、归档 PNG 被意外提交、文档相对链接失效 |
| 提交信息 | `.githooks/commit-msg` | Conventional Commits 前缀、必填「测试方法」栏 |

`pnpm lint`（不带 `:strict`）保留 0 退出码的宽松语义，仅用于本地快速查看；**验收一律用 `lint:strict`**。

## 判断性规则

### 单一职责与拆分
- 函数保持单一职责；单文件超过约 500 行时评估是否拆分，但拆分须以"接口更清楚"为前提，不为了行数机械切分。

### 接口设计（深模块）
- 优先深模块：接口小而实现深——少量方法、简单参数，把复杂度藏在模块内。设计时先问能否减方法数、减参数、多藏实现；不造"大接口转发薄实现"的浅模块。
- 为可测性设计：依赖从外部传入而非内部构造；函数返回结果而非产生副作用。接口面越小，需要测的组合越少。

### 注释
- 新建文件/新函数写一行用途注释；复杂逻辑在关键步骤补注释。
- 注释描述**当前设计与实际行为**，不写"以后要改""临时方案"式的过程记录；已确认接受的实现限制用 `shortcut: <适用界限>；<复查触发条件>` 记在代码或设计文档一处。

### 配置项与路径
- 配置、路径、密钥不硬编码，统一放配置；但"测试 fixture 里的固定字面量""注释里的示例路径"是否算硬编码由 reviewer 按上下文判断。

### 路径分隔符（Windows 宿主）
- 传给子进程或与之约定的路径（spawn CLI 的 cwd 与参数、写进其配置的路径）用 `posix.join` 拼接；Windows 上平台感知 `join` 产出的 `\` 可能被对端静默拒绝——命令继续跑但数据丢失。
- 比较来自不同来源的路径（`===` / `startsWith` / `Set.has` / `includes`）前先归一化分隔符：git 与多数 CLI 输出报 `/`，而 `node:path.join`/`normalize` 在 Windows 报 `\`，混比静默失配；macOS/Linux CI 上两边都是 `/`，测试测不出来。比较用 `/`；结果再交回下游 `join`/fs 前恢复平台原生 `normalize`。

### 契约单源
- 枚举、公共类型、schema 只在一处定义（如 `@kanban/ipc-schema`），消费方导入而非复制。跨多处出现的同名定义是缺陷，即便能通过编译。
- 何时把重复的私有 helper 抽成共享模块属判断：调用方 ≥3、且语义确实同一件事时才抽，避免为消重而造出的间接层。

### 可选参数
- 新增可选参数（带默认值的形参 / `?` 属性）须格外审视：调用方漏传是最常见的 bug 源之一。正确性优先于兼容——能把参数改为必填、让漏传处直接暴露的，就不留可选默认值。

### 占位文案与真链接通
- 开发期占位文案（"IPC 未暴露""暂未接入"等）在真实链路接通后同步清理；是否仍有遗留由 reviewer 结合产物冒烟判断。

### 测试归属
- 执行类判定、目录与门禁协议见 `docs/testing.md`（唯一权威出处）；测试写法判断（行为验证、mock 边界、纵向切片）同见该文「测试写法」。新增测试是否落在正确的类/目录是判断；落错目录由 `check:gates` 与 CI 拦截。

### 异常与日志
- 异常给出明确提示或日志，保证失败可定位；"吞异常"是否可接受由 reviewer 按边界（如 teardown、探测失败回落）判断。

## 导航

- 仓库地图（模块入口、契约、隐藏同步点、原型、评审标准源）：`docs/agents/navigation.md`
- 测试三执行类 / 门禁协议 / 命令矩阵：`docs/testing.md`
- 领域术语与 ADR：`GLOSSARY.md`、`docs/adr/`
- issue 跟踪与关单惯例：`docs/agents/issue-tracker.md`
