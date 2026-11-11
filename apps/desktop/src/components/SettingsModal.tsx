// 用途：设置面板 modal（#61 spec #57 / 原型 stage5 演示③）—— 日志区（两项动作平移自旧顶栏浮层）+ 会话自动归档区（开关/天数经 config:ipc 读写、#64 扫描结果反馈）+ 已归档会话分区骨架（列表由 #63 填充，占位不渲染假数据）
import { useEffect, useState } from "react";
import { AUTO_ARCHIVE_DAYS_BOUNDS, type AutoArchiveConfig, type AutoArchiveScanSummary } from "@kanban/ipc-schema";
import { copyText } from "../lib/copy-text";

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

export function SettingsModal({ onClose }: { onClose: () => void }) {
  // autoArchive=null = 初始值未加载（或桥不可用降级）；daysDraft 为天数输入框本地草稿（blur 时校验提交）；
  // unavailable 初始即按桥存在性判定（render 期同步可知，不在 effect 内同步 setState）
  const [autoArchive, setAutoArchive] = useState<AutoArchiveConfig | null>(null);
  // #64：上次扫描摘要（config:get 缓存值 / config:set 成功应答即时更新；null=尚未扫描）
  const [lastScan, setLastScan] = useState<AutoArchiveScanSummary | null>(null);
  const [daysDraft, setDaysDraft] = useState("30");
  const [unavailable, setUnavailable] = useState(() => !window.api);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          {/* 已归档会话区：分区骨架（按项目分组的列表与操作由 #63 接入；占位说明不渲染假数据） */}
          <section data-testid="archived-section" className="py-2.5">
            <div className="mb-2 text-xs text-muted-foreground">已归档会话（按项目分组）</div>
            <div data-testid="archived-placeholder" className="py-1 text-[11px] text-fg-faint">
              已归档会话管理尚未开放，后续版本将在此按项目分组展示。
            </div>
          </section>
        </div>
        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <button type="button" className="rounded-md bg-primary px-3 py-1 text-xs text-white" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
