// 用途：验收制品（截图/JSON/TXT）写入统一门控 —— 默认落 test-results/（不碰归档），显式更新才覆盖 docs/acceptance/
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Page } from "@playwright/test";

const ROOT = resolve(__dirname, "../../../..");
const ARCHIVE_ROOT = resolve(ROOT, "docs/acceptance");
const OUTPUT_ROOT = resolve(ROOT, "test-results/acceptance");

/** 是否把制品写回归档目录：只有显式置 1 才覆盖，避免每次跑 e2e 都污染共享 git tree */
const UPDATE = process.env.KANBAN_UPDATE_SCREENSHOTS === "1";

/** 制品目标路径：读写都用同一个解析函数，保证门控开启/关闭时行为一致 */
export function artifactPath(archiveDir: string, name: string): string {
  const rel = relative(ARCHIVE_ROOT, resolve(archiveDir));
  if (rel.startsWith("..")) throw new Error(`归档目录不在 docs/acceptance/ 下：${archiveDir}`);
  return join(UPDATE ? ARCHIVE_ROOT : OUTPUT_ROOT, rel, name);
}

/** 截图到验收目录并打印日志（截图本身即证据，断言由调用方随附） */
export async function shot(win: Page, archiveDir: string, name: string, label = "[shot]"): Promise<void> {
  const dest = artifactPath(archiveDir, name);
  mkdirSync(join(dest, ".."), { recursive: true });
  await win.screenshot({ path: dest });
  console.log(`${label} ${name}${UPDATE ? "" : " (test-results/)"}`);
}

/** 写文本/JSON 证据到验收目录（real-evidence 的 cli-versions、isolation 报告等） */
export function writeArtifact(archiveDir: string, name: string, data: string | Buffer): void {
  const dest = artifactPath(archiveDir, name);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, data);
  console.log(`[artifact] ${name}${UPDATE ? "" : " (test-results/)"}`);
}
