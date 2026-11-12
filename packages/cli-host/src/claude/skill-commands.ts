// 用途：Claude skill 命令源扫描（issue #89 / spec #82 E 块）—— 用户级 `<userClaudeDir>/skills/*` + 项目级 `<cwd>/.claude/skills/*` 读各 SKILL.md frontmatter（名称/描述/仅用户调用标记），产出统一命令条目；目录解析知识复用 skill-conflicts 模式（任何读取失败安全降级，列举是提示性能力不报错）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandEntry } from "@kanban/ipc-schema";
import { parseFrontmatter } from "../frontmatter";

/** 读取目录下的一级子目录名（目录缺失/不可读 → 空数组：skill-conflicts.ts 同款安全降级） */
function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 单个 skill 目录 → 统一条目（SKILL.md 缺失/不可读/无 frontmatter 均可列出：name 回落目录名、description 空；读取异常跳过该条） */
function scanSkillDir(skillsRoot: string, source: "user" | "project"): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const dirName of listSubdirs(skillsRoot)) {
    const skillMd = join(skillsRoot, dirName, "SKILL.md");
    let text: string;
    try {
      text = readFileSync(skillMd, "utf8");
    } catch {
      continue; // 无 SKILL.md / 不可读：不是可调用 skill，跳过
    }
    const fm = parseFrontmatter(text) ?? {};
    const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : dirName;
    out.push({
      name,
      description: fm.description ?? "",
      argsHint: null, // skill frontmatter 无参数提示键（与 codex prompt 的 argument-hint 相区分）
      source,
      cli: "claude",
      sourcePath: skillMd,
      userOnly: fm["disable-model-invocation"]?.trim().toLowerCase() === "true",
    });
  }
  return out;
}

/** 列举 Claude 可用 skill 命令：项目级 + 用户级合并，同名项目级覆盖用户级（大小写不敏感，Windows 语义），按名排序保证响应稳定 */
export function listClaudeSkillCommands(projectCwd: string, userClaudeDir: string): CommandEntry[] {
  const merged = new Map<string, CommandEntry>();
  for (const entry of [
    ...scanSkillDir(join(projectCwd, ".claude", "skills"), "project"), // 项目级先入：同名覆盖用户级（项目级优先生效）
    ...scanSkillDir(join(userClaudeDir, "skills"), "user"),
  ]) {
    const key = entry.name.toLowerCase();
    if (!merged.has(key)) merged.set(key, entry);
  }
  return [...merged.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
