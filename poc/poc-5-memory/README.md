# PoC 5 — 需求级 Memory 手动提取验证

对应计划 §7「Memory V1」与 §9 PoC 5。验证「需求级手动提取 + 来源归属 + 审核闭环」这一难点，结构参照 pi-sleep-agent 的 T0/T1/T2 状态机与 review metadata（仅借状态机，无自动调度）。

## 结构

```text
lib/
  normalize.mjs      # 归一化事件模型、分段 chunkEvents、字符 bigram Dice 相似度、跨段合并
  history-claude.mjs # 读 ~/.claude/projects/<esc>/<id>.jsonl（只读）→ 归一化事件；MissingHistoryError
  history-codex.mjs  # app-server thread/read（读磁盘）→ 归一化事件
  codex-client.mjs   # 复制自 poc-1 的已验证客户端（只读复用）
  extract.mjs        # 独立临时 claude -p session（新 UUID + 隔离 cwd）、JSON 抠取、来源校正
  store.mjs          # data/<reqId>/ 布局、批次、summary 人工编辑检测（不静默覆盖）、accepted/ 写入
  review.mjs         # pending → accepted/edited/ignored 状态流转、冲突/纠正提示检测
scripts/
  create-dev-sessions.mjs # 创建真实开发 Session（claude 纠错微任务 + codex 微任务）+ 假 session + 基线指纹
  extract.mjs             # 手动触发提取 pipeline（等价「点击提取」按钮）
  demo-review.mjs         # 审核流演示（review-batch1）与重复提取验证（verify-batch2）
tests/               # 确定性单测（node:test，14 项）
fixture/workdir/     # REQ-001 开发 cwd（calc.js 被两个真实 session 修改）
data/                # Kanban 管理的 Memory 数据目录（产物）
logs/                # 运行证据（基线/隔离指纹、批次报告、模型调用台账）
```

## 复现（注意：会消耗真实模型调用）

```bash
cd poc/poc-5-memory
node --test tests/chunk.test.mjs tests/store.test.mjs tests/review.test.mjs  # 确定性单测，0 模型调用
node scripts/create-dev-sessions.mjs           # 2 次模型调用（claude + codex 开发 session）
node scripts/extract.mjs --req REQ-001 --batch B1   # 手动触发提取，2 次模型调用
node scripts/demo-review.mjs review-batch1     # 审核演示 + 人工编辑 summary（0 调用）
node scripts/extract.mjs --req REQ-001 --batch B2   # 重复提取，2 次模型调用
node scripts/demo-review.mjs verify-batch2     # 不覆盖/冲突/早期错误验证（0 调用）
```

结论见 RESULT.md。
