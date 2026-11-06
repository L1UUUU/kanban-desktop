// 用途：真实 ConPTY 冒烟（env-gated：KANBAN_E2E=1，spec Testing seam 5 / #12 验收第 4 条）—— claude TUI 进出 + resize；PowerShell 回显/resize 对照。断言口径沿用 t0-03（首数据/回显往返/退出事件），经真实 createPtyHost + node-pty 驱动
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePty from "node-pty";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPtyHost, type PtyHost, type TerminalEventSink } from "../../electron/main/pty-host";

// 未配置 env 时整组跳过（CI/常规 pnpm test 不触发真实 ConPTY）
const E2E = process.env.KANBAN_E2E === "1";

/** 轮询等待条件成立（真实 PTY 输出为异步流） */
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
}

describe.skipIf(!E2E)("真实 ConPTY 冒烟（KANBAN_E2E=1）", () => {
  let tmpRoot = "";
  let output = "";
  const exits: Array<{ terminalId: string; exitCode: number; signal?: number }> = [];
  let host: PtyHost;

  const sink: TerminalEventSink = {
    started: () => undefined,
    data: (_id, data) => {
      output += data;
    },
    exit: (terminalId, info) => exits.push({ terminalId, ...info }),
    error: () => undefined,
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-conpty-"));
    output = "";
    exits.length = 0;
    host = createPtyHost(
      {
        pty: nodePty,
        execFileSync: (cmd, args, opts) => {
          execFileSync(cmd, args, opts);
        },
        execFileTextSync: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }) as string,
        existsSync,
        resolve: (p) => join(p),
        tmpdir: () => tmpdir(),
        env: process.env,
        platform: process.platform,
        cwd: () => process.cwd(),
        shellOverride: () => null,
        cliExeOverride: () => null,
      },
      sink,
    );
  });

  afterEach(() => {
    // 停全部（应用 before-quit 等价路径）；kill 后偶发 AttachConsole stderr 噪音无害（t0-03 §4）
    host.killAll();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it(
    "PowerShell：spawn → 提示符 → 回显往返 → resize 后续活（列数变化不中断）",
    { timeout: 45_000 },
    async () => {
      const r = host.spawn("t-ps", { cwd: tmpRoot, cols: 80, rows: 30 });
      expect(r.ok).toBe(true);
      // 首数据：PowerShell 提示符（PS ...>）
      await waitFor(() => /PS [^>]*>/.test(output), 15_000, "PowerShell 提示符");

      // 回显往返（t0-03 口径）
      host.write("t-ps", "echo KB-CONPTY-PS\r");
      await waitFor(() => output.includes("KB-CONPTY-PS"), 15_000, "echo 回显");

      // resize 生效：改列数后命令仍可执行（进程未因 resize 中断）
      host.resize("t-ps", 120, 40);
      host.write("t-ps", "echo KB-AFTER-RESIZE\r");
      await waitFor(() => output.includes("KB-AFTER-RESIZE"), 15_000, "resize 后回显");

      // 退出：exit 事件携带 terminalId
      host.write("t-ps", "exit\r");
      await waitFor(() => exits.some((e) => e.terminalId === "t-ps"), 15_000, "exit 事件");
    },
  );

  it(
    "claude TUI：command 模式 spawn → TUI 首屏（ANSI 画面）→ resize 重绘 → 双 Ctrl+C 退出",
    { timeout: 120_000 },
    async (ctx) => {
      // claude 不可用则动态跳过（环境缺 CLI 不是失败）
      try {
        execFileSync("where", ["claude"], { stdio: "ignore" });
      } catch {
        ctx.skip();
        return;
      }

      const r = host.spawn("t-claude", { cwd: tmpRoot, cols: 100, rows: 34, command: { exe: "claude" } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      // TUI 首屏：claude 品牌文本 + ANSI 控制序列（画面绘制证据）
      await waitFor(() => /claude/i.test(output) && output.includes("\x1b["), 60_000, "claude TUI 首屏");

      // resize：列数变化触发 TUI 重绘（输出继续到达）
      const before = output.length;
      host.resize("t-claude", 120, 40);
      await waitFor(() => output.length > before + 50, 20_000, "resize 后 TUI 重绘输出");

      // 退出：双 Ctrl+C（TUI 惯例退出路径），间隔给 TUI 处理时间
      host.write("t-claude", "\x03");
      await new Promise((res) => setTimeout(res, 800));
      host.write("t-claude", "\x03");
      await waitFor(() => exits.some((e) => e.terminalId === "t-claude"), 45_000, "claude 退出事件");
    },
  );
});
