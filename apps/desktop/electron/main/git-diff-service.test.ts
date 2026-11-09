// 用途：git-diff-service 密封测试（issue #43，spec #40 A/E 节）—— 固定 git 输出 fixture 断言统一解析（M/A/D/R/U/hunks 形状 + binary + 无 HEAD 空仓回退）+ 四档错误逐档 + 解析器边界（含 No newline 尾标/多 untracked/重命名状态跳过原路径 token）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStatusPorcelain, parseUnifiedDiff, readWorkspaceDiff, type GitDiffDeps, type GitRunOutcome } from "./git-diff-service";

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

/** 造 deps：rev-parse --is-inside-work-tree 恒真；HEAD 可解析；status/diff 返回 fixture */
function makeDeps(overrides?: {
  resolveGitExe?: () => string | null;
  status?: string;
  diff?: string;
  diffCode?: number;
  headCode?: number;
}): GitDiffDeps & { calls: Array<{ exe: string; args: string[]; cwd: string }> } {
  const calls: Array<{ exe: string; args: string[]; cwd: string }> = [];
  const ok = (stdout: string): GitRunOutcome => ({ code: 0, stdout, stderr: "" });
  return {
    calls,
    resolveGitExe: overrides?.resolveGitExe ?? (() => "C:/Program Files/Git/bin/git.exe"),
    runGit: async (exe, args, cwd) => {
      calls.push({ exe, args, cwd });
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return ok("true\n");
      }
      if (args[0] === "rev-parse" && args.includes("HEAD")) {
        return overrides?.headCode === 128 ? { code: 128, stdout: "", stderr: "" } : ok("abc123\n");
      }
      if (args[0] === "status") return ok(overrides?.status ?? STATUS_FIXTURE);
      if (args[0] === "diff") {
        if (overrides?.diffCode != null) return { code: 129, stdout: "", stderr: "fatal: diff blew up" };
        return ok(overrides?.diff ?? DIFF_FIXTURE);
      }
      return { code: 1, stdout: "", stderr: "unexpected command" };
    },
  };
}

describe("readWorkspaceDiff 成功形状（固定 git 输出解析）", () => {
  it("M/A/D/R/U 五类文件行 + binary + hunk 行级形状 + truncated 占位 false", async () => {
    const cwd = newTempDir();
    const deps = makeDeps();
    const r = await readWorkspaceDiff(cwd, deps);
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
    // U：untracked 列出即可（全文 #47），hunks null
    expect(u1).toMatchObject({ path: "notes/diff-parsing.md", changeType: "untracked", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 });
    expect(u2).toMatchObject({ path: "notes/other.md", changeType: "untracked" });
  });

  it("git 命令按序发起且 diff 基准为 HEAD（rev-parse --verify HEAD 成功）", async () => {
    const cwd = newTempDir();
    const deps = makeDeps();
    await readWorkspaceDiff(cwd, deps);
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
    const r = await readWorkspaceDiff(cwd, deps);
    expect(r.ok).toBe(true);
    const diffCall = deps.calls.find((c) => c.args[0] === "diff");
    expect(diffCall?.args[1]).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

describe("readWorkspaceDiff 四档错误", () => {
  it("missing-cwd：目录不存在", async () => {
    const r = await readWorkspaceDiff(join(newTempDir(), "gone"), makeDeps());
    expect(r).toEqual({ ok: false, kind: "missing-cwd", message: expect.stringContaining("项目目录不存在") });
  });

  it("git-missing：git 可执行不可解析（解析返回 null）", async () => {
    const r = await readWorkspaceDiff(newTempDir(), makeDeps({ resolveGitExe: () => null }));
    expect(r).toEqual({ ok: false, kind: "git-missing", message: expect.stringContaining("git") });
  });

  it("git-missing：spawn ENOENT（解析成功但可执行消失）", async () => {
    const deps = makeDeps();
    deps.runGit = async () => ({ code: -1, stdout: "", stderr: "", spawnError: new Error("spawn C:/git.exe ENOENT") });
    const r = await readWorkspaceDiff(newTempDir(), deps);
    expect(r).toMatchObject({ ok: false, kind: "git-missing" });
  });

  it("not-a-repo：rev-parse 128 + stderr 含 not a git repository", async () => {
    const deps = makeDeps();
    deps.runGit = async (_exe, args) =>
      args[0] === "rev-parse"
        ? { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" }
        : { code: 0, stdout: "", stderr: "" };
    const r = await readWorkspaceDiff(newTempDir(), deps);
    expect(r).toMatchObject({ ok: false, kind: "not-a-repo" });
  });

  it("not-a-repo：is-inside-work-tree 输出 false（.git 目录内部）", async () => {
    const deps = makeDeps();
    deps.runGit = async (_exe, args) => ({ code: 0, stdout: args[0] === "rev-parse" ? "false" : "", stderr: "" });
    const r = await readWorkspaceDiff(newTempDir(), deps);
    expect(r).toMatchObject({ ok: false, kind: "not-a-repo" });
  });

  it("git-failed：rev-parse 非预期失败（stderr 无 not-a-repo 字样）", async () => {
    const deps = makeDeps();
    deps.runGit = async (_exe, args) =>
      args[0] === "rev-parse"
        ? { code: 128, stdout: "", stderr: "fatal: bad config line 1 in file .git/config" }
        : { code: 0, stdout: "", stderr: "" };
    const r = await readWorkspaceDiff(newTempDir(), deps);
    expect(r).toMatchObject({ ok: false, kind: "git-failed", message: expect.stringContaining("bad config") });
  });

  it("git-failed：diff 子命令失败透传 stderr", async () => {
    const r = await readWorkspaceDiff(newTempDir(), makeDeps({ diffCode: 129 }));
    expect(r).toMatchObject({ ok: false, kind: "git-failed", message: expect.stringContaining("diff blew up") });
  });

  it("git-failed：spawn 非 ENOENT 失败", async () => {
    const deps = makeDeps();
    deps.runGit = async () => ({ code: -1, stdout: "", stderr: "", spawnError: new Error("spawn EACCES: permission denied") });
    const r = await readWorkspaceDiff(newTempDir(), deps);
    expect(r).toMatchObject({ ok: false, kind: "git-failed" });
  });
});

describe("parseStatusPorcelain（-z 解析边界）", () => {
  it("重命名条目跳过原路径 token 不误判为独立条目", () => {
    const out = parseStatusPorcelain("R  to.ts\0from.ts\0?? a.md\0?? b.md\0");
    expect(out).toEqual(["a.md", "b.md"]);
  });

  it("无 untracked → 空数组", () => {
    expect(parseStatusPorcelain("M  x.ts\0 D y.ts\0")).toEqual([]);
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
