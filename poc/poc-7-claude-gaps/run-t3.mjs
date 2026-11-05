// 用途：T3 审批链路实测 —— 非交互 stream-json 模式下 can_use_tool 审批控制请求是否流出、经输入流 control_response 回 accept 后工具真执行 / 回 deny 后真不执行（权限语义保真）
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeExe, prepareCleanHome, FIXTURE_PROJ, LOGS } from "./lib/common.mjs";
import { ProtocolSession } from "./lib/client.mjs";

const exe = resolveClaudeExe();
const home = prepareCleanHome({ label: "t3" });
const ACCEPT_FILE = join(FIXTURE_PROJ, "t3-accept.txt");
const DENY_FILE = join(FIXTURE_PROJ, "t3-deny.txt");
for (const f of [ACCEPT_FILE, DENY_FILE]) if (existsSync(f)) rmSync(f); // 每次运行从干净状态开始

const report = { exe, home: { dir: home.dir, noHooks: !home.hasHooks }, sessionId: null, phases: [], judgments: {}, flag: process.env.POC7_T3_NOFLAG ? "none" : "--permission-prompt-tool=stdio" };
// SDK 源码（claude-agent-sdk@0.3.318）实证：canUseTool 回调的接线方式即 spawn 参数 --permission-prompt-tool=stdio，
// CLI 才会把审批作为 can_use_tool 控制请求发往 stdio 宿主；不带该 flag 时非交互模式自动拒绝（logs/t3-noflag-*.jsonl 对照）
const extraArgs = process.env.POC7_T3_NOFLAG ? [] : ["--permission-prompt-tool=stdio"];
let phase = "accept"; // 脚本当前审批策略：accept / deny
const approvals = []; // 完整审批请求与响应记录（证据）

const session = new ProtocolSession({
  exe, cwd: FIXTURE_PROJ, args: extraArgs,
  env: { CLAUDE_CONFIG_DIR: home.dir },
  rawLogPath: join(LOGS, "t3-raw-stream.jsonl"),
  turnTimeoutMs: 150000,
  // CLI→host 审批控制请求：按当前 phase 应答（SDK wire 形状：response.subtype=success + request_id + {behavior:...}）
  onControlRequest: (msg, s) => {
    if (msg.request?.subtype !== "can_use_tool") return; // 非审批控制请求不处理
    const decision = phase === "accept"
      ? { behavior: "allow" }
      : { behavior: "deny", message: "User denied this tool call (PoC 7 T3 deny probe)." };
    const rec = { phase, request_id: msg.request_id, tool_name: msg.request.tool_name, input: msg.request.input, permission_suggestions: msg.request.permission_suggestions ?? null, decision_reason: msg.request.decision_reason ?? null, decision, ts: new Date().toISOString() };
    approvals.push(rec);
    s.respondToControlRequest(msg.request_id, decision);
  },
});

await session.start();
report.sessionId = session.init?.session_id ?? null;
report.initPermissionMode = session.init?.permissionMode ?? null;

// —— 轮 1：accept ——
phase = "accept";
const t1 = await session.sendTurn("请使用 Bash 工具执行这条命令：echo t3-accept-probe > t3-accept.txt —— 在当前目录创建该文件。命令执行完成后，不要做别的，只回复：DONE-ACCEPT");
report.phases.push({ phase: "accept", turn: t1 });

// —— 轮 2：deny（同会话） ——
phase = "deny";
const t2 = await session.sendTurn("请使用 Bash 工具执行这条命令：echo t3-deny-probe > t3-deny.txt —— 在当前目录创建该文件。命令执行完成后，不要做别的，只回复：DONE-DENY");
report.phases.push({ phase: "deny", turn: t2 });
session.kill();

// —— 判定 ——
const accReq = approvals.find((a) => a.phase === "accept");
const denReq = approvals.find((a) => a.phase === "deny");
report.approvals = approvals;
report.judgments = {
  t3_accept_request_flowed: !!accReq && accReq.tool_name === "Bash",
  t3_accept_tool_executed: existsSync(ACCEPT_FILE),
  t3_accept_file_content: existsSync(ACCEPT_FILE) ? "t3-accept-probe" : null,
  t3_deny_request_flowed: !!denReq && denReq.tool_name === "Bash",
  t3_deny_tool_not_executed: !existsSync(DENY_FILE),
  t3_deny_model_acknowledged: /deny|拒绝|没有|未能|无法/i.test(t2.texts.join("")),
  t3_both_turns_terminated: t1.result && t2.result ? true : false,
  permission_mode: report.initPermissionMode,
};

writeFileSync(join(LOGS, "t3-result.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report.judgments, null, 2));
console.log("accept request:", JSON.stringify(accReq && { tool_name: accReq.tool_name, input: accReq.input, decision_reason: accReq.decision_reason }));
console.log("deny reply text:", JSON.stringify((t2.texts.join("") ?? "").slice(0, 200)));
