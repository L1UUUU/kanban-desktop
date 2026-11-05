// 用途：可注入时钟 —— VirtualClock（虚拟时间，测试确定性推进）与 SystemClock（真实时间驱动，生产节奏），FakeAdapter 唯一时间来源
export interface FakeClock {
  /** 当前时间（ms；Virtual 为虚拟值，System 为 Date.now()） */
  now(): number;
  /** 注册延迟回调，返回取消函数 */
  schedule(delayMs: number, fn: () => void): () => void;
}

/** 虚拟时钟：advance 手动推进，到期回调按（到期时刻, 注册序）确定性触发 */
export class VirtualClock implements FakeClock {
  private nowMs: number;
  private seq = 0;
  private timers: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = [];

  constructor(startAtMs: number = Date.UTC(2026, 0, 1)) {
    this.nowMs = startAtMs;
  }

  now(): number {
    return this.nowMs;
  }

  schedule(delayMs: number, fn: () => void): () => void {
    const timer = { at: this.nowMs + delayMs, seq: this.seq++, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** 推进 byMs 虚拟时间，触发途中到期的回调（回调内再注册且已到期会同批处理） */
  advance(byMs: number): void {
    this.advanceTo(this.nowMs + byMs);
  }

  /** 推进到绝对时刻 */
  advanceTo(targetMs: number): void {
    for (;;) {
      const next = this.peek(targetMs);
      if (!next) {
        this.nowMs = Math.max(this.nowMs, targetMs);
        return;
      }
      this.nowMs = next.at;
      this.timers.splice(this.timers.indexOf(next), 1);
      next.fn(); // 回调内可能注册新定时器，循环继续
    }
  }

  /** 推进直到无待处理定时器（防死循环上限：1e6 轮） */
  runToIdle(): void {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const next = this.peek(Number.POSITIVE_INFINITY);
      if (!next) return;
      this.advanceTo(next.at);
    }
    throw new Error("VirtualClock.runToIdle 超过推进上限（可能存在自续定时器死循环）");
  }

  /** 待处理定时器数量（测试观测用） */
  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /** 窥视下一个到期回调（不弹出；按到期时刻、注册序） */
  private peek(targetMs: number) {
    let due: (typeof this.timers)[number] | null = null;
    for (const t of this.timers) {
      if (t.cancelled || t.at > targetMs) continue;
      if (!due || t.at < due.at || (t.at === due.at && t.seq < due.seq)) due = t;
    }
    return due;
  }
}

/** 生产时钟：内部 Virtual 队列 + setInterval 泵按真实时间触发（事件 at 戳取 Date.now()） */
export class SystemClock extends VirtualClock {
  private pumpTimer: ReturnType<typeof setInterval>;

  constructor(tickMs = 60) {
    super(Date.now());
    this.pumpTimer = setInterval(() => this.advanceTo(Date.now()), tickMs);
  }

  now(): number {
    return Date.now();
  }

  /** 停泵（FakeAdapter 自持时钟时由 dispose 调用） */
  dispose(): void {
    clearInterval(this.pumpTimer);
  }
}
