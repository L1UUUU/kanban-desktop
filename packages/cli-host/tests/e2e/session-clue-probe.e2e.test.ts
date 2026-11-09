// 用途：会话线索探针（issue #48）——KANBAN_E2E=1 且 KANBAN_SESSION_PROBE=1 才跑：三 CLI 真实驱动带文件操作的工具调用，
// 采集 tool_started/tool_completed 样本，用 tool-path-extract 提取路径并对「实际操作文件」计算命中率；
// 样本明细与命中率落 docs/acceptance/stage4/session-clue-probe-samples.json（探针报告的机器证据）。
// 判据归属：命中率是「发现」不是「通过条件」——本套只断言结构性下限（每 CLI ≥10 个干净样本），不断言 ≥80%。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../../src/claude-adapter";
import { CodexAdapter } from "../../src/codex-adapter";
import { OpenCodeAdapter } from "../../src/opencode-adapter";
import { OpenCodeServerHost } from "../../src/opencode/server-host";
import { extractToolFilePaths, resolveForCompare } from "../../src/tool-path-extract";
import type { AdapterEvent, ChatEvent } from "@kanban/ipc-schema";

const E2E = process.env.KANBAN_E2E === "1";
// 二道细粒度门（先例 KANBAN_PROTOCOL_PROBE）：探针一次性取证会真实花 token，避免随 B 类全量例行重跑
const PROBE = process.env.KANBAN_SESSION_PROBE === "1";
const RUN = E2E && PROBE;

// 真实模型 turn 十秒级：探针每 CLI 4 个 turn，放宽到 10 分钟
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

/** 单条指令：操作类型 + 目标文件（绝对路径）+ 唯一 marker（读写验证用） */
interface OpInstruction {
  kind: "read" | "write" | "edit" | "bash-write" | "patch-edit" | "patch-create";
  file: string;
  marker: string;
}

/** 样本行：一个 tool 事件对（started+completed 同 itemId）→ 提取结果 → 实际文件 → 命中与否 */
interface SampleRow {
  cli: "claude-code" | "codex" | "opencode";
  turn: string;
  itemId: string;
  tool: string;
  argsSummary: string;
  outputExcerpt: string;
  extracted: string[];
  actualFile: string;
  hit: boolean;
  status: "hit" | "miss" | "excluded";
  excludeReason?: string;
}

// 顶层同步初始化（非 RUN 不建目录、不读 magpie 配置）
const root = RUN ? mkdtempSync(path.join(tmpdir(), "kb-clue-probe-")) : "";
const claudeDir = RUN ? path.join(root, "claude") : "";
const codexDir = RUN ? path.join(root, "codex") : "";
const opencodeDir = RUN ? path.join(root, "opencode") : "";
const xdgRoot = RUN ? path.join(root, "xdg") : "";

// OpenCode e2e 同法：只读复制用户全局 magpie provider（内网网关 cost=0；密钥不进 git/日志）
const magpieProvider = RUN
  ? (() => {
      const globalPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".config", "opencode", "opencode.json");
      const cfg = JSON.parse(readFileSync(globalPath, "utf8")) as { provider?: Record<string, unknown> };
      const prov = cfg.provider?.magpie;
      if (!prov) throw new Error("探针需要 ~/.config/opencode/opencode.json 内 magpie provider（只读复制注入）");
      return prov;
    })()
  : null;

if (RUN) {
  for (const dir of [claudeDir, codexDir, opencodeDir]) mkdirSync(dir, { recursive: true });
}

/** 尽力清理（Windows 句柄延迟重试；残留 %TEMP% 不判失败） */
function rmBestEffort(target: string): void {
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      /* 重试 */
    }
  }
}

/** 构造带序号与严格次数约束的指令文本（压制模型自由发挥导致的额外工具调用） */
function numberedPrompt(header: string, ops: string[]): string {
  return [
    header,
    ...ops.map((s, i) => `${i + 1}) ${s}`),
    "请严格按上述条数执行：每条恰好一次、顺序执行，不要合并、不要跳过、也不要执行任何其他工具调用或命令。全部完成后只回复：完成。",
  ].join("\n");
}

/** 提取候选与实际文件是否同一（归一化相等，或都存在时经 realpath 消 8.3 短名/大小写差） */
function sameFile(candidate: string, actual: string, cwd: string): boolean {
  const a = resolveForCompare(candidate, cwd);
  const b = resolveForCompare(actual, cwd);
  if (a === b) return true;
  try {
    return realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  } catch {
    return false;
  }
}

/** 事件流工具配对：started+completed 按 itemId（输出取 completed.output；未配对者跳过） */
function pairToolEvents(slice: ChatEvent[]): Array<{ itemId: string; tool: string; argsSummary: string; output: string }> {
  const started = new Map<string, { tool: string; argsSummary: string }>();
  const pairs: Array<{ itemId: string; tool: string; argsSummary: string; output: string }> = [];
  for (const e of slice) {
    if (e.type === "tool_started") started.set(e.itemId, { tool: e.tool, argsSummary: e.argsSummary });
    else if (e.type === "tool_completed" && started.has(e.itemId)) {
      const st = started.get(e.itemId)!;
      pairs.push({ itemId: e.itemId, tool: st.tool, argsSummary: st.argsSummary, output: e.output });
    }
  }
  return pairs;
}

describe.skipIf(!RUN)("会话线索探针（真实采集，KANBAN_E2E=1 + KANBAN_SESSION_PROBE=1）", () => {
  const rows: SampleRow[] = [];

  /** 通用 driveIdle：running 消失且稳定 800ms（waiting=审批等待视为稳定） */
  function makeDriveIdle(events: AdapterEvent[]): () => Promise<void> {
    return async () => {
      const deadline = Date.now() + 300_000;
      let stableSince = 0;
      for (;;) {
        if (Date.now() > deadline) throw new Error("driveIdle 超时（300s 无空闲）");
        const statuses = new Map<string, string>();
        for (const e of events) if ("type" in e && e.type === "session_status") statuses.set(e.sessionId, e.status);
        const busy = [...statuses.values()].some((s) => s === "running");
        if (!busy) {
          if (stableSince === 0) stableSince = Date.now();
          if (Date.now() - stableSince > 800) return;
        } else {
          stableSince = 0;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    };
  }

  /**
   * 跑一个探针 turn 并产出样本行（归因规则预注册：turn 内工具事件对数 == 指令条数才逐对按序归因，
   * 否则该 turn 全部事件记 excluded——归因只看事件计数与文件系统验证，不看事件内容，避免向提取器偏置）。
   * verification：read=助手回复含 marker；write/bash-write/patch-create=文件存在且含 marker；edit=文件含替换后 marker。
   */
  async function runProbeTurn(args: {
    cli: SampleRow["cli"];
    turn: string;
    events: AdapterEvent[];
    driveIdle: () => Promise<void>;
    sendTurn: (text: string) => Promise<void>;
    sessionId: string;
    cwd: string;
    instructions: OpInstruction[];
    buildOpText: (op: OpInstruction) => string;
  }): Promise<void> {
    const mark = args.events.length;
    await args.sendTurn(numberedPrompt(`本回合请完成 ${args.instructions.length} 个操作：`, args.instructions.map(args.buildOpText)));
    await args.driveIdle();
    const turnEvents = args.events.slice(mark).filter((e): e is ChatEvent => "type" in e && e.sessionId === args.sessionId);
    const pairs = pairToolEvents(turnEvents);
    const assistantText = turnEvents
      .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
      .map((e) => e.delta)
      .join("");
    if (pairs.length !== args.instructions.length) {
      // 零事件也留一行排除记录（模型整轮未执行是真实采集局限，必须可见，不能静默消失）
      if (pairs.length === 0) {
        rows.push({
          cli: args.cli, turn: args.turn, itemId: "", tool: "(none)", argsSummary: "", outputExcerpt: "",
          extracted: [], actualFile: "", hit: false, status: "excluded",
          excludeReason: `本 turn 无任何工具事件（指令 ${args.instructions.length} 条，模型未执行）`,
        });
        return;
      }
      for (const p of pairs) {
        rows.push({
          cli: args.cli, turn: args.turn, itemId: p.itemId, tool: p.tool, argsSummary: p.argsSummary,
          outputExcerpt: p.output.slice(0, 200), extracted: [], actualFile: "", hit: false,
          status: "excluded", excludeReason: `事件对数 ${pairs.length} ≠ 指令数 ${args.instructions.length}（无法无偏归因）`,
        });
      }
      return;
    }
    for (let i = 0; i < pairs.length; i += 1) {
      const p = pairs[i];
      const op = args.instructions[i];
      const okRead = op.kind === "read" ? assistantText.includes(op.marker) || p.output.includes(op.marker) : true;
      const okFile = op.kind === "read" ? true : existsSync(op.file) && readFileSync(op.file, "utf8").includes(op.marker);
      const extracted = extractToolFilePaths({ tool: p.tool, argsSummary: p.argsSummary, output: p.output });
      if (!okRead || !okFile) {
        rows.push({
          cli: args.cli, turn: args.turn, itemId: p.itemId, tool: p.tool, argsSummary: p.argsSummary,
          outputExcerpt: p.output.slice(0, 200), extracted, actualFile: op.file, hit: false,
          status: "excluded", excludeReason: !okRead ? "读验证未通过（助手回复与输出均无 marker）" : "写验证未通过（文件缺失或无 marker）",
        });
        continue;
      }
      const hit = extracted.some((c) => sameFile(c, op.file, args.cwd));
      rows.push({
        cli: args.cli, turn: args.turn, itemId: p.itemId, tool: p.tool, argsSummary: p.argsSummary,
        outputExcerpt: p.output.slice(0, 200), extracted, actualFile: op.file, hit,
        status: hit ? "hit" : "miss",
      });
    }
  }

  /** 每 CLI 汇总（供断言与汇总输出共用） */
  function cliSummary(cli: SampleRow["cli"]): { clean: number; hits: number; rate: number; excluded: number } {
    const of = rows.filter((r) => r.cli === cli);
    const clean = of.filter((r) => r.status !== "excluded");
    const hits = clean.filter((r) => r.hit).length;
    return { clean: clean.length, hits, rate: clean.length ? hits / clean.length : 0, excluded: of.length - clean.length };
  }

  /* ---------------- Claude Code：Read / Write / Edit / Bash ---------------- */
  describe("claude-code", () => {
    let adapter: ClaudeAdapter;
    const events: AdapterEvent[] = [];
    let sid = "";
    let driveIdle: () => Promise<void> = () => Promise.resolve();
    const seed = (name: string, content: string): string => {
      const f = path.join(claudeDir, name);
      writeFileSync(f, content, "utf8");
      return f;
    };

    beforeAll(async () => {
      adapter = new ClaudeAdapter({ log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[claude:${k}] ${d}`) });
      adapter.subscribe((e) => events.push(e));
      driveIdle = makeDriveIdle(events);
      sid = (await adapter.createSession({ cwd: claudeDir, permMode: "full" })).sessionId; // full=bypassPermissions：零审批干扰
    });
    afterAll(async () => {
      await adapter.dispose();
    });

    it("≥10 干净样本：read/write/edit/bash 四类工具", async () => {
      const r1 = seed("r1.txt", "MARK-R1 内容甲");
      const r2 = seed("r2.txt", "MARK-R2 内容乙");
      const r3 = seed("r3.txt", "MARK-R3 内容丙");
      const e1 = seed("e1.txt", "alpha 第一处文本");
      const e2 = seed("e2.txt", "alpha 第二处文本");
      await runProbeTurn({
        cli: "claude-code", turn: "read", events, driveIdle, sessionId: sid, cwd: claudeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "read", file: r1, marker: "MARK-R1" },
          { kind: "read", file: r2, marker: "MARK-R2" },
          { kind: "read", file: r3, marker: "MARK-R3" },
        ],
        buildOpText: (op) => `用 Read 工具读取文件 "${op.file}"`,
      });
      await runProbeTurn({
        cli: "claude-code", turn: "write", events, driveIdle, sessionId: sid, cwd: claudeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "write", file: path.join(claudeDir, "w1.txt"), marker: "MARK-W1" },
          { kind: "write", file: path.join(claudeDir, "w2.txt"), marker: "MARK-W2" },
          { kind: "write", file: path.join(claudeDir, "w3.txt"), marker: "MARK-W3" },
        ],
        buildOpText: (op) => `用 Write 工具创建文件 "${op.file}"，内容为一行文本：${op.marker}`,
      });
      await runProbeTurn({
        cli: "claude-code", turn: "edit", events, driveIdle, sessionId: sid, cwd: claudeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "edit", file: e1, marker: "MARK-E1" },
          { kind: "edit", file: e2, marker: "MARK-E2" },
        ],
        buildOpText: (op) => `用 Edit 工具把文件 "${op.file}" 中的 alpha 替换为 ${op.marker}`,
      });
      await runProbeTurn({
        cli: "claude-code", turn: "bash", events, driveIdle, sessionId: sid, cwd: claudeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "bash-write", file: path.join(claudeDir, "b1.txt"), marker: "MARK-B1" },
          { kind: "bash-write", file: path.join(claudeDir, "b2.txt"), marker: "MARK-B2" },
          { kind: "bash-write", file: path.join(claudeDir, "b3.txt"), marker: "MARK-B3" },
          { kind: "bash-write", file: path.join(claudeDir, "b4.txt"), marker: "MARK-B4" },
        ],
        buildOpText: (op) => `用 Bash 工具运行命令：echo ${op.marker} > "${op.file}"`,
      });
      const s = cliSummary("claude-code");
      console.log(`[probe] claude-code 干净样本 ${s.clean}（excluded ${s.excluded}）命中率 ${(s.rate * 100).toFixed(0)}%`);
      expect(s.clean).toBeGreaterThanOrEqual(10);
    });
  });

  /* ---------------- Codex：commandExecution（读/写）/ fileChange（patch 编辑/新建） ---------------- */
  describe("codex", () => {
    let adapter: CodexAdapter;
    const events: AdapterEvent[] = [];
    let sid = "";
    let driveIdle: () => Promise<void> = () => Promise.resolve();
    const seed = (name: string, content: string): string => {
      const f = path.join(codexDir, name);
      writeFileSync(f, content, "utf8");
      return f;
    };

    beforeAll(async () => {
      adapter = new CodexAdapter({ effort: "low", log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[codex:${k}] ${d}`) });
      adapter.subscribe((e) => events.push(e));
      driveIdle = makeDriveIdle(events);
      sid = (await adapter.createSession({ cwd: codexDir, permMode: "full" })).sessionId; // full=danger-full-access：零审批
    });
    afterAll(async () => {
      await adapter.dispose();
    });

    it("≥10 干净样本：commandExecution 读/写 + fileChange 编辑/新建", async () => {
      const r1 = seed("r1.txt", "MARK-R1 内容甲");
      const r2 = seed("r2.txt", "MARK-R2 内容乙");
      const r3 = seed("r3.txt", "MARK-R3 内容丙");
      const e1 = seed("e1.txt", "alpha 第一处文本");
      const e2 = seed("e2.txt", "alpha 第二处文本");
      await runProbeTurn({
        cli: "codex", turn: "cmd-read", events, driveIdle, sessionId: sid, cwd: codexDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "read", file: r1, marker: "MARK-R1" },
          { kind: "read", file: r2, marker: "MARK-R2" },
          { kind: "read", file: r3, marker: "MARK-R3" },
        ],
        buildOpText: (op) => `运行命令：type "${op.file}"`,
      });
      await runProbeTurn({
        cli: "codex", turn: "cmd-write", events, driveIdle, sessionId: sid, cwd: codexDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "bash-write", file: path.join(codexDir, "b1.txt"), marker: "MARK-B1" },
          { kind: "bash-write", file: path.join(codexDir, "b2.txt"), marker: "MARK-B2" },
          { kind: "bash-write", file: path.join(codexDir, "b3.txt"), marker: "MARK-B3" },
          { kind: "bash-write", file: path.join(codexDir, "b4.txt"), marker: "MARK-B4" },
        ],
        buildOpText: (op) => `运行命令：echo ${op.marker} > "${op.file}"（这些文件当前不存在，必须真实运行命令创建）`,
      });
      await runProbeTurn({
        cli: "codex", turn: "patch-edit", events, driveIdle, sessionId: sid, cwd: codexDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "patch-edit", file: e1, marker: "MARK-E1" },
          { kind: "patch-edit", file: e2, marker: "MARK-E2" },
        ],
        buildOpText: (op) => `修改文件 "${op.file}"：把其中的 alpha 替换为 ${op.marker}（用你的文件编辑/apply patch 能力完成，不要用 shell 命令写文件）`,
      });
      await runProbeTurn({
        cli: "codex", turn: "patch-create", events, driveIdle, sessionId: sid, cwd: codexDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "patch-create", file: path.join(codexDir, "w1.txt"), marker: "MARK-W1" },
          { kind: "patch-create", file: path.join(codexDir, "w2.txt"), marker: "MARK-W2" },
          { kind: "patch-create", file: path.join(codexDir, "w3.txt"), marker: "MARK-W3" },
          { kind: "patch-create", file: path.join(codexDir, "w4.txt"), marker: "MARK-W4" },
          { kind: "patch-create", file: path.join(codexDir, "w5.txt"), marker: "MARK-W5" },
        ],
        buildOpText: (op) => `创建新文件 "${op.file}"，内容为一行文本：${op.marker}（用文件编辑/apply patch 能力完成，不要用 shell 命令）`,
      });
      const s = cliSummary("codex");
      console.log(`[probe] codex 干净样本 ${s.clean}（excluded ${s.excluded}）命中率 ${(s.rate * 100).toFixed(0)}%`);
      expect(s.clean).toBeGreaterThanOrEqual(10);
    });
  });

  /* ---------------- OpenCode：read / write / edit / bash（magpie 内网网关 cost=0） ---------------- */
  describe("opencode", () => {
    let adapter: OpenCodeAdapter;
    const events: AdapterEvent[] = [];
    let sid = "";
    let driveIdle: () => Promise<void> = () => Promise.resolve();
    const seed = (name: string, content: string): string => {
      const f = path.join(opencodeDir, name);
      writeFileSync(f, content, "utf8");
      return f;
    };

    beforeAll(async () => {
      const host = new OpenCodeServerHost({
        registryPath: path.join(root, "servers.json"),
        xdgRoot,
        extraConfig: magpieProvider ? { provider: { magpie: magpieProvider } } : undefined,
        log: (k, d) => process.env.KANBAN_E2E_DEBUG && console.error(`[oc:${k}] ${d}`),
      });
      adapter = new OpenCodeAdapter({ host });
      adapter.subscribe((e) => events.push(e));
      driveIdle = makeDriveIdle(events);
      sid = (await adapter.createSession({ cwd: opencodeDir, permMode: "full" })).sessionId; // full=原生 *:*:allow：零审批
    });
    afterAll(async () => {
      await adapter.dispose();
    });

    it("≥10 干净样本：read/write/edit/bash 四类工具", async () => {
      const r1 = seed("r1.txt", "MARK-R1 内容甲");
      const r2 = seed("r2.txt", "MARK-R2 内容乙");
      const r3 = seed("r3.txt", "MARK-R3 内容丙");
      const r4 = seed("r4.txt", "MARK-R4 内容丁");
      const r5 = seed("r5.txt", "MARK-R5 内容戊");
      const r6 = seed("r6.txt", "MARK-R6 内容己");
      const e1 = seed("e1.txt", "alpha 第一处文本");
      const e2 = seed("e2.txt", "alpha 第二处文本");
      const e3 = seed("e3.txt", "alpha 第三处文本");
      await runProbeTurn({
        cli: "opencode", turn: "read", events, driveIdle, sessionId: sid, cwd: opencodeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "read", file: r1, marker: "MARK-R1" },
          { kind: "read", file: r2, marker: "MARK-R2" },
          { kind: "read", file: r3, marker: "MARK-R3" },
          { kind: "read", file: r4, marker: "MARK-R4" },
          { kind: "read", file: r5, marker: "MARK-R5" },
          { kind: "read", file: r6, marker: "MARK-R6" },
        ],
        buildOpText: (op) => `用 read 工具读取文件 "${op.file}"`,
      });
      await runProbeTurn({
        cli: "opencode", turn: "write", events, driveIdle, sessionId: sid, cwd: opencodeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "write", file: path.join(opencodeDir, "w1.txt"), marker: "MARK-W1" },
          { kind: "write", file: path.join(opencodeDir, "w2.txt"), marker: "MARK-W2" },
          { kind: "write", file: path.join(opencodeDir, "w3.txt"), marker: "MARK-W3" },
          { kind: "write", file: path.join(opencodeDir, "w4.txt"), marker: "MARK-W4" },
          { kind: "write", file: path.join(opencodeDir, "w5.txt"), marker: "MARK-W5" },
        ],
        buildOpText: (op) => `用 write 工具创建新文件 "${op.file}"（文件当前不存在，直接写入即可，不需要先读取），内容为一行文本：${op.marker}`,
      });
      await runProbeTurn({
        cli: "opencode", turn: "edit", events, driveIdle, sessionId: sid, cwd: opencodeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "edit", file: e1, marker: "MARK-E1" },
          { kind: "edit", file: e2, marker: "MARK-E2" },
          { kind: "edit", file: e3, marker: "MARK-E3" },
        ],
        buildOpText: (op) =>
          `用 edit 工具把文件 "${op.file}" 中的 alpha 替换为 ${op.marker}（该文件内容已是单行 "alpha 第N处文本"，不需要先读取文件，直接编辑）`,
      });
      await runProbeTurn({
        cli: "opencode", turn: "bash", events, driveIdle, sessionId: sid, cwd: opencodeDir,
        sendTurn: (text) => adapter.sendTurn({ sessionId: sid, text }),
        instructions: [
          { kind: "bash-write", file: path.join(opencodeDir, "b1.txt"), marker: "MARK-B1" },
          { kind: "bash-write", file: path.join(opencodeDir, "b2.txt"), marker: "MARK-B2" },
          { kind: "bash-write", file: path.join(opencodeDir, "b3.txt"), marker: "MARK-B3" },
          { kind: "bash-write", file: path.join(opencodeDir, "b4.txt"), marker: "MARK-B4" },
        ],
        buildOpText: (op) => `务必用 bash 工具真实执行（不要只描述、不要只回答文本）这条命令：echo ${op.marker} > "${op.file}"（这些文件当前不存在，必须真实执行命令创建）`,
      });
      const s = cliSummary("opencode");
      console.log(`[probe] opencode 干净样本 ${s.clean}（excluded ${s.excluded}）命中率 ${(s.rate * 100).toFixed(0)}%`);
      expect(s.clean).toBeGreaterThanOrEqual(10);
    });
  });

  /* ---------------- 汇总输出 + 样本 JSON 落盘（探针报告机器证据） ---------------- */
  afterAll(() => {
    const summary = (["claude-code", "codex", "opencode"] as const).map((cli) => ({ cli, ...cliSummary(cli) }));
    console.log("[probe] ===== 会话线索探针汇总 =====");
    for (const s of summary) {
      console.log(`[probe] ${s.cli}: 干净样本 ${s.clean}，命中 ${s.hits}，命中率 ${(s.rate * 100).toFixed(1)}%，excluded ${s.excluded}`);
    }
    const outPath =
      process.env.KANBAN_SESSION_PROBE_OUT ?? path.resolve(__dirname, "../../../../docs/acceptance/stage4/session-clue-probe-samples.json");
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2), "utf8");
    console.log(`[probe] 样本明细已写入 ${outPath}`);
    rmBestEffort(root);
  });
});
