// 用途：残留通知条密封测试（#49 spec #40 G/I-4 节）—— 警示条 + 进程表（勾选/PID/进程/启动时间/关联记录）、「无会话记录」默认不勾选（防误杀）、清理选中逐 pid 结果回报（killed 移除 / failed 保留并显示原因）、忽略本次；F18 banner 叠加顺序（退出条 → 残留条 → 会话级条）
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ResidueKillResult, ResidueProcess } from "@kanban/ipc-schema";
import { AppShell } from "../../App";
import { ResidueBanner } from "./ResidueBanner";

/** 样本残留清单：一条有精确会话记录、一条无（防误杀默认不勾） */
const SAMPLE: ResidueProcess[] = [
  { pid: 18432, exePath: "C:\\npm\\@openai\\codex\\codex.exe", startedAt: "2026-11-09T01:12:00.000Z", sessionTitle: "实现 Diff 解析" },
  { pid: 19004, exePath: "C:\\npm\\opencode-ai\\opencode.exe", startedAt: null, sessionTitle: null },
];

/** 含疑似回落行的清单（P2：suspectedSessionTitle 仅展示「疑似」提示，不参与默认勾选） */
const SAMPLE_WITH_SUSPECT: ResidueProcess[] = [
  ...SAMPLE,
  { pid: 19256, exePath: "C:\\npm\\@openai\\codex\\codex.exe", startedAt: null, sessionTitle: null, suspectedSessionTitle: "修复启动崩溃" },
];

function row(pid: number): HTMLElement {
  return screen.getByTestId(`residue-row-${pid}`);
}

function checkbox(pid: number): HTMLInputElement {
  return screen.getByLabelText(`勾选 PID ${pid}`) as HTMLInputElement;
}

describe("ResidueBanner（残留通知条）", () => {
  it("警示条 + 进程表五列与行内容（原型 d4 必须一致项：勾选/PID/进程/启动时间/关联记录）；疑似回落行显示「疑似」提示且不称会话记录", () => {
    render(<ResidueBanner processes={SAMPLE_WITH_SUSPECT} onKill={vi.fn()} onDismiss={vi.fn()} />);
    const banner = screen.getByTestId("residue-banner");
    expect(banner.textContent).toContain("检测到 3 个疑似残留 CLI 进程");
    expect(banner.textContent).toContain("清理前请确认它们不是你自己打开的");
    expect(screen.getByTestId("residue-table")).toBeTruthy();
    const tableHead = within(screen.getByTestId("residue-table")).getAllByRole("columnheader");
    expect(tableHead.map((th) => th.textContent)).toEqual(["", "PID", "进程", "启动时间", "关联记录"]);
    expect(row(18432).textContent).toContain("18432");
    expect(row(18432).textContent).toContain("codex.exe");
    expect(row(18432).textContent).toContain("会话「实现 Diff 解析」");
    expect(row(19004).textContent).toContain("无会话记录");
    expect(row(19256).textContent).toContain("疑似上次会话「修复启动崩溃」"); // P2：回落仅「疑似」展示
    expect(screen.getByRole("button", { name: "清理选中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "忽略本次" })).toBeTruthy();
  });

  it("「无会话记录」默认不勾选（防误杀）；有会话记录默认勾选；疑似回落行默认同样不勾选（P2：同 CLI 有历史会话不等于本进程属于它）", () => {
    render(<ResidueBanner processes={SAMPLE_WITH_SUSPECT} onKill={vi.fn()} onDismiss={vi.fn()} />);
    expect(checkbox(18432).checked).toBe(true);
    expect(checkbox(19004).checked).toBe(false);
    expect(checkbox(19256).checked).toBe(false);
  });

  it("空清单不渲染任何 UI（无残留不打扰）", () => {
    const { container } = render(<ResidueBanner processes={[]} onKill={vi.fn()} onDismiss={vi.fn()} />);
    expect(container.querySelector('[data-testid="residue-banner"]')).toBeNull();
  });

  it("清理选中：仅传勾选 pid；killed 移除、failed 保留并显示失败原因；全部清理后条消失", async () => {
    const onKill = vi.fn().mockImplementation(async (pids: number[]): Promise<ResidueKillResult[]> => {
      expect(pids).toEqual([18432, 19004]); // 默认勾选 + 手动勾选的无记录行
      return [
        { pid: 18432, status: "killed" },
        { pid: 19004, status: "failed", error: "taskkill 退出码 5：拒绝访问" },
      ];
    });
    const onDismiss = vi.fn();
    render(<ResidueBanner processes={SAMPLE} onKill={onKill} onDismiss={onDismiss} />);
    // 手动勾上第二条一起清理
    fireEvent.click(checkbox(19004));
    fireEvent.click(screen.getByRole("button", { name: "清理选中" }));
    await waitFor(() => {
      // failed 的 19004 保留并回报失败原因
      expect(row(19004).textContent).toContain("终止失败：taskkill 退出码 5：拒绝访问");
    });
    // killed 的 18432 已移除
    expect(screen.queryByTestId("residue-row-18432")).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled(); // 仍有残留行：条不消失
    // failed 行保持勾选便于重试；重试成功 → 清空 → 条消失
    expect(checkbox(19004).checked).toBe(true);
    onKill.mockResolvedValue([{ pid: 19004, status: "killed" }]);
    fireEvent.click(screen.getByRole("button", { name: "清理选中" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it("忽略本次：条消失（onDismiss，下次启动重新检测）", () => {
    const onDismiss = vi.fn();
    render(<ResidueBanner processes={SAMPLE} onKill={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "忽略本次" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("banner 叠加顺序（spec #40 F18：全局条在上、会话级条在下）", () => {
  it("退出条 → 残留条（两条全局条固定顺序：退出在最上）→ 会话工作区，DOM 物理顺序一致", () => {
    render(
      <AppShell
        transport={null}
        shutdownNotice="正在退出应用"
        residue={SAMPLE}
        onKillResidue={vi.fn()}
        onDismissResidue={vi.fn()}
      />,
    );
    const shutdown = screen.getByTestId("shutdown-banner");
    const residue = screen.getByTestId("residue-banner");
    // shutdown 在 residue 之前（全局层内固定顺序：退出条最上）
    expect(shutdown.compareDocumentPosition(residue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 残留条在主工作区（会话级 banner 所在层）之前：全局条在上、会话级在下
    const workspace = residue.nextElementSibling!;
    expect(workspace).toBeTruthy();
    expect(workspace.compareDocumentPosition(residue) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});
