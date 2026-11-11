// 用途：设置面板 modal（#61 spec #57 / 原型 stage5 演示③）—— 日志区（两项动作平移自旧顶栏浮层）+ 会话自动归档区（开关/天数经 config:ipc 读写、#64 扫描结果反馈）+ 已归档会话管理区（#63：archivedList 按项目分组，取消归档/删除同款二次确认）
import { useEffect, useState } from "react";
import { AUTO_ARCHIVE_DAYS_BOUNDS, type AutoArchiveConfig, type AutoArchiveScanSummary, type ProjectRow, type SessionRow } from "@kanban/ipc-schema";
import { copyText } from "../lib/copy-text";
import { CLI_DOT_CLS } from "./Sidebar";
import { DeleteSessionDialog } from "./DeleteSessionDialog";

/** 「打开日志文件」：资源管理器中定位当前启动主日志文件（Main 侧 shell.showItemInFolder 主文件）；jsdom 无桥可选链降级 */
const openLog = (): void => {
  void window.api?.openLogDir();
};

/** 「复制日志文件路径」：getLogPath 取主文件路径写剪贴板（沿用 copyText 惯例，失败记统一日志不抛出） */
const copyLogPath = (): void => {
  void (async () => {
    const path = await window.api?.getLogPath();
    if (path) await copyText(path);
  })();
};

/** 未关联项目分组键（projectId 为空的行归此组） */
const NONE_PROJECT_KEY = "__none__";
/** 未关联项目分组显示名 */
const NONE_PROJECT_LABEL = "未关联项目";

/** CLI 展示名（已归档条目 meta 用；与侧栏 CLI 色点同源的文本形态） */
const CLI_LABELS: Record<string, string> = { codex: "Codex", claude: "Claude", opencode: "OpenCode", fake: "Fake", pty: "PTY" };

/** ISO 时间 → 本地展示 YYYY-MM-DD HH:mm（null/不可解析显示 —） */
function fmtTime(iso: string | null): string {
  return iso && iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : "—";
}

/** 已归档会话分组（#63）：key=projectId 或未关联哨兵；items 保持 main 返回的归档时间倒序 */
export interface ArchivedGroup {
  key: string;
  label: string;
  items: SessionRow[];
}

/** 归档行按项目分组：组序按行序（归档时间倒序）首次出现；projectId 为空或在项目列表查不到均归「未关联项目」组 */
export function groupArchivedSessions(rows: SessionRow[], projects: ProjectRow[]): ArchivedGroup[] {
  const groups: ArchivedGroup[] = [];
  const byKey = new Map<string, ArchivedGroup>();
  for (const row of rows) {
    const proj = projects.find((p) => p.id === row.projectId);
    const key = proj ? proj.id : NONE_PROJECT_KEY;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: proj ? proj.name : NONE_PROJECT_LABEL, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(row);
  }
  return groups;
}

export function SettingsModal({
  onClose,
  projects = [],
  currentProjectId = null,
  onSessionRestored,
}: {
  onClose: () => void;
  /** #63：项目列表（归档分组头名称数据源；AppShell 经 TopBar 注入） */
  projects?: ProjectRow[];
  /** #63：当前项目 id（默认展开其分组；null=无项目，默认展开「未关联项目」组） */
  currentProjectId?: string | null;
  /** #63：取消归档成功回调（行回默认列表；AppShell 接 controller.store.registerRestored） */
  onSessionRestored?: (row: SessionRow) => void;
}) {
  // autoArchive=null = 初始值未加载（或桥不可用降级）；daysDraft 为天数输入框本地草稿（blur 时校验提交）；
  // unavailable 初始即按桥存在性判定（render 期同步可知，不在 effect 内同步 setState）
  const [autoArchive, setAutoArchive] = useState<AutoArchiveConfig | null>(null);
  // #64：上次扫描摘要（config:get 缓存值 / config:set 成功应答即时更新；null=尚未扫描）
  const [lastScan, setLastScan] = useState<AutoArchiveScanSummary | null>(null);
  const [daysDraft, setDaysDraft] = useState("30");
  const [unavailable, setUnavailable] = useState(() => !window.api);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // #63 已归档会话：rows=null = 未拉取完成或桥不可用降级；opsError 为取消归档/删除失败提示（行保留可重试）
  const [archivedRows, setArchivedRows] = useState<SessionRow[] | null>(null);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  // #63 分组展开集（null=未交互过，按默认集：当前项目分组，无当前项目则「未关联项目」组）
  const [expandedKeys, setExpandedKeys] = useState<Set<string> | null>(null);
  // #63 待二次确认删除的已归档行（null=确认弹窗关闭）
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null);

  // 打开即拉取当前 autoArchive（无桥时上方初始态已降级；失败 → 配置区降级提示，不阻塞日志区）
  useEffect(() => {
    let alive = true;
    if (!window.api) return () => undefined;
    window.api
      .invokeConfig({ channel: "config:get" })
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setAutoArchive(r.autoArchive);
          setDaysDraft(String(r.autoArchive.days));
          setLastScan(r.lastScan ?? null);
        } else {
          setUnavailable(true);
          setError(`读取设置失败：${r.error.message}`);
        }
      })
      .catch(() => alive && setUnavailable(true));
    return () => {
      alive = false;
    };
  }, []);

  // #63 打开即拉取已归档会话列表（无桥/部分桥时保持 null 渲染降级；失败 → 分区报错，不阻塞日志与配置区）
  useEffect(() => {
    let alive = true;
    const api = window.api;
    if (!api?.invoke) return () => undefined;
    void api
      .invoke({ channel: "session:archivedList" })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setArchivedRows(r.sessions ?? []);
        else setArchivedError(`读取已归档会话失败：${r.error.message}`);
      })
      .catch(() => alive && setArchivedError("读取已归档会话失败：IPC 调用异常"));
    return () => {
      alive = false;
    };
  }, []);

  // 分组（组序按最近归档首次出现、组内归档时间倒序——顺序由 main listArchived 保证，此处不重排）
  const archivedGroups = archivedRows === null ? [] : groupArchivedSessions(archivedRows, projects);
  // 生效展开集：用户交互过用其集，否则默认只展开当前项目分组（无当前项目=「未关联项目」组）
  const effectiveExpanded = expandedKeys ?? new Set([currentProjectId ?? NONE_PROJECT_KEY]);
  /** 组头点击切换展开（在生效集副本上翻转，避免默认集被就地改动） */
  const toggleGroup = (key: string): void => {
    const next = new Set(effectiveExpanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedKeys(next);
  };

  /** 取消归档（#63）：成功后行移出本列表并回调 onSessionRestored（回默认列表）；失败留在归档态报错可重试 */
  const unarchiveRow = (row: SessionRow): void => {
    setArchivedError(null);
    void (async () => {
      const r = await window.api?.invoke({ channel: "session:unarchive", sessionId: row.id });
      if (r?.ok) {
        setArchivedRows((prev) => (prev ? prev.filter((x) => x.id !== row.id) : prev));
        onSessionRestored?.(row);
      } else {
        setArchivedError(r && !r.ok ? `取消归档失败：${r.error.message}` : "取消归档失败：IPC 服务不可用");
        window.api?.log?.("error", "settings", "取消归档失败", { sessionId: row.id });
      }
    })();
  };

  /** 删除已归档会话（#63 二次确认后）：走既有 session:delete 编排；失败行保留报错可重试 */
  const deleteRow = (row: SessionRow): void => {
    setArchivedError(null);
    void (async () => {
      const r = await window.api?.invoke({ channel: "session:delete", sessionId: row.id });
      if (r?.ok) {
        setArchivedRows((prev) => (prev ? prev.filter((x) => x.id !== row.id) : prev));
      } else {
        setArchivedError(r && !r.ok ? `删除失败：${r.error.message}` : "删除失败：IPC 服务不可用");
        window.api?.log?.("error", "settings", "删除已归档会话失败", { sessionId: row.id });
      }
    })();
  };

  /** 保存 autoArchive（config:set）：按应答更新生效态与扫描反馈 —— 失败时旧值保持（新值不生效，UI 与主进程不分叉） */
  const save = async (next: AutoArchiveConfig): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await window.api?.invokeConfig({ channel: "config:set", autoArchive: next });
    setBusy(false);
    if (r?.ok) {
      setAutoArchive(r.autoArchive);
      setDaysDraft(String(r.autoArchive.days));
      setLastScan(r.lastScan ?? null);
    } else {
      setError(r && !r.ok ? r.error.message : "保存失败：设置服务不可用");
    }
  };

  /** 开关翻转：携带当前生效天数一并提交 */
  const toggleEnabled = (): void => {
    if (autoArchive) void save({ ...autoArchive, enabled: !autoArchive.enabled });
  };

  /** 天数提交（blur）：本地草稿须为 1–365 整数，非法拒绝并回落当前生效值（不发送请求） */
  const commitDays = (): void => {
    if (!autoArchive) return;
    const n = Number(daysDraft);
    if (daysDraft.trim() === "" || !Number.isInteger(n) || n < AUTO_ARCHIVE_DAYS_BOUNDS.min || n > AUTO_ARCHIVE_DAYS_BOUNDS.max) {
      setError(`天数须为 ${AUTO_ARCHIVE_DAYS_BOUNDS.min}–${AUTO_ARCHIVE_DAYS_BOUNDS.max} 的整数（当前输入「${daysDraft}」未保存）`);
      setDaysDraft(String(autoArchive.days));
      return;
    }
    if (n !== autoArchive.days) void save({ ...autoArchive, days: n });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55" data-testid="settings-modal-overlay">
      <div data-testid="settings-modal" className="flex max-h-[84%] w-[min(560px,88%)] flex-col rounded-[14px] border border-border bg-card shadow-2xl">
        <div className="flex items-center border-b border-border px-4 py-3 text-sm font-semibold">
          设置
          <button type="button" className="ml-auto px-1 text-fg-faint hover:text-foreground" onClick={onClose} aria-label="关闭设置">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-2">
          {/* 日志区：旧顶栏浮层两项动作平移（#55 spec #52 H 节，动作后面板保持打开） */}
          <section data-testid="settings-log-section" className="border-b border-border py-2.5">
            <div className="mb-2 text-xs text-muted-foreground">日志</div>
            <div className="flex items-center gap-2.5 py-1">
              <button
                type="button"
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={openLog}
              >
                打开日志文件
              </button>
              <button
                type="button"
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={copyLogPath}
              >
                复制日志文件路径
              </button>
            </div>
          </section>
          {/* 会话自动归档区：开关 + 天数（config:ipc 持久化，重启后生效）+ 扫描反馈占位 */}
          <section className="border-b border-border py-2.5">
            <div className="mb-2 text-xs text-muted-foreground">会话自动归档</div>
            {unavailable || !autoArchive ? (
              <div data-testid="settings-unavailable" className="py-1 text-xs text-fg-faint">
                设置服务不可用（window.api 未暴露），自动归档设置暂无法读写
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2.5 py-1 text-[13px]">
                  <button
                    type="button"
                    data-testid="auto-archive-switch"
                    role="switch"
                    aria-checked={autoArchive.enabled}
                    disabled={busy}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                      autoArchive.enabled ? "bg-primary" : "bg-border"
                    }`}
                    onClick={toggleEnabled}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-foreground transition-all ${
                        autoArchive.enabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </button>
                  <span className="flex items-center gap-1.5">
                    超过
                    <input
                      type="number"
                      min={AUTO_ARCHIVE_DAYS_BOUNDS.min}
                      max={AUTO_ARCHIVE_DAYS_BOUNDS.max}
                      data-testid="auto-archive-days"
                      className="w-16 rounded-md border border-border bg-muted px-2 py-0.5 text-[13px] outline-none focus:border-primary"
                      value={daysDraft}
                      disabled={busy}
                      onChange={(e) => setDaysDraft(e.target.value)}
                      onBlur={commitDays}
                    />
                    天未活跃的会话自动归档
                  </span>
                </div>
                <div className="py-1 text-[11px] leading-relaxed text-fg-faint">
                  默认关闭；启动时与修改设置时扫描。跳过正在运行 / 等待审批 / 进程仍存活的会话（含空闲终端）；已归档会话不计入。取消归档会重置活跃时间。
                </div>
                {/* #64 扫描结果反馈位：显示上次扫描摘要（get 缓存跨打开周期保留 / set 应答即时更新）；无摘要如实声明，不伪造数字 */}
                {autoArchive.enabled ? (
                  <div data-testid="auto-archive-feedback" className="py-1 text-[11px] text-fg-faint">
                    {lastScan
                      ? `上次扫描：归档 ${lastScan.archived} 条会话${lastScan.failed > 0 ? `，${lastScan.failed} 条失败（详见日志）` : ""}。`
                      : "尚未扫描：应用启动或保存设置时将执行一次扫描。"}
                  </div>
                ) : null}
              </>
            )}
            {error ? (
              <div data-testid="settings-error" className="py-1 text-[11px] text-destructive">
                {error}
              </div>
            ) : null}
          </section>
          {/* #63 已归档会话管理区：按项目分组（未关联项目单独成组）；取消归档/删除（同款二次确认）；空态提示；无续聊/批量入口 */}
          <section data-testid="archived-section" className="py-2.5">
            <div className="mb-2 text-xs text-muted-foreground">已归档会话（按项目分组）</div>
            {archivedRows === null ? (
              <div data-testid="archived-unavailable" className="py-1 text-[11px] text-fg-faint">
                已归档会话不可用（window.api 未暴露）
              </div>
            ) : archivedGroups.length === 0 ? (
              <div data-testid="archived-empty" className="py-1 text-[11px] text-fg-faint">
                暂无已归档会话。可在侧栏会话行 hover → 归档，或开启自动归档。
              </div>
            ) : (
              archivedGroups.map((g) => (
                <div key={g.key} data-testid="archived-group" data-key={g.key} data-label={g.label} className="my-2 overflow-hidden rounded-[10px] border border-border">
                  <button
                    type="button"
                    data-testid="archived-group-head"
                    aria-expanded={effectiveExpanded.has(g.key)}
                    className="flex w-full items-center gap-2 bg-muted px-3 py-2 text-left text-xs hover:bg-border/40"
                    onClick={() => toggleGroup(g.key)}
                  >
                    <span aria-hidden>{effectiveExpanded.has(g.key) ? "▾" : "▸"}</span>
                    <span aria-hidden>📁</span>
                    <span>{g.label}</span>
                    <span className="ml-auto text-[11px] text-fg-faint">{g.items.length} 条</span>
                  </button>
                  {effectiveExpanded.has(g.key)
                    ? g.items.map((row) => (
                    <div
                      key={row.id}
                      data-testid="archived-item"
                      data-session-id={row.id}
                      className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs"
                    >
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${CLI_DOT_CLS[row.cli] ?? "bg-accent2"}`} />
                      <span className="min-w-0 max-w-[45%] truncate" title={row.title ?? undefined}>
                        {row.title ?? "历史会话"}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                        {CLI_LABELS[row.cli] ?? row.cli} · 最后活跃 {fmtTime(row.lastActiveAt)} · 归档于 {fmtTime(row.archivedAt)}
                      </span>
                      <span className="flex shrink-0 gap-1.5">
                        <button
                          type="button"
                          data-testid="archived-unarchive"
                          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                          onClick={() => unarchiveRow(row)}
                        >
                          取消归档
                        </button>
                        <button
                          type="button"
                          data-testid="archived-delete"
                          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(row)}
                        >
                          删除
                        </button>
                      </span>
                    </div>
                  ))
                    : null}
                </div>
              ))
            )}
            {archivedError ? (
              <div data-testid="archived-error" className="py-1 text-[11px] text-destructive">
                {archivedError}
              </div>
            ) : null}
          </section>
        </div>
        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <button type="button" className="rounded-md bg-primary px-3 py-1 text-xs text-white" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
      {/* #63 已归档行删除二次确认：与侧栏同款 DeleteSessionDialog（后渲染的 fixed 遮罩叠于设置面板之上） */}
      {deleteTarget ? (
        <DeleteSessionDialog
          title={deleteTarget.title ?? "历史会话"}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const row = deleteTarget;
            setDeleteTarget(null);
            deleteRow(row);
          }}
        />
      ) : null}
    </div>
  );
}
