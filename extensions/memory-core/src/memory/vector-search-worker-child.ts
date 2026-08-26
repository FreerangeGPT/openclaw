// Memory Core plugin child entrypoint for isolated SQLite vector search.
import type { DatabaseSync } from "node:sqlite";
import {
  loadSqliteVecExtension,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { searchVector } from "./manager-search.js";

type WorkerRequest =
  | {
      id: number;
      type: "initialize";
      databasePath: string;
      extensionPath?: string;
    }
  | {
      id: number;
      type: "search";
      providerModel: string;
      providerModelAliases?: string[];
      queryVec: number[];
      limit: number;
      snippetMaxChars: number;
      sources: MemorySource[];
      nativeEligible: boolean;
    }
  | { id: number; type: "close" };

let db: DatabaseSync | null = null;
let vectorExtensionAvailable = false;
let requestQueue: Promise<void> = Promise.resolve();

function send(message: unknown): void {
  process.send?.(message);
}

function serializeError(error: unknown): { message: string; code?: string } {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const code = (error as Error & { code?: unknown }).code;
  return { message: error.message, ...(typeof code === "string" ? { code } : {}) };
}

function closeDatabase(): void {
  const current = db;
  db = null;
  vectorExtensionAvailable = false;
  current?.close();
}

function sourceFilter(alias: string | undefined, sources: MemorySource[]) {
  if (sources.length === 0) {
    return { sql: "", params: [] as MemorySource[] };
  }
  const column = alias ? `${alias}.source` : "source";
  return {
    sql: ` AND ${column} IN (${sources.map(() => "?").join(", ")})`,
    params: sources,
  };
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  if (request.type === "close") {
    closeDatabase();
    send({ id: request.id, ok: true });
    return;
  }
  if (request.type === "initialize") {
    closeDatabase();
    db = openNodeSqliteDatabase(request.databasePath, { readOnly: true, allowExtension: true });
    const loaded = await loadSqliteVecExtension({
      db,
      extensionPath: request.extensionPath,
    });
    vectorExtensionAvailable = loaded.ok;
    send({ id: request.id, ok: true });
    return;
  }
  if (!db) {
    throw new Error("Vector search worker is not initialized");
  }
  const results = await searchVector({
    db,
    vectorTable: "memory_index_chunks_vec",
    providerModel: request.providerModel,
    providerModelAliases: request.providerModelAliases,
    queryVec: request.queryVec,
    limit: request.limit,
    snippetMaxChars: request.snippetMaxChars,
    ensureVectorReady: async () => request.nativeEligible && vectorExtensionAvailable,
    sourceFilterVec: sourceFilter("v", request.sources),
    sourceFilterChunks: sourceFilter(undefined, request.sources),
  });
  send({ id: request.id, ok: true, value: results });
}

process.on("message", (message) => {
  const request = message as WorkerRequest;
  requestQueue = requestQueue.then(async () => {
    try {
      await handleRequest(request);
    } catch (error) {
      send({ id: request.id, ok: false, error: serializeError(error) });
    }
  });
});

process.once("disconnect", () => {
  closeDatabase();
  process.exit(0);
});
