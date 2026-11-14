// 用途：turn 内核密封直测（arch C1）—— 回合状态机单源件的排队/终态/幂等中断/残留审批回调/死亡收尾/等死超时兜底，逐分支钉住事件序与队列策略
import { describe, expect, it } from "vitest";
import type { ChatEvent } from "@kanban/ipc-schema";
import { AdapterError } from "./adapter";
import {
  DEFAULT_STOP_TIMEOUT_MS,
  requireLiveSessionEntry,
  requireSessionEntry,
  stopAndAwaitExit,
  TurnKernel,
  type KernelApproval,
  type TurnState,
} from "./turn-kernel";

/** 测试用审批条目（扩展 wire 应答记录，验证残留回调透传原生条目） */
interface TestApproval extends KernelApproval {
  respondWire: string[];
}

/** 构造被测内核 + 广播收集（固定时间源获得确定性 at） */
function makeKernel() {
  const events: ChatEvent[] = [];
  let now = 1_000;
  const kernel = new TurnKernel<TestApproval>({
    broadcast: (ev) => events.push(ev),
    nowMs: () => now,
  });
  return {
    kernel,
    events,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** 构造内嵌回合状态的测试会话 */
function makeSession(id = "s-kernel"): TurnState<TestApproval> {
  return {
    sessionId: id,
    seq: 0,
    log: [],
    queue: [],
    turnActive: false,
    interruptRequested: false,
    pendingApprovals: new Map(),
  };
}

/** 挂一条待决审批（携带 wire 应答记录） */
function addApproval(s: TurnState<TestApproval>, requestId: string): TestApproval {
  const entry: TestApproval = { requestId, itemId: `item-${requestId}`, decided: false, respondWire: [] };
  s.pendingApprovals.set(requestId, entry);
  return entry;
}

describe("TurnKernel：emit 单源出口", () => {
  it("seq 严格单调、日志按序追加、广播逐条送达", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.emit(s, { type: "session_status", status: "idle" });
    kernel.emit(s, { type: "turn_started", turnId: "t-1" });
    kernel.emit(s, { type: "turn_completed" });
    expect(s.log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.log.map((e) => e.type)).toEqual(["session_status", "turn_started", "turn_completed"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.sessionId === "s-kernel")).toBe(true);
  });

  it("at 缺省走注入时间源；显式 at 覆盖（transcript 时间戳透传）", () => {
    const { kernel, advance } = makeKernel();
    const s = makeSession();
    kernel.emit(s, { type: "turn_started", turnId: "t-1" });
    expect(s.log[0].at).toBe(new Date(1_000).toISOString()); // 缺省来自 nowMs 注入（确定性时间源）
    advance(5_000);
    kernel.emit(s, { type: "turn_completed" });
    expect(s.log[1].at).toBe(new Date(6_000).toISOString()); // 时间源推进后跟随
    kernel.emit(s, { type: "session_status", status: "idle" }, "2020-01-01T00:00:00.000Z");
    expect(s.log[2].at).toBe("2020-01-01T00:00:00.000Z"); // 显式覆盖（原生历史回填时间戳透传）
  });
});

describe("TurnKernel：不变量 6 忙态排队", () => {
  it("空闲不入队（返回 false）；turn 进行中 FIFO 排队；待决审批非空同样排队", () => {
    const { kernel } = makeKernel();
    const s = makeSession();
    expect(kernel.enqueueIfBusy(s, "a")).toBe(false); // 空闲：由调用方直接开 turn
    kernel.beginTurn(s);
    expect(kernel.enqueueIfBusy(s, "b")).toBe(true);
    expect(kernel.enqueueIfBusy(s, "c")).toBe(true);
    expect(s.queue).toEqual(["b", "c"]);
    kernel.finishTurn(s, "failed"); // 丢弃排队
    s.turnActive = false;
    // 待决审批（turn 态之外的忙信号）：无 turnActive 也排队
    addApproval(s, "ap-1");
    expect(kernel.enqueueIfBusy(s, "d")).toBe(true);
    expect(s.queue).toEqual(["d"]);
  });

  it("beginTurn 置位 turnActive 并复位中断闸门", () => {
    const { kernel } = makeKernel();
    const s = makeSession();
    s.interruptRequested = true;
    kernel.beginTurn(s);
    expect(s.turnActive).toBe(true);
    expect(s.interruptRequested).toBe(false);
  });
});

describe("TurnKernel：requestInterrupt 幂等闸门", () => {
  it("无活动 turn 为 no-op（false）；活跃时首次 true、重复 false（wire 中断只打一次）", () => {
    const { kernel } = makeKernel();
    const s = makeSession();
    expect(kernel.requestInterrupt(s)).toBe(false); // 空闲
    kernel.beginTurn(s);
    expect(kernel.requestInterrupt(s)).toBe(true);
    expect(s.interruptRequested).toBe(true);
    expect(kernel.requestInterrupt(s)).toBe(false); // 幂等
    kernel.finishTurn(s, "interrupted");
    expect(kernel.requestInterrupt(s)).toBe(false); // 终态后空闲 no-op
  });

  it("仅待决审批（turn 态已结束的等待窗口）也可中断", () => {
    const { kernel } = makeKernel();
    const s = makeSession();
    addApproval(s, "ap-1");
    expect(kernel.requestInterrupt(s)).toBe(true);
  });
});

describe("TurnKernel：finishTurn 终态机", () => {
  it("completed：[turn_completed, session_status idle] 事件序 + 队首续发、余量保序", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.beginTurn(s);
    s.queue.push("第二 turn", "第三 turn");
    const sent: string[] = [];
    kernel.finishTurn(s, "completed", { sendQueuedTurn: (text) => sent.push(text) });
    expect(events.map((e) => `${e.type}:${(e as { status?: string }).status ?? ""}`)).toEqual([
      "turn_completed:",
      "session_status:idle",
    ]);
    expect(sent).toEqual(["第二 turn"]); // 只续发队首，余量等待后续终态
    expect(s.queue).toEqual(["第三 turn"]);
    expect(s.turnActive).toBe(false);
    expect(s.interruptRequested).toBe(false);
  });

  it("interrupted：丢弃排队、[turn_interrupted, session_status interrupted]、不续发", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.beginTurn(s);
    s.queue.push("排队消息");
    const sent: string[] = [];
    kernel.finishTurn(s, "interrupted", { sendQueuedTurn: (text) => sent.push(text) });
    const interrupted = events.find((e) => e.type === "turn_interrupted") as Extract<ChatEvent, { type: "turn_interrupted" }>;
    expect(interrupted.reason).toBe("user");
    expect(events.map((e) => e.type)).toEqual(["turn_interrupted", "session_status"]);
    expect(s.queue).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("failed：丢弃排队、只发 session_status idle、不宣称 turn_completed", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.beginTurn(s);
    s.queue.push("排队消息");
    kernel.finishTurn(s, "failed");
    expect(events.map((e) => e.type)).toEqual(["session_status"]);
    expect((events[0] as Extract<ChatEvent, { type: "session_status" }>).status).toBe("idle");
    expect(s.queue).toEqual([]);
  });

  it("残留审批收口：onResidue 在终态事件之前收到全部待决条目与终态分类，收口后 map 清空", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.beginTurn(s);
    const ap1 = addApproval(s, "ap-1");
    addApproval(s, "ap-2");
    const residues: Array<{ requestIds: string[]; status: string; eventCount: number }> = [];
    kernel.finishTurn(s, "interrupted", {
      onResidue: (st, status) => residues.push({ requestIds: [...st.pendingApprovals.values()].map((e) => e.requestId), status, eventCount: events.length }),
    });
    // onResidue 时点：终态事件尚未发射（eventCount=0）、map 仍持有全部条目、收到终态分类
    expect(residues).toEqual([{ requestIds: ["ap-1", "ap-2"], status: "interrupted", eventCount: 0 }]);
    expect(ap1.respondWire).toEqual([]); // wire 应答由消费方回调自行执行（内核不越界）
    expect(s.pendingApprovals.size).toBe(0);
  });
});

describe("TurnKernel：handleDeath 死亡收尾", () => {
  it("丢弃排队 + 复位回合态 + 逐条审批残留（先于 session_exit）+ [session_exit, session_status disconnected]", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.beginTurn(s);
    s.queue.push("排队消息");
    addApproval(s, "ap-1");
    addApproval(s, "ap-2");
    const residueOrder: string[] = [];
    const eventCountAtFirstResidue = { v: -1 };
    kernel.handleDeath(s, {
      exitCode: 127,
      reason: "claude 进程已退出",
      onApprovalResidue: (entry) => {
        if (eventCountAtFirstResidue.v < 0) eventCountAtFirstResidue.v = events.length;
        residueOrder.push(entry.requestId);
      },
    });
    expect(residueOrder).toEqual(["ap-1", "ap-2"]);
    expect(eventCountAtFirstResidue.v).toBe(0); // 残留收口先于 session_exit 事件
    const exit = events.find((e) => e.type === "session_exit") as Extract<ChatEvent, { type: "session_exit" }>;
    expect(exit.exitCode).toBe(127);
    expect(exit.reason).toBe("claude 进程已退出");
    expect((events.at(-1) as Extract<ChatEvent, { type: "session_status" }>).status).toBe("disconnected");
    expect(s.queue).toEqual([]);
    expect(s.turnActive).toBe(false);
    expect(s.pendingApprovals.size).toBe(0);
  });
});

describe("TurnKernel：resetForResume 与查证助手", () => {
  it("resetForResume：回合态/排队/中断闸门一并复位（不发事件）", () => {
    const { kernel, events } = makeKernel();
    const s = makeSession();
    kernel.beginTurn(s);
    s.queue.push("排队");
    s.interruptRequested = true;
    kernel.resetForResume(s);
    expect([s.turnActive, s.queue.length, s.interruptRequested]).toEqual([false, 0, false]);
    expect(events).toEqual([]);
  });

  it("requireSessionEntry：不存在抛 E_SESSION_NOT_FOUND（消息含会话 id）", () => {
    const sessions = new Map<string, { v: number }>();
    sessions.set("s-1", { v: 1 });
    expect(requireSessionEntry(sessions, "s-1").v).toBe(1);
    expect(() => requireSessionEntry(sessions, "nope")).toThrowError(AdapterError);
    expect(() => requireSessionEntry(sessions, "nope")).toThrow(/会话不存在：nope/);
  });

  it("requireLiveSessionEntry：不存在 E_SESSION_NOT_FOUND；dead 命中 E_INTERNAL（deadLabel 模板）；live 放行", () => {
    const sessions = new Map<string, { dead: boolean }>();
    sessions.set("s-live", { dead: false });
    sessions.set("s-dead", { dead: true });
    expect(requireLiveSessionEntry(sessions, "s-live", (s) => s.dead, "Claude 进程已退出").dead).toBe(false);
    expect(() => requireLiveSessionEntry(sessions, "nope", (s) => s.dead, "X")).toThrowError(AdapterError);
    const err = (() => {
      try {
        requireLiveSessionEntry(sessions, "s-dead", (s) => s.dead, "Codex 进程已退出");
        return null;
      } catch (e) {
        return e as AdapterError;
      }
    })();
    expect(err?.code).toBe("E_INTERNAL");
    expect(err?.message).toBe("Codex 进程已退出，会话已断开（请读取原生历史恢复或新建会话）");
  });
});

describe("stopAndAwaitExit：受控终止等死（可注入超时）", () => {
  /** 可控假客户端：stop 是否触发 onDead 由测试决定 */
  function makeClient(diesOnStop: boolean) {
    const deadFns = new Set<(err: Error) => void>();
    return {
      onDead(fn: (err: Error) => void) {
        deadFns.add(fn);
        return () => deadFns.delete(fn);
      },
      stop() {
        if (diesOnStop) for (const fn of deadFns) fn(new Error("exit"));
      },
    };
  }

  it("正常路径：onDead 先到立即返回（不等满超时）", async () => {
    const client = makeClient(true);
    const startedAt = Date.now();
    await stopAndAwaitExit(client, DEFAULT_STOP_TIMEOUT_MS);
    expect(Date.now() - startedAt).toBeLessThan(1_000); // 未吃满 3s 兜底
  });

  it("超时兜底：stop 后进程僵死（无 onDead）时到期放行，不永久挂起", async () => {
    const client = makeClient(false); // stop 不触发死亡：模拟僵死进程
    const startedAt = Date.now();
    await stopAndAwaitExit(client, 30); // 注入缩小超时，密封直测兜底分支
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });
});
