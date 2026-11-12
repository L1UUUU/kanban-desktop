// 用途：Codex prompts 目录扫描测试（issue #89 / spec #82 E 块）—— 用户级 `<home>/.codex/prompts/*.md` + 项目级 `<cwd>/.codex/prompts/*.md`（~/.codex/prompts 为新地面：目录缺失返回空集不报错）；frontmatter description/argument-hint 映射统一条目；同名项目级覆盖用户级
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexPromptCommands } from "./prompt-commands";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function makeFixture(): { home: string; projectCwd: string } {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-prompt-cmd-"));
  return { home: join(tmpRoot, "home"), projectCwd: join(tmpRoot, "proj") };
}

function writePrompt(promptsRoot: string, fileName: string, content: string): string {
  mkdirSync(promptsRoot, { recursive: true });
  const file = join(promptsRoot, fileName);
  writeFileSync(file, content, "utf8");
  return file;
}

describe("listCodexPromptCommands（#89 codex 命令源）", () => {
  it("用户级与项目级合并：名称=文件名去 .md，frontmatter description/argument-hint 映射描述与参数提示", () => {
    const { home, projectCwd } = makeFixture();
    writePrompt(join(home, ".codex", "prompts"), "commit.md", "---\ndescription: 按规范生成提交信息\nargument-hint: [变更说明]\n---\n正文");
    writePrompt(join(projectCwd, ".codex", "prompts"), "review.md", "# 无 frontmatter 的普通提示词\n正文");
    const commands = listCodexPromptCommands(projectCwd, home);
    expect(commands).toHaveLength(2);
    expect(commands.find((c) => c.name === "commit")).toEqual({
      name: "commit",
      description: "按规范生成提交信息",
      argsHint: "[变更说明]",
      source: "user",
      cli: "codex",
      sourcePath: join(home, ".codex", "prompts", "commit.md"),
      userOnly: false,
    });
    const review = commands.find((c) => c.name === "review")!;
    expect(review.source).toBe("project");
    expect(review.description).toBe("");
    expect(review.argsHint).toBeNull();
  });

  it("同名 prompt 项目级覆盖用户级（大小写不敏感）", () => {
    const { home, projectCwd } = makeFixture();
    writePrompt(join(home, ".codex", "prompts"), "Commit.md", "---\ndescription: 用户级\n---\n");
    writePrompt(join(projectCwd, ".codex", "prompts"), "commit.md", "---\ndescription: 项目级\n---\n");
    const commands = listCodexPromptCommands(projectCwd, home);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "commit", description: "项目级", source: "project" });
  });

  it("目录缺失 → 空集不报错；非 .md 文件与子目录不参与", () => {
    const { home, projectCwd } = makeFixture(); // 均未创建
    expect(listCodexPromptCommands(projectCwd, home)).toEqual([]);
    const prompts = join(projectCwd, ".codex", "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "notes.txt"), "不是提示词", "utf8");
    mkdirSync(join(prompts, "sub"), { recursive: true });
    writeFileSync(join(prompts, "sub", "nested.md"), "---\ndescription: 嵌套\n---\n", "utf8");
    expect(listCodexPromptCommands(projectCwd, home)).toEqual([]);
  });
});
