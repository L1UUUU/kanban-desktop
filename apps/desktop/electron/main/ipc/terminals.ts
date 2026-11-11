// 用途：terminal 子通道路由表 —— terminal:create/write/resize/kill 四个 handler（#72 C1 Step2 自 ipc.ts route switch 原样迁入；spec E/H：切换/关标签不停止，kill 为用户显式停止的唯一入口）
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { detectDirIdentity } from "../git-identity";
import type { IpcDeps } from "../ipc";
import { linkAfterCreate } from "./helpers";
import type { SubChannelHandlers } from "./table";

/** terminal:* 请求子集 */
export type TerminalRequest = Extract<IpcRequest, { channel: `terminal:${string}` }>;

/** PTY 终端通道 handler 子表（#12/#20/#60） */
export const terminalHandlers: SubChannelHandlers<TerminalRequest, IpcResult, IpcDeps> = {
  // #60（spec #57 PTY 草稿）：terminalId 由渲染端预生成（uuid 格式经契约校验）；先落库占位 → 启动进程 → 失败回删（无孤儿记录）；firstInput 为草稿缓冲的首输入，启动成功后重放
  "terminal:create": async (req, deps) => {
    const terminalId = req.terminalId;
    if (deps.sessions.get(terminalId)) {
      return { ok: false, error: { code: "E_SESSION_EXISTS", message: `终端 id 已存在：${terminalId}（会话 id 空间冲突）` } };
    }
    // 先落库占位（占位标题在 spawn 成功后回写为「终端 · shell」；启动失败整行回删；status 缺省 idle——store 决策，#70）
    deps.sessions.insert({
      id: terminalId,
      kind: "pty",
      cli: "pty",
      nativeSessionId: null,
      projectId: req.projectId ?? null,
      title: req.title ?? "终端",
      cwd: req.cwd,
      permMode: null,
      lastActiveAt: null,
      archivedAt: null,
    });
    const spawned = deps.pty.spawn(terminalId, { cwd: req.cwd, cols: req.cols ?? 80, rows: req.rows ?? 30, command: req.command });
    if (!spawned.ok) {
      deps.sessions.delete(terminalId); // 回删占位行：默认列表与重启均无该会话
      return { ok: false, error: { code: "E_INTERNAL", message: spawned.message } };
    }
    const title = req.title ?? `终端 · ${spawned.label}`;
    if (title !== (req.title ?? "终端")) deps.sessions.updateTitle(terminalId, title);
    // 草稿首输入重放（含多字符/中文，首输入不丢失；失败路径已提前 return 不会写进未启动的终端）
    if (req.firstInput) deps.pty.write(terminalId, req.firstInput);
    const identity = detectDirIdentity(req.cwd);
    // #20（spec #15 C/D 节）：从需求卡片建 PTY 终端——创建成功后原子落 link 事件（与 session:create+requirementId 同语义；
    // #60 起关联随首输入触发的创建一并落）
    const linkedResult = req.requirementId
      ? linkAfterCreate(deps, terminalId, req.requirementId, req.projectId ?? null, "pty")
      : undefined;
    return {
      ok: true,
      sessionId: terminalId,
      cli: "pty",
      title,
      dirIdentity: identity.kind,
      worktreeName: identity.kind === "worktree" ? identity.name : null,
      ...linkedResult,
    };
  },
  "terminal:write": async (req, deps) => {
    const written = deps.pty.write(req.terminalId, req.data);
    if (!written.ok) {
      return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: written.message } };
    }
    return { ok: true };
  },
  "terminal:resize": async (req, deps) => {
    deps.pty.resize(req.terminalId, req.cols, req.rows);
    return { ok: true };
  },
  "terminal:kill": async (req, deps) => {
    deps.pty.kill(req.terminalId);
    return { ok: true };
  },
};
