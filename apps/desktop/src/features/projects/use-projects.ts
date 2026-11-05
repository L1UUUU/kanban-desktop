// 用途：项目列表控制器 hook —— project:list/register/switch 的 IPC 接线与提示文案（注册=原生目录选择，由 Main 弹窗）
import { useCallback, useEffect, useState } from "react";
import type { ProjectRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";

export type RegisterOutcome = "registered" | "duplicate" | "canceled" | "error";

export interface ProjectsController {
  projects: ProjectRow[];
  currentProjectId: string | null;
  currentProject: ProjectRow | null;
  /** 操作反馈（注册重复/切换失败等；一次性文案，渲染后可清） */
  notice: string | null;
  /** 写入一次性提示（工作区把「项目不存在」等新建拒绝原因落到侧栏提示区） */
  setNotice(message: string | null): void;
  refresh(): Promise<void>;
  register(): Promise<RegisterOutcome>;
  switchTo(projectId: string): Promise<void>;
}

/** 项目侧栏数据源：挂载即拉取；注册/切换后刷新（Main 侧保证 canonical 去重与 currentProjectId 持久化） */
export function useProjects(transport: ChatTransport | null): ProjectsController {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!transport) return;
    const res = await transport.invoke({ channel: "project:list" });
    if (res.ok && res.projects) {
      setProjects(res.projects);
      setCurrentProjectId(res.currentProjectId ?? null);
    }
  }, [transport]);

  // 挂载拉取：异步回调 setState（外部系统=IPC 桥），cancelled 防竞态
  useEffect(() => {
    if (!transport) return;
    let cancelled = false;
    void transport.invoke({ channel: "project:list" }).then((res) => {
      if (cancelled || !res.ok || !res.projects) return;
      setProjects(res.projects);
      setCurrentProjectId(res.currentProjectId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [transport]);

  const register = useCallback(async (): Promise<RegisterOutcome> => {
    if (!transport) return "error";
    const res = await transport.invoke({ channel: "project:register" });
    if (!res.ok) {
      setNotice(`注册失败：${res.error.message}`);
      return "error";
    }
    if (res.canceled) return "canceled";
    if (res.duplicate && res.project) {
      setNotice(`目录已注册为项目「${res.project.name}」`);
      await refresh();
      return "duplicate";
    }
    await refresh();
    return "registered";
  }, [transport, refresh]);

  const switchTo = useCallback(
    async (projectId: string) => {
      if (!transport) return;
      const res = await transport.invoke({ channel: "project:switch", projectId });
      if (!res.ok) {
        setNotice(`切换失败：${res.error.message}`);
        return;
      }
      await refresh();
    },
    [transport, refresh],
  );

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null;

  return { projects, currentProjectId, currentProject, notice, setNotice, refresh, register, switchTo };
}
