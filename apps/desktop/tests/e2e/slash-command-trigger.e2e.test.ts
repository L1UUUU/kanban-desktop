// 用途：三 CLI 真实命令触发验证 B 类 e2e（issue #91 / spec #82 E 块 T10）—— claude 透传形态真实触发 skill（PoC C1 结论：CLI 自行展开 /name 原文）、codex 经 #92 expandCodexPromptCommand 展开链路送达真实 wire（占位符替换进载荷）、opencode 原生 /command 触发（command API 非普通文本）；KANBAN_E2E === "1" 门控（docs/testing.md B 类协议），真实 codex 必须 KANBAN_CODEX_MODEL luna 白名单成本口径
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, CodexAdapter, OpenCodeAdapter, OpenCodeServerHost } from "@kanban/cli-host";
import type { AdapterEvent, ChatEvent, LogKind, SkillObservation } from "@kanban/ipc-schema";
import { resolveSlashDispatch } from "../../src/features/chat/slash-dispatch";
import { composerHandlers } from "../../electron/main/ipc/composer";
import type { IpcDeps } from "../../electron/main/ipc";
import { rmBestEffort } from "../../e2e/helpers/rm-best-effort";

const E2E = process.env.KANBAN_E2E === "1";

// 真实模型 turn 十秒级：测试与钩子都放宽（三套件同款口径）
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/** 事件流过滤器：ChatEvent（有 type 判别）按会话取 */
function chatOf(events: AdapterEvent[], sessionId: string): ChatEvent[] {
  return events.filter((e): e is ChatEvent => "type" in e && e.sessionId === sessionId);
}

/** 事件流过滤器：SkillObservation（无 type 字段）按会话取 */
function skillsOf(events: AdapterEvent[], sessionId: string): SkillObservation[] {
  return events.filter((e): e is SkillObservation => !("type" in e) && e.sessionId === sessionId);
}

/** 会话终文：message_delta 拼接（三套件同款） */
function assistantText(events: AdapterEvent[], sessionId: string): string {
  return chatOf(events, sessionId)
    .filter((e): e is Extract<ChatEvent, { type: "message_delta" }> => e.type === "message_delta")
    .map((e) => e.delta)
    .join("");
}

/** 轮询推进到全局空闲（running 消失且稳定 800ms；waiting=审批等待视为稳定；三套件同款语义） */
async function driveIdle(events: AdapterEvent[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`driveIdle 超时（${timeoutMs / 1000}s 无空闲）`);
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
}

/** KANBAN_E2E_DEBUG 调试日志工厂（缺省静默） */
function debugLog(tag: string): (kind: LogKind, detail: string) => void {
  return (kind, detail) => {
    if (process.env.KANBAN_E2E_DEBUG) console.error(`[${tag}:${kind}] ${detail}`);
  };
}

// PoC 期 codex 云端通道 infra 故障特征（E-poc-results.md §3：纯文本对照同错，与斜杠解析无关）
const CODEX_INFRA_FAILURE_RE = /workspace routing discovery failed/i;

/** 按 thread id 定位 codex rollout 落盘文件（~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl；文件名内嵌 thread id 精确定位，未落盘返回 null） */
function findCodexRollout(threadId: string): string | null {
  if (!threadId) return null;
  const root = path.join(homedir(), ".codex", "sessions");
  const walk = (dir: string): string | null => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (e.name.endsWith(`-${threadId}.jsonl`)) {
        return p;
      }
    }
    return null;
  };
  return walk(root);
}

describe.skipIf(!E2E)("三 CLI 真实命令触发验证（issue #91，KANBAN_E2E=1）", () => {
  /* ---------------- claude：透传形态真实触发 skill（PoC C1） ---------------- */
  describe("claude：透传 /kb-poc-normal → CLI 原生展开执行 skill", () => {
    const events: AdapterEvent[] = [];
    let adapter: ClaudeAdapter;
    let workdir = ""; // beforeAll 内建（非 E2E 时不跑钩子，不泄漏临时目录）
    let userClaudeDir = ""; // 空用户级目录：命令目录只含项目 fixture（枚举确定性，不读机器真实 ~/.claude）
    let hookDir = "";

    beforeAll(() => {
      workdir = mkdtempSync(path.join(tmpdir(), "kb-t91-claude-work-"));
      userClaudeDir = mkdtempSync(path.join(tmpdir(), "kb-t91-claude-user-"));
      hookDir = mkdtempSync(path.join(tmpdir(), "kb-t91-claude-hooks-"));
      // 项目级 fixture：复用 #88 PoC skill（packages/cli-host/tests/fixtures/skills/kb-poc-normal，固定输出 KB-POC-NORMAL-EXECUTED）
      const skillDir = path.join(workdir, ".claude", "skills", "kb-poc-normal");
      mkdirSync(skillDir, { recursive: true });
      copyFileSync(
        path.resolve(__dirname, "../../../../packages/cli-host/tests/fixtures/skills/kb-poc-normal/SKILL.md"),
        path.join(skillDir, "SKILL.md"),
      );
      adapter = new ClaudeAdapter({ hookDir, userClaudeDir, log: debugLog("t91-claude") });
      adapter.subscribe((e) => events.push(e));
    });

    afterAll(async () => {
      await adapter.dispose(); // 等进程退出后再清理（workdir 是 claude 子进程 cwd）
      await rmBestEffort(workdir);
      await rmBestEffort(userClaudeDir);
      await rmBestEffort(hookDir);
    });

    it("透传原文经真实 claude：终文含 skill 固定标记 KB-POC-NORMAL-EXECUTED（skill 语义执行，非普通文本回复）", async () => {
      // 成本控制：目录内最便宜可用档优先（flash 级，PoC 同口径），回落默认档（列表握手零 token）
      const models = await adapter.listModels({ cwd: workdir });
      expect(models.length).toBeGreaterThan(0);
      const cheapest = models.find((m) => m.id.toLowerCase().includes("flash")) ?? models.find((m) => m.isDefault) ?? models[0]!;
      // #89 枚举（fixture 已注入用户级隔离目录）+ #92 判定：claude 匹配 → 透传原文（PoC C1 选定形态）
      const commands = await adapter.listCommands({ cwd: workdir });
      expect(commands.some((c) => c.name === "kb-poc-normal")).toBe(true); // fixture skill 进命令目录
      const action = resolveSlashDispatch({ text: "/kb-poc-normal", cli: "claude", commands });
      expect(action).toEqual({ action: "send-text", text: "/kb-poc-normal" }); // 透传：不展开不拦截
      // 真实触发：wire 载荷 = /kb-poc-normal 原文（所见即所发），CLI 侧自行解析并展开 skill
      const { sessionId } = await adapter.createSession({ cwd: workdir, permMode: "auto", model: cheapest.id });
      await adapter.sendTurn({ sessionId, text: "/kb-poc-normal" });
      await driveIdle(events, 240_000);
      // 执行证据 = skill 固定输出标记：skill 未激活时模型对 /kb-poc-normal 只会普通文本回复，不可能产出该标记
      expect(assistantText(events, sessionId)).toContain("KB-POC-NORMAL-EXECUTED");
      expect(chatOf(events, sessionId).some((e) => e.type === "turn_completed")).toBe(true);
      expect(chatOf(events, sessionId).some((e) => e.type === "session_error")).toBe(false);
    });
  });

  /* ---------------- codex：#92 展开链路 → 真实 wire（占位符替换进载荷） ---------------- */
  describe("codex：/kb-t91-args 展开触发 → wire 收到替换后文本", () => {
    const events: AdapterEvent[] = [];
    let adapter: CodexAdapter;
    let homeDir = ""; // 测试 home：.codex/prompts fixture（客户端目录解析基准，不污染真实 ~/.codex）
    let workdir = "";
    const args = "alpha beta";

    beforeAll(() => {
      homeDir = mkdtempSync(path.join(tmpdir(), "kb-t91-codex-home-"));
      workdir = mkdtempSync(path.join(tmpdir(), "kb-t91-codex-work-"));
      // fixture prompt：带 $ARGUMENTS/$1 占位符（展开语义可观察）+ 固定回复标记（模型端回执可断言）
      const prompts = path.join(homeDir, ".codex", "prompts");
      mkdirSync(prompts, { recursive: true });
      writeFileSync(
        path.join(prompts, "kb-t91-args.md"),
        "---\ndescription: T91 展开探针（$ARGUMENTS/$1 替换验证）\nargument-hint: <first> <rest...>\n---\n请只回复这一行，不要回复其他任何内容：KB-CODEX-PROMPT-EXECUTED args=[$ARGUMENTS] first=[$1]\n",
        "utf8",
      );
      // homeDir 注入：listCommands 枚举走测试 fixture 目录；effort low 控成本（codex 套件同款）
      adapter = new CodexAdapter({ homeDir, effort: "low", log: debugLog("t91-codex") });
      adapter.subscribe((e) => events.push(e));
    });

    afterAll(async () => {
      await adapter.dispose();
      await rmBestEffort(homeDir);
      await rmBestEffort(workdir);
    });

    it("带参命令经 #92 展开链路（判定 → composer:expandCommand）→ 真实 wire 载荷含替换后文本", async () => {
      // 成本口径硬断言（docs/testing.md：真实 codex 测试必须 luna 白名单，防烧 sol/terra；全败报错不回退）
      expect(process.env.KANBAN_CODEX_MODEL ?? "").toContain("gpt-6-luna");
      // #89 枚举：fixture 进命令目录（homeDir 注入，来源=用户级 prompts）
      const commands = await adapter.listCommands({ cwd: workdir });
      const entry = commands.find((c) => c.name === "kb-t91-args");
      expect(entry).toBeDefined();
      expect(entry!.sourcePath).toContain(path.join(homeDir, ".codex", "prompts"));
      // #92 判定：codex 匹配 → expand（app-server 不解析 / 前缀，客户端读文件展开）
      const action = resolveSlashDispatch({ text: `/kb-t91-args ${args}`, cli: "codex", commands });
      expect(action).toMatchObject({ action: "expand", name: "kb-t91-args", args });
      if (action.action !== "expand") throw new Error(`派发动作非 expand：${JSON.stringify(action)}`); // 上面断言的运行时兜底
      // #92 展开路径：生产同款 Main 子通道（composer:expandCommand 读来源文件 + expandCodexPromptCommand；cwd 与 codexHomeDir 注入 = 该请求的 prompts 目录安全边界）
      const res = await composerHandlers["composer:expandCommand"](
        { channel: "composer:expandCommand", sourcePath: action.sourcePath, args: action.args, cwd: workdir },
        { codexHomeDir: homeDir } as IpcDeps,
      );
      if (!res.ok || typeof res.text !== "string") throw new Error(`展开失败：${JSON.stringify(res)}`);
      const expanded = res.text;
      // 展开语义保留：占位符被实参替换、frontmatter 剥离（$ARGUMENTS 全量 / $1 位置）
      expect(expanded).toContain("args=[alpha beta]");
      expect(expanded).toContain("first=[alpha]");
      expect(expanded).not.toContain("$ARGUMENTS");
      expect(expanded).not.toContain("$1");
      expect(expanded).not.toContain("description:");
      // 真实 codex：发送展开文本（普通文本 wire 形态；模型经 KANBAN_CODEX_MODEL 白名单解析）
      const { sessionId, nativeSessionId } = await adapter.createSession({ cwd: workdir, permMode: "auto" });
      await adapter.sendTurn({ sessionId, text: expanded });
      await driveIdle(events, 180_000);
      // wire 送达证据（协议层落盘回执）：rollout 文件名内嵌 thread id 可精确定位，user input_text = 展开后文本
      // （不用 adapter.readTranscript：codex 0.167.0 实测 thread/read 不再回 path/turns → 返回空，属适配层既有问题，已单独记录）
      const rolloutPath = findCodexRollout(nativeSessionId ?? "");
      expect(rolloutPath).toBeDefined();
      const rolloutText = readFileSync(rolloutPath ?? "", "utf8");
      expect(rolloutText).toContain("args=[alpha beta]");
      expect(rolloutText).toContain("first=[alpha]");
      expect(rolloutText).not.toContain("/kb-t91-args"); // wire 上无字面斜杠命令（展开语义已替换）
      // 模型端回执：turn 完成断言模型回显展开语义（标记 + 替换后实参——实参只可能经展开文本送达）+ 零错误；
      // codex 云端 infra 故障（PoC 期 workspace routing discovery failed，2026-11-13 已恢复）复发时断言面收缩到上述
      // wire 层落盘证据，并显式标注「模型端数据未取得」如实上报——不静默降级，其余错误直接失败
      const errors = chatOf(events, sessionId).filter((e): e is Extract<ChatEvent, { type: "session_error" }> => e.type === "session_error");
      if (chatOf(events, sessionId).some((e) => e.type === "turn_completed")) {
        expect(assistantText(events, sessionId)).toContain("KB-CODEX-PROMPT-EXECUTED");
        expect(assistantText(events, sessionId)).toContain("args=[alpha beta]"); // 回显替换后实参（展开语义经模型执行）
        expect(errors).toHaveLength(0);
      } else {
        expect(errors.length).toBeGreaterThan(0); // 未完成必须显性报错（无错误无完成 = 断言面自身异常）
        const msg = errors.map((e) => e.message).join("; ");
        expect(msg).toMatch(CODEX_INFRA_FAILURE_RE); // 仅已知云端 infra 故障允许收缩断言面
        console.warn(`[t91-codex] 模型端数据未取得（codex 云端 infra 故障），断言面收缩至 wire 层送达证据：${msg}`);
      }
    });
  });

  /* ---------------- opencode：原生 /command 触发（command API 非普通文本） ---------------- */
  describe("opencode：原生 /command 触发 → 命令响应（非普通文本回复）", () => {
    const events: AdapterEvent[] = [];
    let adapter: OpenCodeAdapter;
    let ocRoot = "";
    let workdir = "";

    beforeAll(() => {
      ocRoot = mkdtempSync(path.join(tmpdir(), "kb-t91-oc-"));
      const xdgRoot = path.join(ocRoot, "xdg"); // 隔离用户全局 opencode 数据（opencode 套件同法）
      workdir = path.join(ocRoot, "work");
      mkdirSync(workdir, { recursive: true });
      // fixture command：server spawn 前落盘（poc-3：command 新增需重启 server 才被发现）；固定标记只在 command 文件内
      const cmdDir = path.join(workdir, ".opencode", "command");
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(
        path.join(cmdDir, "kb-t91.md"),
        "---\ndescription: T91 触发探针 command\n---\n请只回复这一行，不要回复其他任何内容：KB-OPENCODE-COMMAND-EXECUTED\n",
        "utf8",
      );
      // e2e provider 只读注入（opencode 套件同法：XDG 隔离下从用户全局 opencode.json 复制 magpie；内网网关 cost 0；密钥不进日志）
      const globalPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".config", "opencode", "opencode.json");
      const cfg = JSON.parse(readFileSync(globalPath, "utf8")) as { provider?: Record<string, unknown> };
      const prov = cfg.provider?.magpie;
      if (!prov) throw new Error("e2e 需要 ~/.config/opencode/opencode.json 内 magpie provider（只读复制注入）");
      adapter = new OpenCodeAdapter({
        host: new OpenCodeServerHost({
          registryPath: path.join(ocRoot, "servers.json"),
          xdgRoot,
          extraConfig: { provider: { magpie: prov } },
          log: debugLog("t91-oc-host"),
        }),
        log: debugLog("t91-oc"),
      });
      adapter.subscribe((e) => events.push(e));
    });

    afterAll(async () => {
      await adapter.dispose(); // 停 server（XDG 数据随 ocRoot 清理）
      await rmBestEffort(ocRoot);
    });

    it("透传 /kb-t91 → 适配器 command API 路由执行：self_reported 观察 + command 模板固定标记回复", async () => {
      // #92 判定：opencode 匹配 → 透传原文（命令路由由适配器单点判定，与菜单同源）
      const commands = await adapter.listCommands({ cwd: workdir });
      expect(commands.some((c) => c.name === "kb-t91")).toBe(true); // fixture command 进命令目录
      const action = resolveSlashDispatch({ text: "/kb-t91", cli: "opencode", commands });
      expect(action).toEqual({ action: "send-text", text: "/kb-t91" }); // 透传：CLI/适配器侧解析
      // 真实触发：适配器命中已知 command → POST /session/{id}/command（command API），非普通 prompt
      // 模型显式选 workbuddy/glm-5.3-flash 档（claude PoC 同款最低成本档）：默认档 zcode/GLM-5.3-Flash 曾 quota 超限，
      // POST /command 同步执行模板会 500 → 无命令观察事件（凭据/额度问题不属于断言面，显式选可用档绕开）
      const { sessionId } = await adapter.createSession({ cwd: workdir, model: "magpie/workbuddy/glm-5.3-flash" });
      await adapter.sendTurn({ sessionId, text: "/kb-t91" });
      await driveIdle(events, 240_000);
      // 命令响应证据 1：command API 路由的 self_reported 观察（普通 prompt 不产生该事件）
      expect(
        skillsOf(events, sessionId).some((o) => o.skill === "kb-t91" && o.evidenceLevel === "self_reported" && o.source === "opencode-command"),
      ).toBe(true);
      // 命令响应证据 2：command 模板语义真实执行（固定标记只在 command 文件内，普通文本回复不可能产出）
      expect(assistantText(events, sessionId)).toContain("KB-OPENCODE-COMMAND-EXECUTED");
      expect(chatOf(events, sessionId).some((e) => e.type === "turn_completed")).toBe(true);
      expect(chatOf(events, sessionId).some((e) => e.type === "session_error")).toBe(false);
    });
  });
});
