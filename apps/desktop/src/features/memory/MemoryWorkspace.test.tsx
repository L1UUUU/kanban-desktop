// 用途：记忆视图组件测试（#34，spec #27 I 节原型一致项 1/2、US19–21）—— 真实 MemoryService + memory:ipc 通道直连驱动 AppShell/MemoryWorkspace：入口三态切换、知识/总结列表渲染、搜索过滤与空态、复制与编辑经 IPC、无项目空态（transport 注入 fake，先例 features/kanban/*.test.tsx）
/// <reference types="node" />
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEventWire, MemoryRequest, ProjectRow } from "@kanban/ipc-schema";
import { openDatabase } from "../../../electron/main/db";
import { handleMemoryIpc } from "../../../electron/main/ipc";
import { openMemoryService, type MemoryService } from "../../../electron/main/memory-service";
import { AppShell } from "../../App";
import type { ChatTransport } from "../../lib/kanban-api";
import type { MemoryTransport } from "./memory-transport";

// 未关闭的 db 连接（afterEach 统一关，避免 Windows 上临时目录删除 EPERM）
const openDbs: Array<{ close(): void }> = [];

// 测试项目行（project:list 桩数据）
const PROJECT: ProjectRow = {
  id: "proj-1",
  name: "demo-repo",
  canonicalPath: "C:\\demo\\repo",
  status: "ok",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/**
 * 真实 MemoryService 直连 memory transport（#31 通道全链路：handleMemoryIpc zod 校验 + 业务路由）：
 * 种子经 service.store / service.summaries 落库；calls 记录 renderer 发出的全部 memory 请求
 */
function makeMemoryFixture(dataRoot: string, titles: Record<string, string> = {}) {
  const db = openDatabase(":memory:");
  openDbs.push(db);
  const { service } = openMemoryService({
    db,
    dataRoot,
    listLinkedStructuredSessions: () => [],
    getRequirementTitle: (requirementId) => titles[requirementId] ?? null,
  });
  const calls: MemoryRequest[] = [];
  const listeners = new Set<(event: MemoryEventWire) => void>();
  const transport: MemoryTransport = {
    invoke: (req) => {
      calls.push(req);
      return handleMemoryIpc({ memory: service }, req);
    },
    onEvent: (handler) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
  return { transport, service, calls };
}

/** 轻量 chat transport 桩：只实现挂载必需的 project:list / kanban:list（聊天动作不经 memory 用例） */
function makeChatStub(project: ProjectRow | null): ChatTransport {
  return {
    invoke: async (req) => {
      if (req.channel === "project:list") {
        return { ok: true, projects: project ? [project] : [], currentProjectId: project?.id ?? null };
      }
      if (req.channel === "kanban:list") {
        return { ok: true, requirements: [], sessionToReq: {} };
      }
      return { ok: false, error: { code: "E_INTERNAL", message: `测试桩未实现通道：${req.channel}` } };
    },
    onEvent: () => () => undefined,
    onTerminalEvent: () => () => undefined,
    onTrackerEvent: () => () => undefined,
  };
}

/** 挂载 AppShell（App 的可注入骨架：三态视图 + 侧栏双入口 + memory 控制器） */
function mountApp(chat: ChatTransport, memory: MemoryTransport | null) {
  render(<AppShell transport={chat} memoryTransport={memory} />);
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

// ═══ 周期 1：入口与三态视图切换 + 无项目空态（原型一致项 1） ═══

describe("记忆入口与三态视图切换（#34；原型一致项 1）", () => {
  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
  });

  it("侧栏底部看板入口之侧出现「记忆」整宽入口（图标+「记忆」+当前项目指示）；点击只换中央区为记忆视图", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "kb-mem-entry-"));
    try {
      const mem = makeMemoryFixture(join(tmpRoot, "memory"));
      mountApp(makeChatStub(PROJECT), mem.transport);
      await flush();
      const kanban = screen.getByTestId("kanban-entry");
      const memory = screen.getByTestId("memory-entry");
      expect(memory.textContent).toContain("记忆");
      expect(memory.textContent).toContain("demo-repo"); // 当前项目 → 指示
      // 同列于侧栏底部 footer（sidebarFooter 槽内相邻入口，非导航列表）
      expect(kanban.parentElement).toBe(memory.parentElement);
      // 进入记忆视图：中央区换成记忆工作区，看板与聊天 composer 不在
      fireEvent.click(memory);
      expect(screen.getByTestId("memory-workspace")).toBeTruthy();
      expect(screen.queryByTestId("kanban-board")).toBeNull();
      expect(screen.queryByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeNull();
      // 三态共享侧栏：会话分组仍在
      expect(screen.getByText("结构化会话")).toBeTruthy();
    } finally {
      cleanup();
      for (const db of openDbs.splice(0)) db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("三态往返：记忆 → 看板 → 聊天 → 记忆 → 聊天（各入口点击切换/回落）", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "kb-mem-switch-"));
    try {
      const mem = makeMemoryFixture(join(tmpRoot, "memory"));
      mountApp(makeChatStub(PROJECT), mem.transport);
      await flush();
      fireEvent.click(screen.getByTestId("memory-entry"));
      expect(screen.getByTestId("memory-workspace")).toBeTruthy();
      fireEvent.click(screen.getByTestId("kanban-entry"));
      expect(screen.getByTestId("kanban-board")).toBeTruthy();
      expect(screen.queryByTestId("memory-workspace")).toBeNull();
      fireEvent.click(screen.getByTestId("kanban-entry")); // 看板 → 聊天（既有回落语义）
      expect(screen.getByPlaceholderText("输入消息，/ 开头触发 Skill…")).toBeTruthy();
      fireEvent.click(screen.getByTestId("memory-entry")); // 聊天 → 记忆
      expect(screen.getByTestId("memory-workspace")).toBeTruthy();
      fireEvent.click(screen.getByTestId("memory-entry")); // 记忆 → 聊天（toggle 回落）
      expect(screen.queryByTestId("memory-workspace")).toBeNull();
    } finally {
      cleanup();
      for (const db of openDbs.splice(0)) db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("无项目：记忆视图空态引导", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "kb-mem-noproj-"));
    try {
      const mem = makeMemoryFixture(join(tmpRoot, "memory"));
      mountApp(makeChatStub(null), mem.transport);
      await flush();
      fireEvent.click(screen.getByTestId("memory-entry"));
      expect(screen.getByTestId("memory-empty-project")).toBeTruthy();
    } finally {
      cleanup();
      for (const db of openDbs.splice(0)) db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("memory transport 不可用（window.api 缺失）：入口可见，视图降级提示不崩溃", async () => {
    mountApp(makeChatStub(PROJECT), null);
    await flush();
    expect(screen.getByTestId("memory-entry").textContent).toContain("记忆");
    fireEvent.click(screen.getByTestId("memory-entry"));
    expect(screen.getByTestId("memory-unavailable")).toBeTruthy();
  });
});

// ═══ 周期 2：知识/总结列表渲染 + 搜索过滤与空态（原型一致项 2、US20/21） ═══

// 知识种子 claim 文案（有效值断言的独立事实来源）
const CLAIM_ACCEPTED = "Windows 下 spawn 必须直连真实 exe，npm shim kill 后会留孤儿进程";
const CLAIM_EDITED_ORIG = "node:sqlite 在 Node 24 仅导出 DatabaseSync，新名 Database 自 25.7 起";
const CLAIM_EDITED_EFFECTIVE = "node:sqlite 在 Node 24 仅导出 DatabaseSync（双入口兼容）";
const CLAIM_PENDING = "待审核候选知识不进记忆视图";
const CLAIM_IGNORED = "被忽略候选知识不进记忆视图";
const SUMMARY_TITLE = "CLI Adapter 统一契约";
const SUMMARY_CONTENT = "# 需求开发总结\n统一 CLI Adapter 契约与三实现。目标：跨 CLI 一致体验。";

/** 种子：1 完成批次 + 4 候选（accepted/edited/ignored/pending）+ 1 需求总结 */
function seedMemory(service: MemoryService, projectId: string): void {
  const store = service.store;
  store.createBatch({ id: "batch-1", requirementId: "REQ-001", projectId, sourceSessionCount: 2 });
  const [cAccepted, cEdited, , cIgnored] = store.appendCandidates("batch-1", [
    { claim: CLAIM_ACCEPTED, scope: "全项目", evidence: "PoC 2 发现 #5", sourceSessionIds: ["s1", "s2"] },
    { claim: CLAIM_EDITED_ORIG, scope: "packages/tracker", evidence: "Node 官方文档", sourceSessionIds: ["s1"] },
    { claim: CLAIM_PENDING, scope: "packages/memory", evidence: "证据摘录", sourceSessionIds: ["s1"] },
    { claim: CLAIM_IGNORED, scope: "packages/memory", evidence: "证据摘录", sourceSessionIds: ["s1"] },
  ]);
  store.reviewCandidate(cAccepted.id, "accept");
  store.reviewCandidate(cEdited.id, "edit", { claim: CLAIM_EDITED_EFFECTIVE, scope: "apps/desktop" });
  store.reviewCandidate(cIgnored.id, "ignore"); // cPending 保持 pending
  store.finishBatch("batch-1", { status: "completed" });
  service.summaries.writeSummary({
    requirementId: "REQ-001",
    projectId,
    batchId: "batch-1",
    content: SUMMARY_CONTENT,
  });
}

/** 挂载并进入记忆视图（周期 2+ 用例共用） */
async function bootMemoryView(dataRoot: string) {
  const mem = makeMemoryFixture(dataRoot, { "REQ-001": SUMMARY_TITLE });
  seedMemory(mem.service, PROJECT.id);
  mountApp(makeChatStub(PROJECT), mem.transport);
  await flush();
  fireEvent.click(screen.getByTestId("memory-entry"));
  return mem;
}

describe("记忆视图：知识/总结列表与搜索（#34；原型一致项 2、US20/21）", () => {
  let tmpRoot = "";

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
  });

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-mem-list-"));
  });

  it("知识列表渲染有效值与元信息（claim/适用范围徽标/来源会话数/编号/状态 chip）；pending/ignored 不进", async () => {
    await bootMemoryView(join(tmpRoot, "memory"));
    expect(screen.getAllByTestId("memory-knowledge-card")).toHaveLength(2);
    // 已接受卡：原文 claim + 徽标 + 来源会话数 + 编号 + 状态 chip
    expect(screen.getByText(CLAIM_ACCEPTED)).toBeTruthy();
    expect(screen.getByText("适用范围：全项目")).toBeTruthy();
    expect(screen.getByText("来源 2 会话")).toBeTruthy();
    expect(screen.getByText("CAND-0001")).toBeTruthy();
    // 已编辑卡：显示编辑后的有效值（claim 与适用范围），chip 标「已编辑」
    expect(screen.getByText(CLAIM_EDITED_EFFECTIVE)).toBeTruthy();
    expect(screen.getByText("适用范围：apps/desktop")).toBeTruthy();
    expect(screen.queryByText(CLAIM_EDITED_ORIG)).toBeNull(); // 原文被有效值取代
    // 状态 chip 序 = 编号序（listKnowledge 排序）
    expect(screen.getAllByTestId("memory-knowledge-status").map((el) => el.textContent)).toEqual(["已接受", "已编辑"]);
    // pending/ignored 候选不进记忆视图（US20）
    expect(screen.queryByText(CLAIM_PENDING)).toBeNull();
    expect(screen.queryByText(CLAIM_IGNORED)).toBeNull();
    // 分区标题计数
    expect(screen.getByText("已接受知识（2）")).toBeTruthy();
    expect(screen.getByText("需求总结（1）")).toBeTruthy();
  });

  it("总结区：需求编号+标题 / 更新时间 / 行动作（查看/编辑/复制路径）", async () => {
    await bootMemoryView(join(tmpRoot, "memory"));
    const row = screen.getByTestId("memory-summary-row");
    expect(row.textContent).toContain("REQ-001");
    expect(row.textContent).toContain(SUMMARY_TITLE);
    expect(row.textContent).toMatch(/更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    for (const label of ["查看", "编辑", "复制路径"]) {
      expect(within(row).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("搜索：大小写不敏感子串过滤知识与总结（标题+正文口径）；无匹配空态；清空恢复全列表", async () => {
    await bootMemoryView(join(tmpRoot, "memory"));
    const search = screen.getByTestId("memory-search");
    // 大写查询命中知识 claim（大小写不敏感）
    fireEvent.change(search, { target: { value: "SPAWN" } });
    await waitFor(() => expect(screen.getAllByTestId("memory-knowledge-card")).toHaveLength(1));
    expect(screen.getByText(CLAIM_ACCEPTED)).toBeTruthy();
    expect(screen.queryByText(CLAIM_EDITED_EFFECTIVE)).toBeNull(); // 不匹配的知识隐藏
    expect(screen.queryAllByTestId("memory-summary-row")).toHaveLength(0); // 总结不匹配隐藏
    // 命中总结正文（大小写不敏感）
    fireEvent.change(search, { target: { value: "统一 cli adapter 契约" } });
    await waitFor(() => expect(screen.getAllByTestId("memory-summary-row")).toHaveLength(1));
    expect(screen.queryAllByTestId("memory-knowledge-card")).toHaveLength(0);
    // 无匹配空态
    fireEvent.change(search, { target: { value: "zzz不存在的查询" } });
    await waitFor(() => expect(screen.getByTestId("memory-empty-search")).toBeTruthy());
    expect(screen.queryAllByTestId("memory-knowledge-card")).toHaveLength(0);
    expect(screen.queryAllByTestId("memory-summary-row")).toHaveLength(0);
    // 清空恢复全列表
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByTestId("memory-knowledge-card")).toHaveLength(2));
    expect(screen.getAllByTestId("memory-summary-row")).toHaveLength(1);
  });
});

// ═══ 周期 3：复制动作 + 知识编辑（editAccepted 经 IPC）+ 总结查看/编辑弹层（US21） ═══

describe("复制与编辑动作（#34；US21）", () => {
  let tmpRoot = "";
  let dataRoot = "";
  // clipboard 桩：记录全部 writeText 入参
  const writes: string[] = [];

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-mem-actions-"));
    dataRoot = join(tmpRoot, "memory");
    writes.length = 0;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (text: string) => void writes.push(text) },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    for (const db of openDbs.splice(0)) db.close();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = "";
    }
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });

  /** 定位某编号知识卡（列表内唯一） */
  const cardOf = (displayNo: string): HTMLElement =>
    screen.getAllByTestId("memory-knowledge-card").find((c) => c.textContent?.includes(displayNo)) as HTMLElement;

  it("知识：复制路径（accepted md 绝对路径，spec D 节布局）/ 复制内容（有效 claim）写入剪贴板并提示", async () => {
    await bootMemoryView(dataRoot);
    fireEvent.click(within(cardOf("CAND-0001")).getByTestId("memory-knowledge-copy-path"));
    await waitFor(() => expect(writes).toContain(join(dataRoot, PROJECT.id, "accepted", "CAND-0001.md")));
    fireEvent.click(within(cardOf("CAND-0002")).getByTestId("memory-knowledge-copy-content"));
    await waitFor(() => expect(writes).toContain(CLAIM_EDITED_EFFECTIVE)); // 复制内容取有效 claim
    await waitFor(() => expect(screen.getByTestId("memory-copy-notice").textContent).toContain("已复制"));
  });

  it("总结：复制路径（requirements/<REQ>/summary.md 绝对路径）", async () => {
    await bootMemoryView(dataRoot);
    fireEvent.click(screen.getByTestId("memory-summary-copy-path"));
    await waitFor(() =>
      expect(writes).toContain(join(dataRoot, PROJECT.id, "requirements", "REQ-001", "summary.md")),
    );
  });

  it("知识编辑弹层：溯源只读；修改 claim 与适用范围保存 → memory:editAccepted IPC + 列表刷新 + md 重写", async () => {
    const mem = await bootMemoryView(dataRoot);
    fireEvent.click(within(cardOf("CAND-0001")).getByTestId("memory-knowledge-edit"));
    const dialog = screen.getByTestId("memory-knowledge-dialog");
    // 溯源信息只读可见（编号/来源会话/证据摘录）
    expect(dialog.textContent).toContain("CAND-0001");
    expect(dialog.textContent).toContain("来源会话");
    expect(dialog.textContent).toContain("PoC 2 发现 #5");
    // 表单预填当前有效值
    const claimInput = within(dialog).getByLabelText("知识内容（claim）") as HTMLTextAreaElement;
    const scopeInput = within(dialog).getByLabelText("适用范围（scope）") as HTMLInputElement;
    expect(claimInput.value).toBe(CLAIM_ACCEPTED);
    expect(scopeInput.value).toBe("全项目");
    fireEvent.change(claimInput, { target: { value: "编辑后的新正文" } });
    fireEvent.change(scopeInput, { target: { value: "packages/memory" } });
    fireEvent.click(within(dialog).getByTestId("memory-knowledge-save"));
    await waitFor(() => expect(screen.queryByTestId("memory-knowledge-dialog")).toBeNull());
    // IPC 断言：editAccepted 通道且载荷为新值
    const editCall = mem.calls.find((c) => c.channel === "memory:editAccepted");
    expect(editCall).toMatchObject({ channel: "memory:editAccepted", claim: "编辑后的新正文", scope: "packages/memory" });
    // 列表刷新：新正文/新范围生效，原正文消失，chip 变「已编辑」
    await waitFor(() => expect(screen.getByText("编辑后的新正文")).toBeTruthy());
    expect(screen.getByText("适用范围：packages/memory")).toBeTruthy();
    expect(screen.queryByText(CLAIM_ACCEPTED)).toBeNull();
    // chip 映射 wire status 字段：再编辑不改变审核态（store 契约「再编辑不是审核」），CAND-0001 仍「已接受」
    expect(screen.getAllByTestId("memory-knowledge-status").map((el) => el.textContent)).toEqual(["已接受", "已编辑"]);
    // md 随编辑重写（D 节布局，写回可核验）
    expect(readFileSync(join(dataRoot, PROJECT.id, "accepted", "CAND-0001.md"), "utf-8")).toContain("编辑后的新正文");
  });

  it("知识编辑：取消关闭弹层且不发 IPC", async () => {
    const mem = await bootMemoryView(dataRoot);
    fireEvent.click(within(cardOf("CAND-0001")).getByTestId("memory-knowledge-edit"));
    fireEvent.click(within(screen.getByTestId("memory-knowledge-dialog")).getByTestId("memory-knowledge-cancel"));
    expect(screen.queryByTestId("memory-knowledge-dialog")).toBeNull();
    expect(mem.calls.some((c) => c.channel === "memory:editAccepted")).toBe(false);
  });

  it("总结查看弹层：只读正文 + 关闭", async () => {
    await bootMemoryView(dataRoot);
    fireEvent.click(screen.getByTestId("memory-summary-view"));
    const dialog = screen.getByTestId("memory-summary-dialog");
    expect(dialog.textContent).toContain("统一 CLI Adapter 契约与三实现");
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("memory-summary-dialog")).toBeNull();
  });

  it("总结编辑弹层：textarea 呈现正文；保存提示通道尚未接入且不发任何写 IPC（memory wire 无总结编辑请求）", async () => {
    const mem = await bootMemoryView(dataRoot);
    const callsBefore = mem.calls.length;
    fireEvent.click(screen.getByTestId("memory-summary-edit"));
    const dialog = screen.getByTestId("memory-summary-edit-dialog");
    const textarea = within(dialog).getByTestId("memory-summary-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("统一 CLI Adapter 契约与三实现");
    fireEvent.change(textarea, { target: { value: "人工编辑版正文" } });
    fireEvent.click(within(dialog).getByTestId("memory-summary-save"));
    // 降级提示出现且弹层保留（内容可经复制路径交 CLI 处理），未发出任何写请求
    await waitFor(() => expect(screen.getByTestId("memory-summary-save-notice").textContent).toContain("尚未接入"));
    expect(screen.getByTestId("memory-summary-edit-dialog")).toBeTruthy();
    expect(mem.calls.length).toBe(callsBefore);
  });
});
