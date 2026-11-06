// 用途：JOB_GUARD_PS 脚本常量守卫测试 —— ASCII-only（PS 5.1 对无 BOM 文件按 ANSI 解析）与 KILL_ON_JOB_CLOSE 标志在场（t0-01 T1 语义锚点）
import { describe, expect, it } from "vitest";
import { JOB_GUARD_PS } from "./job-guard";

describe("JOB_GUARD_PS（Job guard 脚本常量）", () => {
  it("全 ASCII（无 BOM 写入时 PS 5.1 ANSI/Latin-1 解析等价，防中文注释炸解析）", () => {
    for (const ch of JOB_GUARD_PS) {
      expect(ch.charCodeAt(0)).toBeLessThanOrEqual(0x7f);
    }
  });

  it("KILL_ON_JOB_CLOSE（0x2000）与成员指派调用在场（t0-01 语义锚点）", () => {
    expect(JOB_GUARD_PS).toContain("0x2000");
    expect(JOB_GUARD_PS).toContain("AssignProcessToJobObject");
    expect(JOB_GUARD_PS).toContain("WaitForSingleObject");
  });
});
