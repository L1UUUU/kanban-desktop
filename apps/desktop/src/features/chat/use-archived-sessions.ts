// 用途：已归档会话管理控制器（issue #74）—— archivedList/unarchive/delete 单执行路径（全部经 ChatTransport.invoke，DEV 出站 zod 校验随 transport 生效）；rows/error 状态内聚，SettingsModal 只剩展示与纯视图态。
// 不进 use-chat controller：归档行不在 ChatStore，setError/removeSession 对不存在会话是 no-op（会静默吞掉失败），归档动作须自持错误面（行保留可重试）
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRow } from "@kanban/ipc-schema";
import type { ChatTransport } from "../../lib/kanban-api";
import { createScopedLogger } from "../../lib/logger";

// 本文件日志出口（scope 固定 chat：归档会话动作属会话域，与 use-chat 同 scope）
const log = createScopedLogger("chat");

export interface ArchivedSessionsController {
  /** null=未拉取/transport 不可用（降级提示由视图渲染） */
  rows: SessionRow[] | null;
  /** 拉取/取消归档/删除失败提示（行保留可重试；null=无错） */
  error: string | null;
  /** 重新拉取已归档列表（视图挂载触发；成功清错；transport 不可用时 rows 恒 null） */
  refresh(): void;
  /** 取消归档：成功移出行并回调 onRestored（行回默认列表，AppShell 接 store.registerRestored）；失败行保留报错可重试 */
  unarchive(row: SessionRow): void;
  /** 删除（二次确认弹窗状态由视图持有）：成功移出行；失败行保留报错可重试 */
  remove(row: SessionRow): void;
}

/**
 * 已归档会话小控制器（#63 设置面板数据源）：不自动拉取（打开面板时视图挂载触发 refresh，行为与旧
 * SettingsModal 打开即拉取一致）；transport=null（桥缺失）全程降级不发任何请求
 */
export function useArchivedSessions(
  transport: ChatTransport | null,
  onRestored?: (row: SessionRow) => void,
): ArchivedSessionsController {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 回调经 ref 取最新：调用方（AppShell）内联箭头每渲染新建，避免动作依赖随之重建（effect 内同步，回调中读取——渲染期不访问）
  const onRestoredRef = useRef(onRestored);
  useEffect(() => {
    onRestoredRef.current = onRestored;
  }, [onRestored]);

  const refresh = useCallback((): void => {
    const t = transport;
    if (!t) return;
    void t
      .invoke({ channel: "session:archivedList" })
      .then((r) => {
        // 成功清错：控制器状态跨面板开合常驻，重开面板重拉成功后不残留上次动作失败提示
        if (r.ok) {
          setRows(r.sessions ?? []);
          setError(null);
        } else {
          setError(`读取已归档会话失败：${r.error.message}`);
        }
      })
      .catch(() => setError("读取已归档会话失败：IPC 调用异常"));
  }, [transport]);

  const unarchive = useCallback(
    (row: SessionRow): void => {
      const t = transport;
      if (!t) return;
      setError(null);
      void (async () => {
        try {
          const r = await t.invoke({ channel: "session:unarchive", sessionId: row.id });
          if (r.ok) {
            setRows((prev) => (prev ? prev.filter((x) => x.id !== row.id) : prev));
            onRestoredRef.current?.(row);
          } else {
            setError(`取消归档失败：${r.error.message}`);
            log.error("取消归档失败", { sessionId: row.id });
          }
        } catch {
          setError("取消归档失败：IPC 服务不可用");
          log.error("取消归档失败", { sessionId: row.id });
        }
      })();
    },
    [transport],
  );

  const remove = useCallback(
    (row: SessionRow): void => {
      const t = transport;
      if (!t) return;
      setError(null);
      void (async () => {
        try {
          const r = await t.invoke({ channel: "session:delete", sessionId: row.id });
          if (r.ok) {
            setRows((prev) => (prev ? prev.filter((x) => x.id !== row.id) : prev));
          } else {
            setError(`删除失败：${r.error.message}`);
            log.error("删除已归档会话失败", { sessionId: row.id });
          }
        } catch {
          setError("删除失败：IPC 服务不可用");
          log.error("删除已归档会话失败", { sessionId: row.id });
        }
      })();
    },
    [transport],
  );

  return { rows, error, refresh, unarchive, remove };
}
