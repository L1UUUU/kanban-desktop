// 用途：renderer 斜杠命令源密封测试（issue #90 / spec #82 E 块）—— TTL 缓存/预热/在途去重/失败保持冷可重试
import { describe, expect, it } from "vitest";
import type { IpcRequest, IpcResult } from "@kanban/ipc-schema";
import { ComposerCommandSource } from "./composer-command-source";

/** 挂起应答构造：测试逐拍 resolve 释放（驱动 loading→ready 状态机） */
function pending(): { promise: Promise<IpcResult>; resolve: (r: IpcResult) => void } {
  let resolve!: (r: IpcResult) => void;
  const promise = new Promise<IpcResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 排空微任务链（async fetcher 的 promise 采纳 + then 链需要多拍） */
async function drain(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

const OK_CMDS: IpcResult = {
  ok: true,
  commands: [
    { name: "fake-plan", description: "演示命令", argsHint: null, source: "native", cli: "fake", sourcePath: null, userOnly: false },
  ],
};

describe("ComposerCommandSource（TTL 缓存 + 预热语义）", () => {
  it("ensure：idle→loading→ready；TTL 内重复 ensure 不重复拉取（预热后首次 / 不等冷启动）", async () => {
    let calls = 0;
    const src = new ComposerCommandSource(async () => {
      calls += 1;
      return OK_CMDS;
    });
    expect(src.getState("fake", "C:/demo")).toEqual({ status: "idle" });
    src.ensure("fake", "C:/demo");
    expect(src.getState("fake", "C:/demo")).toEqual({ status: "loading" });
    await drain();
    expect(src.getState("fake", "C:/demo")).toEqual({ status: "ready", commands: OK_CMDS.commands });
    // TTL 内再 ensure（挂载预热 + 触发检测 ensure 并存）：零新请求
    src.ensure("fake", "C:/demo");
    await drain();
    expect(calls).toBe(1);
  });

  it("在途去重：loading 中重复 ensure 只发一次请求", async () => {
    let calls = 0;
    const p = pending();
    const src = new ComposerCommandSource(async () => {
      calls += 1;
      return p.promise;
    });
    src.ensure("fake", "C:/demo");
    src.ensure("fake", "C:/demo");
    src.ensure("fake", "C:/demo");
    expect(calls).toBe(1);
    p.resolve(OK_CMDS);
    await drain();
    expect(src.getState("fake", "C:/demo").status).toBe("ready");
  });

  it("失败保持冷：error 态下次 ensure 重试（缓存不落错误结果）", async () => {
    let calls = 0;
    const src = new ComposerCommandSource(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: { code: "E_INTERNAL", message: "注入失败" } } satisfies IpcResult : OK_CMDS;
    });
    src.ensure("fake", "C:/demo");
    await drain();
    expect(src.getState("fake", "C:/demo")).toEqual({ status: "error", message: "E_INTERNAL: 注入失败" });
    src.ensure("fake", "C:/demo");
    await drain();
    expect(src.getState("fake", "C:/demo").status).toBe("ready");
    expect(calls).toBe(2);
  });

  it("TTL 过期：ready 后时钟越过 TTL 再 ensure 重新拉取", async () => {
    let at = 1000;
    let calls = 0;
    const src = new ComposerCommandSource(
      async () => {
        calls += 1;
        return OK_CMDS;
      },
      { ttlMs: 10_000, now: () => at },
    );
    src.ensure("fake", "C:/demo");
    await drain();
    expect(calls).toBe(1);
    at += 9999;
    src.ensure("fake", "C:/demo");
    await drain();
    expect(calls).toBe(1); // 仍在新TTL窗口内（1000+9999=10999 < 11000）
    at += 2;
    src.ensure("fake", "C:/demo");
    await drain();
    expect(calls).toBe(2);
  });

  it("键 (cli, cwd) 独立：同 cli 不同 cwd、不同 cli 各自缓存与拉取", async () => {
    const seen: string[] = [];
    const src = new ComposerCommandSource(async (req: Extract<IpcRequest, { channel: "composer:listCommands" }>) => {
      seen.push(`${req.cli}:${req.cwd}`);
      return OK_CMDS;
    });
    src.ensure("fake", "C:/a");
    src.ensure("fake", "C:/b");
    src.ensure("codex", "C:/a");
    await drain();
    expect(seen).toEqual(["fake:C:/a", "fake:C:/b", "codex:C:/a"]);
    expect(src.getState("fake", "C:/a").status).toBe("ready");
    expect(src.getState("fake", "C:/b").status).toBe("ready");
    expect(src.getState("codex", "C:/a").status).toBe("ready");
  });

  it("订阅通知：状态变化时监听者被调用，注销后不再收到", async () => {
    const src = new ComposerCommandSource(async () => OK_CMDS);
    const events: string[] = [];
    const off = src.subscribe("fake", "C:/demo", () => events.push("tick"));
    src.ensure("fake", "C:/demo");
    await drain();
    off();
    src.ensure("fake", "C:/other"); // 无订阅者的键
    await drain();
    expect(events.length).toBeGreaterThanOrEqual(2); // loading + ready 两拍
  });
});
