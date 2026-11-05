// 用途：Electron Main 进程 benchmark 驱动 —— utilityProcess MessagePort 往返/单向吞吐 vs Main 进程内直调（含 JSON 序列化对照），输出 JSON 结果到 stdout 与 logs/t5-bench.json
const { app, utilityProcess, MessageChannelMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// 构造 ~1KB 的 adapter 事件流典型载荷（message_delta 形状）
function makePayload(i) {
  const p = {
    kind: "message_delta",
    eventId: `evt_${i}_${"0".repeat(8)}`,
    sessionId: "ses_0123456789abcdef0123456789abcdef",
    nativeSessionId: "thread_0123456789abcdef0123456789abcdef",
    itemId: "item_" + String(i).padStart(10, "0"),
    partId: "part_" + String(i).padStart(10, "0"),
    cli: "codex",
    delta: "x".repeat(700),
    receivedAt: new Date().toISOString(),
    seq: i,
    meta: { turnId: "turn_0123456789abcdef", model: "gpt-5.6-luna", effort: "low" },
  };
  return p;
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    avg: +(sum / s.length).toFixed(3),
    p50: +s[Math.floor(s.length * 0.5)].toFixed(3),
    p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
  };
}

const RT_N = 5000; // 往返样本数
const BURST_N = 20000; // 单向突发事件数

// —— 基准 1：utilityProcess MessagePort 往返（批量管线：一次发 N 个，等全部回执；吞吐按真实墙钟计）——
function benchMpRoundtrip(port) {
  return new Promise((resolve) => {
    const inflight = new Map(); // id -> t0（负 id 为预热，不计入）
    const lat = [];
    const onMsg = (e) => {
      if (e.data?.t !== "rt-echo") return;
      const t0 = inflight.get(e.data.id);
      if (t0 === undefined) return;
      inflight.delete(e.data.id);
      if (e.data.id >= 0) lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (lat.length >= RT_N) {
        port.removeListener("message", onMsg);
        const wallStart = latStart;
        const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
        resolve({ mode: "utilityProcess MessagePort 往返(管线5000并发)", n: RT_N, eventsPerSec: +(RT_N / (wallMs / 1000)).toFixed(1), wallMs: +wallMs.toFixed(1), latencyMs: stats(lat) });
      }
    };
    port.on("message", onMsg);
    for (let i = 0; i < 200; i++) port.postMessage({ t: "rt-echo", id: -i - 1, payload: makePayload(i) }); // 预热
    setImmediate(() => {
      latStart = process.hrtime.bigint();
      for (let i = 0; i < RT_N; i++) {
        inflight.set(i, process.hrtime.bigint());
        port.postMessage({ t: "rt-echo", id: i, payload: makePayload(i) });
      }
    });
  });
}
let latStart = 0n;

// —— 基准 1b：utilityProcess MessagePort 串行往返（一次一个，真实单命令延迟口径）——
function benchMpSerialRt(port, n = 200) {
  return new Promise((resolve) => {
    const lat = [];
    const onMsg = (e) => { if (e.data?.t === "rt-echo" && e.data.id >= 0) { /* 由轮询 promise 收集 */ } };
    port.on("message", onMsg);
    (async () => {
      for (let i = 0; i < 20; i++) { port.postMessage({ t: "rt-echo", id: -i - 1, payload: makePayload(i) }); await new Promise((r) => setTimeout(r, 2)); }
      const tWall = process.hrtime.bigint();
      for (let i = 0; i < n; i++) {
        const t0 = process.hrtime.bigint();
        await new Promise((res) => {
          const inner = (ev) => {
            if (ev.data?.t === "rt-echo" && ev.data.id === i) { port.removeListener("message", inner); res(); }
          };
          port.on("message", inner);
          port.postMessage({ t: "rt-echo", id: i, payload: makePayload(i) });
        });
        lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      port.removeListener("message", onMsg);
      const wallMs = Number(process.hrtime.bigint() - tWall) / 1e6;
      resolve({ mode: "utilityProcess MessagePort 串行往返(单命令延迟)", n, eventsPerSec: +(n / (wallMs / 1000)).toFixed(1), wallMs: +wallMs.toFixed(1), latencyMs: stats(lat) });
    })();
  });
}

// —— 基准 2：utilityProcess MessagePort 单向突发（worker → main，adapter 事件流洪峰方向）——
function benchMpBurst(port) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let count = 0;
    let firstArrival = null;
    let lastArrival = null;
    const onMsg = (e) => {
      if (e.data?.t === "burst") {
        if (firstArrival === null) firstArrival = process.hrtime.bigint();
        count++;
        if (count >= BURST_N) {
          lastArrival = process.hrtime.bigint();
          port.removeListener("message", onMsg);
          const wallMs = Number(lastArrival - t0) / 1e6;
          resolve({ mode: "utilityProcess MessagePort 单向突发(worker→main)", n: BURST_N, eventsPerSec: +(BURST_N / (wallMs / 1000)).toFixed(1), firstEventMs: +(Number(firstArrival - t0) / 1e6).toFixed(3), wallMs: +wallMs.toFixed(1) });
        }
      }
    };
    port.on("message", onMsg);
    port.postMessage({ t: "burst-go", n: BURST_N });
  });
}

// —— 基准 3：Main 进程内直调（同一载荷按引用传递，零序列化）——
function benchInprocDirect() {
  const lat = [];
  let n = 0;
  const target = RT_N;
  // 模拟 Adapter handler：收事件 → 回执
  function handler(msg, cb) {
    cb({ id: msg.id, ok: true, echo: msg.delta.length });
  }
  const tWall0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) handler({ id: -i - 1, delta: { length: 700 } }, () => {});
  for (let i = 0; i < target; i++) {
    const t0 = process.hrtime.bigint();
    handler(makePayload(i), () => {
      lat.push(process.hrtime.bigint() - t0);
      n++;
    });
  }
  const ms = lat.map((b) => Number(b) / 1e6);
  const wall = Number(process.hrtime.bigint() - tWall0) / 1e6;
  return { mode: "Main 进程内直调（引用传递）", n: target, eventsPerSec: +(1000 / (wall / target)).toFixed(1), latencyMs: stats(ms) };
}

// —— 基准 4：Main 进程内 + JSON.stringify/parse 往返（序列化成本对照）——
function benchInprocJson() {
  const lat = [];
  const target = RT_N;
  function handler(msg, cb) {
    const wire = JSON.parse(msg);
    cb({ id: wire.id, ok: true });
  }
  for (let i = 0; i < 200; i++) handler(JSON.stringify(makePayload(i)), () => {});
  const tWall0 = process.hrtime.bigint();
  for (let i = 0; i < target; i++) {
    const t0 = process.hrtime.bigint();
    const wire = JSON.stringify(makePayload(i));
    handler(wire, () => lat.push(process.hrtime.bigint() - t0));
  }
  const ms = lat.map((b) => Number(b) / 1e6);
  const wall = Number(process.hrtime.bigint() - tWall0) / 1e6;
  return { mode: "Main 进程内 + JSON 序列化往返", n: target, eventsPerSec: +(1000 / (wall / target)).toFixed(1), latencyMs: stats(ms) };
}

// —— 基准 5：Main 进程内 EventEmitter 单向突发（对照基准 2）——
function benchInprocBurst() {
  const { EventEmitter } = require("node:events");
  const bus = new EventEmitter();
  const t0 = process.hrtime.bigint();
  let count = 0;
  bus.on("adapter-event", () => { count++; });
  for (let i = 0; i < BURST_N; i++) bus.emit("adapter-event", makePayload(i));
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { mode: "Main 进程内 EventEmitter 单向突发", n: BURST_N, eventsPerSec: +(BURST_N / (wallMs / 1000)).toFixed(1), wallMs: +wallMs.toFixed(1), received: count };
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const results = { env: { electron: process.versions.electron, node: process.versions.node, platform: process.platform }, payloadBytes: JSON.stringify(makePayload(0)).length, items: [] };
  try {
    const child = utilityProcess.fork(path.join(__dirname, "worker.cjs"));
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ t: "init" }, [port1]);
    await new Promise((resolve) => {
      port2.on("message", (e) => { if (e.data?.t === "worker-ready") resolve(); });
      port2.start();
    });
    results.items.push(await benchMpRoundtrip(port2));
    results.items.push(await benchMpSerialRt(port2));
    results.items.push(await benchMpBurst(port2));
    child.kill();
  } catch (e) {
    results.utilityProcessError = String(e && e.stack || e);
  }
  results.items.push(benchInprocDirect());
  results.items.push(benchInprocJson());
  results.items.push(benchInprocBurst());
  const out = JSON.stringify(results, null, 2);
  const logsDir = path.join(__dirname, "..", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "t5-bench.json"), out, "utf8");
  console.log("BENCH_JSON_START");
  console.log(out);
  console.log("BENCH_JSON_END");
  app.exit(0);
}).catch((e) => { console.error("fatal:", e); app.exit(1); });
