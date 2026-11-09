// 用途：residue wire 契约测试 —— residue:ipc 二请求单通道联合 + 结果形状（业务拒绝 reason 模式，对齐 memory:ipc）+ kill 逐 pid 结果行（issue #49，spec #40 D/F 节）
import { describe, expect, it } from "vitest";
import { residueKillResultSchema, residueProcessSchema, residueRequestSchema, residueResultSchema } from "./residue";

/** 最小合法残留进程行（行形状测试基线） */
const processRow = {
  pid: 18432,
  exePath: "C:\\npm\\@openai\\codex\\codex.exe",
  startedAt: "2026-11-09T01:12:00.000Z",
  sessionTitle: "实现 Diff 解析",
};

describe("residueProcessSchema（残留进程行）", () => {
  it("合法对象 parse 后与输入等值；sessionTitle 可为 null（无会话记录）", () => {
    expect(residueProcessSchema.parse(processRow)).toEqual(processRow);
    expect(residueProcessSchema.parse({ ...processRow, pid: 2, sessionTitle: null }).sessionTitle).toBeNull();
  });

  it("非法形状被拒绝（pid 非正整数 / 空 exePath / startedAt 非字符串非 null / 缺字段）", () => {
    expect(() => residueProcessSchema.parse({ ...processRow, pid: 0 })).toThrow();
    expect(() => residueProcessSchema.parse({ ...processRow, exePath: "" })).toThrow();
    expect(() => residueProcessSchema.parse({ ...processRow, startedAt: 123 })).toThrow();
    const { pid: _omit, ...partial } = processRow;
    expect(() => residueProcessSchema.parse(partial)).toThrow();
  });
});

describe("residueRequestSchema（residue:ipc 二请求联合）", () => {
  it("residue:detect 无载荷合法；residue:kill 携带非空 pid 数组合法", () => {
    expect(residueRequestSchema.parse({ channel: "residue:detect" })).toEqual({ channel: "residue:detect" });
    const kill = residueRequestSchema.parse({ channel: "residue:kill", pids: [18432, 19004] });
    expect(kill).toEqual({ channel: "residue:kill", pids: [18432, 19004] });
  });

  it("未知通道与空 pid 数组被拒绝", () => {
    expect(() => residueRequestSchema.parse({ channel: "residue:purge" })).toThrow();
    expect(() => residueRequestSchema.parse({ channel: "residue:kill", pids: [] })).toThrow();
    expect(() => residueRequestSchema.parse({ channel: "residue:kill", pids: [-1] })).toThrow();
  });
});

describe("residueResultSchema（检测清单与 kill 逐 pid 结果）", () => {
  it("detect 成功携带 processes；kill 成功携带逐 pid killed/failed 结果", () => {
    const detect = residueResultSchema.parse({ ok: true, processes: [processRow] });
    expect(detect).toEqual({ ok: true, processes: [processRow] });
    const kill = residueResultSchema.parse({
      ok: true,
      results: [
        { pid: 18432, status: "killed" },
        { pid: 19004, status: "failed", error: "taskkill 退出码 5：拒绝访问" },
      ],
    });
    expect(kill.ok).toBe(true);
  });

  it("业务拒绝：ok:false + reason（退出门闸/入站不合法）", () => {
    const r = residueResultSchema.parse({ ok: false, reason: "shutting-down" });
    expect(r).toEqual({ ok: false, reason: "shutting-down" });
    expect(() => residueResultSchema.parse({ ok: false })).toThrow();
  });

  it("kill 结果行 status 闭枚举外被拒绝", () => {
    expect(() => residueKillResultSchema.parse({ pid: 1, status: "maybe" })).toThrow();
  });
});
