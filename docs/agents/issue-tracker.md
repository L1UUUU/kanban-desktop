# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `L1UUUU/kanban-desktop`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Make an issue a sub-issue of a parent**: `gh issue create --parent <parent> ...`, or `gh issue edit <parent> --add-sub-issue <child>` afterwards (`gh` 2.94+). Older `gh`: `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` (the child's numeric database id). Without sub-issues, put `Part of #<parent>` at the top of the child body.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

### Spec issue 关闭惯例

`implement-spec` 收尾时，除逐张关闭 ticket 外还须**单独关闭父 spec issue**，判定如下：

- **单阶段 spec**：其全部 ticket 闭环即关闭（如 #23/#27/#40/#52）。合 main / push 不是关闭前置条件。
- **伞形多阶段 spec**（一个 spec 承载多个阶段、当前只完成其中若干阶段）：保持 OPEN，在评论里追记本阶段契约演进（v1 总 Spec #1 的做法）。

历史上曾因只按字面「resolve each ticket」而漏关父 spec，导致用户两次纠正；勿沿用「先例」自行推断。

### 范围外发现登记（out-of-scope findings）

Agent 处理工单时发现的、属于该工单范围之外的问题，**不在当前改动里顺手修**，而是登记为 issue——本节是全局「发现无关问题只记录」口径在本仓的落地，记录的形式就是登记 issue，让发现流入 tracker 而不是随会话沉没。登记规则：

- **门槛**：只登记真实缺陷、风险或技术债；风格瑕疵不登记（那属于 review 流程的范围外观察 O*）。
- **时机**：收尾回报时一并登记，不在任务中途分心查证。
- **去重**：登记前先 `gh issue list --state open --search "<关键词>"` 查重（并行 subagent 可能撞见同一问题）；已有相近 issue 时改为在该 issue 下追加评论补充证据，不新开。
- **标签**：一律打 `needs-triage`——未分诊，不代表 ready，不得直接开工。
- **格式**：标题带 `[out-of-scope]` 前缀；body 注明「处理 #NN 时范围外发现」，给出可核验证据（`file:line`、现象、复现条件），事实与假设分开写（沿用 review 报告 P*/R* 口径）。

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.
