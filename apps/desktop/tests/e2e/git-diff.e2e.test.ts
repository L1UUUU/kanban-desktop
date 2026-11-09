// 用途：git-diff B 类 e2e（#47，spec #40 E 节/Testing）—— 真实 git 仓库 diff 采集往返留证：worktree 目录 HEAD 对比语义、大 diff 三类截断、missing-cwd、非 git 目录空态、空仓回退。直接调 readWorkspaceDiff + defaultGitDiffDeps（真实 spawn git，不经 CLI 无 token 成本）；选择直接调用而非拉起 Main handleDiffIpc 完整链路的理由：B 类价值在被测的真实 git 行为本身，IPC 路由（zod 校验/project 解析/门闸）已由 ipc.test.ts 密封覆盖，走完整应用需装配 DB/ProjectStore，暴露面不划算。KANBAN_E2E=1 门控（照 conpty/memory 先例）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitDiffDeps, readWorkspaceDiff, resolveGitExeDefault, type DiffLimits } from "../../electron/main/git-diff-service";
import { defaultConfig } from "../../electron/main/config";

const E2E = process.env.KANBAN_E2E === "1";
let gitExe: string | null = null;
if (E2E) {
  gitExe = resolveGitExeDefault(null); // 与生产同链：config 覆盖 → env → where 探测
}

const tempDirs: string[] = [];

// 用途：每用例独立临时目录（仓库/worktree 落于此）
function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-gitdiff-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 生产同款默认上限（直接取 config.ts defaultConfig().diff，杜绝两处复制漂移）
const DEFAULT_LIMITS: DiffLimits = defaultConfig().diff;

/** 真实执行一条 git 命令（仓库装配用；stdio pipe 吸收 hint 噪声） */
function git(cwd: string, ...args: string[]): void {
  execFileSync(gitExe as string, args, { cwd, stdio: "pipe" });
}

/** 装配最小仓库：init + 身份配置 + base.txt 首次提交 */
function initRepo(dir: string): void {
  git(dir, "init");
  git(dir, "config", "user.email", "e2e@kanban.local");
  git(dir, "config", "user.name", "kanban-e2e");
  writeFileSync(join(dir, "base.txt"), "line-1\nline-2\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
}

/** 造 N 行追加内容（每行 ~30 字节，行首带序号保证确定性） */
function appendedLines(n: number, prefix: string): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(3, "0")}-xxxxxxxxxxxxxxxx\n`).join("");
}

describe.skipIf(!E2E || !gitExe)("真实 git 仓库 diff 采集往返（KANBAN_E2E=1 门控，真实 git 不经 CLI）", () => {
  it("worktree 目录：HEAD 对比语义正常 —— tracked 修改行级 + untracked 全文 + untracked 二进制只列名", async () => {
    const repo = newTempDir();
    initRepo(repo);
    const wt = join(repo, "wt");
    git(repo, "worktree", "add", wt);
    // worktree 内：改 tracked + 新增 untracked 文本与二进制（主仓保持干净，验证读取的是 worktree 自身状态）
    writeFileSync(join(wt, "base.txt"), "line-1\nline-2-changed\n", "utf8");
    writeFileSync(join(wt, "notes-new.md"), "# 全新文件\n第二行\n", "utf8");
    writeFileSync(join(wt, "icon.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));

    const r = await readWorkspaceDiff(wt, defaultGitDiffDeps(null, DEFAULT_LIMITS), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(["base.txt", "icon.bin", "notes-new.md"]); // git status 排序（icon.bin < notes-new.md）

    const base = r.files[0];
    expect(base).toMatchObject({ changeType: "modified", binary: false });
    const lines = base.hunks?.[0].lines ?? [];
    expect(lines).toContainEqual({ kind: "del", text: "line-2" });
    expect(lines).toContainEqual({ kind: "add", text: "line-2-changed" });

    expect(r.files[1]).toMatchObject({ path: "icon.bin", changeType: "untracked", binary: true, hunks: null });

    const note = r.files[2];
    expect(note).toMatchObject({ changeType: "untracked", binary: false, additions: 2 });
    expect(note.hunks?.[0].lines).toEqual([{ kind: "add", text: "# 全新文件" }, { kind: "add", text: "第二行" }]);
  });

  it("大 diff 截断：字节上限截断采集 + status 对账补名 + 文件数上限窗口外仅列名 + untracked 行数上限", async () => {
    const repo = newTempDir();
    initRepo(repo);
    // file1 小改动（完整节保留 hunks）；file2 大改动（截断点落其节内，整节丢弃）；file3/file4 仅对账可见；untracked 大文件超行数
    for (const name of ["file1.txt", "file2.txt", "file3.txt", "file4.txt"]) {
      writeFileSync(join(repo, name), "line-1\n", "utf8");
      git(repo, "add", name);
    }
    git(repo, "commit", "-m", "add files");
    writeFileSync(join(repo, "file1.txt"), `line-1\n${appendedLines(20, "f1")}`, "utf8"); // ~700B diff
    writeFileSync(join(repo, "file2.txt"), `line-1\n${appendedLines(200, "f2")}`, "utf8"); // ~6KB diff
    writeFileSync(join(repo, "file3.txt"), "line-1\nfile3-new\n", "utf8");
    writeFileSync(join(repo, "file4.txt"), "line-1\nfile4-new\n", "utf8");
    writeFileSync(join(repo, "big-new.txt"), appendedLines(10, "u"), "utf8");

    // maxBytes=3000：file1 节完整、file2 节内截断；maxFiles=3：窗口外仅列名；maxUntrackedLines=5：行数截断
    const LIMITS: DiffLimits = { maxBytes: 3_000, maxFiles: 3, maxUntrackedLines: 5 };
    const r = await readWorkspaceDiff(repo, defaultGitDiffDeps(null, LIMITS), LIMITS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    // 5 个文件全部列名无丢失（file2/3/4 由 status 对账补回）
    expect(r.files.map((f) => f.path)).toEqual(["file1.txt", "file2.txt", "file3.txt", "file4.txt", "big-new.txt"]);
    // file1 完整节保留行级内容
    expect(r.files[0].hunks?.[0].lines).toContainEqual({ kind: "add", text: "f1-020-xxxxxxxxxxxxxxxx" });
    // 其余全部仅列名（截断窗口/对账/文件数上限）
    expect(r.files.slice(1).every((f) => f.hunks === null)).toBe(true);
  });

  it("missing-cwd：项目目录不存在 → 明确错误档", async () => {
    const r = await readWorkspaceDiff(join(newTempDir(), "gone"), defaultGitDiffDeps(null, DEFAULT_LIMITS), DEFAULT_LIMITS);
    expect(r).toMatchObject({ ok: false, kind: "missing-cwd" });
  });

  it("非 git 目录：普通临时目录 → not-a-repo（视图侧居中空态）", async () => {
    const r = await readWorkspaceDiff(newTempDir(), defaultGitDiffDeps(null, DEFAULT_LIMITS), DEFAULT_LIMITS);
    expect(r).toMatchObject({ ok: false, kind: "not-a-repo" });
  });

  it("空仓未提交（无 HEAD）：基准回退空树，暂存新文件仍可见", async () => {
    const repo = newTempDir();
    git(repo, "init");
    git(repo, "config", "user.email", "e2e@kanban.local");
    git(repo, "config", "user.name", "kanban-e2e");
    writeFileSync(join(repo, "staged.txt"), "staged content\n", "utf8");
    git(repo, "add", "-A");
    const r = await readWorkspaceDiff(repo, defaultGitDiffDeps(null, DEFAULT_LIMITS), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.path)).toEqual(["staged.txt"]);
    expect(r.files[0]).toMatchObject({ changeType: "added", binary: false });
    expect(r.files[0].hunks?.[0].lines).toContainEqual({ kind: "add", text: "staged content" });
  });
});
