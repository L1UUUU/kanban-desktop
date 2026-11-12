// 用途：详情面板「关联会话」区（#20，原型一致项 4 关联区）—— 关联会话列表（CLI 色点 + 活动状态徽标 + 跳转 + 解除，US18 分离：活动状态只在会话行显示）、「＋新建会话」四 CLI 菜单（PTY 项标注「无 skill 信号」；session:create/terminal:create+requirementId 原子关联）、关联已有会话选择器（仅当前项目未关联会话，含 PTY）+ link 拒绝原因直达呈现；挂点 data-testid="detail-sessions" 保持稳定（#19 约定），无动作上下文时保持占位形态
import { useState } from "react";
import type { CliKind, RequirementCardRow } from "@kanban/ipc-schema";
import { CLI_DOT_CLS, NEW_MENU_CLIS } from "../../lib/cli-catalog";
import { CLI_NOT_INSTALLED_HINT, isCliUnavailable, useCliInstallStatus } from "../../lib/use-cli-status";
import type { SessionView } from "../chat/chat-store";
import { StatusBadge } from "../chat/components/StatusBadge";

/** 关联区动作面（ChatWorkspace 接线：kanban:link/unlink + 跳转 + 建会话，全部经 IPC） */
export interface RelatedSessionActions {
  /** 解除关联（kanban:unlink；不删历史、不回退阶段，卡片会话数经 tracker 推送即时更新） */
  onUnlink(sessionId: string): void;
  /** 关联已有会话（kanban:link）：返回拒绝原因（null=成功），UI 直达呈现 */
  onLinkExisting(sessionId: string, requirementId: string): Promise<string | null>;
  /** 跳转会话：切回聊天视图并选中该会话（S2-14） */
  onJumpToSession(sessionId: string): void;
  /** ＋新建会话（三 CLI + PTY 终端；创建即自动关联本需求，S2-11） */
  onCreateSession(cli: CliKind | "pty", card: RequirementCardRow): void;
}

export interface RelatedSessionsAreaProps {
  /** 当前需求行（sessions = 已关联会话 id 列表；标题随面板实时更新） */
  card: RequirementCardRow;
  /** 全部已登记会话（关联行详情与「关联已有」候选数据源；缺省空） */
  sessions?: SessionView[];
  /** 会话→需求反查映射（「关联已有」过滤：已关联任何需求的会话不列） */
  sessionToReq?: Record<string, string>;
  /** 关联区动作（缺省时保持 #19 占位形态——挂点在无动作上下文时不半渲染） */
  actions?: RelatedSessionActions;
}

/** 会话行需求徽标展示名：CLI 类型后缀区分 PTY 终端 */
function optionLabel(s: SessionView): string {
  return s.cli === "pty" ? `${s.title} · PTY` : s.title;
}

export function RelatedSessionsArea({ card, sessions = [], sessionToReq = {}, actions }: RelatedSessionsAreaProps) {
  // 「＋新建会话」菜单开合（一次只开一个，与侧栏项目「＋」菜单同交互形态）
  const [menuOpen, setMenuOpen] = useState(false);
  // #80：菜单打开时拉取 CLI 安装表（未装灰置；与侧栏菜单共享禁用逻辑）
  const cliInstalled = useCliInstallStatus(menuOpen);
  // link 拒绝原因（null=无待展示；成功关联即清除）
  const [rejectReason, setRejectReason] = useState<string | null>(null);

  if (!actions) {
    // 无动作上下文（#19 占位形态保持）
    return (
      <section data-testid="detail-sessions" className="flex flex-col gap-2">
        <h5 className="text-[11px] tracking-wide text-muted-foreground">关联会话（{card.sessions.length}）</h5>
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-fg-faint">
          关联会话列表、关联已有会话与「＋新建会话」即将提供
        </p>
      </section>
    );
  }

  /** 关联已有：发起 link 并直达呈现拒绝原因（成功清除） */
  const linkExisting = (sessionId: string): void => {
    void actions.onLinkExisting(sessionId, card.id).then((reason) => setRejectReason(reason));
  };

  // 关联已有候选：当前需求同项目 + 未关联任何需求的会话（含 PTY 终端，S2-12）
  const candidates = sessions.filter((s) => s.projectId === card.projectId && !(s.sessionId in sessionToReq));

  return (
    <section data-testid="detail-sessions" className="flex flex-col gap-2">
      <h5 className="text-[11px] tracking-wide text-muted-foreground">关联会话（{card.sessions.length}）</h5>
      {/* 关联会话列表：CLI 色点 + 标题 + 活动状态徽标（US18：仅会话行显示）+ 跳转 + 解除 */}
      {card.sessions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-fg-faint">暂无关联会话</p>
      ) : (
        card.sessions.map((sessionId) => {
          const s = sessions.find((x) => x.sessionId === sessionId);
          return (
            <div
              key={sessionId}
              data-testid="related-session"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs"
            >
              <span
                aria-hidden
                className={`h-2 w-2 flex-none rounded-full ${s ? (CLI_DOT_CLS[s.cli] ?? "bg-accent2") : "bg-fg-faint"}`}
              />
              <span className="min-w-0 flex-1 truncate" title={sessionId}>
                {s?.title ?? sessionId}
              </span>
              {s ? <StatusBadge status={s.status} /> : null}
              {s ? (
                <button
                  type="button"
                  data-testid="related-jump"
                  title="跳到该会话的聊天视图"
                  className="flex-none rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:border-primary hover:text-primary"
                  onClick={() => actions.onJumpToSession(s.sessionId)}
                >
                  ↩ 跳转
                </button>
              ) : null}
              <button
                type="button"
                data-testid="related-unlink"
                title="解除关联（不删历史、不回退阶段）"
                className="flex-none rounded-md border border-border px-2 py-0.5 text-muted-foreground hover:border-destructive hover:text-destructive"
                onClick={() => actions.onUnlink(sessionId)}
              >
                解除
              </button>
            </div>
          );
        })
      )}
      {/* ＋新建会话：四 CLI 菜单（创建即自动关联本需求，S2-11） */}
      <div className="relative flex flex-col">
        <button
          type="button"
          data-testid="new-session-menu"
          className="rounded-md border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:border-primary hover:text-primary"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ＋ 新建会话（自动关联）
        </button>
        {menuOpen ? (
          <div className="absolute left-0 top-full z-10 mt-1 min-w-[190px] rounded-lg border border-border bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,.5)]">
            {NEW_MENU_CLIS.map(({ cli, label }) => {
              // #80：未装灰置 + 「未安装」标注（标注形态沿用 PTY 项尾注先例），点击无效；fake/pty 恒可选不经探测
              const unavailable = isCliUnavailable(cliInstalled, cli);
              return (
                <button
                  key={cli}
                  type="button"
                  data-testid={`new-session-item-${cli}`}
                  disabled={unavailable}
                  title={unavailable ? CLI_NOT_INSTALLED_HINT : undefined}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs enabled:hover:bg-card disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    setMenuOpen(false);
                    actions.onCreateSession(cli, card);
                  }}
                >
                  <span aria-hidden className={`inline-block h-2 w-2 flex-none rounded-full ${CLI_DOT_CLS[cli]}`} />
                  {label}
                  {unavailable ? <span className="ml-auto text-[11px] text-fg-faint">未安装</span> : null}
                </button>
              );
            })}
            <button
              type="button"
              data-testid="new-session-item-pty"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-card"
              onClick={() => {
                setMenuOpen(false);
                actions.onCreateSession("pty", card);
              }}
            >
              <span aria-hidden className="inline-block h-2 w-2 flex-none rounded-full bg-pty" />
              PTY 终端
              <span className="ml-auto text-[11px] text-fg-faint">无 skill 信号</span>
            </button>
          </div>
        ) : null}
      </div>
      {/* 关联已有会话：仅列出当前项目未关联会话（原型一致项 4；选择即发起 link） */}
      <select
        data-testid="link-existing-select"
        aria-label="关联已有会话"
        className="rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground"
        value=""
        onChange={(e) => {
          const v = e.currentTarget.value;
          if (v) linkExisting(v); // 选择后即复位占位项（可再次选择）
        }}
      >
        <option value="">关联已有会话…（仅列出当前项目未关联会话）</option>
        {candidates.map((s) => (
          <option key={s.sessionId} value={s.sessionId}>
            {optionLabel(s)}
          </option>
        ))}
      </select>
      {/* link 拒绝原因直达呈现（已关联他卡/跨项目/无项目会话；成功即清除） */}
      {rejectReason ? (
        <p data-testid="link-reject-reason" className="rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          ⚠ {rejectReason}
        </p>
      ) : null}
    </section>
  );
}
