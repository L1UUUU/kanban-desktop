// 用途：Codex prompts 命令源扫描（issue #89 / spec #82 E 块）—— 用户级 `<home>/.codex/prompts/*.md` + 项目级 `<cwd>/.codex/prompts/*.md`（~/.codex/prompts 为新地面；目录缺失返回空集不报错），frontmatter description/argument-hint 映射统一条目；读取失败安全降级（列举是提示性能力不报错）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandEntry } from "@kanban/ipc-schema";
import { parseFrontmatter, splitFrontmatter } from "../frontmatter";

/** 读取目录下的一级 .md 文件名（目录缺失/不可读 → 空数组；普通文件只认 .md，子目录不参与——codex prompts 为平铺目录） */
function listMarkdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 单个 prompts 目录 → 统一条目（名称 = 文件名去 .md；读取异常跳过该条） */
function scanPromptDir(promptsRoot: string, source: "user" | "project"): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const fileName of listMarkdownFiles(promptsRoot)) {
    const file = join(promptsRoot, fileName);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // 不可读：跳过该条
    }
    const fm = parseFrontmatter(text) ?? {};
    out.push({
      name: fileName.slice(0, -3),
      description: fm.description ?? "",
      argsHint: fm["argument-hint"] ?? null, // 参数占位提示（$1..$n / $ARGUMENTS 的用法说明）
      source,
      cli: "codex",
      sourcePath: file,
      userOnly: false, // codex prompts 均为用户主动调用，无仅用户标记
    });
  }
  return out;
}

/** 列举 Codex 可用自定义 prompt 命令：项目级 + 用户级合并，同名项目级覆盖用户级（大小写不敏感），按名排序保证响应稳定 */
export function listCodexPromptCommands(projectCwd: string, home: string): CommandEntry[] {
  const merged = new Map<string, CommandEntry>();
  for (const entry of [
    ...scanPromptDir(join(projectCwd, ".codex", "prompts"), "project"), // 项目级先入：同名覆盖用户级
    ...scanPromptDir(join(home, ".codex", "prompts"), "user"),
  ]) {
    const key = entry.name.toLowerCase();
    if (!merged.has(key)) merged.set(key, entry);
  }
  return [...merged.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

// —— #92 codex 客户端展开（PoC 结论：app-server 不解析 / 前缀，GUI 读 prompt 文件展开后作普通文本发送）——
// 占位符形态（与 prompt-commands 的 argument-hint 约定一致）：$ARGUMENTS / $@ = 全量实参原文；$1..$9 = 空白切分位置参数（缺位空串）

/** 占位符单趟匹配（$ARGUMENTS / $@ / $1..$9）：单趟替换保证实参插入文本不被二次展开 */
const PLACEHOLDER_RE = /\$(ARGUMENTS|@|[1-9])/g;

/**
 * 展开 Codex prompt 命令为普通文本（issue #92 / spec #82 E 块派发形态）：
 * 剥 frontmatter（复用 frontmatter.ts 围栏切分单源，无围栏/未闭合取原文）→ 正文占位符替换（$ARGUMENTS/$@ 全量、$1..$9 位置）；无占位符且带实参时空行追加（不静默丢参）。
 */
export function expandCodexPromptCommand(fileText: string, args: string): string {
  const body = splitFrontmatter(fileText).body.trim();
  const fullArgs = args.trim();
  const positionals = fullArgs.split(/\s+/).filter((w) => w !== "");
  let substituted = false;
  const expanded = body.replace(PLACEHOLDER_RE, (_, token: string) => {
    substituted = true;
    if (token === "ARGUMENTS" || token === "@") return fullArgs;
    return positionals[Number(token) - 1] ?? "";
  });
  if (!substituted && fullArgs) return `${expanded}\n\n${fullArgs}`;
  return expanded;
}
