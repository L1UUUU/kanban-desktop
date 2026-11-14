// 用途：one-shot 执行器密封测试（arch C3）—— node 自身替身直测合并后的 Windows 坑位清单骨架：stdout/stderr 回收、stdin 注入（含 undefined 不开管道）、超时 kill 记 verdict（resolve 收口）、handle 取消、启动失败 reject、输出封顶截断、stderr 留痕（tag + slice 400）
import { describe, expect, it } from "vitest";
import { OneShotSpawnError, spawnOneShot } from "./one-shot";

describe("spawnOneShot（node 替身直测）", () => {
  const base = { exe: process.execPath, cwd: process.cwd() } as const;

  it("自然退出：verdict=null、exitCode/stdout/stderr 完整回收、durationMs 非负", async () => {
    const { done } = spawnOneShot({
      ...base,
      args: ["-e", "process.stdout.write('out');process.stderr.write('err')"],
      stdin: "",
      timeoutMs: 15_000,
    });
    const r = await done;
    expect(r.verdict).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("err");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("非零退出：exitCode 如实回传（判定留在消费方）", async () => {
    const { done } = spawnOneShot({
      ...base,
      args: ["-e", "process.exit(3)"],
      stdin: "",
      timeoutMs: 15_000,
    });
    const r = await done;
    expect(r.exitCode).toBe(3);
    expect(r.verdict).toBeNull();
  });

  it("stdin 注入后关闭：子进程可完整读入再退出；undefined 不开 stdin 管道亦可运行", async () => {
    const a = await spawnOneShot({
      ...base,
      args: ["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.slice(0,5)))"],
      stdin: "这是一段很长的 prompt 输入",
      timeoutMs: 15_000,
    }).done;
    expect(a.stdout).toBe("这是一段很");

    const b = await spawnOneShot({ ...base, args: ["-e", "process.stdout.write('no-stdin')"], timeoutMs: 15_000 }).done;
    expect(b.stdout).toBe("no-stdin");
  });

  it("超时 kill：到点记 verdict=timeout 并以 resolve 收口（错误文案映射留在消费方）", { timeout: 20_000 }, async () => {
    const { done } = spawnOneShot({
      ...base,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      stdin: "",
      timeoutMs: 100,
    });
    const r = await done;
    expect(r.verdict).toBe("timeout");
  });

  it("handle 取消：置 verdict=cancelled 并 kill；终结后 cancel 幂等返回 false", { timeout: 20_000 }, async () => {
    const { done, handle } = spawnOneShot({
      ...base,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      stdin: "",
      timeoutMs: 30_000,
    });
    expect(handle.cancel()).toBe(true);
    const r = await done;
    expect(r.verdict).toBe("cancelled");
    expect(handle.cancel()).toBe(false);
  });

  it("启动失败：不存在的 exe reject OneShotSpawnError（message 带原始错误文本）", { timeout: 20_000 }, async () => {
    const { done } = spawnOneShot({
      exe: "kanban-definitely-nonexistent-exe",
      args: [],
      cwd: process.cwd(),
      stdin: "",
      timeoutMs: 15_000,
    });
    await expect(done).rejects.toBeInstanceOf(OneShotSpawnError);
    await expect(done).rejects.toMatchObject({ message: expect.stringContaining("kanban-definitely-nonexistent-exe") });
  });

  it("输出封顶：maxStreamChars 超出截断并带标注行；缺省不封顶", { timeout: 20_000 }, async () => {
    const capped = await spawnOneShot({
      ...base,
      args: ["-e", "process.stdout.write('x'.repeat(100))"],
      stdin: "",
      timeoutMs: 15_000,
      maxStreamChars: 10,
    }).done;
    expect(capped.stdout).toBe("xxxxxxxxxx\n[输出超限截断]");

    const uncapped = await spawnOneShot({
      ...base,
      args: ["-e", "process.stdout.write('y'.repeat(100))"],
      stdin: "",
      timeoutMs: 15_000,
    }).done;
    expect(uncapped.stdout).toBe("y".repeat(100));
  });

  it("stderr 留痕：kind=stderr、detail 带前缀标签且单条截到 400 字符", { timeout: 20_000 }, async () => {
    const logs: Array<[string, string]> = [];
    const { done } = spawnOneShot({
      ...base,
      args: ["-e", "process.stderr.write('e'.repeat(1000))"],
      stdin: "",
      timeoutMs: 15_000,
      log: (kind, detail) => logs.push([kind, detail]),
      logTag: "one-shot[test#t1]",
    });
    const r = await done;
    expect(r.stderr).toBe("e".repeat(1000)); // 留痕截断不影响完整回收
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const [kind, detail] of logs) {
      expect(kind).toBe("stderr");
      expect(detail.startsWith("one-shot[test#t1] ")).toBe(true);
      expect(detail.length).toBeLessThanOrEqual("one-shot[test#t1] ".length + 400);
    }
  });
});
