// 用途：projects 表 store —— 注册（canonical 归一化 + 去重）、列表、目录缺失探测（C3 表已在 db.ts 建好）
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ProjectRow } from "@kanban/ipc-schema";
import { canonicalizePath } from "./canonical-path";
import type { SqliteDb } from "./db";

export type ProjectRecord = ProjectRow;

/** register 结果：duplicate=true 表示该 canonical path 已注册（返回既有记录，不新增） */
export interface RegisterResult {
  duplicate: boolean;
  project: ProjectRecord;
}

/** projects 表读写 */
export class ProjectStore {
  constructor(private readonly db: SqliteDb) {}

  /** 全量列表（created_at 倒序：新注册在前） */
  list(): ProjectRecord[] {
    const rows = this.db
      .prepare("SELECT id, name, canonical_path, status, created_at FROM projects ORDER BY created_at DESC, id")
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      canonicalPath: String(r.canonical_path),
      status: r.status as ProjectRecord["status"],
      createdAt: String(r.created_at),
    }));
  }

  get(id: string): ProjectRecord | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** 注册目录：canonical 归一化后按 canonical_path 去重；name 取末段；status 按存在性初始化 */
  register(path: string): RegisterResult {
    const canonical = canonicalizePath(path);
    const existing = this.list().find((p) => p.canonicalPath === canonical);
    if (existing) return { duplicate: true, project: existing };
    const project: ProjectRecord = {
      id: randomUUID(),
      name: basename(canonical) || canonical,
      canonicalPath: canonical,
      status: existsSync(canonical) ? "ok" : "missing",
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO projects (id, name, canonical_path, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(project.id, project.name, project.canonicalPath, project.status, project.createdAt);
    return { duplicate: false, project };
  }

  /** 探测全部项目目录存在性并落库（启动与切换前调用；返回探测后的最新列表） */
  refreshStatuses(): ProjectRecord[] {
    for (const p of this.list()) {
      const status = existsSync(p.canonicalPath) ? "ok" : "missing";
      if (status !== p.status) {
        this.db.prepare("UPDATE projects SET status = ? WHERE id = ?").run(status, p.id);
      }
    }
    return this.list();
  }
}
