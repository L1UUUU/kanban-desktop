// 用途：FakeAdapter 演示脚本 —— 数据化 ScriptStep（可 JSON 化），行为规格对照原型 TURN_SCRIPT/APPROVAL_SCRIPT/decide()（交互文案为硬约束）
import type { ApprovalSuggestion, SessionErrorCode, SkillObservation } from "@kanban/ipc-schema";

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
  /** SkillObservation 观察信号步（#9）：向订阅者发归一化 skill 事件（不入 chat 日志，C2 语义独立于消息流） */
  | { t: "skill"; skill: string; cli: SkillObservation["cli"]; evidenceLevel: SkillObservation["evidenceLevel"] }
  | { t: "wait"; ms: number }
  /** 错误步（#41）：code 收紧为 session_error 六成员闭枚举，直通发出（S4 错误演示的确定性入口） */
  | { t: "error"; code: SessionErrorCode; message: string }
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

/** 错误分支：CLI 进程意外退出演示（明确报错、不崩溃、不重放，spec H；#41 起 code 用闭枚举 CLI_EXIT） */
export const ERROR_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "我来演示异常场景：Fake CLI 进程即将退出。" },
  { t: "error", code: "CLI_EXIT", message: "Fake CLI 进程意外退出（演示）" },
];

// C2 有效阶段 skill 集合（token 精确匹配用；硬编码于 fake 层，真实识别归各 Adapter）
const STAGE_SKILLS = new Set(["design-feature", "implement-spec", "pr", "retro"]);

/** skill 分支：发送文本首个空白分隔 token 精确等于 /skill名 且命中已知 skill（镜像 Codex 生成规则，spec B）；
 *  Fake 无 hook → 缺省 self_reported；第二个 token 为 "verified" 时以 Claude hook 口径发 verified 信号
 *  （#18 看板自动建卡链路的 e2e/演示入口：verified design-feature 才触发 tracker 自动建卡） */
export function skillTurnScript(skill: string, verified = false): ScriptStep[] {
  const cli = verified ? "claude-code" : "codex";
  const evidenceLevel = verified ? "verified" : "self_reported";
  return [
    { t: "skill", skill, cli, evidenceLevel },
    { t: "assistant", text: `已收到 /${skill}，开始按该 skill 的流程推进（观察信号 ${evidenceLevel} 已发出）。` },
    { t: "turnEnd" },
  ];
}

/** S4 错误演示分支（#46）：认证失效 / spawn 失败 / 协议断连 / 未知兜底（文案对照 auth-samples.md 与真实报错形态） */
export const AUTH_ERROR_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "我来演示认证失效场景：CLI 报告登录已失效。" },
  { t: "error", code: "AUTH_EXPIRED", message: "Failed to authenticate. API Error: 401 无效的令牌（演示）" },
];

export const SPAWN_ERROR_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "我来演示找不到 CLI 的场景：exe 解析全链落空。" },
  { t: "error", code: "SPAWN_NOT_FOUND", message: "未找到 CLI 可执行文件（已尝试：npm 全局；where/which）（演示）" },
];

export const DISCONNECT_ERROR_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "我来演示协议断连场景：与 server 的连接中断。" },
  { t: "error", code: "PROTOCOL_DISCONNECT", message: "opencode server 请求失败（POST /session/s_x/prompt_async）：fetch failed（演示）" },
];

export const UNKNOWN_ERROR_SCRIPT: ScriptStep[] = [
  { t: "assistant", text: "我来演示未识别错误场景：保留原始 code 与 message。" },
  { t: "error", code: "UNKNOWN", message: "某种未覆盖的错误形态（演示）" },
];

/** 按发送文本选择脚本：命中关键词走对应演示分支（E2E/手动演示的确定性入口）；/skill 名精确命中走 skill 分支，未命中按普通 prompt 发送 */
export function pickScript(text: string): ScriptStep[] {
  const tokens = text.split(/\s+/);
  const token = tokens[0] ?? "";
  if (token.startsWith("/") && STAGE_SKILLS.has(token.slice(1))) return cloneScript(skillTurnScript(token.slice(1), tokens[1] === "verified"));
  if (text.includes("审批")) return cloneScript(APPROVAL_SCRIPT);
  if (text.includes("过期")) return cloneScript(EXPIRY_SCRIPT);
  // #46 四条错误分支（「未知错误」含「错误」，须先于通用分支判定）
  if (text.includes("认证")) return cloneScript(AUTH_ERROR_SCRIPT);
  if (text.includes("找不到")) return cloneScript(SPAWN_ERROR_SCRIPT);
  if (text.includes("断连")) return cloneScript(DISCONNECT_ERROR_SCRIPT);
  if (text.includes("未知错误")) return cloneScript(UNKNOWN_ERROR_SCRIPT);
  if (text.includes("错误") || text.includes("异常")) return cloneScript(ERROR_SCRIPT);
  return cloneScript(DEFAULT_TURN_SCRIPT);
}

/** 脚本是共享数据：每个 turn 深拷贝一份避免运行期改写（onDeny 替换脚本指针） */
function cloneScript(steps: ScriptStep[]): ScriptStep[] {
  return steps.map((s) => ({ ...s }));
}
