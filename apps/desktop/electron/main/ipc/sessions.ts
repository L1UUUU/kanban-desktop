// 用途：session 子通道路由表 —— session:list/archivedList/archive/unarchive/delete/create/send/interrupt/setModel/resolveApproval/readHistory/resume/rename 十三个 handler（#72 C1 Step2 自 ipc.ts route switch 原样迁入；归档/取消归档/删除编排主体在 session-lifecycle，#70 C2 唯一写者；#94 起标题派生挂 create/send 两 IPC + rename 手动主权，ADR 0003；arch C12 起 create 编排主体亦在 session-lifecycle，handler 只做解请求→调编排→组响应）
import { homedir } from "node:os";
import type { IpcRequest, IpcResult, SessionRow } from "@kanban/ipc-schema";
import { detectSkillConflicts, resolveUserClaudeDir } from "@kanban/cli-host";
import type { IpcDeps } from "../ipc";
import { dirIdentityFields, guiEvent, linkAfterCreate, processAndEmit, TRACKER_CLI_BY_APP } from "./helpers";
import { isSessionBusy, type SessionRecord } from "../session-store";
import { deriveTitle } from "../title-derive";
import type { SubChannelHandlers } from "./table";

/** session:* 请求子集 */
export type SessionRequest = Extract<IpcRequest, { channel: `session:${string}` }>;

/** DB 记录 → wire 行（目录身份经 dirIdentityFields 单点投影，arch C12） */
function toSessionRow(rec: SessionRecord): SessionRow {
  return {
    id: rec.id,
    kind: rec.kind,
    cli: rec.cli,
    nativeSessionId: rec.nativeSessionId,
    projectId: rec.projectId,
    title: rec.title,
    ...(rec.titleSource ? { titleSource: rec.titleSource } : {}), // review A1：标题来源回带（#94 验收）
    cwd: rec.cwd,
    permMode: rec.permMode,
    status: rec.status ?? null,
    lastActiveAt: rec.lastActiveAt,
    createdAt: rec.createdAt ?? null,
    archivedAt: rec.archivedAt,
    ...dirIdentityFields(rec.cwd),
  };
}

/** #62 删除前解关联（session-lifecycle.remove 的 beforeDelete hook）：已关联时落 unlink 事件并推送变更，抛错即中止删除（行保留可重试） */
async function unlinkForDelete(deps: IpcDeps, sessionId: string): Promise<void> {
  if (!deps.engine.tracker.sessionToReq.has(sessionId)) return; // 幂等：本就未关联
  processAndEmit(deps, guiEvent(`unlink:${sessionId}`, {
    kind: "unlink",
    source: "gui",
    requirementId: null,
    sessionId,
  }));
}

/** #58 未知会话 → E_SESSION_NOT_FOUND（session:archive / session:unarchive 共用） */
function sessionNotFound(sessionId: string): IpcResult {
  return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: `会话不存在：${sessionId}` } };
}

/** #21：用户级 Claude 基准目录缺省解析（生产路径：CLAUDE_CONFIG_DIR 优先，否则 ~/.claude；测试经 deps.resolveUserClaudeDir 注入） */
function defaultUserClaudeDir(): string {
  return resolveUserClaudeDir(process.env, homedir());
}

/** 会话通道 handler 子表（#6/#58/#59/#62） */
export const sessionHandlers: SubChannelHandlers<SessionRequest, IpcResult, IpcDeps> = {
  "session:list": async (req, deps) => {
    const rows = deps.sessions.list(req.projectId).map(toSessionRow);
    return { ok: true, sessions: rows };
  },
  "session:archivedList": async (_req, deps) => {
    // #58 归档视图（设置面板用）：含归档时间等展示字段
    return { ok: true, sessions: deps.sessions.listArchived().map(toSessionRow) };
  },
  "session:archive": async (req, deps) => {
    // #58 归档编排（spec #57 D 节）：编排主体在 session-lifecycle（#70 C2 唯一写者，与 #64 自动归档引擎共用同一实现）；此处仅未知会话错误形状
    if (!deps.sessions.get(req.sessionId)) return sessionNotFound(req.sessionId);
    await deps.lifecycle.archive(req.sessionId);
    return { ok: true };
  },
  "session:unarchive": async (req, deps) => {
    // #58 取消归档编排（spec #57 D 节）：先重新登记可恢复句柄（adopt）→ 成功才清标记并刷新活跃时间；失败留在归档态报错（可重试）。
    // PTY 无进程恢复能力（与重启后行为一致）：仅清标记回列表显示已断开；编排主体在 session-lifecycle
    if (!deps.sessions.get(req.sessionId)) return sessionNotFound(req.sessionId);
    await deps.lifecycle.unarchive(req.sessionId);
    return { ok: true };
  },
  "session:delete": async (req, deps) => {
    // #62 删除编排（spec #57 D 节）：先解除看板关联（落 unlink 事件，重启重放后映射干净；失败抛错即中止，记录保留可重试）→
    // 终止 CLI 进程（终止失败 best-effort 放行——进程已死不应挡删除）→ 删除本地会话记录；
    // 幂等：记录已不存在（重复删除/从未存在）直接成功；不删 CLI 原生历史文件、不做撤销；历史事件日志永不删除。
    // 编排主体在 session-lifecycle（#70 C2）；解关联经 hooks 注入（lifecycle 不依赖 tracker）
    await deps.lifecycle.remove(req.sessionId, { beforeDelete: () => unlinkForDelete(deps, req.sessionId) });
    return { ok: true };
  },
  "session:create": async (req, deps) => {
    // arch C12：创建编排主体在 session-lifecycle（原生创建→标题随行原子派生落库→firstMessage 原子发送→失败回滚，
    // #59/#94 / ADR 0003 决策 2 逐条保持）；此处只组响应——关联落链（#17）与 claude 同名 skill 检测（#21）属 tracker/检测面，留在路由层
    const r = await deps.lifecycle.createStructuredSession({
      cli: req.cli,
      cwd: req.cwd,
      projectId: req.projectId,
      title: req.title,
      model: req.model,
      permMode: req.permMode,
      firstMessage: req.firstMessage,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // #17（spec #15 C 节）：可选 requirementId —— 创建成功后由 Main 原子落 link 事件（避免 renderer 两步编排竞态）；
    // 会话须与需求同项目，业务拒绝是合法结果不走错误码，原因直达调用方
    const linkedResult = req.requirementId
      ? linkAfterCreate(deps, r.sessionId, req.requirementId, req.projectId ?? null, TRACKER_CLI_BY_APP[req.cli])
      : undefined;
    return {
      ok: true,
      sessionId: r.sessionId,
      cli: req.cli,
      title: r.title,
      // issue #76（spec #75）：会话实际采用的 model（codex=探测结果、opencode=显式或 /config 默认、fake/claude 透传；供调用方回显）
      ...(r.model !== undefined && r.model !== null ? { model: r.model } : {}),
      ...dirIdentityFields(req.cwd),
      ...linkedResult, // 无 requirementId 时为 undefined，展开为空（响应不含 linked/reason 字段，保持既有形状）
      // #21（spec #15 E 节）：仅 Claude 创建时扫描一次（不做运行时/发送时检测；Codex/OpenCode 不检测）；检测失败安全降级为空数组（纯函数内兜底）
      ...(req.cli === "claude"
        ? { skillConflicts: detectSkillConflicts(req.cwd, (deps.resolveUserClaudeDir ?? defaultUserClaudeDir)()) }
        : {}),
    };
  },
  "session:send": async (req, deps) => {
    await deps.adapter.sendTurn({ sessionId: req.sessionId, text: req.text });
    // #94 / ADR 0003 决策 2：sendTurn 成功后按请求文本派生（失败在上方 throw，不派生——不留「来自未发出消息」的标题）；
    // 门控仅 default 升级 derived（单向）；响应带回新标题，renderer 即时刷新无需推送
    const derived = deriveTitle(req.text);
    const applied = derived ? deps.sessions.applyDerivedTitle(req.sessionId, derived) : false;
    return { ok: true, ...(applied ? { title: derived } : {}) };
  },
  "session:rename": async (req, deps) => {
    // #94 / ADR 0003 手动重命名：置 manual（终态权威，吸收一切前态）；renderer 请求-响应后本地刷新（单窗口，无推送）
    const rec = deps.sessions.get(req.sessionId);
    if (!rec) return sessionNotFound(req.sessionId);
    // review S5/C1：PTY 行拒绝（ADR 0003「PTY 永不进状态机」——终端标题由 shell 回写，rename 不改写其标题/来源）
    if (rec.kind !== "structured") {
      return { ok: false, error: { code: "E_INTERNAL", message: "PTY 会话不支持重命名（标题由终端回写维护）" } };
    }
    deps.sessions.renameTitle(req.sessionId, req.title);
    return { ok: true, title: req.title };
  },
  "session:interrupt": async (req, deps) => {
    await deps.adapter.interruptTurn(req.sessionId);
    return { ok: true };
  },
  "session:setModel": async (req, deps) => {
    // issue #79 / spec #75：三 CLI 统一「idle 可切、下一轮生效、进行中/断开拒绝」——忙态/断开在 Main 侧以落库状态校验
    //（session_status 事件驱动更新；running/waiting 均属本轮进行中，interrupted 本轮已结束可切），adapter 侧各自落实生效语义；
    // 忙态判定经 isSessionBusy 单点（arch C11），断开拒绝的业务理由留在此处
    const rec = deps.sessions.get(req.sessionId);
    if (!rec) return sessionNotFound(req.sessionId);
    if (isSessionBusy(rec.status)) {
      return { ok: false, error: { code: "E_INTERNAL", message: "本轮进行中，结束后再切换" } };
    }
    if (rec.status === "disconnected") {
      return { ok: false, error: { code: "E_INTERNAL", message: "会话已断开，恢复后可切换" } };
    }
    const r = await deps.adapter.setModel({ sessionId: req.sessionId, model: req.model });
    return { ok: true, ...(r.model ? { model: r.model } : {}) }; // 生效模型回传（claude 为响应实际名，供 chip 回显）
  },
  "session:resolveApproval": async (req, deps) => {
    await deps.adapter.resolveApproval({
      sessionId: req.sessionId,
      requestId: req.requestId,
      decision: req.decision,
    });
    return { ok: true };
  },
  "session:readHistory": async (req, deps) => {
    // 断开会话恢复第一步：原生历史快照（不变量 4：与实时流同键同 seq，renderer 侧无缝拼接）
    const events = await deps.adapter.readHistory(req.sessionId);
    return { ok: true, events };
  },
  "session:resume": async (req, deps) => {
    // 断开会话恢复第二步：重连原生会话（真实 CLI 语义由 #8/#10/#11 Adapter 实现）
    await deps.adapter.resume(req.sessionId);
    return { ok: true };
  },
};
