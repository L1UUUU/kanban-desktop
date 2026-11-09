// 用途：Diff 视图控制器 hook（#43，spec #40 G 节）—— transport → diff:get 一次读；进入视图（组件挂载）或切项目自动读取一次 + 手动刷新；结果归一为六态（不可用/空闲/读取中/成功/非 git 空态/错误档），视图零解析知识
import { useCallback, useEffect, useState } from "react";
import type { DiffFileRow, DiffResult } from "@kanban/ipc-schema";
import type { DiffTransport } from "./diff-transport";

/** Diff 视图状态（not-a-repo 单列空态：居中说明不弹窗；其余错误档带原因文案） */
export type WorkspaceDiffState =
  | { status: "unavailable" }
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; files: DiffFileRow[]; truncated: boolean }
  | { status: "empty" }
  | { status: "error"; message: string };

export interface WorkspaceDiffController {
  state: WorkspaceDiffState;
  /** 手动刷新（进入视图自动读取外的唯一触发；读取中重复点击由按钮禁用挡住） */
  refresh(): Promise<void>;
}

/** 状态归一：wire 结果 → 六态 */
function toState(res: DiffResult): WorkspaceDiffState {
  if (res.ok) return { status: "ok", files: res.files, truncated: res.truncated };
  if ("kind" in res) {
    // 四档错误：not-a-repo 是合法空态（居中说明），其余为错误档
    return res.kind === "not-a-repo" ? { status: "empty" } : { status: "error", message: res.message };
  }
  return { status: "error", message: `${res.error.code}：${res.error.message}` };
}

/** Diff 控制器 hook：transport 不可用或无项目保持不可用/空闲（入口禁用下不会进入，防御归一） */
export function useWorkspaceDiff(transport: DiffTransport | null, projectId: string | null): WorkspaceDiffController {
  const [state, setState] = useState<WorkspaceDiffState>(() =>
    transport == null ? { status: "unavailable" } : projectId == null ? { status: "idle" } : { status: "loading" },
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (transport == null || projectId == null) return;
    setState({ status: "loading" });
    const res = await transport.invoke({ channel: "diff:get", projectId });
    setState(toState(res));
  }, [transport, projectId]);

  // 进入视图（组件挂载）或切项目自动读取一次（spec US5）；setState 均在异步回调，use-projects/use-memory 同款形态
  useEffect(() => {
    if (transport == null || projectId == null) return;
    let cancelled = false;
    void transport.invoke({ channel: "diff:get", projectId }).then((res) => {
      if (!cancelled) setState(toState(res));
    });
    return () => {
      cancelled = true;
    };
  }, [transport, projectId]);

  return { state, refresh };
}
