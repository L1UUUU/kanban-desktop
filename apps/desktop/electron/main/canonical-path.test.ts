// 用途：canonical path 归一化测试 —— 大小写/斜杠/尾分隔符/不存在回退（工单 #7 验收：canonical path 注册去重的根基）
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePath } from "./canonical-path";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 建临时 fixture 根目录 */
function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-canonical-"));
  return tmpRoot;
}

describe("canonicalizePath", () => {
  it("尾分隔符与正反斜杠输入归一到同一 canonical 值", () => {
    const root = makeTmp();
    const dir = join(root, "proj");
    mkdirSync(dir);
    const a = canonicalizePath(dir);
    const b = canonicalizePath(dir + "\\");
    const forward = dir.split("\\").join("/");
    const c = canonicalizePath(forward);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("相对段（..）折叠到真实位置", () => {
    const root = makeTmp();
    const dir = join(root, "a", "b");
    mkdirSync(dir, { recursive: true });
    const dotted = join(root, "a", "x", "..", "b");
    expect(canonicalizePath(dotted)).toBe(canonicalizePath(dir));
  });

  it("win32：大小写差异归一（realpath.native 返回盘上真实大小写）", () => {
    const root = makeTmp();
    const dir = join(root, "ProjCase");
    mkdirSync(dir);
    const lowered = dir.toUpperCase();
    const upper = canonicalizePath(lowered);
    // 真实大小写应含 ProjCase 段（大小写不敏感比较同一位置）
    expect(upper.toLowerCase()).toBe(dir.toLowerCase());
    // 且注册去重比较成立：不同大小写输入 canonical 相等
    expect(canonicalizePath(dir)).toBe(upper);
  });

  it("不存在的路径回退 path.resolve（注册流程可继续，missing 态另行探测）", () => {
    const root = makeTmp();
    const missing = join(root, "no-such-dir");
    expect(canonicalizePath(missing)).toBe(resolve(missing));
  });
});
