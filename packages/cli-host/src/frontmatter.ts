// 用途：markdown frontmatter 最小解析器（issue #89 / spec #82 E 块）—— `---` 围栏 + `key: value` 行手写切分，claude SKILL.md 与 codex prompt md 共用（仓内零新依赖约定，不引 yaml 库；只取单行字符串值，多行/结构化值不支持）

/** 解析文本头部 frontmatter：首个 `---` 行起至下一个 `---` 行止，中段按首个冒号切 key/value（值去首尾引号）；无围栏/未闭合返回 null，杂行忽略 */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") return out; // 闭合围栏：其后正文不参与
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // 杂行（列表/空行/无冒号）忽略
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = unquote(raw);
  }
  return null; // 扫到文件尾仍未闭合
}

/** 去掉成对的单/双引号（值本身含引号的场景不受影响） */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
