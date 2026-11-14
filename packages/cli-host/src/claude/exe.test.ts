// 用途：claude PATH 采纳谓词表驱动直测（arch D4）—— win32/posix × 后缀形态全组合纯函数验证（平台为显式入参，win32 本机可钉住 posix 分支）；另验链声明把 pathLookup 行统一经该谓词出口（resolve 首个采纳行与并集同条件）
import { describe, expect, it } from "vitest";
import { adoptClaudePathLine, listClaudeExeCandidates, resolveClaudeExe } from "./exe";

describe("adoptClaudePathLine（平台感知采纳谓词单源）", () => {
  it.each([
    // [平台, where/which 行, 期望采纳]
    ["win32", "C:\\tools\\claude.exe", true],
    ["win32", "C:\\tools\\CLAUDE.EXE", true], // 大小写不敏感
    ["win32", "/usr/local/bin/claude", false], // 无扩展名：win32 不采纳
    ["win32", "C:\\shim\\claude.cmd", false], // .cmd shim：两平台都不采纳
    ["win32", "C:\\tools\\claude.bat", false], // 其他后缀：win32 只认 .exe
    ["win32", "C:\\tools\\claude.ps1", false],
    ["linux", "/usr/local/bin/claude", true], // posix 无扩展名原生可执行可采纳（arch D4 修复点）
    ["linux", "/usr/local/bin/claude.exe", true], // posix 判据是「非 .cmd」，名为 .exe 也采纳
    ["linux", "/usr/bin/claude.cmd", false],
    ["linux", "/usr/bin/claude.sh", true], // 其他后缀非 .cmd：采纳（对齐 opencode posix 形态）
    ["darwin", "/opt/homebrew/bin/claude", true],
  ] as const)("platform=%s line=%s → 采纳 %s", (platform, line, expected) => {
    expect(adoptClaudePathLine(platform, line)).toBe(expected);
  });
});

describe("claude 链 PATH 兜底接线（resolve 与并集同一谓词出口）", () => {
  it("pathLookup 行按平台谓词统一过滤：resolve 命中首个采纳行、并集全收采纳行", () => {
    const lines = ["/usr/local/bin/claude", "C:\\tools\\claude.exe", "C:\\shim\\claude.cmd"];
    // 期望值直接由谓词推导：本测试钉「链出口与谓词一致」，谓词本身由上方表驱动钉死
    const adopted = lines.filter((line) => adoptClaudePathLine(process.platform, line));
    // manualOverride: null 满足弱类型公共属性要求（真实语义：无手动覆盖）
    const probes = { manualOverride: null, npmRoot: () => "C:\\definitely\\missing", pathLookup: () => lines };
    expect(resolveClaudeExe(probes)).toBe(adopted[0]);
    expect(listClaudeExeCandidates(probes)).toEqual(adopted);
  });
});
