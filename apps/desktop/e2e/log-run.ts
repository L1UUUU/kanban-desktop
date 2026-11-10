// 用途：日志 E2E 共享读档 helper（#56 spec #52 C 类）—— 按启动组（<pid> 前缀，N17）读 <userData>/logs 全部 JSONL 条目：
// 主文件 + .1/.2 分片有序合并（M9：分片属同次运行续写，写入口径 = 到达顺序）、半行容忍（追加写入中途读到的残行跳过，下一轮轮询补全）；
// logging/error-cards/resume-banner 三份 spec 统一此口径，防各拷贝语义漂移。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 日志条目读取形状（logger.ts 落盘 JSONL 格式；ts 为 Main 生成 ISO 串） */
export interface LogEntry {
  ts: string;
  level: "error" | "warn" | "info" | "debug";
  source: "main" | "worker" | "renderer";
  scope: string;
  message: string;
  ctx?: Record<string, string | number | boolean>;
}

/** 取该 pid 启动组文件名前缀（YYYYMMDD-HHmmss-<pid>；主文件缺失时从同组任一分片回退，供 getLogPath 等断言） */
export function runPrefixOf(names: string[], pid: number): string {
  const main = names.find((n) => new RegExp(`^\\d{8}-\\d{6}-${pid}\\.jsonl$`).test(n));
  const any = names.find((n) => n.includes(`-${pid}.jsonl`));
  return (main ?? any ?? "").replace(/\.jsonl.*$/, "");
}

/** 读指定启动组全部日志条目：主文件 + .1/.2 分片按序拼接（N17/M9）；跨启动组文件不读（同 userData 多次 launch 禁跨组拼接） */
export function readRunEntries(userData: string, pid: number): LogEntry[] {
  const dir = join(userData, "logs");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((n) => new RegExp(`^\\d{8}-\\d{6}-${pid}\\.jsonl(?:\\.\\d+)?$`).test(n));
  const prefix = runPrefixOf(names, pid);
  const ordered = [`${prefix}.jsonl`, `${prefix}.jsonl.1`, `${prefix}.jsonl.2`].filter((n) => names.includes(n));
  const entries: LogEntry[] = [];
  for (const name of ordered) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as LogEntry);
      } catch {
        // 追加写入中途读到的半行：跳过（下一轮轮询补全）
      }
    }
  }
  return entries;
}
