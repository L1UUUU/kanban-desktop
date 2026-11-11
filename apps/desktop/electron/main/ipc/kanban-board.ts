// 用途：kanban 看板子通道路由表 —— kanban:list/create/rename/setStage/link/unlink/delete 七个 handler（#72 C1 Step2 自 ipc.ts route switch 原样迁入；#17 spec #15 C 节：全部状态变化经 TrackerEngine.process 落事件流，restore 重放不产生推送，启动靠 kanban:list 再水化）
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { formatRequirementId, type TrackerEngine } from "@kanban/tracker";
import type { IpcDeps } from "../ipc";
import { guiEvent, processAndEmit, processLink, TRACKER_CLI_BY_APP } from "./helpers";
import type { SubChannelHandlers } from "./table";

/** kanban:* 请求子集 */
export type KanbanBoardRequest = Extract<IpcRequest, { channel: `kanban:${string}` }>;

/** 未知需求 id → E_REQUIREMENT_NOT_FOUND（kanban:rename/setStage/delete/link 共用） */
function requirementNotFound(requirementId: string): IpcResult {
  return { ok: false, error: { code: "E_REQUIREMENT_NOT_FOUND", message: `需求不存在：${requirementId}` } };
}

/** 下一个可用确定性需求 id（REQ-00N；跳过已占用编号；create 事件进 tracker 后推进 nextId 防自动建卡编号冲突） */
function nextRequirementId(tracker: TrackerEngine["tracker"]): string {
  let n = tracker.nextId;
  while (tracker.requirements.has(formatRequirementId(n))) n++;
  return formatRequirementId(n);
}

/** 看板通道 handler 子表 */
export const kanbanBoardHandlers: SubChannelHandlers<KanbanBoardRequest, IpcResult, IpcDeps> = {
  "kanban:list": async (req, deps) => {
    const rows = deps.engine.snapshot().filter((r) => !req.projectId || r.projectId === req.projectId);
    const sessionToReq: Record<string, string> = {};
    for (const [sessionId, requirementId] of deps.engine.tracker.sessionToReq) sessionToReq[sessionId] = requirementId;
    return { ok: true, requirements: rows, sessionToReq };
  },
  "kanban:create": async (req, deps) => {
    const id = nextRequirementId(deps.engine.tracker);
    processAndEmit(deps, guiEvent(`create:${id}`, {
      kind: "create",
      source: "gui-create",
      requirementId: id,
      title: req.title ?? "待命名需求",
      projectId: req.projectId,
    }));
    return { ok: true, requirementId: id };
  },
  "kanban:rename": async (req, deps) => {
    if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
    processAndEmit(deps, guiEvent(`rename:${req.requirementId}`, {
      kind: "rename",
      source: "gui-rename",
      requirementId: req.requirementId,
      title: req.title,
    }));
    return { ok: true };
  },
  "kanban:setStage": async (req, deps) => {
    // uncertain 确认 = setStage 当前阶段（manual 立即生效、uncertain 清除、不锁定）；"none" 由 validateEvent 归一为未开始
    if (!deps.engine.tracker.req(req.requirementId)) return requirementNotFound(req.requirementId);
    processAndEmit(deps, guiEvent(`manual:${req.requirementId}:${req.stage}`, {
      kind: "manual",
      source: "gui-manual",
      requirementId: req.requirementId,
      stage: req.stage,
    }));
    return { ok: true };
  },
  "kanban:link": async (req, deps) => {
    // 业务拒绝（已关联他卡/跨项目/无项目会话）是合法结果：linked=false + reason，不走错误码（spec #15 C 节）
    const r = deps.engine.tracker.req(req.requirementId);
    if (!r) return requirementNotFound(req.requirementId);
    const session = deps.sessions.get(req.sessionId);
    if (!session) {
      return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: `会话不存在：${req.sessionId}` } };
    }
    const existing = deps.engine.tracker.sessionToReq.get(req.sessionId);
    if (existing === req.requirementId) return { ok: true, linked: true }; // 幂等：已关联同一需求
    if (existing) return { ok: true, linked: false, reason: `会话已关联需求 ${existing}，请先解除关联` };
    if (session.projectId == null) {
      return { ok: true, linked: false, reason: "会话未归属项目，无法关联需求（请先在项目中创建会话）" };
    }
    if (session.projectId !== r.projectId) {
      return {
        ok: true,
        linked: false,
        reason: `跨项目关联被拒绝：会话属项目 ${session.projectId}，需求属项目 ${r.projectId}`,
      };
    }
    const changes = processLink(deps, req.sessionId, req.requirementId, session.projectId, TRACKER_CLI_BY_APP[session.cli] ?? "claude-code");
    if (changes.some((c) => c.type === "session_linked")) return { ok: true, linked: true };
    // 预检通过但状态机拒绝（并发态漂移，理论不至）：仍按业务拒绝返回原因
    return { ok: true, linked: false, reason: "关联被拒绝（会话或需求状态已变化，请刷新看板重试）" };
  },
  "kanban:unlink": async (req, deps) => {
    const session = deps.sessions.get(req.sessionId);
    if (!session) {
      return { ok: false, error: { code: "E_SESSION_NOT_FOUND", message: `会话不存在：${req.sessionId}` } };
    }
    if (!deps.engine.tracker.sessionToReq.has(req.sessionId)) return { ok: true }; // 幂等：本就未关联
    processAndEmit(deps, guiEvent(`unlink:${req.sessionId}`, {
      kind: "unlink",
      source: "gui",
      requirementId: null,
      sessionId: req.sessionId,
    }));
    return { ok: true };
  },
  "kanban:delete": async (req, deps) => {
    const r = deps.engine.tracker.req(req.requirementId);
    if (!r) return requirementNotFound(req.requirementId);
    // #35（spec #27 J 节 US22）：需求删除级联清理 memory 数据（批次/待审与已忽略候选/总结与 proposed/需求目录），
    // accepted/edited 知识保留；置于墓碑事件前——清理抛错时需求仍在、用户可重试删除，不产生永不可达的孤儿 memory 数据
    deps.memory?.deleteRequirementData(req.requirementId, r.projectId);
    processAndEmit(deps, guiEvent(`delete:${req.requirementId}`, {
      kind: "delete",
      source: "gui-delete",
      requirementId: req.requirementId,
    }));
    return { ok: true };
  },
};
