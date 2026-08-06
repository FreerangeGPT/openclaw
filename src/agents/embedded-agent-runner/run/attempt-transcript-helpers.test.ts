import { describe, expect, it } from "vitest";
import { MainSessionCacheKeeperIdentityMismatchError } from "../prompt-cache-evidence.js";
import {
  discardPureMainSessionHeartbeatAckTurn,
  rollbackReplaySafeMainSessionCacheKeeperTurn,
} from "./attempt-transcript-helpers.js";

describe("cache keeper heartbeat acknowledgement discard", () => {
  function createHarness(assistantContent: unknown[]) {
    const priorMessage = { role: "assistant", content: "prior" } as const;
    const heartbeatUser = { role: "user", content: "heartbeat" } as const;
    const heartbeatAssistant = {
      role: "assistant",
      content: assistantContent,
      stopReason: "stop",
    } as const;
    const entries = [
      { id: "prior", parentId: null, type: "message", message: priorMessage },
      {
        id: "heartbeat-user",
        parentId: "prior",
        type: "message",
        message: heartbeatUser,
      },
      {
        id: "heartbeat-assistant",
        parentId: "heartbeat-user",
        type: "message",
        message: heartbeatAssistant,
      },
    ];
    const stateMessages = [priorMessage, heartbeatUser, heartbeatAssistant];
    const sessionMessages = [...stateMessages];
    const sessionManager = {
      getLeafEntry: () => entries.at(-1),
      getBranch: () => entries,
      removeTrailingEntries: (predicate: (entry: (typeof entries)[number]) => boolean) => {
        let removed = 0;
        while (entries.length > 0 && predicate(entries.at(-1)!)) {
          entries.pop();
          removed += 1;
        }
        return removed;
      },
      buildSessionContext: () => ({ messages: entries.map((entry) => entry.message) }),
    };
    return {
      activeSession: {
        messages: sessionMessages,
        agent: { state: { messages: stateMessages } },
      },
      entries,
      sessionManager,
    };
  }

  it("removes an exact HEARTBEAT_OK turn while ignoring thinking content", () => {
    const harness = createHarness([
      { type: "thinking", thinking: "checked the monitor" },
      { type: "text", text: "HEARTBEAT_OK" },
    ]);

    expect(
      discardPureMainSessionHeartbeatAckTurn({
        activeSession: harness.activeSession as never,
        sessionManager: harness.sessionManager as never,
        attempt: {
          trigger: "heartbeat",
          promptCacheKeeperEvidenceId: "evidence-1",
          userTurnTranscriptRecorder: {
            getPersistedMessageId: () => "heartbeat-user",
          } as never,
        },
        cacheRefreshConfirmed: true,
        compactionOccurredThisAttempt: false,
        interrupted: false,
        promptError: undefined,
        toolActivityCount: 0,
      }),
    ).toBe("discarded");
    expect(harness.entries.map((entry) => entry.id)).toEqual(["prior"]);
    expect(harness.activeSession.agent.state.messages).toEqual([
      { role: "assistant", content: "prior" },
    ]);
  });

  it.each([
    {
      name: "extra visible text",
      content: [{ type: "text", text: "HEARTBEAT_OK but something changed" }],
      toolActivityCount: 0,
    },
    {
      name: "tool activity",
      content: [{ type: "text", text: "HEARTBEAT_OK" }],
      toolActivityCount: 1,
    },
  ])("keeps the turn when it has $name", ({ content, toolActivityCount }) => {
    const harness = createHarness(content);
    expect(
      discardPureMainSessionHeartbeatAckTurn({
        activeSession: harness.activeSession as never,
        sessionManager: harness.sessionManager as never,
        attempt: {
          trigger: "heartbeat",
          promptCacheKeeperEvidenceId: "evidence-1",
          userTurnTranscriptRecorder: {
            getPersistedMessageId: () => "heartbeat-user",
          } as never,
        },
        cacheRefreshConfirmed: true,
        compactionOccurredThisAttempt: false,
        interrupted: false,
        promptError: undefined,
        toolActivityCount,
      }),
    ).toBe("not-discardable");
    expect(harness.entries).toHaveLength(3);
  });

  it("keeps the turn when the provider did not prove a covering cache refresh", () => {
    const harness = createHarness([{ type: "text", text: "HEARTBEAT_OK" }]);
    expect(
      discardPureMainSessionHeartbeatAckTurn({
        activeSession: harness.activeSession as never,
        sessionManager: harness.sessionManager as never,
        attempt: {
          trigger: "heartbeat",
          promptCacheKeeperEvidenceId: "evidence-1",
          userTurnTranscriptRecorder: {
            getPersistedMessageId: () => "heartbeat-user",
          } as never,
        },
        cacheRefreshConfirmed: false,
        compactionOccurredThisAttempt: false,
        interrupted: false,
        promptError: undefined,
        toolActivityCount: 0,
      }),
    ).toBe("not-discardable");
  });

  it("fails without mutation when the exact trailing pair is not present", () => {
    const harness = createHarness([{ type: "text", text: "HEARTBEAT_OK" }]);
    harness.sessionManager.getBranch = () => [harness.entries[0]!, harness.entries[2]!];

    expect(
      discardPureMainSessionHeartbeatAckTurn({
        activeSession: harness.activeSession as never,
        sessionManager: harness.sessionManager as never,
        attempt: {
          trigger: "heartbeat",
          promptCacheKeeperEvidenceId: "evidence-1",
          userTurnTranscriptRecorder: {
            getPersistedMessageId: () => "heartbeat-user",
          } as never,
        },
        cacheRefreshConfirmed: true,
        compactionOccurredThisAttempt: false,
        interrupted: false,
        promptError: undefined,
        toolActivityCount: 0,
      }),
    ).toBe("discard-failed");
    expect(harness.entries.map((entry) => entry.id)).toEqual([
      "prior",
      "heartbeat-user",
      "heartbeat-assistant",
    ]);
  });
});

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
