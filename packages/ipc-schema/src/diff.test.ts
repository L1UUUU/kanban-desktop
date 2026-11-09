// 用途：diff wire 契约测试（issue #43，spec #40 D/E 节）—— diff:ipc 请求单通道联合 + 工作区 diff 结果（文件/hunk/行三级行状 + 四档错误 + 全局 truncated 占位）
import { describe, expect, it } from "vitest";
import { diffRequestSchema, diffResultSchema } from "./diff";

/** 最小合法 hunk（含上下文/新增/删除三性行） */
const hunk = {
  header: "@@ -180,6 +180,24 @@ export class ChatStore {",
  lines: [
    { kind: "context", text: "    case \"session_status\":" },
    { kind: "del", text: "      if (event.status === \"disconnected\") {" },
    { kind: "add", text: "      if (event.status === \"disconnected\") {" },
  ],
};

/** 最小合法修改文件行 */
const modifiedFile = {
  path: "apps/desktop/src/features/chat/chat-store.ts",
  changeType: "modified",
  binary: false,
  oldPath: null,
  hunks: [hunk],
  additions: 2,
  deletions: 1,
};

describe("diffRequestSchema", () => {
  it("diff:get {projectId} 合法；空 projectId 拒绝", () => {
    expect(diffRequestSchema.parse({ channel: "diff:get", projectId: "p-1" })).toEqual({
      channel: "diff:get",
      projectId: "p-1",
    });
    expect(diffRequestSchema.safeParse({ channel: "diff:get", projectId: "" }).success).toBe(false);
  });

  it("未知通道拒绝（单通道判别联合）", () => {
    expect(diffRequestSchema.safeParse({ channel: "diff:rollback" }).success).toBe(false);
  });
});

describe("diffResultSchema", () => {
  it("成功形状：files + truncated 往返等值", () => {
    const ok = { ok: true, files: [modifiedFile], truncated: false };
    expect(diffResultSchema.parse(ok)).toEqual(ok);
  });

  it("全类型徽标行合法：added/deleted/renamed/untracked/binary", () => {
    const res = diffResultSchema.safeParse({
      ok: true,
      truncated: false,
      files: [
        { path: "b.ts", changeType: "added", binary: false, oldPath: null, hunks: [], additions: 52, deletions: 0 },
        { path: "c.ts", changeType: "deleted", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 18 },
        { path: "d.ts", changeType: "renamed", binary: false, oldPath: "old/d.ts", hunks: null, additions: 0, deletions: 0 },
        { path: "notes/x.md", changeType: "untracked", binary: false, oldPath: null, hunks: null, additions: 0, deletions: 0 },
        { path: "assets/logo.png", changeType: "modified", binary: true, oldPath: null, hunks: null, additions: 0, deletions: 0 },
      ],
    });
    expect(res.success).toBe(true);
  });

  it("四档错误逐档合法（not-a-repo / git-missing / git-failed / missing-cwd）", () => {
    for (const kind of ["not-a-repo", "git-missing", "git-failed", "missing-cwd"] as const) {
      expect(diffResultSchema.safeParse({ ok: false, kind, message: "说明" }).success).toBe(true);
    }
  });

  it("非法错误档拒绝（错误档为闭枚举）", () => {
    expect(diffResultSchema.safeParse({ ok: false, kind: "exploded", message: "x" }).success).toBe(false);
  });

  it("IPC 错误信封合法（项目不存在等复用全局错误码，spec D 节）", () => {
    expect(
      diffResultSchema.safeParse({ ok: false, error: { code: "E_PROJECT_NOT_FOUND", message: "项目不存在：p-x" } }).success,
    ).toBe(true);
  });

  it("行 kind 为闭枚举：hunk/add/del 外拒绝", () => {
    const bad = {
      ok: true,
      truncated: false,
      files: [{ ...modifiedFile, hunks: [{ header: "@@", lines: [{ kind: "meta", text: "x" }] }] }],
    };
    expect(diffResultSchema.safeParse(bad).success).toBe(false);
  });
});
