// node 级运行时验证：直接驱动抽离的纯函数，验证语义与上游一致。
// 运行：node --experimental-strip-types verify-logic.ts
import { summarizeTurnChanges } from "./src/pi-desktop/turn-changed-files.ts";
import { reviewChangeFromMessage } from "./src/pi-desktop/workspace-review.ts";
import type { UiMessage } from "./src/pi-desktop/types.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  if (!pass) {
    console.log(`  actual:   ${JSON.stringify(actual)}`);
    console.log(`  expected: ${JSON.stringify(expected)}`);
  }
}

const okMsg: UiMessage = {
  id: "m1",
  role: "tool",
  toolName: "Edit",
  toolCallId: "c1",
  toolStatus: "success",
  content: "",
  createdAt: "2026-11-05T10:00:00Z",
  toolResult: {
    details: {
      root: "workspace",
      review: {
        version: 1,
        snapshotId: "snap-1",
        messageId: "m1",
        path: "src/app.tsx",
        operation: "edit",
        status: "modified",
        state: "active",
        additions: 10,
        deletions: 2,
        reversible: true,
        hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "x" }] }],
      },
    },
  },
};

// 1. 合法 review 消息被解析
const change = reviewChangeFromMessage(okMsg);
check("解析合法 review", change?.snapshotId, "snap-1");
check("解析 hunks", change?.hunks.length, 1);

// 2. error 状态消息被忽略（上游语义：只认 success）
check(
  "忽略 error 消息",
  reviewChangeFromMessage({ ...okMsg, toolStatus: "error" }),
  null,
);

// 3. 非 Write/Edit 工具被忽略
check(
  "忽略非 Write/Edit 工具",
  reviewChangeFromMessage({ ...okMsg, toolName: "Bash" }),
  null,
);

// 4. details.root 不在允许集合被忽略
const badRoot = JSON.parse(JSON.stringify(okMsg)) as UiMessage;
(badRoot.toolResult as { details: { root: string } }).details.root = "/etc";
check("忽略非法 root", reviewChangeFromMessage(badRoot), null);

// 5. 聚合：同路径两次编辑累加、状态合并
const summary = summarizeTurnChanges([
  okMsg,
  { ...okMsg, id: "m2", toolCallId: "c2", toolResult: { details: { root: "workspace", review: { version: 1, snapshotId: "snap-2", messageId: "m2", path: "src/app.tsx", operation: "edit", status: "modified", state: "active", additions: 3, deletions: 4, reversible: true, hunks: [] } } } },
  { ...okMsg, id: "m3", toolCallId: "c3", toolResult: { details: { root: "workspace", review: { version: 1, snapshotId: "snap-3", messageId: "m3", path: "src/new.ts", operation: "write", status: "added", state: "active", additions: 20, deletions: 0, reversible: true, hunks: [] } } } },
]);
check("聚合文件数", summary.files.length, 2);
const app = summary.files.find((file) => file.path === "src/app.tsx");
check("同路径计数累加", [app?.additions, app?.deletions], [13, 6]);
check("快照收集", app?.snapshotIds, ["snap-1", "snap-2"]);
check("目录计数", summary.directoryCount, 1);
check("总计数", [summary.additions, summary.deletions], [33, 6]);

// 6. 边界：空输入
check("空输入", summarizeTurnChanges([]).files.length, 0);

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log("\n全部通过：抽离的聚合/解析逻辑与上游语义一致");
