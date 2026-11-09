// 用途：tool-path-extract 提取器的密封测试——按三 CLI 真实事件形状（argsSummary/output 构造见各 adapter 源码）断言纯函数提取结果
import { describe, expect, it } from "vitest";
import { extractToolFilePaths, normalizePathForCompare } from "./tool-path-extract";

// Claude：tool_started.argsSummary = safeJson(block.input)（claude-adapter.ts L419）
describe("extractToolFilePaths：Claude JSON 参数摘要", () => {
  it("Read 工具：JSON file_path 字段值被提取", () => {
    const argsSummary = JSON.stringify({ file_path: "C:\\tmp\\kb-probe\\seed.txt" });
    const got = extractToolFilePaths({ tool: "Read", argsSummary, output: "" });
    expect(got).toContain("C:\\tmp\\kb-probe\\seed.txt");
  });

  it("Write/Edit 工具：JSON file_path 优先于内容噪声", () => {
    const argsSummary = JSON.stringify({
      file_path: "C:\\tmp\\kb-probe\\out\\new-file.md",
      content: "正文提及另一个路径 C:\\Windows\\system32\\cmd.exe 但不是操作目标",
    });
    const got = extractToolFilePaths({ tool: "Write", argsSummary, output: "" });
    expect(got[0]).toBe("C:\\tmp\\kb-probe\\out\\new-file.md");
  });

  it("Bash 工具：command 字符串内引号包裹的绝对路径被提取", () => {
    const argsSummary = JSON.stringify({ command: 'echo a > "C:\\tmp\\kb-probe\\probe-f1.txt"' });
    const got = extractToolFilePaths({ tool: "Bash", argsSummary, output: "" });
    expect(got.some((p) => p.toLowerCase().includes("probe-f1.txt"))).toBe(true);
  });
});

// Codex：commandExecution.argsSummary = 裸命令串（codex-adapter.ts L639）；fileChange = paths 逗号连接 / "apply patch"（L643），completed.output = safeJson(changes)（L672）
describe("extractToolFilePaths：Codex 形状", () => {
  it("commandExecution：裸命令串（非 JSON）内引号路径被提取", () => {
    const argsSummary = 'echo a > "C:\\tmp\\kb-probe\\probe-f1.txt"';
    const got = extractToolFilePaths({ tool: "commandExecution", argsSummary, output: "" });
    expect(got.some((p) => normalizePathForCompare(p) === normalizePathForCompare("C:\\tmp\\kb-probe\\probe-f1.txt"))).toBe(true);
  });

  it("fileChange：argsSummary 为逗号连接的多路径列表", () => {
    const got = extractToolFilePaths({ tool: "fileChange", argsSummary: "src/app.ts, src/lib/util.ts", output: "[]" });
    expect(got).toContain("src/app.ts");
    expect(got).toContain("src/lib/util.ts");
  });

  it("fileChange：output JSON changes 数组的 path 字段被提取（apply patch 摘要兜底）", () => {
    const output = JSON.stringify([{ path: "docs/notes.md", kind: "add", diff: "--- a/docs/notes.md\n+++ b/docs/notes.md\n+hello" }]);
    const got = extractToolFilePaths({ tool: "fileChange", argsSummary: "apply patch", output });
    expect(got).toContain("docs/notes.md");
  });

  it("commandExecution output 混合退出码前缀时仍能提取路径", () => {
    const output = '[exit 1] Get-Content "C:\\tmp\\kb-probe\\seed.txt" : 找不到路径';
    const got = extractToolFilePaths({ tool: "commandExecution", argsSummary: "", output });
    expect(got.some((p) => p.toLowerCase().endsWith("seed.txt"))).toBe(true);
  });
});

// OpenCode：read/write/edit 摘要 = filePath 直出（describeToolArgs，opencode-adapter.ts L1018）；bash = command 直出
describe("extractToolFilePaths：OpenCode 形状", () => {
  it("read 工具：argsSummary 即裸路径字符串", () => {
    const got = extractToolFilePaths({ tool: "read", argsSummary: "C:\\tmp\\kb-probe\\seed.txt", output: "1→ASK-TIER-PROBE" });
    expect(got.some((p) => p.toLowerCase().endsWith("seed.txt"))).toBe(true);
  });

  it("bash 工具：命令串内相对重定向路径被提取（无绝对路径时相对 token 兜底）", () => {
    const got = extractToolFilePaths({ tool: "bash", argsSummary: "echo a > out/probe-f1.txt", output: "" });
    expect(got).toContain("out/probe-f1.txt");
  });

  it("write 工具：JSON filePath 正斜杠形态被提取", () => {
    const argsSummary = '{"filePath":"C:/tmp/kb-probe/notes/new-file.md"}';
    const got = extractToolFilePaths({ tool: "write", argsSummary, output: "" });
    expect(got.some((p) => normalizePathForCompare(p).endsWith("new-file.md"))).toBe(true);
  });
});

// 边界与降级：URL 排除、空输入、纯文本无路径
describe("extractToolFilePaths：边界", () => {
  it("空输入返回空数组", () => {
    expect(extractToolFilePaths({ tool: "Read", argsSummary: "", output: "" })).toEqual([]);
  });

  it("URL 不算路径", () => {
    const got = extractToolFilePaths({ tool: "WebFetch", argsSummary: "https://example.com/docs/readme.md", output: "" });
    expect(got).toEqual([]);
  });

  it("普通对话文本无路径时返回空数组", () => {
    expect(extractToolFilePaths({ tool: "Read", argsSummary: "用户问了单元测试的概念", output: "回答文本" })).toEqual([]);
  });
});
