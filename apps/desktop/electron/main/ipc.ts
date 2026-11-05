// 用途：Main 入站 IPC 路由 —— 单通道 kanban:ipc 强制 zod 校验 + 分发到 CliAdapter；纯函数无 Electron 依赖（窗口转发在 index.ts 接线）
import { ipcRequestSchema, type IpcRequest, type IpcResult } from "@kanban/ipc-schema";
import { AdapterError, type CliAdapter } from "@kanban/cli-host";

/** 处理一条入站请求：校验 → 路由 → 错误码形状化（spec E：Main 强制校验，非法消息明确错误码） */
export async function handleIpc(adapter: CliAdapter, raw: unknown): Promise<IpcResult> {
  const parsed = ipcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "E_SCHEMA", message: summarizeIssues(parsed.error.issues) },
    };
  }
  try {
    return await route(adapter, parsed.data);
  } catch (err) {
    if (err instanceof AdapterError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    return {
      ok: false,
      error: { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** 按 channel 分发到 Adapter 方法面（不变量 1：send 等只表达已提交，内容经事件流） */
async function route(adapter: CliAdapter, req: IpcRequest): Promise<IpcResult> {
  switch (req.channel) {
    case "session:create": {
      const { sessionId } = await adapter.createSession({
        cwd: req.cwd,
        model: req.model,
        permMode: req.permMode,
      });
      // 元数据回显：renderer 据此登记会话列表
      return { ok: true, sessionId, cli: req.cli, title: req.title ?? "新会话 · Fake" };
    }
    case "session:send":
      await adapter.sendTurn({ sessionId: req.sessionId, text: req.text });
      return { ok: true };
    case "session:interrupt":
      await adapter.interruptTurn(req.sessionId);
      return { ok: true };
    case "session:resolveApproval":
      await adapter.resolveApproval({
        sessionId: req.sessionId,
        requestId: req.requestId,
        decision: req.decision,
      });
      return { ok: true };
  }
}

/** zod issue 摘要：路径 + 信息，定位到字段（不含堆栈噪音） */
function summarizeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
