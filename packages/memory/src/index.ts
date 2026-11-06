// 用途：@kanban/memory 入口 —— SQLite v3 三表 DDL/迁移 + MemoryStore（批次/候选状态机/双写序/判重标注）+ SummaryStore（总结防覆盖）+ 启动对账修复 + 分段与相似度纯函数（spec #27 D/E/F/G 节）；纯 Node 包，db 句柄与数据根目录经注入
export { MAX_CHUNK_CHARS, chunkEvents, type ChunkSessionRef, type EventChunk, type MemoryEvent } from "./chunk";
export {
  CONFLICT_THRESHOLD,
  MERGE_THRESHOLD,
  diceSimilarity,
  mergeCandidates,
  normalizeClaimText,
  type ExtractedCandidate,
} from "./similarity";
export {
  MEMORY_TABLES_DDL,
  MEMORY_V3_MIGRATION_NAME,
  ensureMemoryTables,
  listMemoryTables,
  migrateMemoryToV3,
  type SqliteDb,
} from "./ddl";
export {
  MemoryStore,
  type BatchStatus,
  type CandidateStatus,
  type MemoryBatchRecord,
  type MemoryCandidateRecord,
  type MissingSession,
  type ReviewAction,
  type SimilarityNote,
} from "./store";
export {
  SummaryStore,
  type MemorySummaryRecord,
  type WriteSummaryResult,
} from "./summary";
export { reconcileMemory, type ReconcileReport } from "./recovery";
