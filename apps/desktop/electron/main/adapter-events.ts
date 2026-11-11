// 用途：Adapter 事件流接线（#9；#16 起在 SkillObservation 分支注入会话项目，#17 起把 tracker 变更经 sendChange 推送 renderer，#53 起诊断走统一日志，#70 起 ChatEvent 落库/迟到守卫经 store.applyEvent 一次收口）—— 出站 zod 校验 + 会话落库 + SkillObservation 进 TrackerEngine（stage_events 幂等落库 + 状态机驱动）+ 转发 renderer；从 index.ts 提取为可单测的纯接线
import { adapterEventSchema, type AdapterEvent } from "@kanban/ipc-schema";
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
  /** #53（spec #52 I 节）：诊断日志 —— 出站契约丢弃与 tracker 处理失败记 error；缺省 no-op 供旧测试（console 迁移至统一日志） */
  log?: LogFn;
}

/** 构造 adapter.subscribe 的处理器：ChatEvent 落会话库、SkillObservation 进 tracker、全部事件转发 renderer；任何失败只记日志不抛出（不打断 adapter 事件泵，spec H 不崩溃） */
export function createAdapterEventHandler(deps: AdapterEventDeps): (event: AdapterEvent) => void {
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
}
