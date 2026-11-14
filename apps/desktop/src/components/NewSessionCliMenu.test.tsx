// 用途：NewSessionCliMenu 密封测试（arch D9）—— open 经 transport seam（mock transport 而非 window.api）拉安装表：未装灰置 +「未安装」尾注 + 悬停说明、已装与 PTY 恒可选（ptyNote 尾注）、选中即 onClose+onPick、通道未接/查询失败不拦、open=false 不拉不渲染、重开重探（未装不缓存）、itemTestIdPrefix 定位面
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliInstalledMap } from "@kanban/ipc-schema";
import type { CliStatusChannel } from "../lib/use-cli-status";
import { CLI_NOT_INSTALLED_HINT } from "../lib/use-cli-status";
import { NewSessionCliMenu, type NewSessionCliMenuProps } from "./NewSessionCliMenu";

/** fake cli:status 通道：记录请求 + 可变应答（flip 驱动「模拟装完」；failNext 切换失败应答） */
function fakeChannel(initial: CliInstalledMap) {
  let installed = initial;
  let fail = false;
  const requests: unknown[] = [];
  const channel: CliStatusChannel = {
    invokeCliStatus: async (req) => {
      requests.push(req);
      if (fail) return { ok: false, error: { code: "E_INTERNAL", message: "探测异常" } };
      return { ok: true, installed };
    },
  };
  return {
    channel,
    requests,
    flip(next: CliInstalledMap) {
      installed = next;
    },
    failNext() {
      fail = true;
    },
  };
}

/** 挂载菜单（缺省 open + 详情面板口径的尾注/锚点/字号/testid 前缀；props 覆盖） */
function mountMenu(props: Partial<NewSessionCliMenuProps> = {}) {
  const onClose = vi.fn();
  const onPick = vi.fn();
  render(
    <NewSessionCliMenu
      open
      onClose={onClose}
      onPick={onPick}
      ptyNote="无 skill 信号"
      menuClassName="left-0 min-w-[190px]"
      itemClassName="text-xs"
      itemTestIdPrefix="new-session-item"
      {...props}
    />,
  );
  return { onClose, onPick };
}

afterEach(cleanup);

describe("NewSessionCliMenu（arch D9：侧栏与详情面板两处「＋」菜单单一实现）", () => {
  it("open 即经 transport 拉安装表（cli:status）；未装项灰置 + 「未安装」尾注 + 悬停说明，点击无效", async () => {
    const { channel, requests } = fakeChannel({ codex: true, claude: false, opencode: true });
    const h = mountMenu({ transport: channel });
    const claudeItem = await waitFor(() => {
      const el = screen.getByTestId("new-session-item-claude") as HTMLButtonElement;
      expect(el.disabled).toBe(true);
      return el;
    });
    expect(requests).toEqual([{ channel: "cli:status" }]);
    expect(claudeItem.textContent).toContain("未安装");
    expect(claudeItem.getAttribute("title")).toBe(CLI_NOT_INSTALLED_HINT);
    fireEvent.click(claudeItem);
    expect(h.onPick).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("已装项可选：点击 → onClose + onPick({ kind: 'structured', cli })", () => {
    const { channel } = fakeChannel({ codex: true, claude: true, opencode: true });
    const h = mountMenu({ transport: channel });
    fireEvent.click(screen.getByTestId("new-session-item-codex"));
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onPick).toHaveBeenCalledWith({ kind: "structured", cli: "codex" });
  });

  it("PTY 项恒可选（有未装项也不灰置）+ ptyNote 尾注；点击 → onClose + onPick({ kind: 'pty' })", async () => {
    const { channel } = fakeChannel({ codex: true, claude: false, opencode: true });
    const h = mountMenu({ transport: channel });
    await waitFor(() => expect((screen.getByTestId("new-session-item-claude") as HTMLButtonElement).disabled).toBe(true));
    const ptyItem = screen.getByTestId("new-session-item-pty") as HTMLButtonElement;
    expect(ptyItem.disabled).toBe(false);
    expect(ptyItem.textContent).toContain("无 skill 信号");
    fireEvent.click(ptyItem);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onPick).toHaveBeenCalledWith({ kind: "pty" });
  });

  it("通道未接（transport=null，旧 fake/降级口径）：全部可选不灰置，不发生请求", () => {
    const h = mountMenu({ transport: null });
    const claudeItem = screen.getByTestId("new-session-item-claude") as HTMLButtonElement;
    expect(claudeItem.disabled).toBe(false);
    expect(claudeItem.textContent).not.toContain("未安装");
    fireEvent.click(claudeItem);
    expect(h.onPick).toHaveBeenCalledWith({ kind: "structured", cli: "claude" });
  });

  it("查询失败（ok:false）：不拦菜单（点击后由创建链报错）", async () => {
    const { channel, requests, failNext } = fakeChannel({ codex: true, claude: false, opencode: true });
    failNext();
    mountMenu({ transport: channel });
    await waitFor(() => expect(requests.length).toBe(1)); // 拉取已发生且失败
    expect((screen.getByTestId("new-session-item-claude") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("new-session-item-claude").textContent).not.toContain("未安装");
  });

  it("open=false：不渲染不拉取；翻开即拉取渲染", async () => {
    const { channel, requests } = fakeChannel({ codex: true, claude: false, opencode: true });
    const base: Omit<NewSessionCliMenuProps, "open"> = {
      transport: channel,
      onClose: () => undefined,
      onPick: () => undefined,
      menuClassName: "left-0 min-w-[190px]",
      itemClassName: "text-xs",
      itemTestIdPrefix: "new-session-item",
    };
    const view = render(<NewSessionCliMenu open={false} {...base} />);
    expect(screen.queryByTestId("new-session-item-codex")).toBeNull();
    expect(requests).toEqual([]);

    view.rerender(<NewSessionCliMenu open {...base} />);
    await waitFor(() => expect((screen.getByTestId("new-session-item-claude") as HTMLButtonElement).disabled).toBe(true));
    expect(requests).toEqual([{ channel: "cli:status" }]);
  });

  it("重开重探（未装不缓存）：flip 后关开重拉，未装项恢复可选", async () => {
    const { channel, flip } = fakeChannel({ codex: true, claude: false, opencode: true });
    const base: Omit<NewSessionCliMenuProps, "open"> = {
      transport: channel,
      onClose: () => undefined,
      onPick: () => undefined,
      menuClassName: "left-0 min-w-[190px]",
      itemClassName: "text-xs",
      itemTestIdPrefix: "new-session-item",
    };
    const view = render(<NewSessionCliMenu open {...base} />);
    await waitFor(() => expect((screen.getByTestId("new-session-item-claude") as HTMLButtonElement).disabled).toBe(true));

    flip({ codex: true, claude: true, opencode: true }); // 模拟装完 CLI
    view.rerender(<NewSessionCliMenu open={false} {...base} />); // 关菜单
    view.rerender(<NewSessionCliMenu open {...base} />); // 重开即重探
    await waitFor(() => expect((screen.getByTestId("new-session-item-claude") as HTMLButtonElement).disabled).toBe(false));
  });

  it("itemTestIdPrefix 缺省（侧栏口径）：项不带 data-testid，按角色名可定位", () => {
    mountMenu({ itemTestIdPrefix: undefined });
    expect(screen.queryByTestId("new-session-item-codex")).toBeNull();
    expect(screen.getByRole("button", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /PTY 终端/ })).toBeTruthy();
  });
});
