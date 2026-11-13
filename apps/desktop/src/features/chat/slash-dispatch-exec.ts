// 用途：斜杠派发执行器（issue #92 / spec #82 E 块）—— 发送期把 resolveSlashDispatch 的动作落到既有链路：透传/展开文本走会话发送与草稿原子提交（codex 展开经 composer:expandCommand；用户气泡与 wire 载荷同为最终文本，所见即所发，恢复重建不漂移）；内置 /pty /kanban 本地执行（openSessionDraft / onSetView）；fail-closed 与展开/发送失败直达既有错误卡（会话 ErrorBanner=store.setError、草稿 CreateErrorCard=store.setDraftSubmitError），不静默
import type { CliKind, CommandEntry, IpcResult } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";
import type { ChatStore } from "./chat-store";
import type { ComposerCommandSource } from "./composer-command-source";
import { resolveSlashDispatch } from "./slash-dispatch";
import type { OpenDraftResult, OpenSessionDraftInput } from "./use-chat";

// 本文件日志出口（scope 固定 chat，经 lib/logger 唯一出口发出）
const log = createScopedLogger("chat");

/** 执行环境：store/transport/命令源 + 内置命令的两个本地出口（#92：视图切换经 deps 注入，composer 不直面 App） */
export interface SlashDispatchEnv {
  store: ChatStore;
  transport: ChatTransport;
  commands: ComposerCommandSource;
  openSessionDraft(input: OpenSessionDraftInput): OpenDraftResult;
  onSetView?(v: "chat" | "kanban"): void;
}

/** 取 (cli,cwd) 命令目录快照：ready 返回列表（与菜单同源不漂移）；idle/loading/error/无 cwd 返回 null（codex 判定 fail-closed 用，透传类 CLI 形态与匹配无关） */
function snapshotCommands(env: SlashDispatchEnv, cli: CliKind, cwd: string | null): CommandEntry[] | null {
  if (!cwd) return null;
  const st = env.commands.getState(cli, cwd);
  return st.status === "ready" ? st.commands : null;
}

/** 会话内发送并回流错误卡与派生标题（#94：响应带 title 即本地刷新——侧栏标题即时更新，无需事件推送） */
function reportSend(env: SlashDispatchEnv, sessionId: string, text: string): void {
  void env.transport
    .invoke({ channel: "session:send", sessionId, text })
    .then((r: IpcResult) => {
      if (!r.ok) {
        env.store.setError(sessionId, r.error.code, r.error.message);
        return;
      }
      // #94：sendTurn 成功后 Main 派生（仅 default 态生效）；未带 title = 门控未生效，标题保持
      if (r.title) env.store.updateSession(sessionId, { title: r.title });
    })
    .catch((err: unknown) => {
      env.store.setError(sessionId, "E_INTERNAL", err instanceof Error ? err.message : String(err));
    });
}

/** 展开请求（codex 派发形态）：cwd 随请求带给 Main 做项目级 prompts 目录安全校验；成功返回展开文本；失败统一 {code,message}（IPC 错误原码透传，结果为空视为失败不静默） */
async function invokeExpand(
  env: SlashDispatchEnv,
  cwd: string,
  sourcePath: string,
  args: string,
): Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }> {
  let r: IpcResult;
  try {
    r = await env.transport.invoke({ channel: "composer:expandCommand", cwd, sourcePath, args });
  } catch (err) {
    return { ok: false, code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
  }
  if (r.ok && typeof r.text === "string" && r.text.trim() !== "") return { ok: true, text: r.text };
  return {
    ok: false,
    code: r.ok ? "E_INTERNAL" : r.error.code,
    message: r.ok ? "命令展开结果为空" : r.error.message,
  };
}

/**
 * 会话态发送编排：派发判定 → 透传/展开发送、内置本地执行、fail-closed 拒绝。
 * 返回 true=输入已消费（调用方清空输入框）；false=保留输入（错误卡已展示，可重试）。
 */
export async function dispatchSessionSend(env: SlashDispatchEnv, sessionId: string, text: string): Promise<boolean> {
  const session = env.store.getSession(sessionId);
  if (!session || text.trim().length === 0) return true;
  const action = resolveSlashDispatch({
    text,
    cli: session.cli as CliKind,
    commands: snapshotCommands(env, session.cli as CliKind, session.cwd),
  });
  switch (action.action) {
    case "send-text":
      env.store.appendUserMessage(sessionId, action.text);
      reportSend(env, sessionId, action.text);
      return true;
    case "expand": {
      // cwd 非空是进入本分支的前提（命令快照非 null 依赖 cwd，codex 目录不可用已 blocked），断言仅类型收窄
      const r = await invokeExpand(env, session.cwd!, action.sourcePath, action.args);
      if (!r.ok) {
        log.error("斜杠命令展开失败（会话发送拒绝）", { sessionId, command: action.name, code: r.code, message: r.message });
        env.store.setError(sessionId, r.code, r.message);
        return false;
      }
      env.store.appendUserMessage(sessionId, r.text);
      reportSend(env, sessionId, r.text);
      return true;
    }
    case "app":
      if (action.app === "kanban") env.onSetView?.("kanban");
      else env.openSessionDraft({ projectId: session.projectId ?? null, cli: "pty", fromSessionId: sessionId });
      return true;
    case "blocked":
      log.error("斜杠派发被拒绝（fail-closed）", { sessionId, code: action.code, message: action.message });
      env.store.setError(sessionId, action.code, action.message);
      return false;
  }
}

/**
 * 草稿态提交编排：派发判定 → 原子链以最终文本为首条消息（submit(firstMessage?) 注入，undefined=草稿原文）、
 * 内置本地执行（/pty 替换为终端草稿、/kanban 切视图并清空输入保留草稿）、fail-closed 拒绝（失败卡数据）。
 * 返回语义同会话态：true=已消费；false=保留（失败卡已展示）。
 */
export async function dispatchDraftSubmit(
  env: SlashDispatchEnv,
  submit: (firstMessage?: string) => Promise<boolean>,
): Promise<boolean> {
  const d = env.store.getSnapshot().draft;
  if (!d || d.input.trim().length === 0) return false;
  const action = resolveSlashDispatch({ text: d.input, cli: d.cli, commands: snapshotCommands(env, d.cli, d.cwd) });
  switch (action.action) {
    case "send-text":
      return submit();
    case "expand": {
      const r = await invokeExpand(env, d.cwd, action.sourcePath, action.args);
      if (!r.ok) {
        log.error("斜杠命令展开失败（草稿提交拒绝）", { command: action.name, code: r.code, message: r.message });
        env.store.setDraftSubmitError(r.code, r.message);
        return false;
      }
      return submit(r.text);
    }
    case "app":
      if (action.app === "kanban") {
        env.onSetView?.("kanban");
        env.store.updateDraft({ input: "" }); // 命令已消费：清空输入、保留草稿继续输入
        return true;
      }
      // /pty：当前草稿被 PTY 终端草稿替换（cwd 按项目解析；项目失效时提示由 openSessionDraft 单源发出，输入保留）
      return env.openSessionDraft({ projectId: d.projectId, cli: "pty" }).ok;
    case "blocked":
      log.error("斜杠派发被拒绝（fail-closed，草稿）", { code: action.code, message: action.message });
      env.store.setDraftSubmitError(action.code, action.message);
      return false;
  }
}
