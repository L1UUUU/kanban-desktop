// 用途：消息旅程编排（arch C7）—— 会话态发送与草稿首条提交的单一编排模块：斜杠派发三态判定（resolveSlashDispatch 矩阵，
// ADR 0004 零内置）与链路执行（session:send+派生标题回写 / composer:expandCommand 展开 / session:create+firstMessage 原子链）
// 收拢于此，全部失败经 chat-error 统一出口落对应错误槽（会话 lastError=ErrorBanner、草稿 submitError=CreateErrorCard），不静默；
// 调用方（use-chat）只注入 {store, transport, commands} 环境，不再以 submit 函数指针跨界回调。
import { defaultSessionTitle } from "@kanban/ipc-schema";
import type { CliKind, CommandEntry } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import { exitDraftError, exitSessionError, toActionError } from "./chat-error";
import type { ChatStore } from "./chat-store";
import type { ChatActionError } from "./session-view";
import type { ComposerCommandSource } from "./composer-command-source";
import { resolveSlashDispatch } from "./slash-dispatch";

// 本文件日志出口（scope 固定 chat，经 lib/logger 唯一出口发出）
const log = createScopedLogger("chat");

/** 发送环境（会话态/草稿态共用）：store + transport + 命令源（ADR 0004 零内置后无本地执行出口） */
export interface SendEnv {
  store: ChatStore;
  transport: ChatTransport;
  commands: ComposerCommandSource;
}

/** 消息链路出口统一形态：consumed=输入已消费（调用方清空输入框）；handled=输入保留（失败已写对应错误槽并展示，可重试） */
export type SendOutcome = "consumed" | "handled";

/** 取 (cli,cwd) 命令目录快照：ready 返回列表（与菜单同源不漂移）；idle/loading/error/无 cwd 返回 null（codex 判定 fail-closed 用，透传类 CLI 形态与匹配无关） */
function snapshotCommands(env: SendEnv, cli: CliKind, cwd: string | null): CommandEntry[] | null {
  if (!cwd) return null;
  const st = env.commands.getState(cli, cwd);
  return st.status === "ready" ? st.commands : null;
}

/** 展开请求（codex 派发形态）：cwd 随请求带给 Main 做项目级 prompts 目录安全校验；成功返回展开文本；失败统一 {code,message}（IPC 错误原码透传，结果为空视为失败不静默） */
async function invokeExpand(
  env: SendEnv,
  cwd: string,
  sourcePath: string,
  args: string,
): Promise<{ ok: true; text: string } | { ok: false; error: ChatActionError }> {
  let r;
  try {
    r = await env.transport.invoke({ channel: "composer:expandCommand", cwd, sourcePath, args });
  } catch (err) {
    return { ok: false, error: toActionError(err) };
  }
  if (r.ok && typeof r.text === "string" && r.text.trim() !== "") return { ok: true, text: r.text };
  return { ok: false, error: r.ok ? { code: "E_INTERNAL", message: "命令展开结果为空" } : toActionError(r.error) };
}

/** 会话发送回流：session:send 失败/异常经统一出口落会话错误槽；成功响应带派生标题即本地回写（#94 / ADR 0003：send 成功才派生，未带 title=门控未生效，标题保持）。发出即消费，不阻塞调用方 */
function invokeSessionSend(env: SendEnv, sessionId: string, text: string): void {
  void env.transport
    .invoke({ channel: "session:send", sessionId, text })
    .then((r) => {
      if (!r.ok) {
        exitSessionError(env.store, sessionId, r.error);
        return;
      }
      if (r.title) env.store.updateSession(sessionId, { title: r.title });
    })
    .catch((err: unknown) => exitSessionError(env.store, sessionId, err));
}

/**
 * 会话态发送编排（原 dispatchSessionSend 收编）：派发判定 → 透传/展开文本发送（用户气泡与 wire 载荷同为最终文本，所见即所发）、
 * fail-closed 拒绝。session:send 发出即返回 consumed（错误/标题异步回流）；展开失败与 blocked 返回 handled（输入保留，错误卡已展示）。
 */
export async function sendSessionText(env: SendEnv, sessionId: string, text: string): Promise<SendOutcome> {
  const session = env.store.getSession(sessionId);
  // 斜杠派发为结构化会话专属（composer 不渲染 PTY 行）；kind 收窄后 cli 即 CliKind
  if (!session || session.kind !== "structured" || text.trim().length === 0) return "consumed";
  const action = resolveSlashDispatch({ text, cli: session.cli, commands: snapshotCommands(env, session.cli, session.cwd) });
  switch (action.action) {
    case "send-text":
      env.store.appendUserMessage(sessionId, action.text);
      invokeSessionSend(env, sessionId, action.text);
      return "consumed";
    case "expand": {
      // cwd 非空是进入本分支的前提（命令快照非 null 依赖 cwd，codex 目录不可用已 blocked），断言仅类型收窄
      const r = await invokeExpand(env, session.cwd!, action.sourcePath, action.args);
      if (!r.ok) {
        log.error("斜杠命令展开失败（会话发送拒绝）", { sessionId, command: action.name, ...r.error });
        exitSessionError(env.store, sessionId, r.error);
        return "handled";
      }
      env.store.appendUserMessage(sessionId, r.text);
      invokeSessionSend(env, sessionId, r.text);
      return "consumed";
    }
    case "blocked":
      log.error("斜杠派发被拒绝（fail-closed）", { sessionId, code: action.code, message: action.message });
      exitSessionError(env.store, sessionId, action);
      return "handled";
  }
}

/**
 * 草稿首条提交编排（原 dispatchDraftSubmit + submitDraftChain 收编，回调边界消失）：派发判定（codex 展开类以展开文本为首条消息，
 * 覆盖草稿原文——气泡与 wire 同文本，所见即所发；恢复重建不漂移）→ session:create+firstMessage 原子链 ——
 * 成功：登记会话 + 首条消息本地回显 + 丢弃草稿；失败：草稿与输入保留（可重试），错误直达失败卡，
 * Main 回滚时事件先至的占位行按 rolledBackSessionId 撤销（不留空会话）。
 */
export async function submitDraftFirstMessage(env: SendEnv): Promise<SendOutcome> {
  const current = env.store.getSnapshot().draft;
  // 草稿态提交为结构化草稿专属（PTY 草稿无 composer/提交链）——kind 收窄
  if (!current || current.kind !== "structured") return "handled";
  const d = current.data;
  if (d.input.trim().length === 0) return "handled";
  const action = resolveSlashDispatch({ text: d.input, cli: d.cli, commands: snapshotCommands(env, d.cli, d.cwd) });
  let firstMessage: string | undefined; // undefined=草稿原文（透传/未匹配）
  switch (action.action) {
    case "expand": {
      const r = await invokeExpand(env, d.cwd, action.sourcePath, action.args);
      if (!r.ok) {
        log.error("斜杠命令展开失败（草稿提交拒绝）", { command: action.name, ...r.error });
        exitDraftError(env.store, r.error);
        return "handled";
      }
      firstMessage = r.text;
      break;
    }
    case "blocked":
      log.error("斜杠派发被拒绝（fail-closed，草稿）", { code: action.code, message: action.message });
      exitDraftError(env.store, action);
      return "handled";
    case "send-text":
      break;
  }
  // 单一就绪态守卫：模型未选（列表未就绪/未手输兜底）不提交——UI 发送钮同步禁用，此处为链路兜底
  if (!d.model) return "handled";
  const sendText = firstMessage ?? d.input;
  const r = await env.transport.invoke({
    channel: "session:create",
    cli: d.cli,
    cwd: d.cwd,
    projectId: d.projectId ?? undefined,
    // 显式草稿名（boot 演示）才下发；占位名不在 renderer 构造，由 Main defaultSessionTitle 兜底（arch C8 标题单源）
    ...(d.title ? { title: d.title } : {}),
    model: d.model, // 所见即所发：默认选中项同样真实下发（无占位串）
    permMode: d.permMode,
    requirementId: d.requirementId,
    firstMessage: sendText,
  });
  if (r.ok && r.sessionId) {
    // #20：卡片进草稿的自动关联由 Main 原子完成（session_linked 推送回流看板 store）；拒绝仅报告不阻断会话
    if (r.linked === false)
      log.error("会话创建后自动关联被拒绝", {
        sessionId: r.sessionId,
        ...(r.reason ? { reason: r.reason } : {}),
      });
    env.store.registerSession({
      sessionId: r.sessionId,
      cli: r.cli ?? d.cli,
      title: r.title ?? d.title ?? defaultSessionTitle(d.cli),
      permMode: d.permMode,
      model: d.model,
      projectId: d.projectId,
      cwd: d.cwd,
      dirIdentity: r.dirIdentity ?? "none",
      worktreeName: r.worktreeName ?? null,
      // #21：Main 仅对 claude 会话附同名 skill 冲突名（其余 CLI 缺省无冲突）
      skillConflicts: r.skillConflicts ?? [],
    });
    env.store.appendUserMessage(r.sessionId, sendText); // 首条消息本地回显（内容不经事件流回传；= 实际发送文本）
    env.store.discardDraft();
    return "consumed";
  }
  // 失败：草稿与输入保留（可重试），错误直达失败卡；不留空会话（Main 已回滚记录）
  const failure: ChatActionError = r.ok ? { code: "E_INTERNAL", message: "未知错误" } : toActionError(r.error);
  // Main 回滚时事件（session_status 等）可能已先至渲染端建占位行——按回滚 id 撤销，不留空会话
  if (!r.ok && r.error.rolledBackSessionId) env.store.removeSession(r.error.rolledBackSessionId);
  // #55（spec #52 G 节）：提交失败留痕（带关键参数；requirementId 可选键条件携带，防 ctx 出现 undefined）
  log.error("草稿提交失败（创建+发送首条消息）", {
    cli: d.cli,
    code: failure.code,
    message: failure.message,
    cwd: d.cwd,
    ...(d.projectId ? { projectId: d.projectId } : {}),
    ...(d.requirementId ? { requirementId: d.requirementId } : {}),
  });
  exitDraftError(env.store, failure);
  return "handled";
}
