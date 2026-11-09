// 用途：git-diff-service 密封测试（issue #43/#47，spec #40 A/E 节）—— 固定 git 输出 fixture 断言统一解析（M/A/D/R/U/hunks 形状 + binary + 无 HEAD 空仓回退）+ 四档错误逐档 + 解析器边界（No newline 尾标/重命名原路径 token/XY 分类）+ #47 三类截断上限（maxBytes 采集字节/maxFiles 文件数/maxUntrackedLines 行数）+ untracked 全文与二进制探测
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStatusEntries, parseUnifiedDiff, readWorkspaceDiff, type DiffLimits, type GitDiffDeps, type GitRunOutcome } from "./git-diff-service";

const tempDirs: string[] = [];

// 用途：每用例独立临时目录（真实存在的 cwd，供 missing-cwd 判定通过）
function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-gitdiff-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 充足上限（不触发截断路径的用例统一用；截断用例单独传小值）
const AMPLE: DiffLimits = { maxBytes: 1_000_000, maxFiles: 100, maxUntrackedLines: 500 };

// ── 固定 fixture：git status --porcelain -z -uall（重命名条目后跟原路径 token）──
const STATUS_FIXTURE = ["M  apps/chat-store.ts", "R  new-name.ts\0old-name.ts", "?? notes/diff-parsing.md", "?? notes/other.md", ""].join("\0");

// ── 固定 fixture：git diff <base> -M --unified=3（M/A/D/R/binary 五节）──
const DIFF_FIXTURE = [
  "diff --git a/apps/chat-store.ts b/apps/chat-store.ts",
  "index 111..222 100644",
  "--- a/apps/chat-store.ts",
  "+++ b/apps/chat-store.ts",
  "@@ -180,6 +180,8 @@ export class ChatStore {",
  "     case \"session_status\":",
  "-      if (old) {",
  "+      if (new) {",
  "+        added();",
  "     }",
  "diff --git a/DiffWorkspace.tsx b/DiffWorkspace.tsx",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/DiffWorkspace.tsx",
  "@@ -0,0 +1,2 @@",
  "+// new",
  "+export const x = 1;",
  "diff --git a/legacy.ts b/legacy.ts",
  "deleted file mode 100644",
  "--- a/legacy.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-old line",
  "\\ No newline at end of file",
  "diff --git a/old-name.ts b/new-name.ts",
  "similarity index 90%",
  "rename from old-name.ts",
  "rename to new-name.ts",
  "diff --git a/logo.png b/logo.png",
  "index 444..555 100644",
  "Binary files a/logo.png and b/logo.png differ",
].join("\n");

/** 造 deps：rev-parse --is-inside-work-tree 恒真；HEAD 可解析；status/diff 返回 fixture（可注入截断标志与 untracked 文件内容桩） */
function makeDeps(overrides?: {
  resolveGitExe?: () => string | null;
  status?: string;
  statusCapped?: boolean;
  diff?: string;
  diffCode?: number;
  headCode?: number;
  diffCapped?: boolean;
  /** untracked 文件内容桩：string=文本全文；Buffer=原始字节（二进制用）；null=读取失败；未列出=空文件 */
  untrackedFiles?: Record<string, string | Buffer | null>;
}): GitDiffDeps & {
  calls: Array<{ exe: string; args: string[]; cwd: string }>;
  readFileCalls: Array<{ cwd: string; path: string; maxBytes: number }>;
} {
  const calls: Array<{ exe: string; args: string[]; cwd: string }> = [];
  const readFileCalls: Array<{ cwd: string; path: string; maxBytes: number }> = [];
  const ok = (stdout: string, stdoutCapped?: boolean): GitRunOutcome => ({ code: 0, stdout, stderr: "", stdoutCapped });
  return {
    calls,
    readFileCalls,
    resolveGitExe: overrides?.resolveGitExe ?? (() => "C:/Program Files/Git/bin/git.exe"),
    runGit: async (exe, args, cwd) => {
      calls.push({ exe, args, cwd });
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return ok("true\n");
      }
      if (args[0] === "rev-parse" && args.includes("HEAD")) {
        return overrides?.headCode === 128 ? { code: 128, stdout: "", stderr: "" } : ok("abc123\n");
      }
      if (args[0] === "status") return ok(overrides?.status ?? STATUS_FIXTURE, overrides?.statusCapped);
      if (args[0] === "diff") {
        if (overrides?.diffCode != null) return { code: 129, stdout: "", stderr: "fatal: diff blew up" };
        return ok(overrides?.diff ?? DIFF_FIXTURE, overrides?.diffCapped);
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
    readFileHead: async (cwd, path, maxBytes) => {
      readFileCalls.push({ cwd, path, maxBytes });
      const v = overrides?.untrackedFiles?.[path];
      if (v === null) return null;
      if (typeof v === "string") return Buffer.from(v, "utf8");
      if (v instanceof Buffer) return v;
      return Buffer.alloc(0);
    },
  };
}

describe("readWorkspaceDiff 成功形状（固定 git 输出解析）", () => {
  it("M/A/D/R/U 五类文件行 + binary + hunk 行级形状 + 未截断", async () => {
    const cwd = newTempDir();
    const deps = makeDeps();
    const r = await readWorkspaceDiff(cwd, deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(false);
    expect(r.files).toHaveLength(7); // 5 tracked（M/A/D/R/binary）+ 2 untracked

    const [modified, added, deleted, renamed, binary, u1, u2] = r.files;
    // M：hunks 三性行 + 计数
    expect(modified).toMatchObject({ path: "apps/chat-store.ts", changeType: "modified", binary: false, oldPath: null, additions: 2, deletions: 1 });
    expect(modified.hunks).toEqual([
      {
        header: "@@ -180,6 +180,8 @@ export class ChatStore {",
        lines: [
          { kind: "context", text: "    case \"session_status\":" },
          { kind: "del", text: "      if (old) {" },
          { kind: "add", text: "      if (new) {" },
          { kind: "add", text: "        added();" },
          { kind: "context", text: "    }" },
        ],
      },
    ]);
    // A：新文件节
    expect(added).toMatchObject({ path: "DiffWorkspace.tsx", changeType: "added", additions: 2, deletions: 0 });
    expect(added.hunks?.[0].header).toBe("@@ -0,0 +1,2 @@");
    // D：删除节（No newline 尾标被跳过）
    expect(deleted).toMatchObject({ path: "legacy.ts", changeType: "deleted", additions: 0, deletions: 1 });
    // R：rename from/to，无 hunks
    expect(renamed).toMatchObject({ path: "new-name.ts", changeType: "renamed", oldPath: "old-name.ts", binary: false, additions: 0, deletions: 0 });
    expect(renamed.hunks).toEqual([]);
    // binary：hunks null
    expect(binary).toMatchObject({ path: "logo.png", changeType: "modified", binary: true, additions: 0, deletions: 0 });
    expect(binary.hunks).toBeNull();
    // U：untracked 全文承载（#47）；fixture 未给内容桩 → 空文件 → hunks=[]
    expect(u1).toMatchObject({ path: "notes/diff-parsing.md", changeType: "untracked", binary: false, oldPath: null, additions: 0, deletions: 0 });
    expect(u1.hunks).toEqual([]);
    expect(u2).toMatchObject({ path: "notes/other.md", changeType: "untracked", hunks: [] });
  });

  it("git 命令按序发起且 diff 基准为 HEAD（rev-parse --verify HEAD 成功）", async () => {
    const cwd = newTempDir();
    const deps = makeDeps();
    await readWorkspaceDiff(cwd, deps, AMPLE);
    const argv = deps.calls.map((c) => c.args.join(" "));
    expect(argv).toEqual([
      "rev-parse --is-inside-work-tree",
      'rev-parse --verify -q HEAD',
      'status --porcelain -z -uall',
      'diff HEAD -M --unified=3',
    ]);
    expect(deps.calls.every((c) => c.cwd === cwd)).toBe(true);
  });

  it("无 HEAD 空仓：diff 基准回退空树对象（暂存区新增仍可见）", async () => {
    const cwd = newTempDir();
    const deps = makeDeps({ headCode: 128 });
    const r = await readWorkspaceDiff(cwd, deps, AMPLE);
    expect(r.ok).toBe(true);
    const diffCall = deps.calls.find((c) => c.args[0] === "diff");
    expect(diffCall?.args[1]).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

describe("readWorkspaceDiff 四档错误", () => {
  it("missing-cwd：目录不存在", async () => {
    const r = await readWorkspaceDiff(join(newTempDir(), "gone"), makeDeps(), AMPLE);
    expect(r).toEqual({ ok: false, kind: "missing-cwd", message: expect.stringContaining("项目目录不存在") });
  });

  it("git-missing：git 可执行不可解析（解析返回 null）", async () => {
    const r = await readWorkspaceDiff(newTempDir(), makeDeps({ resolveGitExe: () => null }), AMPLE);
    expect(r).toEqual({ ok: false, kind: "git-missing", message: expect.stringContaining("git") });
  });

  it("git-missing：spawn ENOENT（解析成功但可执行消失）", async () => {
    const deps = makeDeps();
    deps.runGit = async () => ({ code: -1, stdout: "", stderr: "", spawnError: new Error("spawn C:/git.exe ENOENT") });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r).toMatchObject({ ok: false, kind: "git-missing" });
  });

  it("not-a-repo：rev-parse 128 + stderr 含 not a git repository", async () => {
    const deps = makeDeps();
    deps.runGit = async (_exe, args) =>
      args[0] === "rev-parse"
        ? { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" }
        : { code: 0, stdout: "", stderr: "" };
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r).toMatchObject({ ok: false, kind: "not-a-repo" });
  });

  it("not-a-repo：is-inside-work-tree 输出 false（.git 目录内部）", async () => {
    const deps = makeDeps();
    deps.runGit = async (_exe, args) => ({ code: 0, stdout: args[0] === "rev-parse" ? "false" : "", stderr: "" });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r).toMatchObject({ ok: false, kind: "not-a-repo" });
  });

  it("git-failed：rev-parse 非预期失败（stderr 无 not-a-repo 字样）", async () => {
    const deps = makeDeps();
    deps.runGit = async (_exe, args) =>
      args[0] === "rev-parse"
        ? { code: 128, stdout: "", stderr: "fatal: bad config line 1 in file .git/config" }
        : { code: 0, stdout: "", stderr: "" };
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r).toMatchObject({ ok: false, kind: "git-failed", message: expect.stringContaining("bad config") });
  });

  it("git-failed：diff 子命令失败透传 stderr", async () => {
    const r = await readWorkspaceDiff(newTempDir(), makeDeps({ diffCode: 129 }), AMPLE);
    expect(r).toMatchObject({ ok: false, kind: "git-failed", message: expect.stringContaining("diff blew up") });
  });

  it("git-failed：spawn 非 ENOENT 失败", async () => {
    const deps = makeDeps();
    deps.runGit = async () => ({ code: -1, stdout: "", stderr: "", spawnError: new Error("spawn EACCES: permission denied") });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r).toMatchObject({ ok: false, kind: "git-failed" });
  });
});

describe("parseStatusEntries（-z 解析与 XY 分类）", () => {
  it("重命名条目取后续原路径 token 为 oldPath，不误判为独立条目", () => {
    const out = parseStatusEntries("R  to.ts\0from.ts\0?? a.md\0?? b.md\0");
    expect(out).toEqual([
      { path: "to.ts", changeType: "renamed", oldPath: "from.ts" },
      { path: "a.md", changeType: "untracked", oldPath: null },
      { path: "b.md", changeType: "untracked", oldPath: null },
    ]);
  });

  it("XY 分类：A→added、D→deleted、其余（M/U 等）→modified；无 untracked → 无 untracked 条目", () => {
    expect(parseStatusEntries("A  new.ts\0 D gone.ts\0AM staged.ts\0UU both.ts\0M  x.ts\0")).toEqual([
      { path: "new.ts", changeType: "added", oldPath: null },
      { path: "gone.ts", changeType: "deleted", oldPath: null },
      { path: "staged.ts", changeType: "added", oldPath: null },
      { path: "both.ts", changeType: "modified", oldPath: null },
      { path: "x.ts", changeType: "modified", oldPath: null },
    ]);
    expect(parseStatusEntries("M  x.ts\0 D y.ts\0").every((e) => e.changeType !== "untracked")).toBe(true);
    expect(parseStatusEntries("")).toEqual([]);
  });
});

// ============ #47：untracked 全文 / 二进制 / 三类截断上限 ============

describe("untracked 全文展示（#47，spec US3：hunks 槽位承载全文）", () => {
  const UN_STATUS = ["?? notes/new.md", ""].join("\0");

  it("文本全文：单 hunk 全新增行 + additions=行数，未截断", async () => {
    const deps = makeDeps({ status: UN_STATUS, diff: "", untrackedFiles: { "notes/new.md": "hello\nworld\n" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ path: "notes/new.md", changeType: "untracked", binary: false, oldPath: null, additions: 2, deletions: 0 });
    expect(r.files[0].hunks).toEqual([
      { header: "@@ -0,0 +1,2 @@", lines: [{ kind: "add", text: "hello" }, { kind: "add", text: "world" }] },
    ]);
    expect(r.truncated).toBe(false);
  });

  it("CRLF 剥 \\r、无尾换行末行保留", async () => {
    const deps = makeDeps({ status: UN_STATUS, diff: "", untrackedFiles: { "notes/new.md": "a\r\nb" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].hunks?.[0].lines).toEqual([{ kind: "add", text: "a" }, { kind: "add", text: "b" }]);
  });

  it("空文件 → hunks=[]（列出但无内容行），不截断", async () => {
    const deps = makeDeps({ status: UN_STATUS, diff: "", untrackedFiles: { "notes/new.md": "" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0]).toMatchObject({ additions: 0, hunks: [] });
    expect(r.truncated).toBe(false);
  });

  it("行数超限（maxUntrackedLines）：只展示前 N 行且 truncated=true", async () => {
    const deps = makeDeps({ status: UN_STATUS, diff: "", untrackedFiles: { "notes/new.md": "l1\nl2\nl3\nl4\nl5\n" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, { ...AMPLE, maxUntrackedLines: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].additions).toBe(3);
    expect(r.files[0].hunks?.[0].lines).toHaveLength(3);
    expect(r.files[0].hunks?.[0].lines[2]).toEqual({ kind: "add", text: "l3" });
    expect(r.truncated).toBe(true);
  });

  it("字节超限（内容长于 maxBytes）：残行丢弃且 truncated=true", async () => {
    // 14 字节内容恰达 maxBytes=14：末行无换行视为被切断的残行丢弃
    const deps = makeDeps({ status: UN_STATUS, diff: "", untrackedFiles: { "notes/new.md": "aaaa\nbbbb\ncccc" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, { ...AMPLE, maxBytes: 14 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].hunks?.[0].lines).toEqual([{ kind: "add", text: "aaaa" }, { kind: "add", text: "bbbb" }]);
    expect(r.truncated).toBe(true);
  });

  it("二进制探测（前 8000 字节含 NUL，对齐 git 自身判定）→ binary=true + hunks=null，不计行数", async () => {
    const binStatus = ["?? assets/icon.png", ""].join("\0");
    const deps = makeDeps({ status: binStatus, diff: "", untrackedFiles: { "assets/icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]) } });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0]).toMatchObject({ path: "assets/icon.png", changeType: "untracked", binary: true, hunks: null, additions: 0 });
    expect(r.truncated).toBe(false);
  });

  it("读取失败（竞态删除/权限）→ 仅列名不展开，整体结果不失败", async () => {
    const deps = makeDeps({ status: UN_STATUS, diff: "", untrackedFiles: { "notes/new.md": null } });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0]).toMatchObject({ path: "notes/new.md", binary: false, hunks: null, additions: 0 });
    expect(r.truncated).toBe(false);
  });
});

describe("maxFiles 文件数上限（#47：窗口外仅列名不采集）", () => {
  it("7 文件 fixture + maxFiles=3：前 3 保留内容，其余仅列名，truncated=true，窗口外 untracked 不发起文件读取", async () => {
    const deps = makeDeps({ untrackedFiles: { "notes/diff-parsing.md": "x\n", "notes/other.md": "y\n" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, { ...AMPLE, maxFiles: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.files).toHaveLength(7);
    expect(r.files.slice(0, 3).every((f) => f.hunks !== null)).toBe(true);
    expect(r.files.slice(3).every((f) => f.hunks === null)).toBe(true);
    // 窗口外（索引 5、6 ≥ maxFiles=3）untracked 不读取文件内容
    expect(deps.readFileCalls).toEqual([]);
  });
});

describe("maxBytes 采集字节上限（#47：stdout 超限 → truncated + 末节丢弃 + status 对账补名）", () => {
  // chat-store 完整节 + big.ts 残节（截断点落在 hunk 行中间）
  const CAPPED_DIFF = [
    "diff --git a/apps/chat-store.ts b/apps/chat-store.ts",
    "--- a/apps/chat-store.ts",
    "+++ b/apps/chat-store.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "diff --git a/big.ts b/big.ts",
    "--- a/big.ts",
    "+++ b/big.ts",
    "@@ -1 +1 @@",
    "-old",
    "+ne", // 截断残行
  ].join("\n");
  const CAP_STATUS = ["M  apps/chat-store.ts", "M  big.ts", "M  tail.ts", "?? notes/new.md", ""].join("\0");

  it("diff 被截：完整节保留 hunks；残节整节丢弃；未覆盖 tracked 由 status 对账仅列名；untracked 全文不受影响", async () => {
    const deps = makeDeps({ status: CAP_STATUS, diff: CAPPED_DIFF, diffCapped: true, untrackedFiles: { "notes/new.md": "hello\n" } });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["apps/chat-store.ts", "big.ts", "tail.ts", "notes/new.md"]);
    expect(r.files[0].hunks?.[0].lines).toHaveLength(2); // 完整节内容保留
    expect(r.files[1]).toMatchObject({ path: "big.ts", changeType: "modified", hunks: null, additions: 0, deletions: 0 });
    expect(r.files[2]).toMatchObject({ path: "tail.ts", changeType: "modified", hunks: null });
    expect(r.files[3].hunks?.[0].lines).toEqual([{ kind: "add", text: "hello" }]);
  });

  it("status 被截：末条目（可能残名）丢弃 + truncated=true；已解析 diff 节正常返回", async () => {
    const deps = makeDeps({ status: "M  apps/chat-store.ts\0M  bi", statusCapped: true, diff: CAPPED_DIFF });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.files.map((f) => f.path)).toContain("apps/chat-store.ts");
    expect(r.files.some((f) => f.path === "bi")).toBe(false); // 残名条目不出现
  });

  it("status 被截不误判为 git 失败（截断不算非 0 退出）", async () => {
    const deps = makeDeps({ status: "M  a.ts\0", statusCapped: true });
    const r = await readWorkspaceDiff(newTempDir(), deps, AMPLE);
    expect(r.ok).toBe(true);
  });
});

describe("parseUnifiedDiff（解析器边界）", () => {
  it("空输入 → 空数组", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("多 hunk 同文件：hunks 顺序保留", () => {
    const out = parseUnifiedDiff(
      [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,2 +1,2 @@",
        "-a",
        "+b",
        "@@ -10,2 +10,2 @@",
        "-c",
        "+d",
      ].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0].hunks).toHaveLength(2);
    expect(out[0].hunks?.[1].header).toBe("@@ -10,2 +10,2 @@");
    expect(out[0]).toMatchObject({ additions: 2, deletions: 2 });
  });
});
