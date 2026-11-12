// 用途：主仓库并行冲突判据单测（spec I-4/#13）—— ≥2 活跃（running/waiting）同目录主仓库会话才提示；worktree/断开/空闲/PTY/异目录不计入
import { describe, expect, it } from "vitest";
import type { SessionView } from "./chat-store";
import { detectMainRepoConflict, normalizeCwdKey } from "./conflict";

/** 视图工厂：缺省主仓库 + 指定目录/身份/状态 */
function view(over: Partial<SessionView> & { sessionId: string }): SessionView {
  return {
    cli: "claude",
    title: over.title ?? over.sessionId,
    status: "idle",
    permMode: "auto",
    model: undefined,
    projectId: "p1",
    cwd: "C:\\repo",
    dirIdentity: "main",
    worktreeName: null,
    items: [],
    pendingApproval: null,
    lastTurnInterrupted: false,
    lastError: null,
    ...over,
  } as SessionView;
}

describe("detectMainRepoConflict（spec I-4 冲突提示条判据）", () => {
  it("同目录主仓库 ≥2 活跃（running/waiting）→ 返回会话名列表（含当前会话）", () => {
    const sessions = [
      view({ sessionId: "a", title: "会话A", status: "running" }),
      view({ sessionId: "b", title: "会话B", status: "waiting" }),
      view({ sessionId: "c", title: "会话C", status: "idle" }),
    ];
    expect(detectMainRepoConflict(sessions, "a")).toEqual(["会话A", "会话B"]);
    // 当前会话为 idle 也提示（当前会话属该主仓库即可）
    expect(detectMainRepoConflict(sessions, "c")).toEqual(["会话A", "会话B"]);
  });

  it("单活跃不提示；全部空闲不提示", () => {
    const one = [view({ sessionId: "a", status: "running" }), view({ sessionId: "b", status: "idle" })];
    expect(detectMainRepoConflict(one, "a")).toBeNull();
    const allIdle = [view({ sessionId: "a" }), view({ sessionId: "b" })];
    expect(detectMainRepoConflict(allIdle, "a")).toBeNull();
  });

  it("worktree/断开会话不计入", () => {
    const sessions = [
      view({ sessionId: "a", title: "主A", status: "running" }),
      view({ sessionId: "w", title: "wt", status: "running", dirIdentity: "worktree", worktreeName: "wt" }),
      view({ sessionId: "d", title: "断开", status: "disconnected" }),
    ];
    expect(detectMainRepoConflict(sessions, "a")).toBeNull();
  });

  it("异目录不计入（cwd 归一化大小写/分隔符差异视为同目录）", () => {
    const sessions = [
      view({ sessionId: "a", title: "A", status: "running", cwd: "C:\\Repo" }),
      view({ sessionId: "x", title: "X", status: "running", cwd: "C:\\other" }),
    ];
    expect(detectMainRepoConflict(sessions, "a")).toBeNull();
    const same = [
      view({ sessionId: "a", title: "A", status: "running", cwd: "C:\\Repo" }),
      view({ sessionId: "b", title: "B", status: "running", cwd: "c:/repo/" }),
    ];
    expect(detectMainRepoConflict(same, "a")).toEqual(["A", "B"]);
    expect(normalizeCwdKey("C:\\Repo\\")).toBe(normalizeCwdKey("c:/repo"));
  });

  it("当前会话为 worktree/PTY/不存在 → 不提示", () => {
    const sessions = [
      view({ sessionId: "a", status: "running" }),
      view({ sessionId: "b", status: "running" }),
      view({ sessionId: "w", status: "idle", dirIdentity: "worktree", worktreeName: "wt" }),
    ];
    expect(detectMainRepoConflict(sessions, "w")).toBeNull();
    expect(detectMainRepoConflict(sessions, "nope")).toBeNull();
    const withPty = [
      view({ sessionId: "a", cli: "pty", status: "idle" }),
      view({ sessionId: "b", status: "running" }),
      view({ sessionId: "c", status: "running" }),
    ];
    expect(detectMainRepoConflict(withPty, "a")).toBeNull(); // PTY 会话自身不触发（状态模型无 running）
  });
});
