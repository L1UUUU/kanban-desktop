// 用途：项目目录 canonical path 归一化 —— resolve + realpath（Windows 用 native 变体取盘上真实大小写并剥 \\?\ 前缀）；不存在时回退 resolve（注册不阻断，缺失态由项目探测标记）
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const IS_WINDOWS = process.platform === "win32";
// realpathSync.native 在 Windows 返回 \\?\ 长路径前缀，剥掉后才能与普通 resolve 字符串比较
const WIN_LONG_PATH_PREFIX = /^\\\\\?\\/;

/**
 * canonical 化一个目录路径（注册去重与显示依据）。
 * Windows：realpathSync.native（NTFS 大小写不敏感、8.3 短名折叠）；POSIX：realpathSync。
 * 路径不存在时返回 path.resolve 结果（不阻断注册）。
 */
export function canonicalizePath(p: string): string {
  const abs = resolve(p);
  let raw: string;
  try {
    raw = IS_WINDOWS ? realpathSync.native(abs) : realpathSync(abs);
  } catch {
    return abs;
  }
  return IS_WINDOWS ? raw.replace(WIN_LONG_PATH_PREFIX, "") : raw;
}
