// 用途：Adapter 事件流接线（#9）—— 出站 zod 校验 + session_status/turn_started 会话落库 + SkillObservation 进 TrackerEngine（stage_events 幂等落库 + 状态机驱动）+ 转发 renderer；从 index.ts 提取为可单测的纯接线
import { adapterEventSchema, type AdapterEvent } from "@kanban/ipc-schema";
import type { TrackerEngine } from "@kanban/tracker";
import type { SessionStore } from "./session-store";

export interface AdapterEventDeps {
  sessions: SessionStore;
  engine: TrackerEngine;
  /** 事件转发（窗口 webContents.send；窗口不在由调用方丢弃） */
  send(event: AdapterEvent): void;
}

/** 构造 adapter.subscribe 的处理器：ChatEvent 落会话库、SkillObservation 进 tracker、全部事件转发 renderer；任何失败只记日志不抛出（不打断 adapter 事件泵，spec H 不崩溃） */
export function createAdapterEventHandler(deps: AdapterEventDeps): (event: AdapterEvent) => void {
  return (event) => {
    try {
      adapterEventSchema.parse(event); // 出站也过 schema 校验（spec E，廉价全量）；不合契约的事件丢弃并记日志
    } catch (err) {
      console.error("[kanban] 事件不符合契约，已丢弃", err);
      return;
    }
    if ("type" in event) {
      // 会话状态与活跃时间随事件流落库（sessions 表，重启恢复依据）
      if (event.type === "session_status") deps.sessions.updateStatus(event.sessionId, event.status);
      else if (event.type === "turn_started") deps.sessions.touch(event.sessionId, new Date().toISOString());
    } else {
      // SkillObservation → Engine：校验 + tracker 状态机 + stage_events 落库（同 eventId 重放幂等）
      try {
        deps.engine.process(event);
      } catch (err) {
        console.error("[kanban] tracker 事件处理失败", err); // 落库/校验失败不阻断消息流转发
      }
    }
    deps.send(event);
  };
}
