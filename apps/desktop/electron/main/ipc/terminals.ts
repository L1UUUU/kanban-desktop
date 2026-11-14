// 用途：terminal 子通道路由表 —— terminal:create/write/resize/kill 四个 handler（#72 C1 Step2 自 ipc.ts route switch 原样迁入；spec E/H：切换/关标签不停止，kill 为用户显式停止的唯一入口；arch C12 起 create 编排主体在 session-lifecycle，handler 只做解请求→调编排→组响应）
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { IpcDeps } from "../ipc";
import { dirIdentityFields, linkAfterCreate } from "./helpers";
import type { SubChannelHandlers } from "./table";

/** terminal:* 请求子集 */
export type TerminalRequest = Extract<IpcRequest, { channel: `terminal:${string}` }>;

/** PTY 终端通道 handler 子表（#12/#20/#60） */
export const terminalHandlers: SubChannelHandlers<TerminalRequest, IpcResult, IpcDeps> = {
  // arch C12：创建编排主体在 session-lifecycle（#60：terminalId 渲染端预生成→id 冲突守卫→占位落库→spawn→失败回滚→标题回写→首输入重放）；
  // 此处组响应——关联落链（#20）属 tracker 面，留在路由层
  "terminal:create": async (req, deps) => {
    const r = await deps.lifecycle.createTerminalSession({
      terminalId: req.terminalId,
      cwd: req.cwd,
      projectId: req.projectId,
      title: req.title,
      cols: req.cols,
      rows: req.rows,
      command: req.command,
      firstInput: req.firstInput,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // #20（spec #15 C/D 节）：从需求卡片建 PTY 终端——创建成功后原子落 link 事件（与 session:create+requirementId 同语义；
    // #60 起关联随首输入触发的创建一并落）
    const linkedResult = req.requirementId
      ? linkAfterCreate(deps, r.sessionId, req.requirementId, req.projectId ?? null, "pty")
      : undefined;
    return {
      ok: true,
      sessionId: r.sessionId,
      cli: "pty",
      title: r.title,
      ...dirIdentityFields(req.cwd),
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
