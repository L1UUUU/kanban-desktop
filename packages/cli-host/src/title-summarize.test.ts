// 用途：title-summarize 基建密封测试（#95）—— 一次性执行器经 node 自身替身验证（stdout 回收 / stdin 注入 / 超时 kill），prompt 构造与整形纯函数直测
import { describe, expect, it } from "vitest";
import type { TranscriptEvent } from "@kanban/ipc-schema";
import { buildSummaryTranscript, runTitleOneShot, toTitleLine } from "./title-summarize";

describe("runTitleOneShot（node 替身）", () => {
  it("stdout 回收 + exitCode 判定：echo 类脚本 completed", async () => {
    const r = await runTitleOneShot({
      exe: process.execPath,
      args: ["-e", "process.stdout.write('摘要标题')"],
      cwd: process.cwd(),
      stdin: "",
      timeoutMs: 15_000,
    });
    expect(r).toMatchObject({ exitCode: 0, stdout: "摘要标题" });
  });

  it("stdin 注入后关闭：子进程可完整读入 prompt 再退出", async () => {
    const r = await runTitleOneShot({
      exe: process.execPath,
      args: ["-e", "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.slice(0,5)))"],
      cwd: process.cwd(),
      stdin: "这是一段很长的摘要 prompt 输入",
      timeoutMs: 15_000,
    });
    expect(r.stdout).toBe("这是一段很");
  });

  it("超时 kill：到点抛 AdapterError（不沿用 run-once 300s 缺省）", async () => {
    await expect(
      runTitleOneShot({
        exe: process.execPath,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        cwd: process.cwd(),
        stdin: "",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "E_INTERNAL", message: expect.stringContaining("超时") });
  });

  it("非零退出：原样回传 exitCode 与 stderr（判定留在调用方）", async () => {
    const r = await runTitleOneShot({
      exe: process.execPath,
      args: ["-e", "process.stderr.write('boom');process.exit(3)"],
      cwd: process.cwd(),
      stdin: "",
      timeoutMs: 15_000,
    });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("boom");
  });
});

describe("buildSummaryTranscript / toTitleLine（纯函数）", () => {
  const t = (role: "user" | "assistant", text: string): TranscriptEvent => ({ role, text });

  it("user/assistant 双视角成行；工具调用折叠为一行标注", () => {
    const out = buildSummaryTranscript([
      t("user", "帮我拆类型"),
      { role: "assistant", text: "", tool: { name: "Bash", summary: "npm test" } },
      t("assistant", "好的，先跑测试"),
    ]);
    expect(out).toBe("用户：帮我拆类型\n（工具 Bash）\n助手：好的，先跑测试");
  });

  it("空文本事件跳过；超长截尾（保最近上下文）", () => {
    const events: TranscriptEvent[] = [t("user", "x".repeat(3_000)), t("assistant", "y".repeat(3_000)), t("assistant", "tail结论")];
    const out = buildSummaryTranscript(events);
    expect(out.length).toBe(4_000);
    expect(out.endsWith("tail结论")).toBe(true);
    expect(buildSummaryTranscript([t("user", "  "), t("assistant", "")])).toBe("");
  });

  it("toTitleLine：空白压单行、去首尾、限长 48", () => {
    expect(toTitleLine("  标题\n第二行\t缩进  ")).toBe("标题 第二行 缩进");
    expect(toTitleLine("x".repeat(80))).toHaveLength(48);
    expect(toTitleLine("   ")).toBe("");
  });

  it("toTitleLine：按 Unicode 码点截断（review S3：增补平面 emoji 不截半，与 title-derive 同型语义）", () => {
    // 第 48 个码点是 astral emoji（占 2 个 UTF-16 单元）：码点截断保留完整 emoji（49 单元），UTF-16 slice 会截出孤立代理项
    const boundary = "x".repeat(47) + "😀";
    expect(toTitleLine(boundary)).toBe(boundary);
    expect(toTitleLine(boundary)).toHaveLength(49); // 47 BMP + 1 完整 emoji 的 UTF-16 长度
    // 全 emoji 串：截到 48 个码点（96 单元），无孤立代理项
    const emojiOnly = "😀".repeat(60);
    const cut = toTitleLine(emojiOnly);
    expect(Array.from(cut)).toHaveLength(48);
    expect(cut.endsWith("😀")).toBe(true);
    // 界内不截：恰 48 个码点原样返回
    expect(toTitleLine("y".repeat(48))).toHaveLength(48);
  });
});
