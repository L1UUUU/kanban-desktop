// 用途：FakeAdapter 演示脚本 —— 数据化 ScriptStep（可 JSON 化），行为规格对照原型 TURN_SCRIPT/APPROVAL_SCRIPT/decide()（交互文案为硬约束）
import type { ApprovalSuggestion } from "@kanban/ipc-schema";

/** 单步脚本：driver 解释执行；approval 步暂停等待用户决定（或过期） */
export type ScriptStep =
  | { t: "assistant"; text: string }
  | { t: "tool"; tool: string; args: string }
  | { t: "toolOutput"; chunk: string }
  | { t: "toolDone"; status: "completed" | "denied" | "interrupted"; durationMs: number; output?: string }
  | {
      t: "approval";
      command: string;
      suggestions: ApprovalSuggestion[];
      /** 无人决定时过期（Codex timed_out → approval_expired 映射） */
      expireAfterMs?: number;
      /** deny 后续步骤（缺省：直接结束 turn） */
      onDeny?: ScriptStep[];
    }
  | { t: "wait"; ms: number }
  | { t: "error"; code: string; message: string }
  | { t: "turnEnd" };

/** 默认 turn：流式 → 工具运行/输出/完成 → 总结（原型 TURN_SCRIPT） */
export const DEFAULT_TURN_SCRIPT: ScriptStep[] = [
  { t: "wait", ms: 600 },
  { t: "assistant", text: "好的，我先跑一遍现有测试确认基线，然后开始拆分。" },
  { t: "tool", tool: "Bash", args: "pnpm vitest run --filter ipc-schema" },
  { t: "toolOutput", chunk: "$ pnpm vitest run --filter ipc-schema\n" },
  { t: "toolOutput", chunk: " ✓ src/chat.test.ts (8) 2.1s\n ✓ src/session.test.ts (5) 1.4s\n" },
  { t: "toolDone", status: "completed", durationMs: 3600, output: " Test Files  2 passed\n      Tests  13 passed" },
  { t: "assistant", text: "基线全绿。现在把 chat 与 session 两个命名空间拆成独立文件，并在 index 里保持原导出面不变。" },
  { t: "turnEnd" },
];

// 审批卡建议（原型 approvalHTML 文案）
const EDIT_SUGGESTIONS: ApprovalSuggestion[] = [
  { kind: "addRules", label: "允许规则", detail: "Edit(src/**) 后续免询问" },
  { kind: "addDirectories", label: "允许目录", detail: "packages/ipc-schema/** 整目录" },
];

/** 审批分支：两次写文件审批 —— once 后第二次仍询问、always 后第二次跳过、deny 走道歉分支（原型 decide() 行为规格） */
export const APPROVAL_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "结构清楚了，我会新增 src/session/create.ts 并改写 index.ts 的导出。" },
  { t: "tool", tool: "Edit", args: "packages/ipc-schema/src/index.ts（写入 86 行）" },
  {
    t: "approval",
    command: "Edit packages/ipc-schema/src/index.ts",
    suggestions: EDIT_SUGGESTIONS,
    onDeny: [
      { t: "assistant", text: "好的，我不改这个文件。需要我先列出计划再逐条确认吗？" },
      { t: "turnEnd" },
    ],
  },
  { t: "assistant", text: "第一个文件写入完成，继续新建 src/session/create.ts。" },
  { t: "tool", tool: "Edit", args: "packages/ipc-schema/src/session/create.ts（新建 40 行）" },
  {
    t: "approval",
    command: "Edit packages/ipc-schema/src/session/create.ts",
    suggestions: EDIT_SUGGESTIONS,
    onDeny: [
      { t: "assistant", text: "好的，第二个文件也先不动，等你确认后再继续。" },
      { t: "turnEnd" },
    ],
  },
  { t: "assistant", text: "拆分完成，index.ts 的导出面保持不变，测试仍然全绿。" },
  { t: "turnEnd" },
];

/** 过期分支：审批无人应答 → approval_expired + 未执行（spec B 服务端终态映射演示） */
export const EXPIRY_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "这条命令需要审批；服务端超时后会自动过期，注意观察。" },
  { t: "tool", tool: "Bash", args: "rm -rf node_modules" },
  {
    t: "approval",
    command: "Bash rm -rf node_modules",
    suggestions: [{ kind: "none", label: "无建议", detail: "高危命令，请人工确认" }],
    expireAfterMs: 5000,
    onDeny: [
      { t: "assistant", text: "审批已过期，本次操作未执行；如需继续请重新发起。" },
      { t: "turnEnd" },
    ],
  },
];

/** 错误分支：CLI 进程意外退出演示（明确报错、不崩溃、不重放，spec H） */
export const ERROR_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "我来演示异常场景：Fake CLI 进程即将退出。" },
  { t: "error", code: "E_FAKE_CRASH", message: "Fake CLI 进程意外退出（演示）" },
];

/** 按发送文本选择脚本：命中关键词走对应演示分支（E2E/手动演示的确定性入口） */
export function pickScript(text: string): ScriptStep[] {
  if (text.includes("审批")) return cloneScript(APPROVAL_SCRIPT);
  if (text.includes("过期")) return cloneScript(EXPIRY_SCRIPT);
  if (text.includes("错误") || text.includes("异常")) return cloneScript(ERROR_SCRIPT);
  return cloneScript(DEFAULT_TURN_SCRIPT);
}

/** 脚本是共享数据：每个 turn 深拷贝一份避免运行期改写（onDeny 替换脚本指针） */
function cloneScript(steps: ScriptStep[]): ScriptStep[] {
  return steps.map((s) => ({ ...s }));
}
