// 用途：VirtualClock 单测 —— 定序触发/取消/runToIdle（FakeAdapter 确定性的基石）
import { describe, expect, it } from "vitest";
import { VirtualClock } from "./clock";

describe("VirtualClock", () => {
  it("按到期时间顺序触发，同刻按注册顺序", () => {
    const clock = new VirtualClock(0);
    const fired: string[] = [];
    clock.schedule(200, () => fired.push("b"));
    clock.schedule(100, () => fired.push("a"));
    clock.schedule(100, () => fired.push("a2"));
    clock.advance(300);
    expect(fired).toEqual(["a", "a2", "b"]);
    expect(clock.now()).toBe(300);
  });

  it("advance 未到期的不触发；now 只前进", () => {
    const clock = new VirtualClock(0);
    let fired = 0;
    clock.schedule(1000, () => fired++);
    clock.advance(500);
    expect(fired).toBe(0);
    expect(clock.now()).toBe(500);
    clock.advance(100);
    expect(fired).toBe(0);
    expect(clock.now()).toBe(600);
    clock.advance(400);
    expect(fired).toBe(1);
  });

  it("回调内再注册的定时器会被后续 advance 处理", () => {
    const clock = new VirtualClock(0);
    const fired: string[] = [];
    clock.schedule(100, () => {
      fired.push("one");
      clock.schedule(50, () => fired.push("two"));
    });
    clock.advance(100);
    expect(fired).toEqual(["one"]);
    clock.advance(50);
    expect(fired).toEqual(["one", "two"]);
  });

  it("cancel 后不触发", () => {
    const clock = new VirtualClock(0);
    let fired = 0;
    const cancel = clock.schedule(100, () => fired++);
    cancel();
    clock.advance(200);
    expect(fired).toBe(0);
  });

  it("runToIdle 推进到无待处理定时器为止（含链式注册）", () => {
    const clock = new VirtualClock(0);
    let count = 0;
    const chain = () => {
      count++;
      if (count < 5) clock.schedule(10, chain);
    };
    clock.schedule(10, chain);
    clock.runToIdle();
    expect(count).toBe(5);
    expect(clock.pending()).toBe(0);
  });
});
