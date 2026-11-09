// 用途：从 tool 事件摘要/输出提取文件路径的纯函数（会话线索探针 #48 判据核心；三 CLI 事件形状见各 adapter 的 argsSummary/output 构造）

/** 提取输入：tool_started.tool / argsSummary + tool_completed.output（同一 itemId 两半合并供提取） */
export interface ToolEventForExtract {
  tool: string;
  argsSummary: string;
  output: string;
}

/** 语义上指向文件路径的 JSON 参数键（Claude file_path / OpenCode filePath / 通用 path 等） */
const PATH_KEY_RE = /^(file_?path|path|paths|notebook_?path|relative_?path|target_?file|file)$/i;

/** JSON 值递归收集路径键的字符串值（对象/数组/嵌套皆收） */
function collectJsonPathValues(v: unknown, out: string[]): void {
  if (Array.isArray(v)) {
    for (const item of v) collectJsonPathValues(item, out);
    return;
  }
  if (!v || typeof v !== "object") return;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (PATH_KEY_RE.test(k) && typeof val === "string" && val) out.push(val);
    else collectJsonPathValues(val, out);
  }
}

/** 裸文本中的路径 token：Windows 绝对路径（含 UNC）与 POSIX 绝对路径；引号包裹时连引号一起匹配后剥离 */
const RAW_PATH_RE = /(?:\\\\[A-Za-z0-9_.-]+\\[^\s"'<>|]+)|(?:"((?:[A-Za-z]:)?[\\/][^\s"<>|]+)")|((?:[A-Za-z]:)?[\\/][^\s"'<>|]+)/g;

/** URL 剥除模式（scheme://... 形态；避免 //host/path 被误当 POSIX/UNC 路径，三处扫描入口共用） */
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>|]+/g;

/** 剥除文本中的 URL（替换为空格） */
function stripUrls(text: string): string {
  return text.replace(URL_RE, " ");
}

/** 单段 token 是否算文件路径候选：含分隔符，或带扩展名（package.json、seed.txt） */
function looksLikeFilePath(token: string): boolean {
  if (/^[A-Za-z]:$/.test(token)) return false; // 盘符裸字母（PowerShell 提示符等噪声）
  if (/[\\/]/.test(token)) return true; // 任意分隔符 → 路径形态
  return /\.[A-Za-z0-9]{1,8}$/.test(token); // 无分隔符但带扩展名
}

/** 从任意文本（JSON 字符串形态或命令行/输出原文）收集路径 token */
function collectRawPathTokens(text: string, out: string[]): void {
  if (!text) return;
  // 先剥除 URL，避免 //host/path 形态被误当 POSIX/UNC 路径
  const stripped = stripUrls(text);
  // JSON.stringify 形态（Claude/OpenCode 摘要）里反斜杠加倍：先尝试解析回原文再扫描
  const targets: string[] = [stripped];
  if (/^[\s]*[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const jsonPaths: string[] = [];
      collectJsonPathValues(parsed, jsonPaths);
      out.push(...jsonPaths); // 语义键值优先（无噪声）
      const restringified: string[] = [];
      collectDeepStrings(parsed, restringified); // 字符串值（含 command）再作命令扫描
      targets.push(...restringified.map(stripUrls));
    } catch {
      /* 非 JSON 走原文扫描 */
    }
  }
  for (const t of targets) {
    for (const m of t.matchAll(RAW_PATH_RE)) {
      const token = m[1] ?? m[0]; // 引号组优先（整段带引号路径），否则裸匹配
      const clean = token.replace(/^["']+|["']+$/g, "").replace(/[.,;:)]+$/, "");
      if (clean && looksLikeFilePath(clean) && !/^(https?:|file:)/i.test(clean)) out.push(clean);
    }
  }
}

/** 递归收集 JSON 内全部字符串叶子值（供命令串等二次扫描） */
function collectDeepStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectDeepStrings(item, out);
    return;
  }
  if (v && typeof v === "object") for (const val of Object.values(v as Record<string, unknown>)) collectDeepStrings(val, out);
}

/** 相对路径 token（含目录分隔或扩展名，排除裸命令词）；仅当文本不含绝对路径时补充 */
const RELATIVE_PATH_RE = /[^\s"'<>|:]*[\\/][^\s"'<>|:]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}/g;

/** 供探针/UI 比对：路径归一化（win32 大小写不敏感 + 分隔符统一 + 去尾点） */
export function normalizePathForCompare(p: string): string {
  let s = p.replace(/["']/g, "").trim();
  s = s.replace(/[.,;]+$/, "");
  s = s.replace(/\\/g, "/");
  if (/^[A-Z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

/** 相对路径按 cwd 解析为可比对绝对形态（无 cwd 或非相对则原样归一化） */
export function resolveForCompare(p: string, cwd?: string): string {
  const norm = normalizePathForCompare(p);
  if (!cwd) return norm;
  const isAbs = /^[a-z]:\//.test(norm) || norm.startsWith("//") || norm.startsWith("/");
  if (isAbs) return norm;
  return normalizePathForCompare(cwd) + "/" + norm;
}

/**
 * 从单个工具事件（started 摘要 + completed 输出合并）提取文件路径候选，按可信度排序去重：
 * JSON 语义键值（file_path/path 等）在前，文本 token 在后；空输入返回 []。
 */
export function extractToolFilePaths(event: ToolEventForExtract): string[] {
  const out: string[] = [];
  collectRawPathTokens(event.argsSummary, out);
  collectRawPathTokens(event.output, out);
  // 相对路径补充：摘要/输出整体无绝对路径时，从原文补相对路径 token（src/foo.ts、package.json）
  if (!out.some((p) => /^[a-z]:|^\/\//.test(normalizePathForCompare(p)))) {
    for (const text of [event.argsSummary, event.output]) {
      const stripped = stripUrls(text); // 相对兜底同样剥 URL
      for (const m of stripped.matchAll(RELATIVE_PATH_RE)) {
        const clean = m[0].replace(/^["']+|["',;:)]+$/g, "");
        if (clean && looksLikeFilePath(clean)) out.push(clean);
      }
    }
  }
  // 去重保序（win32 大小写不敏感）
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of out) {
    const key = normalizePathForCompare(p).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}
