// 用途：应用配置加载/保存单元测试 —— 默认值（三 CLI exe 占位 null）、缺失/损坏回退、往返与部分合并
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, detectCliExe, loadConfig, saveConfig } from "./config";

const tempDirs: string[] = [];

// 用途：每用例独立临时目录，避免相互污染
function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-config-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("文件不存在 → 返回默认配置（三 CLI exe 均为 null 占位、无当前项目）", () => {
    const dir = newTempDir();
    expect(loadConfig(join(dir, "config.json"))).toEqual(defaultConfig());
    expect(defaultConfig().currentProjectId).toBeNull();
  });

  it("currentProjectId：合法往返；非法类型回退 null", () => {
    const dir = newTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ currentProjectId: "p-1" }), "utf8");
    expect(loadConfig(join(dir, "config.json")).currentProjectId).toBe("p-1");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ currentProjectId: 42 }), "utf8");
    expect(loadConfig(join(dir, "config.json")).currentProjectId).toBeNull();
  });

  it("损坏 JSON → 回退默认配置", () => {
    const dir = newTempDir();
    writeFileSync(join(dir, "config.json"), "{oops", "utf8");
    expect(loadConfig(join(dir, "config.json"))).toEqual(defaultConfig());
  });

  it("部分字段 → 与默认值合并（手动覆盖保留、未覆盖为 null）", () => {
    const dir = newTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ cliExe: { codex: "C:/codex.exe" } }), "utf8");
    const cfg = loadConfig(join(dir, "config.json"));
    expect(cfg.cliExe.codex).toBe("C:/codex.exe");
    expect(cfg.cliExe.claude).toBeNull();
    expect(cfg.cliExe.opencode).toBeNull();
  });

  it("非法类型字段 → 该字段回退默认（不信任文件里的数字/对象）", () => {
    const dir = newTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ cliExe: { codex: 123, claude: {} } }), "utf8");
    const cfg = loadConfig(join(dir, "config.json"));
    expect(cfg.cliExe.codex).toBeNull();
    expect(cfg.cliExe.claude).toBeNull();
  });
});

describe("saveConfig / loadConfig 往返", () => {
  it("save 后 load 得到等值配置（含父目录自动创建）", () => {
    const dir = newTempDir();
    const path = join(dir, "nested", "config.json");
    saveConfig(path, { cliExe: { codex: "C:/codex.exe", claude: null, opencode: "C:/oc.exe" }, currentProjectId: "p-9", gitExe: null, diff: { maxBytes: 4096, maxFiles: 5, maxUntrackedLines: 10 }, terminal: { shell: null }, shutdown: { graceMs: 3000 } });
    const loaded = loadConfig(path);
    expect(loaded.cliExe).toEqual({ codex: "C:/codex.exe", claude: null, opencode: "C:/oc.exe" });
    expect(loaded.currentProjectId).toBe("p-9");
    expect(loaded.diff).toEqual({ maxBytes: 4096, maxFiles: 5, maxUntrackedLines: 10 });
  });
});

describe("detectCliExe（探测占位）", () => {
  it("返回三 CLI null 占位形状（真实探测由后续 Adapter 工单接入，spec G）", () => {
    expect(detectCliExe()).toEqual({ codex: null, claude: null, opencode: null });
  });
});

describe("gitExe（#43 git 可执行手动覆盖：where 探测之上的最高优先）", () => {
  it("默认 null（未覆盖 → 走 where 探测）；合法字符串往返；非法类型回退 null", () => {
    expect(defaultConfig().gitExe).toBeNull();
    const dir = newTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ gitExe: "C:/Program Files/Git/bin/git.exe" }), "utf8");
    expect(loadConfig(path).gitExe).toBe("C:/Program Files/Git/bin/git.exe");
    writeFileSync(path, JSON.stringify({ gitExe: 123 }), "utf8");
    expect(loadConfig(path).gitExe).toBeNull();
    writeFileSync(path, JSON.stringify({ gitExe: "" }), "utf8");
    expect(loadConfig(path).gitExe).toBeNull();
  });
});


describe("diff 截断上限配置（#47，spec #40 E 节/F8：三类上限数值进配置不硬编码）", () => {
  it("默认 maxBytes=2_000_000 / maxFiles=200 / maxUntrackedLines=2000；合法值逐字段透传", () => {
    expect(defaultConfig().diff).toEqual({ maxBytes: 2_000_000, maxFiles: 200, maxUntrackedLines: 2000 });
    const dir = newTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ diff: { maxBytes: 4096, maxFiles: 5, maxUntrackedLines: 10 } }), "utf8");
    expect(loadConfig(path).diff).toEqual({ maxBytes: 4096, maxFiles: 5, maxUntrackedLines: 10 });
  });

  it("非法值（非整数/非正/超防御上限）逐字段回退默认；缺节保持默认", () => {
    const dir = newTempDir();
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ diff: { maxBytes: 1.5, maxFiles: 0, maxUntrackedLines: 9e99 } }), "utf8");
    expect(loadConfig(path).diff).toEqual(defaultConfig().diff);
    writeFileSync(path, JSON.stringify({ diff: "nope" }), "utf8");
    expect(loadConfig(path).diff).toEqual(defaultConfig().diff);
    writeFileSync(path, JSON.stringify({ diff: { maxFiles: 3 } }), "utf8");
    const partial = loadConfig(path).diff;
    expect(partial.maxFiles).toBe(3);
    expect(partial.maxBytes).toBe(2_000_000); // 未覆盖字段保持默认（各字段独立合并）
  });
});

describe("退出序列配置（#13/spec H 参数进 config 不硬编码）", () => {
  it("缺省 graceMs=3000；合法值透传、非法值回退缺省", () => {
    const dir = newTempDir();
    const path = join(dir, "config.json");
    expect(defaultConfig().shutdown.graceMs).toBe(3000);
    writeFileSync(path, JSON.stringify({ shutdown: { graceMs: 1500 } }), "utf8");
    expect(loadConfig(path).shutdown.graceMs).toBe(1500);
    writeFileSync(path, JSON.stringify({ shutdown: { graceMs: -5 } }), "utf8");
    expect(loadConfig(path).shutdown.graceMs).toBe(3000);
    writeFileSync(path, JSON.stringify({ shutdown: { graceMs: "fast" } }), "utf8");
    expect(loadConfig(path).shutdown.graceMs).toBe(3000);
  });
});
