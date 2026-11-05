// 用途：目录身份判定测试 —— cwd/.git 目录=主仓库 / 文件=worktree（解析 gitdir 取名）/ 均无=none（工单 #7 验收第 3 条，spec I-3）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectDirIdentity } from "./git-identity";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 建临时 fixture 根目录 */
function makeTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-gitid-"));
  return tmpRoot;
}

describe("detectDirIdentity", () => {
  it("cwd/.git 是目录 → 主仓库", () => {
    const root = makeTmp();
    const repo = join(root, "main-repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(detectDirIdentity(repo)).toEqual({ kind: "main" });
  });

  it("cwd/.git 是文件（gitdir 绝对路径）→ worktree，取末段为名", () => {
    const root = makeTmp();
    const wt = join(root, "wt-poc7");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "main-repo", ".git", "worktrees", "poc7")}\n`, "utf8");
    expect(detectDirIdentity(wt)).toEqual({ kind: "worktree", name: "poc7" });
  });

  it("cwd/.git 是文件（gitdir 相对路径，正反斜杠）→ resolve 后取名", () => {
    const root = makeTmp();
    const wt = join(root, "wt-rel");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: ../main-repo/.git/worktrees/rel7", "utf8");
    expect(detectDirIdentity(wt)).toEqual({ kind: "worktree", name: "rel7" });
    writeFileSync(join(wt, ".git"), `gitdir: ..\\main-repo\\.git\\worktrees\\back7`, "utf8");
    expect(detectDirIdentity(wt)).toEqual({ kind: "worktree", name: "back7" });
  });

  it("非 git 目录（无 .git）→ none", () => {
    const root = makeTmp();
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(detectDirIdentity(plain)).toEqual({ kind: "none" });
    expect(detectDirIdentity(join(root, "not-exist"))).toEqual({ kind: "none" });
  });

  it(".git 文件内容不含 gitdir 行 → 容错为 none", () => {
    const root = makeTmp();
    const wt = join(root, "wt-broken");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "garbage content", "utf8");
    expect(detectDirIdentity(wt)).toEqual({ kind: "none" });
  });
});
