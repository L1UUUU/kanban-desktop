// 用途：D2 冒烟 —— 在 Electron 44 主进程验证 node:sqlite 可用（打开内存库建表读写；同时核对 Database 新入口是否存在）
const { app } = require("electron");

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const sqlite = require("node:sqlite");
  const hasNewEntry = typeof sqlite.Database === "function";
  const Ctor = hasNewEntry ? sqlite.Database : sqlite.DatabaseSync;
  const result = { ok: false, entry: hasNewEntry ? "Database" : "DatabaseSync", versions: process.versions };

  try {
    const db = new Ctor(":memory:");
    db.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO smoke (v) VALUES (?)").run("hello-kanban");
    const row = db.prepare("SELECT v FROM smoke WHERE id = 1").get();
    result.ok = !!row && row.v === "hello-kanban";
    result.row = row;
    db.close();
  } catch (err) {
    result.error = String(err);
  }

  console.log("SMOKE_JSON_START");
  console.log(JSON.stringify(result, null, 2));
  console.log("SMOKE_JSON_END");
  app.exit(result.ok ? 0 : 1);
}).catch((err) => {
  console.error("fatal:", err);
  app.exit(1);
});
