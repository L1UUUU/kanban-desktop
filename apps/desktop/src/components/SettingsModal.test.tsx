// 用途：SettingsModal 密封测试（#61 spec #57 / 原型 stage5 演示③）—— 三分区骨架、autoArchive 读写经 config:ipc、天数非法拒绝回落、保存失败明确报错且新值不生效、扫描反馈、无桥降级；#63 已归档会话管理区（archivedList 拉取/分组/排序/展开/取消归档/删除二次确认/空态）
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRow, SessionRow } from "@kanban/ipc-schema";
import { SettingsModal } from "./SettingsModal";

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  window.api = undefined;
});

/** clipboard 桩：记录全部 writeText 入参 */
function stubClipboard(): string[] {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (text: string) => void writes.push(text) },
    configurable: true,
  });
  return writes;
}

/** config:set 应答：成功（生效值 + 可选扫描摘要）或失败（写盘错误 message） */
type SetReply =
  | { ok: true; autoArchive: { enabled: boolean; days: number }; lastScan?: { archived: number; failed: number } | null }
  | { ok: false; message: string };

/** fake 桥：invokeConfig 按 get 初始值（含可选 lastScan）/ setResults 队列应答，并记录全部请求（用例可随时向队列 push 追加应答） */
function stubConfigApi(
  opts: { initial?: { enabled: boolean; days: number }; lastScan?: { archived: number; failed: number } | null; setResults?: SetReply[] } = {},
): {
  requests: unknown[];
  setResults: SetReply[];
} {
  const requests: unknown[] = [];
  const setResults = opts.setResults ?? [];
  window.api = {
    invokeConfig: async (req: unknown) => {
      requests.push(req);
      const channel = (req as { channel: string }).channel;
      if (channel === "config:get") {
        return { ok: true, autoArchive: opts.initial ?? { enabled: false, days: 30 }, lastScan: opts.lastScan ?? null };
      }
      const r = setResults.shift();
      if (!r) throw new Error("未预置的 config:set 应答");
      return r.ok ? { ok: true, autoArchive: r.autoArchive, lastScan: r.lastScan ?? null } : { ok: false, error: { code: "E_INTERNAL", message: r.message } };
    },
  } as unknown as typeof window.api;
  return { requests, setResults };
}

/** 打开面板并等 config:get 初始值渲染完成（返回句柄供用例追加 set 应答） */
async function openAndReady(initial?: { enabled: boolean; days: number }) {
  const handle = stubConfigApi({ initial });
  render(<SettingsModal onClose={() => undefined} />);
  await waitFor(() => expect(handle.requests).toEqual([{ channel: "config:get" }]));
  await waitFor(() => expect((screen.getByTestId("auto-archive-days") as HTMLInputElement).value).toBe(String(initial?.days ?? 30)));
  return handle;
}

describe("SettingsModal 三分区骨架（#61）", () => {
  it("渲染「日志」「会话自动归档」「已归档会话」三分区；日志区含且仅含两项动作（密封：不新增其它日志入口）", async () => {
    await openAndReady();
    const logSection = screen.getByTestId("settings-log-section");
    expect(logSection.querySelectorAll("button").length).toBe(2);
    expect(screen.getByRole("button", { name: "打开日志文件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制日志文件路径" })).toBeTruthy();
    expect(screen.getByText("会话自动归档")).toBeTruthy();
    expect(screen.getByText("已归档会话（按项目分组）")).toBeTruthy();
  });

  it("已归档分区在桥无 invoke（部分桥）时降级提示，不渲染会话条目不崩（#63）", async () => {
    await openAndReady();
    const section = screen.getByTestId("archived-section");
    expect(section.querySelectorAll("[data-testid='archived-item']").length).toBe(0);
    expect(screen.getByTestId("archived-unavailable").textContent).toContain("不可用");
  });
});

// ── #63 已归档会话管理区 fixtures ──────────────────────────────

/** 归档行 fixture（archivedAt 必填；其余按需覆盖） */
function archRow(p: { id: string; archivedAt: string; projectId?: string | null; title?: string; cli?: string; kind?: "structured" | "pty"; lastActiveAt?: string | null }): SessionRow {
  return {
    id: p.id,
    kind: p.kind ?? "structured",
    cli: p.cli ?? "codex",
    nativeSessionId: "native-" + p.id,
    projectId: p.projectId ?? null,
    title: p.title ?? "会话 " + p.id,
    cwd: "C:\\repo",
    permMode: "auto",
    status: "idle",
    lastActiveAt: p.lastActiveAt ?? null,
    archivedAt: p.archivedAt,
    dirIdentity: "none",
    worktreeName: null,
  };
}

const PROJECTS: ProjectRow[] = [
  { id: "p-1", name: "kanban-desktop", canonicalPath: "C:\\kanban", status: "ok", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "p-2", name: "另个项目", canonicalPath: "C:\\other", status: "ok", createdAt: "2026-01-02T00:00:00.000Z" },
];

/** session 通道应答：成功或失败（message） */
type SessionOpReply = { ok: true } | { ok: false; message: string };

/** fake 桥（#63）：invokeConfig 走既有形态；invoke 应答 session:archivedList（初始 rows）与 unarchive/delete（opReplies 队列），记录全部请求 */
function stubArchivedApi(opts: { rows?: SessionRow[]; opReplies?: SessionOpReply[] } = {}): {
  requests: unknown[];
  opReplies: SessionOpReply[];
} {
  const requests: unknown[] = [];
  const opReplies = opts.opReplies ?? [];
  window.api = {
    invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 }, lastScan: null }),
    invoke: async (req: unknown) => {
      requests.push(req);
      const channel = (req as { channel: string }).channel;
      if (channel === "session:archivedList") return { ok: true, sessions: opts.rows ?? [] };
      const r = opReplies.shift();
      if (!r) throw new Error(`未预置的 ${channel} 应答`);
      return r.ok ? { ok: true } : { ok: false, error: { code: "E_INTERNAL", message: r.message } };
    },
  } as unknown as typeof window.api;
  return { requests, opReplies };
}

/** 打开面板（带 projects/currentProjectId props）并等归档分组渲染完成 */
async function openWithArchived(
  rows: SessionRow[],
  props: { currentProjectId?: string | null; onSessionRestored?: (row: SessionRow) => void } = {},
): Promise<{ requests: unknown[]; opReplies: SessionOpReply[] }> {
  const h = stubArchivedApi({ rows });
  render(
    <SettingsModal
      onClose={() => undefined}
      projects={PROJECTS}
      currentProjectId={props.currentProjectId ?? null}
      onSessionRestored={props.onSessionRestored}
    />,
  );
  await waitFor(() => expect(screen.getAllByTestId("archived-group").length).toBeGreaterThan(0));
  return h;
}

// 归档时间倒序 fixture：r1(11-11,p-1) r3(11-10,p-2) r2(11-09,无项目) r4(11-08,p-1)
const GROUP_ROWS: SessionRow[] = [
  archRow({ id: "r1", projectId: "p-1", title: "新会话 · Codex", archivedAt: "2026-11-11T08:00:00.000Z", lastActiveAt: "2026-10-02T09:30:00.000Z" }),
  archRow({ id: "r3", projectId: "p-2", title: "B 会话", cli: "claude", archivedAt: "2026-11-10T08:00:00.000Z" }),
  archRow({ id: "r2", projectId: null, title: "调研缓存策略", cli: "claude", archivedAt: "2026-11-09T08:00:00.000Z" }),
  archRow({ id: "r4", projectId: "p-1", title: "A 会话", cli: "pty", kind: "pty", archivedAt: "2026-11-08T08:00:00.000Z" }),
];

/** 按 data-session-id 取已渲染的归档条目元素 */
function withinItem(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid='archived-item'][data-session-id='${id}']`);
  if (!el) throw new Error(`归档条目未找到：${id}`);
  return el as HTMLElement;
}

/** 按 data-key 取已渲染的归档分组元素 */
function groupByKey(key: string): HTMLElement {
  const el = document.querySelector(`[data-testid='archived-group'][data-key='${key}']`);
  if (!el) throw new Error(`归档分组未找到：${key}`);
  return el as HTMLElement;
}

describe("已归档会话：拉取与分组排序（#63）", () => {
  it("打开面板经 session:archivedList 拉取；按项目分组（未关联项目单独成组），组序按最近归档首次出现、组内保持归档时间倒序；每条显示标题/CLI/最后活跃/归档时间", async () => {
    const h = await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1" });
    expect(h.requests).toContainEqual({ channel: "session:archivedList" });
    const groups = screen.getAllByTestId("archived-group");
    // 组序：p-1（r1 最新归档首次出现）→ p-2（r3）→ 未关联项目（r2）
    expect(groups.map((g) => g.getAttribute("data-key"))).toEqual(["p-1", "p-2", "__none__"]);
    expect(groups.map((g) => g.getAttribute("data-label"))).toEqual(["kanban-desktop", "另个项目", "未关联项目"]);
    expect(groups[0].textContent).toContain("2 条");
    // 组内排序：p-1 组 r1（11-11）在前 r4（11-08）在后
    const p1Items = groups[0].querySelectorAll("[data-testid='archived-item']");
    expect([...p1Items].map((n) => n.getAttribute("data-session-id"))).toEqual(["r1", "r4"]);
    // 每条字段：标题 + CLI + 最后活跃 + 归档时间（时间 YYYY-MM-DD HH:mm；缺失显示 —）
    const r1 = p1Items[0];
    expect(r1.textContent).toContain("新会话 · Codex");
    expect(r1.textContent).toContain("Codex");
    expect(r1.textContent).toContain("最后活跃 2026-10-02 09:30");
    expect(r1.textContent).toContain("归档于 2026-11-11 08:00");
    // lastActiveAt 缺失的行如实显示 —
    expect(groups[0].querySelectorAll("[data-testid='archived-item']")[1].textContent).toContain("最后活跃 —");
  });

  it("空态：无已归档会话时显示提示文案，不渲染分组", async () => {
    const h = stubArchivedApi({ rows: [] });
    render(<SettingsModal onClose={() => undefined} projects={PROJECTS} currentProjectId="p-1" />);
    await waitFor(() => expect(h.requests).toContainEqual({ channel: "session:archivedList" }));
    await waitFor(() => expect(screen.getByTestId("archived-empty")).toBeTruthy());
    expect(screen.getByTestId("archived-empty").textContent).toContain("暂无已归档会话");
    expect(screen.queryByTestId("archived-group")).toBeNull();
  });
});

describe("已归档会话：分组展开（#63 默认展开当前项目分组）", () => {
  it("默认仅展开当前项目分组（其余组条目不渲染）；点组头切换展开/收起", async () => {
    await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1" });
    const groups = screen.getAllByTestId("archived-group");
    const itemIdsIn = (g: HTMLElement): string[] => [...g.querySelectorAll("[data-testid='archived-item']")].map((n) => n.getAttribute("data-session-id") ?? "");
    // 默认：p-1 展开可见条目；p-2 与未关联项目收起（条目不渲染）
    expect(itemIdsIn(groups[0])).toEqual(["r1", "r4"]);
    expect(itemIdsIn(groups[1])).toEqual([]);
    expect(itemIdsIn(groups[2])).toEqual([]);
    // 点 p-2 组头 → 展开显示 r3；再点 → 收起
    fireEvent.click(groups[1].querySelector("[data-testid='archived-group-head']")!);
    await waitFor(() => expect(itemIdsIn(screen.getAllByTestId("archived-group")[1])).toEqual(["r3"]));
    fireEvent.click(screen.getAllByTestId("archived-group")[1].querySelector("[data-testid='archived-group-head']")!);
    await waitFor(() => expect(itemIdsIn(screen.getAllByTestId("archived-group")[1])).toEqual([]));
  });

  it("无当前项目（currentProjectId=null）：默认展开「未关联项目」组", async () => {
    await openWithArchived(GROUP_ROWS, { currentProjectId: null });
    const groups = screen.getAllByTestId("archived-group");
    const itemIdsIn = (g: HTMLElement): string[] => [...g.querySelectorAll("[data-testid='archived-item']")].map((n) => n.getAttribute("data-session-id") ?? "");
    expect(itemIdsIn(groups[0])).toEqual([]); // p-1 收起
    expect(itemIdsIn(groups[2])).toEqual(["r2"]); // 未关联项目展开
  });
});

describe("已归档会话：取消归档（#63 回默认列表）", () => {
  it("点击「取消归档」→ session:unarchive；成功后行移出列表并回调 onSessionRestored（携带该行，供回默认列表）", async () => {
    const restored: SessionRow[] = [];
    const h = await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1", onSessionRestored: (row) => restored.push(row) });
    h.opReplies.push({ ok: true });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-unarchive']")!);
    await waitFor(() => expect(h.requests).toContainEqual({ channel: "session:unarchive", sessionId: "r1" }));
    await waitFor(() => expect(restored.map((r) => r.id)).toEqual(["r1"]));
    // 行移出：p-1 组只剩 r4（r1 移除后组序按剩余最近归档重排，按 key 定位）
    await waitFor(() => {
      const g = groupByKey("p-1");
      expect([...g.querySelectorAll("[data-testid='archived-item']")].map((n) => n.getAttribute("data-session-id"))).toEqual(["r4"]);
    });
  });

  it("取消归档失败（如 adopt 登记失败）：明确报错、行保留在归档列表、不回调", async () => {
    const restored: SessionRow[] = [];
    const h = await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1", onSessionRestored: (row) => restored.push(row) });
    h.opReplies.push({ ok: false, message: "当前 CLI 不支持会话收养，无法取消归档：claude" });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-unarchive']")!);
    await waitFor(() => expect(screen.getByTestId("archived-error").textContent).toContain("无法取消归档"));
    expect(restored).toEqual([]);
    const g = groupByKey("p-1");
    expect([...g.querySelectorAll("[data-testid='archived-item']")].map((n) => n.getAttribute("data-session-id"))).toEqual(["r1", "r4"]);
  });
});

describe("已归档会话：删除（#63 与侧栏同款二次确认）", () => {
  it("点「删除」先弹 DeleteSessionDialog（标题命中该会话）；取消不发请求行保留；确认走 session:delete 且行移除", async () => {
    const h = await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1" });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-delete']")!);
    // 同款二次确认弹窗（#62 DeleteSessionDialog），正文含会话标题与不可撤销说明
    const dialog = screen.getByTestId("delete-session-dialog");
    expect(dialog.textContent).toContain("新会话 · Codex");
    expect(dialog.textContent).toContain("不可撤销");
    // 取消：不发任何 session:delete，行保留，弹窗关闭
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByTestId("delete-session-dialog")).toBeNull();
    expect(h.requests.filter((r) => (r as { channel: string }).channel === "session:delete")).toEqual([]);
    expect(withinItem("r1")).toBeTruthy();
    // 确认：session:delete 发出，行移出列表
    h.opReplies.push({ ok: true });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-delete']")!);
    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    await waitFor(() => expect(h.requests).toContainEqual({ channel: "session:delete", sessionId: "r1" }));
    await waitFor(() => expect(document.querySelector("[data-testid='archived-item'][data-session-id='r1']")).toBeNull());
  });

  it("删除失败：明确报错、行保留（可重试）", async () => {
    const h = await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1" });
    h.opReplies.push({ ok: false, message: "解除看板关联失败：数据库锁定" });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-delete']")!);
    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    await waitFor(() => expect(screen.getByTestId("archived-error").textContent).toContain("数据库锁定"));
    expect(withinItem("r1")).toBeTruthy();
  });

  it("密封：条目操作仅「取消归档/删除」两项——无续聊/恢复/批量入口", async () => {
    await openWithArchived(GROUP_ROWS, { currentProjectId: "p-1" });
    const item = withinItem("r1");
    const buttons = item.querySelectorAll("button");
    expect([...buttons].map((b) => b.textContent)).toEqual(["取消归档", "删除"]);
    const section = screen.getByTestId("archived-section");
    expect(section.textContent).not.toContain("恢复");
    expect(section.textContent).not.toContain("续聊");
    expect(section.querySelectorAll("input[type='checkbox']").length).toBe(0);
  });
});

describe("autoArchive 读初始值", () => {
  it("开关按 config:get 结果渲染（enabled=true 时 aria-checked=true、天数输入显示 days）", async () => {
    await openAndReady({ enabled: true, days: 14 });
    expect(screen.getByTestId("auto-archive-switch").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByTestId("auto-archive-days") as HTMLInputElement).value).toBe("14");
  });

  it("无 window.api（jsdom）：配置区降级提示、无开关/天数控件、不崩", async () => {
    render(<SettingsModal onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("settings-unavailable")).toBeTruthy());
    expect(screen.queryByTestId("auto-archive-switch")).toBeNull();
    expect(screen.queryByTestId("auto-archive-days")).toBeNull();
  });
});

describe("autoArchive 写（config:set）", () => {
  it("点击开关 → config:set 携带翻转后的 enabled 与当前生效 days；成功后 UI 生效态更新", async () => {
    const { requests, setResults } = await openAndReady({ enabled: false, days: 30 });
    setResults.push({ ok: true, autoArchive: { enabled: true, days: 30 } });
    fireEvent.click(screen.getByTestId("auto-archive-switch"));
    await waitFor(() =>
      expect(requests).toContainEqual({ channel: "config:set", autoArchive: { enabled: true, days: 30 } }),
    );
    await waitFor(() => expect(screen.getByTestId("auto-archive-switch").getAttribute("aria-checked")).toBe("true"));
  });

  it("天数合法修改（blur 提交）→ config:set 新 days；非法值（空/0/400/1.5）被拒绝：不发送、显示错误、输入回落当前生效值", async () => {
    const { requests, setResults } = await openAndReady({ enabled: true, days: 30 });
    setResults.push({ ok: true, autoArchive: { enabled: true, days: 45 } });
    // 合法：30 → 45
    fireEvent.change(screen.getByTestId("auto-archive-days"), { target: { value: "45" } });
    fireEvent.blur(screen.getByTestId("auto-archive-days"));
    await waitFor(() => expect(requests).toContainEqual({ channel: "config:set", autoArchive: { enabled: true, days: 45 } }));
    // 非法：45 → 0 / 400 / 1.5 / 空（均不发送、回落 45）
    for (const bad of ["0", "400", "1.5", ""]) {
      fireEvent.change(screen.getByTestId("auto-archive-days"), { target: { value: bad } });
      fireEvent.blur(screen.getByTestId("auto-archive-days"));
      expect(screen.getByTestId("settings-error").textContent).toContain("1–365");
      expect((screen.getByTestId("auto-archive-days") as HTMLInputElement).value).toBe("45");
    }
    expect(requests.filter((r) => (r as { channel: string }).channel === "config:set").length).toBe(1);
  });

  it("保存失败（写盘失败）→ 明确报错显示、开关/天数回落生效值（新值不生效不留分叉）", async () => {
    const { setResults } = await openAndReady({ enabled: false, days: 30 });
    setResults.push({ ok: false, message: "配置保存失败，新值未生效：EACCES: permission denied" });
    fireEvent.click(screen.getByTestId("auto-archive-switch"));
    await waitFor(() => expect(screen.getByTestId("settings-error").textContent).toContain("EACCES"));
    // 开关回落：生效值仍为关
    expect(screen.getByTestId("auto-archive-switch").getAttribute("aria-checked")).toBe("false");
  });

  it("扫描反馈位（#64 接通）：开启后显示上次扫描结果（归档 N 条，失败另计）；无摘要时如实显示尚未扫描", async () => {
    // 1) 打开即有缓存摘要（config:get 携带 lastScan）→ 显示归档条数与失败数
    stubConfigApi({ initial: { enabled: true, days: 30 }, lastScan: { archived: 3, failed: 1 } });
    render(<SettingsModal onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("auto-archive-feedback")).toBeTruthy());
    expect(screen.getByTestId("auto-archive-feedback").textContent).toContain("归档 3 条");
    expect(screen.getByTestId("auto-archive-feedback").textContent).toContain("1 条失败");
    cleanup();
    // 2) 保存成功应答携带新摘要 → 反馈即时更新（fault：若不接 set 载荷则保持旧值，断言红）
    const { setResults } = await openAndReady({ enabled: false, days: 30 });
    expect(screen.queryByTestId("auto-archive-feedback")).toBeNull(); // 关闭时不显示
    setResults.push({ ok: true, autoArchive: { enabled: true, days: 30 }, lastScan: { archived: 2, failed: 0 } });
    fireEvent.click(screen.getByTestId("auto-archive-switch"));
    await waitFor(() => expect(screen.getByTestId("auto-archive-feedback").textContent).toContain("归档 2 条"));
    expect(screen.getByTestId("auto-archive-feedback").textContent).not.toContain("失败");
    // 3) 开启但尚无摘要（主进程未扫描完成/未注入）→ 如实显示尚未扫描，不伪造数字
    cleanup();
    stubConfigApi({ initial: { enabled: true, days: 30 }, lastScan: null });
    render(<SettingsModal onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("auto-archive-feedback").textContent).toContain("尚未扫描"));
  });
});

describe("日志两项动作（自旧浮层平移，动作后面板保持打开）", () => {
  it("打开日志文件 → openLogDir；复制日志文件路径 → getLogPath + clipboard.writeText", async () => {
    const writes = stubClipboard();
    const calls = { openLogDirCalls: 0, getLogPathCalls: 0 };
    window.api = {
      invokeConfig: async () => ({ ok: true, autoArchive: { enabled: false, days: 30 } }),
      openLogDir: async () => {
        calls.openLogDirCalls++;
      },
      getLogPath: async () => {
        calls.getLogPathCalls++;
        return "C:\\userData\\logs\\20260102-030405-4242.jsonl";
      },
    } as unknown as typeof window.api;
    render(<SettingsModal onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开日志文件" }));
    await waitFor(() => expect(calls.openLogDirCalls).toBe(1));
    expect(screen.getByRole("button", { name: "打开日志文件" })).toBeTruthy(); // 面板不收起
    fireEvent.click(screen.getByRole("button", { name: "复制日志文件路径" }));
    await waitFor(() => {
      expect(calls.getLogPathCalls).toBe(1);
      expect(writes).toEqual(["C:\\userData\\logs\\20260102-030405-4242.jsonl"]);
    });
  });
});
