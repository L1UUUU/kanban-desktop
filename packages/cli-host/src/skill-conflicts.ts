// 用途：Claude 同名 skill 检测（spec #15 E 节 / ticket #21）—— 项目级 .claude/skills/* 与用户级 skills 目录名交集（大小写不敏感，Windows）；用户级基准目录解析（CLAUDE_CONFIG_DIR 优先，否则 ~/.claude）同为纯函数供 Main 调用（本模块不读环境变量、无 Electron 依赖）
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 读取目录下的一级子目录名（目录缺失/不可读 → 空数组：检测是提示性能力，任何读取失败都安全降级为「无冲突」；普通文件不参与） */
function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 同名 skill 检测：项目 `.claude/skills/*` 子目录名与用户级 `skills/*` 目录名的交集。
 * 比较大小写不敏感（Windows 文件系统语义）；返回项目侧目录名（项目级将优先生效，以其命名展示），按名字排序保证响应稳定。
 */
export function detectSkillConflicts(projectCwd: string, userClaudeDir: string): string[] {
  const projectSkills = listSubdirs(join(projectCwd, ".claude", "skills"));
  if (projectSkills.length === 0) return [];
  const userSkills = new Set(listSubdirs(join(userClaudeDir, "skills")).map((n) => n.toLowerCase()));
  return projectSkills
    .filter((n) => userSkills.has(n.toLowerCase()))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/**
 * 用户级 Claude 基准目录解析（Main 侧调用后传给 detectSkillConflicts）：
 * 优先 CLAUDE_CONFIG_DIR（空白视为未设置），否则 `~/.claude`（home + ".claude"）。
 * env 形状兼容 NodeJS.ProcessEnv 与测试字面量（只读，不改动调用方环境对象）。
 */
export function resolveUserClaudeDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(home, ".claude");
}
