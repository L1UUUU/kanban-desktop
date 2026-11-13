// 用途：Codex prompts 目录扫描测试（issue #89 / spec #82 E 块）—— 用户级 `<home>/.codex/prompts/*.md` + 项目级 `<cwd>/.codex/prompts/*.md`（~/.codex/prompts 为新地面：目录缺失返回空集不报错）；frontmatter description/argument-hint 映射统一条目；同名项目级覆盖用户级
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listCodexPromptCommands, expandCodexPromptCommand } from "./prompt-commands";

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

describe("expandCodexPromptCommand（#92 codex 客户端展开）", () => {
  it("frontmatter 剥离 + $ARGUMENTS 全量实参替换", () => {
    const file = "---\ndescription: 探针\nargument-hint: [说明]\n---\n目标：$ARGUMENTS，标记 KB-CODEX-PROMPT-EXECUTED";
    expect(expandCodexPromptCommand(file, "修登录bug")).toBe("目标：修登录bug，标记 KB-CODEX-PROMPT-EXECUTED");
  });

  it("位置参数 $1..$9：空白切分；缺位展开为空串", () => {
    expect(expandCodexPromptCommand("第一=$1 第二=$2 第三=$3", "alpha beta")).toBe("第一=alpha 第二=beta 第三=");
  });

  it("$@ 与 $ARGUMENTS 同义（全量实参）", () => {
    expect(expandCodexPromptCommand("全部：$@", "a b c")).toBe("全部：a b c");
  });

  it("无占位符且带实参：正文后空行追加实参（不静默丢参）", () => {
    expect(expandCodexPromptCommand("Reply with exactly this line.", "extra input")).toBe(
      "Reply with exactly this line.\n\nextra input",
    );
  });

  it("无占位符且无实参：仅正文；无 frontmatter 文件全文为正文；未闭合围栏按无围栏处理", () => {
    expect(expandCodexPromptCommand("---\ndescription: d\n---\n仅正文", "")).toBe("仅正文");
    expect(expandCodexPromptCommand("# 普通提示词\n正文两行", "")).toBe("# 普通提示词\n正文两行");
    expect(expandCodexPromptCommand("---\n未闭合\n正文", "x")).toBe("---\n未闭合\n正文\n\nx");
  });

  it("实参自身含 $1 不被二次展开（单趟替换）", () => {
    expect(expandCodexPromptCommand("值=$ARGUMENTS 后续=$1", "$1 raw")).toBe("值=$1 raw 后续=$1");
  });
});
