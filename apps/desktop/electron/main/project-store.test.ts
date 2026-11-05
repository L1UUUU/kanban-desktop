// 用途：projects 表 store 测试 —— 注册（canonical 去重/命名/初始状态）、列表、缺失探测、重启恢复（工单 #7 验收第 1/5 条）
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDb } from "./db";
import { ProjectStore, type ProjectRecord } from "./project-store";

let tmpRoot = "";
let dbPath = "";
let db: SqliteDb | null = null;

afterEach(() => {
  db?.close();
  db = null;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

/** 建临时 fixture：返回 { tmp, store }（db 文件落在临时目录内，afterEach 统一关连接） */
function makeStore(): { tmp: string; store: ProjectStore } {
  tmpRoot = mkdtempSync(join(tmpdir(), "kb-projstore-"));
  dbPath = join(tmpRoot, "test.db");
  db = openDatabase(dbPath);
  return { tmp: tmpRoot, store: new ProjectStore(db) };
}

describe("ProjectStore.register", () => {
  it("注册存在的目录：canonical 落库、name 取末段、status=ok", () => {
    const { tmp, store } = makeStore();
    mkdirSync(join(tmp, "my-proj"));
    const r = store.register(join(tmp, "my-proj"));
    expect(r.duplicate).toBe(false);
    expect(r.project.name).toBe("my-proj");
    expect(r.project.status).toBe("ok");
    expect(r.project.canonicalPath).toBe(store.register(join(tmp, "MY-PROJ")).project.canonicalPath);
  });

  it("同一 canonical 重复注册 → duplicate 返回已存在记录，不新增行", () => {
    const { tmp, store } = makeStore();
    mkdirSync(join(tmp, "dup"));
    const first = store.register(join(tmp, "dup"));
    const second = store.register(join(tmp, "dup", "..", "dup"));
    expect(second.duplicate).toBe(true);
    expect(second.project.id).toBe(first.project.id);
    expect(store.list()).toHaveLength(1);
  });
});

describe("ProjectStore 状态与恢复", () => {
  it("refreshStatuses：目录被删 → missing；目录恢复 → ok", () => {
    const { tmp, store } = makeStore();
    const dir = join(tmp, "gone");
    mkdirSync(dir);
    const { project } = store.register(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(store.refreshStatuses().find((p) => p.id === project.id)?.status).toBe("missing");
    mkdirSync(dir);
    expect(store.refreshStatuses().find((p) => p.id === project.id)?.status).toBe("ok");
  });

  it("重启恢复：新 store 实例（新 db 连接）读同一文件，项目列表完整", () => {
    const { tmp, store } = makeStore();
    mkdirSync(join(tmp, "alpha"));
    mkdirSync(join(tmp, "beta"));
    store.register(join(tmp, "alpha"));
    store.register(join(tmp, "beta"));
    const reopenedDb = openDatabase(dbPath);
    const reopened = new ProjectStore(reopenedDb);
    const names = reopened.list().map((p: ProjectRecord) => p.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    reopenedDb.close();
  });

  it("get：按 id 查找", () => {
    const { tmp, store } = makeStore();
    mkdirSync(join(tmp, "one"));
    const { project } = store.register(join(tmp, "one"));
    expect(store.get(project.id)?.canonicalPath).toBe(project.canonicalPath);
    expect(store.get("nope")).toBeUndefined();
  });
});
