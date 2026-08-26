// Memory Core plugin module owns persisted vector completeness state.
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_INDEX_META_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const VECTOR_REBUILD_META_KEY = "memory_vector_rebuild_v1";

function vectorTableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

/** True when the derived vec0 table can filter before KNN candidate selection. */
export function hasMemoryVectorFilterColumns(db: DatabaseSync, tableName: string): boolean {
  if (!vectorTableExists(db, tableName)) {
    return false;
  }
  const columns = new Set(
    (db.prepare(`PRAGMA table_xinfo(${tableName})`).all() as Array<{ name?: unknown }>).flatMap(
      (row) => (typeof row.name === "string" ? [row.name] : []),
    ),
  );
  return columns.has("source") && columns.has("model");
}

export function markMemoryVectorIndexClean(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO ${MEMORY_INDEX_META_TABLE} (key, value) VALUES (?, 'clean')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(VECTOR_REBUILD_META_KEY);
}

export function markMemoryVectorRebuildRequired(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO ${MEMORY_INDEX_META_TABLE} (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(VECTOR_REBUILD_META_KEY);
}

export function requiresMemoryVectorRebuild(params: {
  db: DatabaseSync;
  vectorTable: string;
  metaVectorDims?: number;
  hasSemanticChunks: boolean;
}): boolean {
  const row = params.db
    .prepare(`SELECT value FROM ${MEMORY_INDEX_META_TABLE} WHERE key = ?`)
    .get(VECTOR_REBUILD_META_KEY) as { value?: unknown } | undefined;
  if (row?.value === "1") {
    return true;
  }
  if (!vectorTableExists(params.db, params.vectorTable)) {
    return Boolean(params.metaVectorDims && params.hasSemanticChunks);
  }
  if (!hasMemoryVectorFilterColumns(params.db, params.vectorTable)) {
    return true;
  }
  // Existing releases had no completeness marker. Rebuild their vector table
  // once rather than assuming it has neither missing nor orphaned rows.
  return row?.value !== "clean";
}
