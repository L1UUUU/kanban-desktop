// 用途：一次性标题摘要基建（#95 / ADR 0003 决策 3）—— 摘要 prompt 构造 + 产出整形纯函数 + 对 one-shot 执行器（./one-shot，arch C3 合并的 Windows 坑位清单单源）的薄消费面；CLI 命令行差异留在各 adapter，本模块只承载两 CLI 共性
import type { LogKind, TranscriptEvent } from "@kanban/ipc-schema";
import { AdapterError } from "./adapter";
import { OneShotSpawnError, spawnOneShot, type OneShotOutcome } from "./one-shot";

/** 摘要一次性执行超时缺省（独立设定，不沿用 run-once 300s：标题生成是轻量单轮任务；量级对齐 claude setModel ack 15s 起放宽到 60s 真实模型裕量） */
export const DEFAULT_SUMMARIZE_TIMEOUT_MS = 60_000;

/** 喂给摘要模型的最近对话文本上限（字符；超长截尾——最近上下文最能代表会话主题） */
const MAX_TRANSCRIPT_CHARS = 4_000;

/** 摘要标题单行码点数上限（防御模型 disobey：多行/超长压成单行短标题；按 Unicode 码点计，review S3） */
const TITLE_MAX_CHARS = 48;

export interface TitleOneShotOptions {
  /** spawn 直连目标（各 adapter 既有 exe 解析链产物） */
  exe: string;
  /** CLI 专属参数（-p / exec 及模型、输出控制等） */
  args: string[];
  /** 会话工作目录 */
  cwd: string;
  /** 摘要 prompt（经 stdin 注入，不进命令行——长度无关且不落进程列表） */
  stdin: string;
  /** 超时 ms（到点 kill 并抛 AdapterError） */
  timeoutMs: number;
  /** 诊断日志（stderr 留痕） */
  log?: (kind: LogKind, detail: string) => void;
}

export interface TitleOneShotResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** 一次性 CLI 执行（one-shot 执行器薄消费方）：进程启动失败/超时抛 AdapterError；正常退出按 {exitCode, stdout, stderr} 交调用方判定 */
export async function runTitleOneShot(options: TitleOneShotOptions): Promise<TitleOneShotResult> {
  const { done } = spawnOneShot({
    exe: options.exe,
    args: options.args,
    cwd: options.cwd,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs, // 独立超时设定（不沿用 run-once 300s 缺省），值由 adapter 层注入
    log: options.log,
    logTag: "title-summarize",
  });
  let r: OneShotOutcome;
  try {
    r = await done;
  } catch (e) {
    // 启动失败（spawn 同步抛错与异步 error 事件同路）统一映射既有文案
    if (e instanceof OneShotSpawnError) {
      throw new AdapterError("E_INTERNAL", `标题摘要进程启动失败：${e.message}`);
    }
    throw e;
  }
  if (r.verdict === "timeout") {
    throw new AdapterError("E_INTERNAL", `标题摘要超时（${options.timeoutMs}ms，已终止一次性进程）`);
  }
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

/** 喂给摘要模型的最近对话文本：user/assistant 文本行（工具调用折叠为一行标注）；超长截尾 */
export function buildSummaryTranscript(transcript: TranscriptEvent[]): string {
  const lines: string[] = [];
  for (const ev of transcript) {
    if (ev.role === "user") {
      if (ev.text.trim()) lines.push(`用户：${ev.text.trim()}`);
    } else if (ev.tool) {
      lines.push(`（工具 ${ev.tool.name}）`);
    } else if (ev.text.trim()) {
      lines.push(`助手：${ev.text.trim()}`);
    }
  }
  const joined = lines.join("\n");
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  return joined.slice(joined.length - MAX_TRANSCRIPT_CHARS);
}

/** 摘要指令（#95：adapter 层写死控成本——单行短标题、无解释；两 CLI 共用） */
const SUMMARY_INSTRUCTION = "请根据下面的对话内容生成一个不超过 16 个字的简短中文标题，直接输出标题文字本身：不要引号、不要结尾标点、不要换行、不要任何解释。";

/** 完整摘要 prompt：指令 + 截断的最近对话文本（经一次性进程 stdin 注入） */
export function buildSummaryPrompt(transcript: TranscriptEvent[]): string {
  return `${SUMMARY_INSTRUCTION}\n\n${buildSummaryTranscript(transcript)}`;
}

/** 摘要产出整形：压成单行（空白折叠）、去首尾、按 Unicode 码点限长截断（review S3：与 main title-derive 同型语义——Array.from 迭代码点，增补平面 emoji 不截半；超长截断不加省略号——标题自短） */
export function toTitleLine(raw: string): string {
  const line = raw.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  if (chars.length <= TITLE_MAX_CHARS) return line;
  return chars.slice(0, TITLE_MAX_CHARS).join("");
}
