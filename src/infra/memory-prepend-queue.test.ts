import { describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  enqueueMemoryPrepend,
  hasPendingMemoryPrepend,
  prepareMemoryPrependQueueDrain,
  prependAssociativeRecallBlockToText,
} from "./memory-prepend-queue.js";

describe("memory prepend queue", () => {
  it("dedupes, truncates, and commits only consumed entries", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-bounds", applyEnv: false },
      async (state) => {
        const scope = { agentId: "main", env: state.env };
        const first = enqueueMemoryPrepend({ ...scope, text: "First recall", now: 1 });
        const duplicate = enqueueMemoryPrepend({ ...scope, text: "First recall", now: 2 });
        enqueueMemoryPrepend({
          ...scope,
          text: "Second recall is much longer than the allowed budget.",
          now: 3,
        });
        enqueueMemoryPrepend({ ...scope, text: "Third recall", now: 4 });

        expect(duplicate).toEqual({ enqueued: false, id: first.id });

        const prepared = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxFragments: 2,
          maxChars: 30,
          renewLease: false,
          now: 5,
        });

        expect(prepared.block).toBe("[Associative recall]\nFirst recall");
        expect(prepared.includedFragments).toBe(1);
        expect(prepared.truncated).toBe(false);
        expect(
          prependAssociativeRecallBlockToText({
            body: "User message",
            recallBlock: prepared.block,
          }),
        ).toContain("User message");

        await expect(prepared.commit()).resolves.toEqual({ applied: true, reason: "updated" });
        const oversized = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxFragments: 2,
          maxChars: 30,
          renewLease: false,
          now: 6,
        });
        expect(oversized.block).toContain("[Associative recall]\nSecond recall");
        expect(oversized.includedFragments).toBe(1);
        expect(oversized.truncated).toBe(true);
        await expect(oversized.commit()).resolves.toEqual({ applied: true, reason: "updated" });
        const remaining = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxFragments: 3,
          maxChars: 100,
          renewLease: false,
          now: 7,
        });
        expect(remaining.block).toBe("[Associative recall]\nThird recall");
        await expect(remaining.commit()).resolves.toEqual({ applied: true, reason: "cleared" });
        expect(hasPendingMemoryPrepend(scope)).toBe(false);
      },
    );
  });

  it("defers a whole fragment that does not fit the remaining batch budget", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-whole-fragment", applyEnv: false },
      async (state) => {
        const scope = { agentId: "main", env: state.env };
        enqueueMemoryPrepend({ ...scope, text: "1234567890", now: 1 });
        enqueueMemoryPrepend({ ...scope, text: "abcdefghij", now: 2 });

        const first = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxChars: 15,
          renewLease: false,
          now: 3,
        });
        expect(first.block).toBe("[Associative recall]\n1234567890");
        expect(first.truncated).toBe(false);
        await first.commit();

        const second = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxChars: 15,
          renewLease: false,
          now: 4,
        });
        expect(second.block).toBe("[Associative recall]\nabcdefghij");
        expect(second.truncated).toBe(false);
        await second.commit();
      },
    );
  });

  it("keeps rows enqueued after a consumer claims its batch", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-producer-race", applyEnv: false },
      async (state) => {
        const scope = { agentId: "main", env: state.env };
        enqueueMemoryPrepend({ ...scope, text: "First recall", now: 1 });
        enqueueMemoryPrepend({ ...scope, text: "Second recall", now: 2 });

        const prepared = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxFragments: 1,
          maxChars: 100,
          renewLease: false,
          now: 3,
        });
        enqueueMemoryPrepend({ ...scope, text: "Appended later", now: 4 });

        await expect(prepared.commit()).resolves.toEqual({ applied: true, reason: "updated" });
        const remaining = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxFragments: 3,
          maxChars: 100,
          renewLease: false,
          now: 5,
        });
        expect(remaining.block).toContain("[Associative recall]\nSecond recall");
        expect(remaining.block).toContain("[Associative recall]\nAppended later");
        expect(remaining.includedFragments).toBe(2);
        await remaining.commit();
      },
    );
  });

  it("releases failed work for the next consumer", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-release", applyEnv: false },
      async (state) => {
        const scope = { agentId: "main", env: state.env };
        enqueueMemoryPrepend({ ...scope, text: "Retry this memory", now: 1 });

        const first = await prepareMemoryPrependQueueDrain({
          ...scope,
          renewLease: false,
          now: 2,
        });
        await expect(first.release()).resolves.toEqual({ applied: true, reason: "released" });

        const retry = await prepareMemoryPrependQueueDrain({
          ...scope,
          renewLease: false,
          now: 3,
        });
        expect(retry.block).toBe("[Associative recall]\nRetry this memory");
        await retry.commit();
      },
    );
  });

  it("truncates emoji without emitting an unpaired UTF-16 surrogate", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-utf16", applyEnv: false },
      async (state) => {
        const scope = { agentId: "main", env: state.env };
        enqueueMemoryPrepend({ ...scope, text: "🧠 memory", now: 1 });

        const prepared = await prepareMemoryPrependQueueDrain({
          ...scope,
          maxChars: 3,
          renewLease: false,
          now: 2,
        });

        expect(prepared.block).toBe("[Associative recall]\n🧠…");
        await prepared.commit();
      },
    );
  });

  it("reclaims an expired lease without allowing the stale consumer to delete it", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-lease", applyEnv: false },
      async (state) => {
        const scope = { agentId: "main", env: state.env };
        enqueueMemoryPrepend({ ...scope, text: "Lease protected memory", now: 1 });

        const stale = await prepareMemoryPrependQueueDrain({
          ...scope,
          leaseMs: 10,
          renewLease: false,
          now: 100,
        });
        const replacement = await prepareMemoryPrependQueueDrain({
          ...scope,
          leaseMs: 10,
          renewLease: false,
          now: 111,
        });

        expect(replacement.block).toBe(stale.block);
        await expect(stale.commit()).resolves.toEqual({ applied: false, reason: "claim_lost" });
        await expect(replacement.commit()).resolves.toEqual({ applied: true, reason: "cleared" });
      },
    );
  });

  it("stops renewing a claim when commit throws so the row can expire", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-finalize-failure", applyEnv: false },
      async (state) => {
        const options = { agentId: "main", env: state.env };
        enqueueMemoryPrepend({ ...options, text: "Recover after commit failure" });
        const prepared = await prepareMemoryPrependQueueDrain({
          ...options,
          leaseMs: 60,
        });
        const database = openOpenClawAgentDatabase(options);
        database.db.exec(
          "ALTER TABLE memory_prepend_queue RENAME TO memory_prepend_queue_blocked;",
        ); // sqlite-allow-raw -- Force the finalize transaction to fail after the claim exists.
        try {
          await expect(prepared.commit()).rejects.toThrow();
        } finally {
          database.db.exec(
            "ALTER TABLE memory_prepend_queue_blocked RENAME TO memory_prepend_queue;",
          ); // sqlite-allow-raw -- Restore the canonical fixture after the injected failure.
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 80);
        });
        const reclaimed = await prepareMemoryPrependQueueDrain({
          ...options,
          renewLease: false,
        });
        expect(reclaimed.block).toBe("[Associative recall]\nRecover after commit failure");
        await reclaimed.commit();
      },
    );
  });

  it("lazily restores the additive queue table in an existing current-version database", async () => {
    await withOpenClawTestState(
      { label: "memory-prepend-lazy-schema", applyEnv: false },
      async (state) => {
        const options = { agentId: "main", env: state.env };
        const database = openOpenClawAgentDatabase(options);
        database.db.exec("DROP TABLE memory_prepend_queue;"); // sqlite-allow-raw -- Simulate a v16 database created before this additive feature.
        closeOpenClawAgentDatabasesForTest();

        expect(enqueueMemoryPrepend({ ...options, text: "Lazy schema memory" }).enqueued).toBe(
          true,
        );
        expect(hasPendingMemoryPrepend(options)).toBe(true);
      },
    );
  });
});
