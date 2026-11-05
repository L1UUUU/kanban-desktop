// 用途：Codex 协议版本探针（spec §7-6）—— generate-ts 产物与锁版本基线 diff，检测协议漂移；--version 对比缓存版本做轻量锁版本
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import baseline from "./protocol-baseline.json";

export interface ProtocolProbeResult {
  /** generate-ts 是否成功产出 */
  generated: boolean;
  /** 与基线一致（无方法增删且审批枚举未变） */
  matchesBaseline: boolean;
  added: string[];
  removed: string[];
  detail: string;
}

/** 从 generate-ts 产物目录提取协议面（方法名集合 + 审批 decision 枚举） */
function extractProtocolFace(outDir: string): {
  serverRequests: string[];
  serverNotifications: string[];
  clientRequests: string[];
  approvalDecisions: string[];
} | null {
  const read = (rel: string): string | null => {
    const file = path.join(outDir, rel);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const methods = (src: string | null): string[] =>
    src ? [...new Set([...src.matchAll(/"method": "([a-zA-Z/]+)"/g)].map((m) => m[1]))].sort() : [];
  const decisions = (src: string | null): string[] =>
    src ? [...new Set([...src.matchAll(/"(accept|acceptForSession|decline|cancel)"/g)].map((m) => m[1]))].sort() : [];
  const req = read("ServerRequest.ts");
  if (!req) return null;
  return {
    serverRequests: methods(req),
    serverNotifications: methods(read("ServerNotification.ts")),
    clientRequests: methods(read("ClientRequest.ts")),
    approvalDecisions: [...new Set([...decisions(read(path.join("v2", "CommandExecutionApprovalDecision.ts"))), ...decisions(read(path.join("v2", "FileChangeApprovalDecision.ts")))])].sort(),
  };
}

/**
 * 协议探针：跑 `codex.exe app-server generate-ts --out <tmp>` 与基线（0.144.1 产物提取）diff。
 * 成本较高（生成 ~470 文件、秒级），供升级/排障时手动运行，不在每次启动执行。
 */
export function probeProtocol(exe: string): ProtocolProbeResult {
  const outDir = mkdtempSync(path.join(tmpdir(), "codex-protocol-probe-"));
  try {
    execFileSync(exe, ["app-server", "generate-ts", "--out", outDir], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const face = extractProtocolFace(outDir);
    if (!face) {
      return { generated: false, matchesBaseline: false, added: [], removed: [], detail: "generate-ts 未产出 ServerRequest.ts（命令或版本行为变化）" };
    }
    const base = baseline as { serverRequests: string[]; serverNotifications: string[]; clientRequests: string[]; approvalDecisions: string[] };
    const diff = (a: string[], b: string[]) => ({
      added: b.filter((x) => !a.includes(x)),
      removed: a.filter((x) => !b.includes(x)),
    });
    const parts = [
      { name: "serverRequests", ...diff(base.serverRequests, face.serverRequests) },
      { name: "serverNotifications", ...diff(base.serverNotifications, face.serverNotifications) },
      { name: "clientRequests", ...diff(base.clientRequests, face.clientRequests) },
      { name: "approvalDecisions", ...diff(base.approvalDecisions, face.approvalDecisions) },
    ];
    const added = parts.flatMap((p) => p.added.map((m) => `${p.name}:+${m}`));
    const removed = parts.flatMap((p) => p.removed.map((m) => `${p.name}:-${m}`));
    return {
      generated: true,
      matchesBaseline: added.length === 0 && removed.length === 0,
      added,
      removed,
      detail: added.length + removed.length === 0 ? "与锁版本基线一致" : `协议漂移：新增 ${added.join(",") || "无"}；移除 ${removed.join(",") || "无"}`,
    };
  } catch (e) {
    return {
      generated: false,
      matchesBaseline: false,
      added: [],
      removed: [],
      detail: `generate-ts 执行失败：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
