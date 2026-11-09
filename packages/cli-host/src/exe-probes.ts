// 用途：exe 解析链候选并集的共享探测注入面（#49 spec #40 F 节）—— npm root -g / where 子进程探测可注入替换（密封测试），路径去重归一共用；与各 resolve*Exe 的采纳条件保持一致（存在才收）
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** 候选探测注入面（缺省真实探测：npm root -g 经 ComSpec / where|which 全部结果行） */
export interface ExeCandidateProbes {
  /** npm 全局根探测（缺省 npm root -g；测试注入临时目录） */
  npmRoot?: () => string;
  /** PATH 查询全部结果行（缺省 where/which 原始多行；过滤规则由各 CLI lister 按解析链语义应用） */
  pathLookup?: (name: string) => string[];
}

/** where/which 全部结果行（存在文件的原始行；.cmd/.exe 过滤由调用方按各 CLI 采纳规则做） */
export function lookupAllPathLines(name: string): string[] {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, [name], { encoding: "utf8" }).trim();
    return out.split(/\r?\n/).filter((line) => line.length > 0 && existsSync(line));
  } catch {
    return [];
  }
}

/** 路径去重（win32 大小写不敏感 + 斜杠方向归一为比较键；保留首个出现的原形） */
export function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = p.toLowerCase().replace(/\//g, "\\");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
