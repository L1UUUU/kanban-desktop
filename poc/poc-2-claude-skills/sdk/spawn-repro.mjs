// 用途：最小 Node spawn 复现 —— 判别 SDK 失败是否由 Node 异步管道 + claude.exe 组合导致
import { spawn } from "node:child_process";

const exe = "C:/project2/kanban-desktop/poc/poc-2-claude-skills/sdk/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];
const child = spawn(exe, args, { cwd: "C:/project2/kanban-desktop/poc/poc-2-claude-skills/fixture/proj", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

child.stdout.on("data", (d) => console.log("[stdout]", d.toString().slice(0, 120)));
child.stderr.on("data", (d) => console.log("[stderr]", d.toString().slice(0, 200)));
child.on("exit", (code, sig) => { console.log("EXIT code=", code, "signal=", sig); process.exit(0); });

child.stdin.write(JSON.stringify({ request_id: "np1", type: "control_request", request: { subtype: "initialize", options: {} } }) + "\n");
setTimeout(() => { console.log("存活 8 秒，视为成功"); child.kill(); }, 8000).unref();
