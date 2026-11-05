// 用途：Main 入站 IPC 路由 —— 单通道 kanban:ipc 强制 zod 校验 + 分发到 CliAdapter 与 projects/sessions store（纯函数无 Electron 依赖：dialog 与 config 经 deps 注入）
import {
  ipcRequestSchema,
  type IpcRequest,
  type IpcResult,
  type SessionRow,
} from "@kanban/ipc-schema";
import { AdapterError, type CliAdapter } from "@kanban/cli-host";
import { detectDirIdentity } from "./git-identity";
import type { ProjectStore } from "./project-store";
import type { SessionStore } from "./session-store";

/** 路由依赖：adapter + 持久化 store + 平台能力（Electron dialog/config 由 index.ts 注入，测试可替换） */
export interface IpcDeps {
  adapter: CliAdapter;
  projects: ProjectStore;
  sessions: SessionStore;
  /** 原生目录选择（用户取消返回 null） */
  pickDirectory(): Promise<string | null>;
  getCurrentProjectId(): string | null;
  setCurrentProjectId(id: string): void;
}

// CLI 显示名（新建会话默认标题「新会话 · {名}」，原型 §3.6）
const CLI_LABELS: Record<string, string> = {
  fake: "Fake",
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
};

/** 处理一条入站请求：校验 → 路由 → 错误码形状化（spec E：Main 强制校验，非法消息明确错误码） */
export async function handleIpc(deps: IpcDeps, raw: unknown): Promise<IpcResult> {
  const parsed = ipcRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "E_SCHEMA", message: summarizeIssues(parsed.error.issues) },
    };
  }
  try {
    return await route(deps, parsed.data);
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

/** 按 channel 分发（不变量 1：send 等只表达已提交，内容经事件流） */
async function route(deps: IpcDeps, req: IpcRequest): Promise<IpcResult> {
  switch (req.channel) {
    case "project:list": {
      // 列表随取随探测（existsSync 便宜）：missing 标记始终新鲜
      return { ok: true, projects: deps.projects.refreshStatuses(), currentProjectId: deps.getCurrentProjectId() };
    }
    case "project:register": {
      const dir = await deps.pickDirectory();
      if (!dir) return { ok: true, canceled: true };
      const { duplicate, project } = deps.projects.register(dir);
      // 注册成功即切到新项目（用户刚注册，立即开始工作）；重复注册不打断当前指向
      if (!duplicate) deps.setCurrentProjectId(project.id);
      return { ok: true, duplicate, project };
    }
    case "project:switch": {
      // 切换时探测（工单验收第 1 条）：missing 仅标记不阻止
      deps.projects.refreshStatuses();
      const project = deps.projects.get(req.projectId);
      if (!project) {
        return { ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: `项目不存在：${req.projectId}` } };
      }
      deps.setCurrentProjectId(project.id);
      return { ok: true, project };
    }
    case "session:list": {
      const rows = deps.sessions.list(req.projectId).map(toSessionRow);
      return { ok: true, sessions: rows };
    }
    case "session:create": {
      const { sessionId } = await deps.adapter.createSession({
        cwd: req.cwd,
        model: req.model,
        permMode: req.permMode,
      });
      const title = req.title ?? `新会话 · ${CLI_LABELS[req.cli] ?? req.cli}`;
      const identity = detectDirIdentity(req.cwd);
      // 会话落库（重启恢复依据；nativeSessionId 由真实 Adapter 接入后回填，Fake 无 native id）
      deps.sessions.insert({
        id: sessionId,
        kind: "structured",
        cli: req.cli,
        nativeSessionId: null,
        projectId: req.projectId ?? null,
        title,
        cwd: req.cwd,
        permMode: req.permMode ?? "auto",
        status: "idle",
        lastActiveAt: null,
      });
      return {
        ok: true,
        sessionId,
        cli: req.cli,
        title,
        dirIdentity: identity.kind,
        worktreeName: identity.kind === "worktree" ? identity.name : null,
      };
    }
    case "session:send":
      await deps.adapter.sendTurn({ sessionId: req.sessionId, text: req.text });
      return { ok: true };
    case "session:interrupt":
      await deps.adapter.interruptTurn(req.sessionId);
      return { ok: true };
    case "session:resolveApproval":
      await deps.adapter.resolveApproval({
        sessionId: req.sessionId,
        requestId: req.requestId,
        decision: req.decision,
      });
      return { ok: true };
    case "session:readHistory": {
      // 断开会话恢复第一步：原生历史快照（不变量 4：与实时流同键同 seq，renderer 侧无缝拼接）
      const events = await deps.adapter.readHistory(req.sessionId);
      return { ok: true, events };
    }
    case "session:resume":
      // 断开会话恢复第二步：重连原生会话（真实 CLI 语义由 #8/#10/#11 Adapter 实现）
      await deps.adapter.resume(req.sessionId);
      return { ok: true };
  }
}

/** DB 记录 → wire 行（cwd 存在时附带目录身份判定） */
function toSessionRow(rec: ReturnType<SessionStore["list"]>[number]): SessionRow {
  const identity = rec.cwd ? detectDirIdentity(rec.cwd) : { kind: "none" as const };
  return {
    id: rec.id,
    kind: rec.kind,
    cli: rec.cli,
    nativeSessionId: rec.nativeSessionId,
    projectId: rec.projectId,
    title: rec.title,
    cwd: rec.cwd,
    permMode: rec.permMode,
    status: rec.status,
    lastActiveAt: rec.lastActiveAt,
    dirIdentity: identity.kind,
    worktreeName: identity.kind === "worktree" ? identity.name : null,
  };
}

/** zod issue 摘要：路径 + 信息，定位到字段（不含堆栈噪音） */
function summarizeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}
