// PoC 6 演示页：上半区为 PI-Desktop TurnChangesCard（改造后抽离），
// 下半区为旧 Kanban TerminalPanel（原样抽离 + mock terminalApi）。
import { useEffect, useMemo, useState } from "react";
import { TurnChangesCard } from "./pi-desktop/TurnChangesCard";
import type { UiMessage } from "./pi-desktop/types";
import { TerminalPanel } from "./old-kanban/TerminalPanel";
import { installMockTerminalApi } from "./old-kanban/mock-terminal";
import "./demo.css";
import "@xterm/xterm/css/xterm.css";

// 模拟真实 Electron preload 的注入时机：在任何 renderer 组件挂载之前，
// window.terminalApi 就已可用（TerminalPanel 的 effect 依赖它存在）。
installMockTerminalApi();

// 模拟 PI-Desktop 的一轮工具调用：两次 Write/Edit 成功消息，
// toolResult 内嵌上游 review-change 结构（version 1 协议）。
function makeToolMessages(): UiMessage[] {
  const review = (
    path: string,
    status: "added" | "modified" | "deleted",
    additions: number,
    deletions: number,
    snapshotId: string,
  ) => ({
    version: 1,
    snapshotId,
    messageId: `msg-${snapshotId}`,
    path,
    operation: "edit",
    status,
    state: "active",
    additions,
    deletions,
    reversible: true,
    root: "workspace",
    hunks: [
      {
        header: "@@ -1,3 +1,4 @@",
        lines: [
          { type: "context", text: "demo context" },
          { type: "add", text: "+demo add" },
        ],
      },
    ],
  });

  return [
    {
      id: "m1",
      role: "tool",
      toolName: "Write",
      toolCallId: "c1",
      toolStatus: "success",
      content: "",
      createdAt: "2026-11-05T10:00:00Z",
      toolResult: { details: { root: "workspace", review: review("src/app.tsx", "added", 24, 0, "snap-1") } },
    },
    {
      id: "m2",
      role: "tool",
      toolName: "Edit",
      toolCallId: "c2",
      toolStatus: "success",
      content: "",
      createdAt: "2026-11-05T10:01:00Z",
      toolResult: { details: { root: "workspace", review: review("src/lib/utils.ts", "modified", 8, 3, "snap-2") } },
    },
    {
      id: "m3",
      role: "tool",
      toolName: "Edit",
      toolCallId: "c3",
      toolStatus: "success",
      content: "",
      createdAt: "2026-11-05T10:02:00Z",
      toolResult: { details: { root: "workspace", review: review("../outside/renamed-file.md", "modified", 5, 12, "snap-3") } },
    },
    // 一条失败调用：reviewChangeFromMessage 应忽略它（toolStatus !== success）
    {
      id: "m4",
      role: "tool",
      toolName: "Write",
      toolCallId: "c4",
      toolStatus: "error",
      content: "",
      createdAt: "2026-11-05T10:03:00Z",
      toolResult: { message: "EACCES" },
    },
  ];
}

export default function App() {
  const tools = useMemo(makeToolMessages, []);
  const [reviewLog, setReviewLog] = useState<string[]>([]);
  const [termReady, setTermReady] = useState(false);

  useEffect(() => {
    // mock API 已在模块顶层安装（模拟真实 Electron preload 先于 renderer 执行）。
    // 延迟 start()，让 TerminalPanel 的 effect 先注册 onData/onExit handler。
    const timer = setTimeout(() => {
      window.terminalApi
        ?.start({ cwd: "C:\\demo\\project", cols: 80, rows: 24 })
        .then(() => setTermReady(true));
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="demo-page">
      <h1>PoC 6 — 参考组件独立编译实测</h1>

      <section className="demo-section">
        <h2>1. PI-Desktop TurnChangesCard（改造后抽离）</h2>
        <p className="demo-note">
          上游 144 行 + 连带 lib（turn-changed-files / workspace-review 裁剪 /
          ReviewFileIcon / turn-changes.css 原样）；替换了 i18n、zustand、plugin
          slots、disclosure、ui/icons 基础件。点击行触发 onOpenReview 回调（替代
          work-panel 联动）：
        </p>
        <TurnChangesCard
          tools={tools}
          onOpenReview={(ids, expand) =>
            setReviewLog((log) => [
              `openReview(snapshots=${ids.length}, expand=${expand})`,
              ...log.slice(0, 4),
            ])
          }
        />
        {reviewLog.length > 0 && (
          <pre className="demo-log">{reviewLog.join("\n")}</pre>
        )}
      </section>

      <section className="demo-section">
        <h2>2. 旧 Kanban TerminalPanel（原样抽离 + mock PTY）</h2>
        <p className="demo-note">
          TerminalPanel.tsx / terminalApi.ts 与上游 0 diff；浏览器内注入 mock
          window.terminalApi（本地回显 shell）。可输入 clear / exit 验证 PTY
          生命周期事件。真实 PTY 需 Electron main + node-pty（见评估文档风险项）。
          PTY 状态：{termReady ? "running" : "starting…"}
        </p>
        <div className="demo-terminal">
          <TerminalPanel />
        </div>
      </section>
    </main>
  );
}
