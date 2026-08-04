import { describe, expect, it } from "vitest";
import { MainSessionCacheKeeperIdentityMismatchError } from "../prompt-cache-evidence.js";
import { rollbackReplaySafeMainSessionCacheKeeperTurn } from "./attempt-transcript-helpers.js";

describe("cache keeper transcript rollback", () => {
  it("removes the exact unanswered keeper turn and synchronizes later message views", () => {
    const priorMessage = { role: "assistant", content: "prior" } as const;
    const keeperMessage = { role: "user", content: "heartbeat" } as const;
    const laterMessage = { role: "user", content: "later" } as const;
    const entries = [
      { id: "prior", type: "message", message: priorMessage },
      { id: "keeper-user", type: "message", message: keeperMessage },
      { id: "later-user", type: "message", message: laterMessage },
    ];
    const stateMessages = [priorMessage, keeperMessage, laterMessage];
    const sessionMessages = [...stateMessages];
    const activeSession = {
      messages: sessionMessages,
      agent: { state: { messages: stateMessages } },
    };
    const sessionManager = {
      removeTrailingEntries: (
        predicate: (entry: (typeof entries)[number]) => boolean,
        options?: { preserveTrailing?: (entry: (typeof entries)[number]) => boolean },
      ) => {
        let index = entries.length - 1;
        while (index >= 0 && options?.preserveTrailing?.(entries[index]!)) {
          index -= 1;
        }
        const target = entries[index];
        if (!target || !predicate(target)) {
          return 0;
        }
        entries.splice(index, 1);
        return 1;
      },
      buildSessionContext: () => ({ messages: entries.map((entry) => entry.message) }),
    };

    expect(
      rollbackReplaySafeMainSessionCacheKeeperTurn({
        activeSession: activeSession as never,
        attempt: {
          promptCacheKeeperEvidenceId: "evidence-1",
          userTurnTranscriptRecorder: { getPersistedMessageId: () => "keeper-user" } as never,
        },
        promptError: new MainSessionCacheKeeperIdentityMismatchError(),
        sessionManager: sessionManager as never,
      }),
    ).toBe("rolled-back");
    expect(entries.map((entry) => entry.id)).toEqual(["prior", "later-user"]);
    expect(activeSession.agent.state.messages).toEqual([priorMessage, laterMessage]);
    expect(activeSession.messages).toEqual([priorMessage, laterMessage]);
  });

  it("fails closed when the exact keeper message cannot be removed", () => {
    const removeTrailingEntries = () => 0;
    expect(
      rollbackReplaySafeMainSessionCacheKeeperTurn({
        activeSession: { agent: { state: { messages: [] } } } as never,
        attempt: {
          promptCacheKeeperEvidenceId: "evidence-1",
          userTurnTranscriptRecorder: { getPersistedMessageId: () => "keeper-user" } as never,
        },
        promptError: new MainSessionCacheKeeperIdentityMismatchError(),
        sessionManager: { removeTrailingEntries } as never,
      }),
    ).toBe("rollback-failed");
  });
});
