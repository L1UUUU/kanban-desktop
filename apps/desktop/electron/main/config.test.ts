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
  it("文件不存在 → 返回默认配置（三 CLI exe 均为 null 占位）", () => {
    const dir = newTempDir();
    expect(loadConfig(join(dir, "config.json"))).toEqual(defaultConfig());
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
    saveConfig(path, { cliExe: { codex: "C:/codex.exe", claude: null, opencode: "C:/oc.exe" } });
    expect(loadConfig(path).cliExe).toEqual({ codex: "C:/codex.exe", claude: null, opencode: "C:/oc.exe" });
  });
});

describe("detectCliExe（探测占位）", () => {
  it("返回三 CLI null 占位形状（真实探测由后续 Adapter 工单接入，spec G）", () => {
    expect(detectCliExe()).toEqual({ codex: null, claude: null, opencode: null });
  });
});
