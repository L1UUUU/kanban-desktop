// 用途：utilityProcess worker 端 —— 回应 rt-echo 往返请求；按指令向 main 单向突发推送 N 个事件（模拟 adapter 事件流洪峰）
process.parentPort.on("message", (e) => {
  const msg = e.data;
  if (msg?.t === "init") {
    const [port] = e.ports;
    port.on("message", (ev) => {
      const m = ev.data;
      if (m?.t === "rt-echo") {
        port.postMessage({ t: "rt-echo", id: m.id, payload: m.payload, ok: true });
      } else if (m?.t === "burst-go") {
        const n = m.n || 10000;
        for (let i = 0; i < n; i++) {
          port.postMessage({
            t: "burst",
            i,
            kind: "message_delta",
            eventId: `evt_${i}`,
            sessionId: "ses_0123456789abcdef0123456789abcdef",
            itemId: "item_" + String(i).padStart(10, "0"),
            delta: "x".repeat(700),
            seq: i,
            meta: { turnId: "turn_0123456789abcdef", model: "gpt-5.6-luna" },
          });
        }
        port.postMessage({ t: "burst-done", n });
      }
    });
    port.start();
    port.postMessage({ t: "worker-ready" });
  }
});
