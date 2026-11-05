// 用途：会话目录身份判定（spec I-3）—— cwd/.git 目录=主仓库（绿徽标）、是文件=worktree（解析 gitdir 行取末段名，蓝徽标）、其余 none 不渲染徽标
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";

export type DirIdentity =
  | { kind: "main" }
  | { kind: "worktree"; name: string }
  | { kind: "none" };

/** 判定一个工作目录的 git 身份（纯读文件系统，无 git 依赖） */
export function detectDirIdentity(cwd: string): DirIdentity {
  let stat: { isDirectory(): boolean };
  try {
    stat = statSync(`${cwd}${sep}.git`);
  } catch {
    return { kind: "none" };
  }
  if (stat.isDirectory()) return { kind: "main" };
  // worktree：.git 文件首行 "gitdir: <path>"（绝对或相对 cwd）；名字取解析后路径末段
  let content: string;
  try {
    content = readFileSync(`${cwd}${sep}.git`, "utf8");
  } catch {
    return { kind: "none" };
  }
  const m = /gitdir:\s*(.+)/.exec(content);
  if (!m) return { kind: "none" };
  const gitdir = m[1].trim();
  if (!gitdir) return { kind: "none" };
  const abs = isAbsolute(gitdir) ? gitdir : resolve(cwd, gitdir);
  const name = basename(abs);
  return name ? { kind: "worktree", name } : { kind: "none" };
}
