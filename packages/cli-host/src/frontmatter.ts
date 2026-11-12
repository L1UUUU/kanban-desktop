// 用途：markdown frontmatter 最小解析器（issue #89 / spec #82 E 块）—— `---` 围栏 + `key: value` 行手写切分，claude SKILL.md 与 codex prompt md 共用（仓内零新依赖约定，不引 yaml 库；只取单行字符串值，多行/结构化值不支持）

/** 围栏扫描切分结果：data=null 表示无围栏或未闭合（此时 body 为原文） */
export interface FrontmatterSplit {
  data: Record<string, string> | null;
  body: string;
}

/** 单次围栏扫描：首个 `---` 行起至下一个 `---` 行止为中段（按首个冒号切 key/value，值去首尾引号），闭合行之后为正文；无围栏/未闭合 data=null 且 body=原文，杂行忽略 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: null, body: text };
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "---") return { data: out, body: lines.slice(i + 1).join("\n") }; // 闭合围栏：其后为正文
    const idx = line.indexOf(":");
    if (idx <= 0) continue; // 杂行（列表/空行/无冒号）忽略
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = unquote(raw);
  }
  return { data: null, body: text }; // 扫到文件尾仍未闭合
}

/** 解析文本头部 frontmatter（splitFrontmatter 的 data 视图）：无围栏/未闭合返回 null */
export function parseFrontmatter(text: string): Record<string, string> | null {
  return splitFrontmatter(text).data;
}

/** 去掉成对的单/双引号（值本身含引号的场景不受影响） */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}
