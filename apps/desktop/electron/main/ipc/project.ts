// 用途：project 子通道路由表 —— project:list/register/switch 三个 handler（#72 C1 Step2 自 ipc.ts route switch 原样迁入；漏写成员编译失败）
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import type { IpcDeps } from "../ipc";
import type { SubChannelHandlers } from "./table";

/** project:* 请求子集 */
export type ProjectRequest = Extract<IpcRequest, { channel: `project:${string}` }>;

/** 项目通道 handler 子表（#7 持久化通道） */
export const projectHandlers: SubChannelHandlers<ProjectRequest, IpcResult, IpcDeps> = {
  "project:list": async (_req, deps) => {
    // 列表随取随探测（existsSync 便宜）：missing 标记始终新鲜
    return { ok: true, projects: deps.projects.refreshStatuses(), currentProjectId: deps.getCurrentProjectId() };
  },
  "project:register": async (_req, deps) => {
    const dir = await deps.pickDirectory();
    if (!dir) return { ok: true, canceled: true };
    const { duplicate, project } = deps.projects.register(dir);
    // 注册成功即切到新项目（用户刚注册，立即开始工作）；重复注册不打断当前指向
    if (!duplicate) deps.setCurrentProjectId(project.id);
    return { ok: true, duplicate, project };
  },
  "project:switch": async (req, deps) => {
    // 切换时探测（工单验收第 1 条）：missing 仅标记不阻止
    deps.projects.refreshStatuses();
    const project = deps.projects.get(req.projectId);
    if (!project) {
      return { ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: `项目不存在：${req.projectId}` } };
    }
    deps.setCurrentProjectId(project.id);
    return { ok: true, project };
  },
};
