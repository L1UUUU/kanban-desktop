// 用途：Adapter 事件流接线（#9；#16 起在 SkillObservation 分支注入会话项目，#17 起把 tracker 变更经 sendChange 推送 renderer，#53 起诊断走统一日志，#70 起 ChatEvent 落库/迟到守卫经 store.applyEvent 一次收口，#95 起首轮 idle 触发一次性异步标题摘要并经 session:event 轻通道推送）—— 出站 zod 校验 + 会话落库 + SkillObservation 进 TrackerEngine（stage_events 幂等落库 + 状态机驱动）+ 转发 renderer；从 index.ts 提取为可单测的纯接线
import type { AdapterCapabilities, CliAdapter } from "@kanban/cli-host";
import { adapterEventSchema, type AdapterEvent, type ChatEvent, type SessionEventWire } from "@kanban/ipc-schema";
import type { TrackerChange, TrackerEngine } from "@kanban/tracker";
import type { LogFn } from "./logger";
import type { SessionStore } from "./session-store";

export interface AdapterEventDeps {
  sessions: SessionStore;
  engine: TrackerEngine;
  /** 事件转发（窗口 webContents.send；窗口不在由调用方丢弃） */
  send(event: AdapterEvent): void;
  /** #17：tracker 变更推送（webContents.send("tracker:event")；可选，缺省不推送供旧接线/测试） */
  sendChange?(change: TrackerChange): void;
  /** #95 / ADR 0003 摘要触发面（窄注入：CliAdapter 满足本面；可选，缺省不触发供旧接线/测试）；arch D3 起含能力位——capabilities.summarizeTitle=false 直接跳过尝试 */
  adapter?: Pick<CliAdapter, "summarizeTitle"> & { readonly capabilities: Pick<AdapterCapabilities, "summarizeTitle"> };
  /** #95：session:event 轻通道推送（摘要标题完成通知，schema 见 sessionEventSchema；可选，缺省写库不推送） */
  sendSessionEvent?(event: SessionEventWire): void;
  /** #53（spec #52 I 节）：诊断日志 —— 出站契约丢弃与 tracker 处理失败记 error；缺省 no-op 供旧测试（console 迁移至统一日志） */
  log?: LogFn;
}

/** 构造 adapter.subscribe 的处理器：ChatEvent 落会话库、SkillObservation 进 tracker、全部事件转发 renderer；任何失败只记日志不抛出（不打断 adapter 事件泵，spec H 不崩溃） */
export function createAdapterEventHandler(deps: AdapterEventDeps): (event: AdapterEvent) => void {
  // #95 / ADR 0003：本进程已尝试摘要的会话（免新列；含失败/null——同进程不重试，重启后靠 title_source 门控防重复）
  const attemptedSummary = new Set<string>();
  return (event) => {
    try {
      adapterEventSchema.parse(event); // 出站也过 schema 校验（spec E，廉价全量）；不合契约的事件丢弃并记日志
    } catch (err) {
      deps.log?.("error", "adapter", `事件不符合契约，已丢弃：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // ChatEvent 面：#58/#62 迟到守卫 + 状态/活跃时间落库一次收口（store.applyEvent，#70 C2）——
    // dropped（已归档/已删除）不写库、不转发 renderer（杜绝幽灵行）；session_error 等其余 ChatEvent（#41）守卫放行但零写入
    if ("type" in event) {
      if (deps.sessions.applyEvent(event, new Date().toISOString()) === "dropped") return;
      maybeSummarize(event);
    } else {
      // SkillObservation：同守卫挡 tracker 与转发（projectId 注入与 tracker 接线是事件泵职责，不进 store）
      if (deps.sessions.shouldDropEvents(event.sessionId)) return;
      // SkillObservation → Engine：校验 + tracker 状态机 + stage_events 落库（同 eventId 重放幂等）
      // #16（spec #15 A 节注入点）：进 Engine 前按 sessions 表注入会话项目（Adapter 不感知；转发 renderer 的原始事件不带 projectId）
      // #17：引发的 TrackerChange 经 sendChange 推送 renderer（看板事件驱动刷新）
      try {
        const session = deps.sessions.get(event.sessionId);
        const { changes } = deps.engine.process({ ...event, projectId: session?.projectId ?? null });
        if (deps.sendChange) for (const c of changes) deps.sendChange(c);
      } catch (err) {
        deps.log?.("error", "adapter", `tracker 事件处理失败：${err instanceof Error ? err.message : String(err)}`); // 落库/校验失败不阻断消息流转发
      }
    }
    deps.send(event);
  };

  /**
   * #95 / ADR 0003 决策 2 摘要触发：idle 事件 + kind='structured' + title_source='derived' + 本进程未尝试 →
   * 异步一次性摘要（不阻塞事件泵）；返回非 null 经 store.applySummarizedTitle 门控写入（manual/已删行/竞态零命中），
   * 生效才经 session:event 推送；失败/超时/null 静默不重试（attemptedSummary 在调用前登记，含失败）。
   * arch D3：能力位先行——注入面 capabilities.summarizeTitle=false（opencode 形态）直接跳过，
   * 不逐会话白付往返后丢弃 null；有能力的面 attemptedSummary 登记行为不变。
   */
  function maybeSummarize(event: ChatEvent): void {
    const summarizer = deps.adapter;
    if (!summarizer || event.type !== "session_status" || event.status !== "idle") return;
    if (!summarizer.capabilities.summarizeTitle) return;
    if (attemptedSummary.has(event.sessionId)) return;
    const row = deps.sessions.get(event.sessionId);
    if (!row || row.kind !== "structured" || row.titleSource !== "derived") return;
    attemptedSummary.add(event.sessionId);
    summarizer
      .summarizeTitle(event.sessionId)
      .then((raw) => {
        const title = raw?.trim();
        if (!title) return; // null/空串：该会话无摘要素材或产出为空（无能力面已在能力位跳过），降级保留 fallback
        if (!deps.sessions.applySummarizedTitle(event.sessionId, title)) return; // 门控拒绝：竞态下已 manual/已删行
        deps.sendSessionEvent?.({ type: "title", sessionId: event.sessionId, title });
      })
      .catch((err) => {
        deps.log?.("error", "adapter", `会话标题摘要失败（静默不重试）：${err instanceof Error ? err.message : String(err)}`);
      });
  }
}
