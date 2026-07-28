import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";

const MEMORY_PREPEND_SCHEMA_START = "CREATE TABLE IF NOT EXISTS memory_prepend_queue (";
const MEMORY_PREPEND_SCHEMA_END = "CREATE TABLE IF NOT EXISTS auth_profile_store (";

function extractMemoryPrependSchema(sql: string): string {
  const start = sql.indexOf(MEMORY_PREPEND_SCHEMA_START);
  const end = sql.indexOf(MEMORY_PREPEND_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent memory-prepend schema markers are missing.");
  }
  return sql.slice(start, end);
}

const OPENCLAW_AGENT_MEMORY_PREPEND_SCHEMA_SQL =
  extractMemoryPrependSchema(OPENCLAW_AGENT_SCHEMA_SQL);

/** Lazily create the additive memory-prepend queue inside the caller's transaction. */
export function ensureOpenClawAgentMemoryPrependSchemaInTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new Error("memory-prepend schema ensure requires an active transaction");
  }
  database.exec(OPENCLAW_AGENT_MEMORY_PREPEND_SCHEMA_SQL); // sqlite-allow-raw -- Canonical DDL bootstrap for the lazy agent queue.
}
