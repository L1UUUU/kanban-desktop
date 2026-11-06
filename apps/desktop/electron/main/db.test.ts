// 用途：SQLite 访问层单元测试 —— 打开即建 C3 五表 + memory v3 三表（#30）、建表幂等、可写入读取（D2 定版 node:sqlite）
import { describe, expect, it } from "vitest";
import { SQLITE_ENTRY, SCHEMA_VERSION, ensureSchema, listTables, openDatabase } from "./db";

describe("openDatabase（node:sqlite）", () => {
  it("打开内存库即建立 C3 五表 + memory v3 三表", () => {
    const db = openDatabase(":memory:");
    try {
      expect(listTables(db)).toEqual([
        "memory_batches", "memory_candidates", "memory_summaries",
        "projects", "requirements", "schema_migrations", "sessions", "stage_events",
      ]);
    } finally {
      db.close();
    }
  });

  it("建表幂等：重复 ensureSchema 不抛错、表数不变", () => {
    const db = openDatabase(":memory:");
    try {
      expect(() => ensureSchema(db)).not.toThrow();
      expect(listTables(db)).toHaveLength(8);
    } finally {
      db.close();
    }
  });

  it("schema_migrations 记录版本链（v1 基线 + v2 需求归属 + v3 memory 三表）且不重复插入", () => {
    const db = openDatabase(":memory:");
    try {
      ensureSchema(db);
      const rows = db.prepare("SELECT version FROM schema_migrations").all() as unknown as Array<{ version: number }>;
      expect(rows.map((r) => r.version)).toEqual([1, 2, SCHEMA_VERSION]);
    } finally {
      db.close();
    }
  });

  it("可写入读取（projects 行 INSERT/SELECT 往返）", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare("INSERT INTO projects (id, name, canonical_path, status, created_at) VALUES (?, ?, ?, ?, ?)")
        .run("p-1", "kanban-desktop", "C:\\project2\\kanban-desktop", "ok", "2026-11-05T00:00:00Z");
      const row = db.prepare("SELECT name, canonical_path, status FROM projects WHERE id = ?").get("p-1") as {
        name: string;
        canonical_path: string;
        status: string;
      };
      expect(row).toEqual({ name: "kanban-desktop", canonical_path: "C:\\project2\\kanban-desktop", status: "ok" });
    } finally {
      db.close();
    }
  });

  it("SQLITE_ENTRY 暴露实际入口名（Database 或 DatabaseSync，以实测为准）", () => {
    expect(["Database", "DatabaseSync"]).toContain(SQLITE_ENTRY);
  });
});
