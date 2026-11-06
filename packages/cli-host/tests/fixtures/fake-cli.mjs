// 用途：run-once 契约测试与 Job Object e2e 共用的 fake CLI（node.exe 直连形态，不经 shell）—— 按 argv[2] 行为分支驱动四场景：ok 正常输出 / fail 非零退出 / sleep 长睡（超时与取消载体）/ echo-stdin 回读 stdin / hang-with-pid 落 pid 后长睡（Job 覆盖验证载体）
const [, , behavior, ...rest] = process.argv;

if (behavior === "ok") {
  const marker = rest[0] ?? "OK";
  process.stdout.write(`fake-out:${marker}\n`);
  process.stderr.write(`fake-err:${marker}\n`);
  process.exit(0);
}

if (behavior === "fail") {
  const marker = rest[0] ?? "FAIL";
  process.stdout.write(`partial:${marker}\n`);
  process.stderr.write(`boom:${marker}\n`);
  process.exit(3);
}

if (behavior === "sleep") {
  const ms = Number(rest[0] ?? 1000);
  process.stdout.write("started\n");
  await new Promise((r) => setTimeout(r, ms));
  process.exit(0);
}

if (behavior === "echo-stdin") {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  process.stdout.write(`stdin:${data}`);
  process.exit(0);
}

if (behavior === "hang-with-pid") {
  const pidFile = rest[0];
  if (pidFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pidFile, String(process.pid), "utf8");
  }
  await new Promise((r) => setTimeout(r, 120_000));
  process.exit(0);
}

process.stderr.write(`unknown behavior: ${behavior}\n`);
process.exit(2);
