// 用途：Claude 同名 skill 检测纯函数单测（spec #15 E 节 / ticket #21）—— 交集检出（大小写不敏感）/仅单侧/空与缺失目录安全/文件混杂 + 用户级基准目录解析（CLAUDE_CONFIG_DIR 优先与 ~/.claude 回退）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSkillConflicts, resolveUserClaudeDir } from "./skill-conflicts";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 构造 fixture：返回项目根与用户级 Claude 基准目录（各自预建 skills 根，子目录名由调用方给出） */
function makeFixture(projectSkills: string[], userSkills: string[]): { projDir: string; userDir: string } {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-skill-conflict-"));
  const projDir = join(tmpRoot, "proj");
  const userDir = join(tmpRoot, "user-claude");
  for (const n of projectSkills) mkdirSync(join(projDir, ".claude", "skills", n), { recursive: true });
  for (const n of userSkills) mkdirSync(join(userDir, "skills", n), { recursive: true });
  return { projDir, userDir };
}

describe("detectSkillConflicts（项目 .claude/skills ∩ 用户级 skills）", () => {
  it("同名检出：交集名返回（项目侧命名），单侧独有不报", () => {
    const { projDir, userDir } = makeFixture(["design-feature", "proj-only"], ["design-feature", "user-only"]);
    expect(detectSkillConflicts(projDir, userDir)).toEqual(["design-feature"]);
  });

  it("大小写不敏感（Windows）：Review vs review 检出，返回项目侧目录名", () => {
    const { projDir, userDir } = makeFixture(["Review"], ["review"]);
    expect(detectSkillConflicts(projDir, userDir)).toEqual(["Review"]);
  });

  it("多冲突全部检出且排序稳定", () => {
    const { projDir, userDir } = makeFixture(["zeta", "alpha"], ["ALPHA", "Zeta"]);
    expect(detectSkillConflicts(projDir, userDir)).toEqual(["alpha", "zeta"]);
  });

  it("空目录（双侧 skills 根存在但无子目录）安全返回空数组", () => {
    const { projDir, userDir } = makeFixture([], []);
    expect(detectSkillConflicts(projDir, userDir)).toEqual([]);
  });

  it("目录缺失安全返回空数组：项目无 .claude / 用户级基准整体不存在", () => {
    const { projDir, userDir } = makeFixture([], ["design-feature"]); // 项目侧未建任何目录
    expect(detectSkillConflicts(projDir, userDir)).toEqual([]);
    const absent = join(tmpRoot, "absent-claude");
    expect(detectSkillConflicts(projDir, absent)).toEqual([]);
  });

  it("文件与嵌套不参与：skills 根下的普通文件被忽略，子目录内部不递归", () => {
    const { projDir, userDir } = makeFixture(["design-feature"], ["design-feature"]);
    // 双侧 skills 根混入普通文件（同名文件不得误报为冲突）
    writeFileSync(join(projDir, ".claude", "skills", "plain-file"), "");
    writeFileSync(join(userDir, "skills", "plain-file"), "");
    // 项目侧再放一个仅存在于用户侧文件形态的名字（文件 ≠ skill 目录）
    mkdirSync(join(projDir, ".claude", "skills", "file-only"), { recursive: true });
    writeFileSync(join(userDir, "skills", "file-only"), "");
    // 嵌套：项目 skill 子目录内的再下一级目录不递归（用户级无同名顶层目录 → 不冲突）
    mkdirSync(join(projDir, ".claude", "skills", "design-feature", "nested"), { recursive: true });
    expect(detectSkillConflicts(projDir, userDir)).toEqual(["design-feature"]);
  });
});

describe("resolveUserClaudeDir（用户级基准解析：CLAUDE_CONFIG_DIR 优先，否则 ~/.claude）", () => {
  it("CLAUDE_CONFIG_DIR 已设置：直接采用其值", () => {
    expect(resolveUserClaudeDir({ CLAUDE_CONFIG_DIR: "D:\\cfg\\claude" }, "C:\\home\\u")).toBe("D:\\cfg\\claude");
  });

  it("未设置或空白值：回退 ~/.claude（home 下 .claude）", () => {
    expect(resolveUserClaudeDir({}, "C:\\home\\u")).toBe(join("C:\\home\\u", ".claude"));
    expect(resolveUserClaudeDir({ CLAUDE_CONFIG_DIR: "   " }, "C:\\home\\u")).toBe(join("C:\\home\\u", ".claude"));
    expect(resolveUserClaudeDir({ CLAUDE_CONFIG_DIR: "" }, "C:\\home\\u")).toBe(join("C:\\home\\u", ".claude"));
  });
});
