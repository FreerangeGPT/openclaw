import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentMemoryPrependSchemaInTransaction } from "../state/openclaw-agent-memory-prepend-schema.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { generateSecureUuid } from "./secure-random.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export const MEMORY_PREPEND_BLOCK_LABEL = "[Associative recall]";
export const DEFAULT_MEMORY_PREPEND_MAX_FRAGMENTS = 3;
export const DEFAULT_MEMORY_PREPEND_MAX_CHARS = 2_500;

const DEFAULT_MEMORY_PREPEND_CLAIM_LEASE_MS = 15 * 60_000;
const DEFAULT_MEMORY_PREPEND_CLAIM_RENEW_MS = 60_000;

type MemoryPrependDatabase = Pick<OpenClawAgentKyselyDatabase, "memory_prepend_queue">;
type MemoryPrependDatabaseScope = {
  agentId?: string;
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
};
type MemoryPrependQueueRow = {
  id: string;
  text: string;
};
type ClaimedMemoryPrependRow = MemoryPrependQueueRow & {
  truncated: boolean;
};

export type MemoryPrependCommitResult =
  | { applied: true; reason: "updated" | "cleared" }
  | { applied: false; reason: "noop" | "already_finalized" | "claim_lost" };

export type MemoryPrependReleaseResult =
  | { applied: true; reason: "released" }
  | { applied: false; reason: "noop" | "already_finalized" | "claim_lost" };

export type PreparedMemoryPrependQueueDrain = {
  databasePath: string;
  block?: string;
  includedFragments: number;
  truncated: boolean;
  commit: () => Promise<MemoryPrependCommitResult>;
  release: () => Promise<MemoryPrependReleaseResult>;
};

const ensuredMemoryPrependDatabases = new WeakSet<DatabaseSync>();

function normalizeAssociativeRecallText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function truncateAssociativeRecallText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return maxChars === 1 ? "…" : "";
  }
  return `${truncateUtf16Safe(text, maxChars - 1).trimEnd()}…`;
}

function hashAssociativeRecallText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toDatabaseOptions(scope: MemoryPrependDatabaseScope): OpenClawAgentDatabaseOptions {
  return {
    agentId: normalizeAgentId(scope.agentId),
    ...(scope.databasePath ? { path: scope.databasePath } : {}),
    ...(scope.env ? { env: scope.env } : {}),
  };
}

function ensureMemoryPrependSchema(options: OpenClawAgentDatabaseOptions): OpenClawAgentDatabase {
  const database = openOpenClawAgentDatabase(options);
  if (ensuredMemoryPrependDatabases.has(database.db)) {
    return database;
  }
  if (database.db.isTransaction) {
    throw new Error("memory-prepend schema must be ensured before the write transaction starts");
  }
  runSqliteImmediateTransactionSync(
    database.db,
    () => ensureOpenClawAgentMemoryPrependSchemaInTransaction(database.db),
    {
      databaseLabel: database.path,
      operationLabel: "memory-prepend.ensure-schema",
    },
  );
  ensuredMemoryPrependDatabases.add(database.db);
  return database;
}

function runMemoryPrependWrite<T>(
  scope: MemoryPrependDatabaseScope,
  operationLabel: string,
  operation: (database: OpenClawAgentDatabase) => T,
): T {
  const options = toDatabaseOptions(scope);
  ensureMemoryPrependSchema(options);
  return runOpenClawAgentWriteTransaction(operation, options, { operationLabel });
}

function memoryPrependKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<MemoryPrependDatabase>(database.db);
}

function countClaimRows(
  database: OpenClawAgentDatabase,
  claimId: string,
  ids: readonly string[],
): number {
  if (ids.length === 0) {
    return 0;
  }
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    memoryPrependKysely(database)
      .selectFrom("memory_prepend_queue")
      .select((eb) => eb.fn.countAll<number | bigint>().as("count"))
      .where("claim_id", "=", claimId)
      .where("id", "in", ids),
  );
  return Number(row?.count ?? 0);
}

function renewMemoryPrependClaim(params: {
  scope: MemoryPrependDatabaseScope;
  claimId: string;
  ids: readonly string[];
  leaseMs: number;
  now: number;
}): boolean {
  return runMemoryPrependWrite(params.scope, "memory-prepend.renew", (database) => {
    if (countClaimRows(database, params.claimId, params.ids) !== params.ids.length) {
      return false;
    }
    return (
      executeSqliteQuerySync(
        database.db,
        memoryPrependKysely(database)
          .updateTable("memory_prepend_queue")
          .set({
            claim_expires_at: params.now + params.leaseMs,
            updated_at: params.now,
          })
          .where("claim_id", "=", params.claimId)
          .where("id", "in", params.ids),
      ).numAffectedRows === BigInt(params.ids.length)
    );
  });
}

export function formatAssociativeRecallBlocks(texts: readonly string[]): string {
  return texts
    .map((text) => `${MEMORY_PREPEND_BLOCK_LABEL}\n${normalizeAssociativeRecallText(text)}`)
    .join("\n\n");
}

export function prependAssociativeRecallBlockToText(params: {
  body: string;
  recallBlock?: string;
}): string {
  const recallBlock = normalizeAssociativeRecallText(params.recallBlock ?? "");
  if (!recallBlock) {
    return params.body;
  }
  return params.body.trim() ? `${recallBlock}\n\n${params.body}` : recallBlock;
}

/** Enqueue one memory fragment, deduplicating only against currently queued work. */
export function enqueueMemoryPrepend(
  params: MemoryPrependDatabaseScope & {
    text: string;
    hash?: string;
    id?: string;
    now?: number;
  },
): { enqueued: boolean; id: string } {
  const text = normalizeAssociativeRecallText(params.text);
  if (!text) {
    throw new Error("memory prepend text must not be empty");
  }
  const dedupeKey =
    normalizeAssociativeRecallText(params.hash ?? "") || hashAssociativeRecallText(text);
  const id = params.id?.trim() || generateSecureUuid();
  const now = params.now ?? Date.now();
  return runMemoryPrependWrite(params, "memory-prepend.enqueue", (database) => {
    const db = memoryPrependKysely(database);
    const inserted =
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("memory_prepend_queue")
          .values({
            id,
            dedupe_key: dedupeKey,
            text,
            status: "pending",
            claim_id: null,
            claim_expires_at: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) => conflict.doNothing()),
      ).numAffectedRows === 1n;
    if (inserted) {
      return { enqueued: true, id };
    }
    const existing = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("memory_prepend_queue")
        .select("id")
        .where("dedupe_key", "=", dedupeKey)
        .limit(1),
    );
    if (!existing) {
      throw new Error(`memory prepend queue id collision: ${id}`);
    }
    return { enqueued: false, id: existing.id };
  });
}

/** Return whether work is claimable now without mutating queue ownership. */
export function hasPendingMemoryPrepend(
  params: MemoryPrependDatabaseScope & { now?: number },
): boolean {
  const database = ensureMemoryPrependSchema(toDatabaseOptions(params));
  const now = params.now ?? Date.now();
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      memoryPrependKysely(database)
        .selectFrom("memory_prepend_queue")
        .select("id")
        .where((eb) =>
          eb.or([
            eb("status", "=", "pending"),
            eb.and([eb("status", "=", "claimed"), eb("claim_expires_at", "<=", now)]),
          ]),
        )
        .limit(1),
    ),
  );
}

/** Atomically claim a bounded batch; callers ack success or release failure. */
export async function prepareMemoryPrependQueueDrain(
  params: MemoryPrependDatabaseScope & {
    maxFragments?: number;
    maxChars?: number;
    now?: number;
    leaseMs?: number;
    renewLease?: boolean;
  },
): Promise<PreparedMemoryPrependQueueDrain> {
  const scope: MemoryPrependDatabaseScope = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.databasePath ? { databasePath: params.databasePath } : {}),
    ...(params.env ? { env: params.env } : {}),
  };
  const maxFragments = Math.max(
    1,
    Math.floor(params.maxFragments ?? DEFAULT_MEMORY_PREPEND_MAX_FRAGMENTS),
  );
  const maxChars = Math.max(1, Math.floor(params.maxChars ?? DEFAULT_MEMORY_PREPEND_MAX_CHARS));
  const leaseMs = Math.max(1, Math.floor(params.leaseMs ?? DEFAULT_MEMORY_PREPEND_CLAIM_LEASE_MS));
  const claimId = generateSecureUuid();
  const now = params.now ?? Date.now();
  let databasePath = "";

  const rows = runMemoryPrependWrite(scope, "memory-prepend.claim", (database) => {
    databasePath = database.path;
    const db = memoryPrependKysely(database);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("memory_prepend_queue")
        .set({
          status: "pending",
          claim_id: null,
          claim_expires_at: null,
          updated_at: now,
        })
        .where("status", "=", "claimed")
        .where("claim_expires_at", "<=", now),
    );
    const pending = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("memory_prepend_queue")
        .select(["id", "text"])
        .where("status", "=", "pending")
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(maxFragments),
    ).rows as MemoryPrependQueueRow[];
    const selected: ClaimedMemoryPrependRow[] = [];
    let selectedChars = 0;
    for (const row of pending) {
      const remainingChars = maxChars - selectedChars;
      if (remainingChars <= 0) {
        break;
      }
      const text =
        row.text.length <= remainingChars
          ? row.text
          : selected.length === 0 && row.text.length > maxChars
            ? truncateAssociativeRecallText(row.text, maxChars)
            : "";
      if (!text) {
        // Preserve a fragment that fits an empty batch instead of deleting its
        // undisplayed tail merely because earlier rows consumed this batch.
        break;
      }
      selected.push({ id: row.id, text, truncated: text.length < row.text.length });
      selectedChars += text.length;
      if (selectedChars >= maxChars) {
        break;
      }
    }
    if (selected.length === 0) {
      return selected;
    }
    const ids = selected.map((row) => row.id);
    const claimed = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("memory_prepend_queue")
        .set({
          status: "claimed",
          claim_id: claimId,
          claim_expires_at: now + leaseMs,
          updated_at: now,
        })
        .where("status", "=", "pending")
        .where("id", "in", ids),
    ).numAffectedRows;
    if (claimed !== BigInt(ids.length)) {
      throw new Error("memory prepend claim changed inside its write transaction");
    }
    return selected;
  });

  if (rows.length === 0) {
    return {
      databasePath,
      includedFragments: 0,
      truncated: false,
      commit: async () => ({ applied: false, reason: "noop" }),
      release: async () => ({ applied: false, reason: "noop" }),
    };
  }

  const includedTexts = rows.map((row) => row.text);
  const truncated = rows.some((row) => row.truncated);
  const ids = rows.map((row) => row.id);
  let finalized = false;
  let claimLost = false;
  let renewTimer: NodeJS.Timeout | undefined;

  const stopRenewal = () => {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = undefined;
    }
  };
  if (params.renewLease !== false) {
    const renewEveryMs = Math.max(
      1,
      Math.min(DEFAULT_MEMORY_PREPEND_CLAIM_RENEW_MS, Math.floor(leaseMs / 3)),
    );
    renewTimer = setInterval(() => {
      if (finalized || claimLost) {
        stopRenewal();
        return;
      }
      try {
        claimLost = !renewMemoryPrependClaim({
          scope,
          claimId,
          ids,
          leaseMs,
          now: Date.now(),
        });
      } catch {
        // A transient SQLite failure should not consume memory. Keep retrying
        // until the lease expires; commit/release will still verify ownership.
      }
    }, renewEveryMs);
    renewTimer.unref();
  }

  return {
    databasePath,
    block: formatAssociativeRecallBlocks(includedTexts),
    includedFragments: includedTexts.length,
    truncated,
    commit: async () => {
      if (finalized) {
        return { applied: false, reason: "already_finalized" };
      }
      if (claimLost) {
        finalized = true;
        stopRenewal();
        return { applied: false, reason: "claim_lost" };
      }
      try {
        return runMemoryPrependWrite(scope, "memory-prepend.commit", (database) => {
          if (countClaimRows(database, claimId, ids) !== ids.length) {
            return { applied: false, reason: "claim_lost" } as const;
          }
          executeSqliteQuerySync(
            database.db,
            memoryPrependKysely(database)
              .deleteFrom("memory_prepend_queue")
              .where("claim_id", "=", claimId)
              .where("id", "in", ids),
          );
          const remaining = executeSqliteQueryTakeFirstSync(
            database.db,
            memoryPrependKysely(database)
              .selectFrom("memory_prepend_queue")
              .select((eb) => eb.fn.countAll<number | bigint>().as("count")),
          );
          return {
            applied: true,
            reason: Number(remaining?.count ?? 0) > 0 ? "updated" : "cleared",
          } as const;
        });
      } finally {
        finalized = true;
        stopRenewal();
      }
    },
    release: async () => {
      if (finalized) {
        return { applied: false, reason: "already_finalized" };
      }
      try {
        return runMemoryPrependWrite(scope, "memory-prepend.release", (database) => {
          if (countClaimRows(database, claimId, ids) !== ids.length) {
            return { applied: false, reason: "claim_lost" } as const;
          }
          executeSqliteQuerySync(
            database.db,
            memoryPrependKysely(database)
              .updateTable("memory_prepend_queue")
              .set({
                status: "pending",
                claim_id: null,
                claim_expires_at: null,
                updated_at: Date.now(),
              })
              .where("claim_id", "=", claimId)
              .where("id", "in", ids),
          );
          return { applied: true, reason: "released" } as const;
        });
      } finally {
        finalized = true;
        stopRenewal();
      }
    },
  };
}
