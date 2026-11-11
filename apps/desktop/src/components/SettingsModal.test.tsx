// 用途：SettingsModal 密封测试（#61 spec #57 / 原型 stage5 演示③）—— 三分区骨架、autoArchive 读写经 config:ipc、天数非法拒绝回落、保存失败明确报错且新值不生效、扫描反馈、无桥降级；#63 已归档会话管理区（分组/排序/展开/取消归档/删除二次确认/空态）；#74 起归档区纯展示——注入 fake 控制器断言（通道载荷/错误面/行移出在 use-archived-sessions.test）
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRow, SessionRow } from "@kanban/ipc-schema";
import type { ArchivedSessionsController } from "../features/chat/use-archived-sessions";
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

  it("已归档分区在控制器未注入（#74 缺省 null，如无 transport 降级）时提示不可用，不渲染会话条目不崩", async () => {
    await openAndReady();
    const section = screen.getByTestId("archived-section");
    expect(section.querySelectorAll("[data-testid='archived-item']").length).toBe(0);
    expect(screen.getByTestId("archived-unavailable").textContent).toContain("不可用");
  });
});

// ── #63/#74 已归档会话管理区 fixtures ──────────────────────────────

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

// 归档时间倒序 fixture：r1(11-11,p-1) r3(11-10,p-2) r2(11-09,无项目) r4(11-08,p-1)
const GROUP_ROWS: SessionRow[] = [
  archRow({ id: "r1", projectId: "p-1", title: "新会话 · Codex", archivedAt: "2026-11-11T08:00:00.000Z", lastActiveAt: "2026-10-02T09:30:00.000Z" }),
  archRow({ id: "r3", projectId: "p-2", title: "B 会话", cli: "claude", archivedAt: "2026-11-10T08:00:00.000Z" }),
  archRow({ id: "r2", projectId: null, title: "调研缓存策略", cli: "claude", archivedAt: "2026-11-09T08:00:00.000Z" }),
  archRow({ id: "r4", projectId: "p-1", title: "A 会话", cli: "pty", kind: "pty", archivedAt: "2026-11-08T08:00:00.000Z" }),
];

/**
 * fake 控制器（#74）：rows/error 经 getter 活读（用例改 state 后 rerender 即生效，模拟控制器状态推进）；
 * 三个动作记录调用次数与入参——通道载荷/错误面断言在 use-archived-sessions.test，此处只断言视图正确转调
 */
function fakeArchived(initial: { rows?: SessionRow[] | null; error?: string | null } = {}): {
  controller: ArchivedSessionsController;
  state: { rows: SessionRow[] | null; error: string | null };
  calls: { refresh: number; unarchive: SessionRow[]; remove: SessionRow[] };
} {
  const state = { rows: initial.rows ?? null, error: initial.error ?? null };
  const calls = { refresh: 0, unarchive: [] as SessionRow[], remove: [] as SessionRow[] };
  const controller: ArchivedSessionsController = {
    get rows() {
      return state.rows;
    },
    get error() {
      return state.error;
    },
    refresh: () => {
      calls.refresh++;
    },
    unarchive: (row) => {
      calls.unarchive.push(row);
    },
    remove: (row) => {
      calls.remove.push(row);
    },
  };
  return { controller, state, calls };
}

/** 打开面板（注入 fake 控制器与 projects/currentProjectId props；rows=null 模拟未拉取/降级；归档区不再触桥，config 区无桥走降级不影响断言） */
function openWithController(
  rows: SessionRow[] | null,
  props: { currentProjectId?: string | null; error?: string | null } = {},
): ReturnType<typeof fakeArchived> {
  const h = fakeArchived({ rows, error: props.error });
  render(
    <SettingsModal
      onClose={() => undefined}
      projects={PROJECTS}
      currentProjectId={props.currentProjectId ?? null}
      archived={h.controller}
    />,
  );
  return h;
}

/** 按 data-session-id 取已渲染的归档条目元素 */
function withinItem(id: string): HTMLElement {
  const el = document.querySelector(`[data-testid='archived-item'][data-session-id='${id}']`);
  if (!el) throw new Error(`归档条目未找到：${id}`);
  return el as HTMLElement;
}

describe("已归档会话：拉取与分组排序（#63/#74）", () => {
  it("打开面板触发控制器 refresh；按项目分组（未关联项目单独成组），组序按最近归档首次出现、组内保持归档时间倒序；每条显示标题/CLI/最后活跃/归档时间", () => {
    openWithController(GROUP_ROWS, { currentProjectId: "p-1" });
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

  it("空态：控制器 rows=[] 显示提示文案，不渲染分组", () => {
    const h = openWithController([], { currentProjectId: "p-1" });
    expect(h.calls.refresh).toBe(1); // 打开仍触发拉取（空数据是拉取结果而非未拉取）
    expect(screen.getByTestId("archived-empty").textContent).toContain("暂无已归档会话");
    expect(screen.queryByTestId("archived-group")).toBeNull();
  });

  it("控制器 rows=null（未拉取完成/transport 不可用）→ 不可用降级提示，不渲染分组", () => {
    const h = openWithController(null, { currentProjectId: "p-1" });
    expect(h.calls.refresh).toBe(1); // 挂载仍触发拉取（降级是应答未至/transport 缺失的结果）
    expect(screen.getByTestId("archived-unavailable").textContent).toContain("不可用");
    expect(screen.queryByTestId("archived-group")).toBeNull();
  });
});

describe("已归档会话：分组展开（#63 默认展开当前项目分组）", () => {
  it("默认仅展开当前项目分组（其余组条目不渲染）；点组头切换展开/收起", async () => {
    openWithController(GROUP_ROWS, { currentProjectId: "p-1" });
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

  it("无当前项目（currentProjectId=null）：默认展开「未关联项目」组", () => {
    openWithController(GROUP_ROWS, { currentProjectId: null });
    const groups = screen.getAllByTestId("archived-group");
    const itemIdsIn = (g: HTMLElement): string[] => [...g.querySelectorAll("[data-testid='archived-item']")].map((n) => n.getAttribute("data-session-id") ?? "");
    expect(itemIdsIn(groups[0])).toEqual([]); // p-1 收起
    expect(itemIdsIn(groups[2])).toEqual(["r2"]); // 未关联项目展开
  });
});

describe("已归档会话：取消归档（#74 经控制器）", () => {
  it("点击「取消归档」→ controller.unarchive 携带该行（行移出/回默认列表由控制器 onRestored 负责，见 use-archived-sessions.test）；视图不抢先移行", () => {
    const h = openWithController(GROUP_ROWS, { currentProjectId: "p-1" });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-unarchive']")!);
    expect(h.calls.unarchive).toEqual([GROUP_ROWS[0]]);
    // 视图纯展示：控制器未推进 rows 前行仍在（等待应答，不乐观移除）
    expect(withinItem("r1")).toBeTruthy();
  });

  it("控制器 error（取消归档/删除失败共用通道）→ archived-error 文案直达渲染", () => {
    openWithController(GROUP_ROWS, { currentProjectId: "p-1", error: "取消归档失败：当前 CLI 不支持会话收养，无法取消归档：claude" });
    expect(screen.getByTestId("archived-error").textContent).toContain("无法取消归档");
    expect(withinItem("r1")).toBeTruthy(); // 行保留可重试
  });
});

describe("已归档会话：删除（#63 与侧栏同款二次确认）", () => {
  it("点「删除」先弹 DeleteSessionDialog（标题命中该会话）；取消不调 remove 行保留；确认 → controller.remove 携带该行", () => {
    const h = openWithController(GROUP_ROWS, { currentProjectId: "p-1" });
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-delete']")!);
    // 同款二次确认弹窗（#62 DeleteSessionDialog），正文含会话标题与不可撤销说明
    const dialog = screen.getByTestId("delete-session-dialog");
    expect(dialog.textContent).toContain("新会话 · Codex");
    expect(dialog.textContent).toContain("不可撤销");
    // 取消：不调 controller.remove，行保留，弹窗关闭
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByTestId("delete-session-dialog")).toBeNull();
    expect(h.calls.remove).toEqual([]);
    expect(withinItem("r1")).toBeTruthy();
    // 确认：controller.remove 携带该行（通道载荷见 use-archived-sessions.test）
    fireEvent.click(withinItem("r1").querySelector("[data-testid='archived-delete']")!);
    fireEvent.click(screen.getByTestId("delete-session-confirm"));
    expect(h.calls.remove).toEqual([GROUP_ROWS[0]]);
  });

  it("控制器 error（删除失败）→ archived-error 渲染、行保留（可重试）", () => {
    openWithController(GROUP_ROWS, { currentProjectId: "p-1", error: "删除失败：解除看板关联失败：数据库锁定" });
    expect(screen.getByTestId("archived-error").textContent).toContain("数据库锁定");
    expect(withinItem("r1")).toBeTruthy();
  });

  it("密封：条目操作仅「取消归档/删除」两项——无续聊/恢复/批量入口", () => {
    openWithController(GROUP_ROWS, { currentProjectId: "p-1" });
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
