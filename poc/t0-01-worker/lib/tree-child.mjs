// 用途：合成孙进程树节点 —— 自身长驻（detached），并再 spawn 一个 detached 长驻孙进程，经 stdout 上报两级 pid 后一起沉睡
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 孙进程模式：--grandchild 时只沉睡
if (process.argv.includes("--grandchild")) {
  process.stdout.write(`GRANDCHILD_READY ${process.pid}\n`);
  setInterval(() => {}, 3600000); // 长驻
} else {
  const g = spawn(process.execPath, [fileURLToPath(import.meta.url), "--grandchild"], { stdio: ["ignore", "pipe", "ignore"], detached: true, windowsHide: true });
  g.stdout.setEncoding("utf8");
  g.stdout.once("data", (c) => {
    process.stdout.write(`CHILD_READY ${process.pid} GRANDCHILD ${String(c).match(/(\d+)/)?.[1] ?? "?"}\n`);
  });
  setInterval(() => {}, 3600000); // 长驻
}
