// 用途：三 CLI exe 解析链候选并集测试（#49 spec #40 F 节——残留检测的 exe 匹配粒度是全量候选路径并集，不只匹配本次解析出的单一路径）；探测子进程（npm root -g / where）经注入替换，LOCALAPPDATA 经 env 重定向到临时目录，密封可测且不触碰真实系统路径
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeExeCandidates } from "./claude/exe";
import { listCodexExeCandidates } from "./codex/exe";
import { listOpenCodeExeCandidates } from "./opencode/exe";

// 临时目录统一登记清理（含重定向的 LOCALAPPDATA 根）
const tmpRoots: string[] = [];
afterEach(() => {
  for (const p of tmpRoots.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** 在临时 npm 全局根下造一个存在指定相对路径的文件，返回该根 */
function makeNpmRoot(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "kb-exe-cand-"));
  tmpRoots.push(root);
  for (const rel of files) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "", "utf8");
  }
  return root;
}

const norm = (p: string): string => p.toLowerCase().replace(/\//g, "\\");

describe("listCodexExeCandidates（codex 解析链候选并集）", () => {
  it("manualOverride + env + npm 全局 vendored 深路径全部入并集（存在才收、去重）", () => {
    const root = makeNpmRoot([
      join("@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      join("env", "codex.exe"),
    ]);
    const vendored = join(root, "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    const envExe = join(root, "env", "codex.exe");
    process.env.KANBAN_CODEX_BIN = envExe;
    try {
      const got = listCodexExeCandidates({ npmRoot: () => root, localVendoredExe: () => null });
      expect(got.map(norm)).toEqual([norm(envExe), norm(vendored)]);
    } finally {
      delete process.env.KANBAN_CODEX_BIN;
    }
    // manualOverride 与 vendored 同路径：去重只留一份（env 已清除不再混入）
    const manual = listCodexExeCandidates({ manualOverride: vendored, npmRoot: () => root, localVendoredExe: () => null });
    expect(manual.map(norm)).toEqual([norm(vendored)]);
  });

  it("路径不存在的 manualOverride 不入并集（与 resolveCodexExe 采纳条件一致）", () => {
    const got = listCodexExeCandidates({
      manualOverride: "C:\\fake\\manual-codex.exe",
      npmRoot: () => "C:\\definitely\\missing",
      localVendoredExe: () => null,
    });
    expect(got).toEqual([]);
  });
});

describe("listClaudeExeCandidates（claude 解析链候选并集）", () => {
  it("npm 全局 + where 多结果全部入并集（.cmd shim 不采用，与 resolveClaudeExe 同过滤）", () => {
    const root = makeNpmRoot([join("@anthropic-ai", "claude-code", "bin", "claude.exe")]);
    const npmExe = join(root, "@anthropic-ai", "claude-code", "bin", "claude.exe");
    const where1 = "C:\\tools\\claude.exe";
    const where2 = "C:\\other\\claude.exe";
    const got = listClaudeExeCandidates({
      npmRoot: () => root,
      pathLookup: () => [where1, "C:\\shim\\claude.cmd", where2],
    });
    expect(got.map(norm)).toEqual([norm(npmExe), norm(where1), norm(where2)]);
  });
});

describe("listOpenCodeExeCandidates（opencode 解析链候选并集）", () => {
  it("npm 全局 + 原生安装位 + where 多结果全部入并集（.cmd 不收、去重）", () => {
    const root = makeNpmRoot([join("opencode-ai", "bin", "opencode.exe")]);
    const npmExe = join(root, "opencode-ai", "bin", "opencode.exe");
    // LOCALAPPDATA 重定向到临时目录：原生安装位探测落在隔离环境内（不触碰真实系统路径）
    const fakeLocal = mkdtempSync(join(tmpdir(), "kb-exe-local-"));
    tmpRoots.push(fakeLocal);
    const native = join(fakeLocal, "Programs", "opencode", "opencode.exe");
    mkdirSync(join(native, ".."), { recursive: true });
    writeFileSync(native, "", "utf8");
    const prevLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = fakeLocal;
    try {
      const got = listOpenCodeExeCandidates({ npmRoot: () => root, pathLookup: () => [npmExe, "C:\\shim\\opencode.cmd"] });
      expect(got.map(norm)).toEqual([norm(npmExe), norm(native)]);
    } finally {
      if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocal;
    }
  });
});
