// 用途：Claude skill 目录扫描测试（issue #89 / spec #82 E 块）—— 用户级 `<userClaudeDir>/skills/*` + 项目级 `<cwd>/.claude/skills/*` 读 SKILL.md frontmatter（名称/描述/仅用户调用标记）；同名项目级覆盖用户级；目录缺失/条目不可读安全降级
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listClaudeSkillCommands } from "./skill-commands";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 建 fixture 根（用户级基准目录 + 项目 cwd 两棵树） */
function makeFixture(): { userClaudeDir: string; projectCwd: string } {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-skill-cmd-"));
  return { userClaudeDir: join(tmpRoot, "claude-user"), projectCwd: join(tmpRoot, "proj") };
}

/** 写一个 skill 目录（SKILL.md 内容可省略 = 无文件的空目录） */
function writeSkill(skillsRoot: string, dirName: string, skillMd: string | null): string {
  const dir = join(skillsRoot, dirName);
  mkdirSync(dir, { recursive: true });
  if (skillMd !== null) writeFileSync(join(dir, "SKILL.md"), skillMd, "utf8");
  return dir;
}

describe("listClaudeSkillCommands（#89 claude 命令源）", () => {
  it("用户级与项目级合并：名称/描述/来源/来源文件路径/所属 CLI 全字段正确", () => {
    const { userClaudeDir, projectCwd } = makeFixture();
    writeSkill(join(userClaudeDir, "skills"), "daily-report", "---\nname: daily-report\ndescription: 生成日报\n---\n正文");
    writeSkill(join(projectCwd, ".claude", "skills"), "kb-probe-skill", "---\nname: kb-probe-skill\ndescription: 探针\n---\n正文");
    const commands = listClaudeSkillCommands(projectCwd, userClaudeDir);
    expect(commands).toHaveLength(2);
    const probe = commands.find((c) => c.name === "kb-probe-skill")!;
    expect(probe).toEqual({
      name: "kb-probe-skill",
      description: "探针",
      argsHint: null,
      source: "project",
      cli: "claude",
      sourcePath: join(projectCwd, ".claude", "skills", "kb-probe-skill", "SKILL.md"),
      userOnly: false,
    });
    expect(commands.find((c) => c.name === "daily-report")!.source).toBe("user");
    // 按名排序稳定（相邻名字单调不减）
    const names = commands.map((c) => c.name);
    for (let i = 1; i < names.length; i += 1) {
      expect(names[i - 1].toLowerCase() <= names[i].toLowerCase()).toBe(true);
    }
  });

  it("仅用户调用标记：disable-model-invocation: true → userOnly=true", () => {
    const { userClaudeDir, projectCwd } = makeFixture();
    writeSkill(join(userClaudeDir, "skills"), "manual-only", "---\nname: manual-only\ndescription: 仅用户\ndisable-model-invocation: true\n---\n");
    const commands = listClaudeSkillCommands(projectCwd, userClaudeDir);
    expect(commands).toHaveLength(1);
    expect(commands[0].userOnly).toBe(true);
  });

  it("同名 skill 项目级覆盖用户级（大小写不敏感）；frontmatter 缺 name 回落目录名", () => {
    const { userClaudeDir, projectCwd } = makeFixture();
    writeSkill(join(userClaudeDir, "skills"), "Shared", "---\nname: shared\ndescription: 用户级\n---\n");
    writeSkill(join(projectCwd, ".claude", "skills"), "shared", "---\ndescription: 项目级\n---\n"); // 无 name → 目录名 shared
    const commands = listClaudeSkillCommands(projectCwd, userClaudeDir);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "shared", description: "项目级", source: "project" });
  });

  it("目录缺失 → 空集不报错；无 SKILL.md 的目录跳过", () => {
    const { userClaudeDir, projectCwd } = makeFixture(); // 两棵目录树均未创建
    expect(listClaudeSkillCommands(projectCwd, userClaudeDir)).toEqual([]);
    writeSkill(join(projectCwd, ".claude", "skills"), "no-skill-md", null); // 目录在、SKILL.md 不在
    expect(listClaudeSkillCommands(projectCwd, userClaudeDir)).toEqual([]);
  });
});
