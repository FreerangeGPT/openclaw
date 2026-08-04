import { beforeEach, describe, expect, it, vi } from "vitest";
import { MainSessionCacheKeeperIdentityMismatchError } from "../prompt-cache-evidence.js";
import { clearProviderPromptState, getProviderPromptState } from "../provider-prompt-state.js";

const hoisted = vi.hoisted(() => ({
  runAgentEndSideEffects: vi.fn(),
}));

vi.mock("../../harness/agent-end-side-effects.js", () => ({
  runAgentEndSideEffects: hoisted.runAgentEndSideEffects,
}));
vi.mock("./agent-end-context.js", () => ({
  buildEmbeddedAgentEndContext: () => ({}),
}));

import { completeEmbeddedAttemptAfterTurn } from "./attempt-after-turn.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";

describe("embedded attempt phase lifecycle state", () => {
  beforeEach(() => {
    hoisted.runAgentEndSideEffects.mockReset();
  });

  it("re-reads compaction timeout state after the retry wait", async () => {
    let timedOut = false;
    let timedOutDuringCompaction = false;
    const messages: never[] = [];
    const removeTrailingEntries = vi.fn(() => 0);
    const sessionManager = {
      appendCustomEntry: vi.fn(),
      buildSessionContext: () => ({ messages }),
      getEntries: () => [],
      removeTrailingEntries,
    };
    const activeSession = {
      agent: { state: { messages } },
      isCompacting: false,
      isStreaming: false,
      messages,
      sessionId: "session-1",
    };

    const result = await settleEmbeddedAttemptStream({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        provider: "test",
        modelId: "model",
        model: { api: "openai-responses" },
      } as never,
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: {
        waitForSessionEvents: async () => {},
      } as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      subscription: {
        toolMetas: [],
        waitForCompactionRetry: async () => {
          timedOut = true;
          timedOutDuringCompaction = true;
        },
        isCompactionInFlight: () => false,
        getCompactionCount: () => 0,
        getCurrentAttemptAssistant: () => undefined,
        getUsageTotals: () => undefined,
        getLastAssistantUsage: () => undefined,
      } as never,
      state: {
        promptError: null,
        promptErrorSource: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
      },
      readLifecycleState: () => ({
        aborted: timedOut,
        timedOut,
        timedOutDuringCompaction,
      }),
      markTimedOutDuringCompaction: () => {
        timedOutDuringCompaction = true;
      },
      runAbortDeadlineAtMs: Date.now() + 60_000,
      runAbortSignal: new AbortController().signal,
      isProbeSession: true,
      sessionAgentId: "main",
      abortable: async (promise) => await promise,
      prePromptMessageCount: 0,
      toolSearchTargetTranscriptProjections: [],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        retention: undefined,
      },
      shouldFlushForContextEngine: false,
    });

    expect(result.timedOutDuringCompaction).toBe(true);
    expect(removeTrailingEntries).toHaveBeenCalledOnce();
  });

  it("does not repeat a cache-keeper rollback completed during session preparation", async () => {
    const promptError = new MainSessionCacheKeeperIdentityMismatchError();
    const activeMessages = [{ role: "user", content: "stale keeper" }] as never[];
    const rebuiltMessages = [{ role: "assistant", content: "authoritative branch" }] as never[];
    const removeTrailingEntries = vi.fn(() => 0);
    const sessionManager = {
      appendCustomEntry: vi.fn(),
      buildSessionContext: () => ({ messages: rebuiltMessages }),
      getEntries: () => [],
      removeTrailingEntries,
    };
    const activeSession = {
      agent: { state: { messages: activeMessages } },
      isCompacting: false,
      isStreaming: false,
      messages: activeMessages,
      sessionId: "session-1",
    };

    const result = await settleEmbeddedAttemptStream({
      attempt: {
        runId: "run-keeper-rollback",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        model: { api: "anthropic-messages" },
        promptCacheKeeperEvidenceId: "evidence-1",
        promptCacheKeeperTurnRollbackCompleted: true,
        userTurnTranscriptRecorder: { getPersistedMessageId: () => "keeper-user" },
      } as never,
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: { waitForSessionEvents: async () => {} } as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      subscription: {
        toolMetas: [],
        waitForCompactionRetry: async () => undefined,
        isCompactionInFlight: () => false,
        getCompactionCount: () => 0,
        getCurrentAttemptAssistant: () => undefined,
        getUsageTotals: () => undefined,
        getLastAssistantUsage: () => undefined,
      } as never,
      state: {
        promptError,
        promptErrorSource: "prompt",
        yieldAborted: false,
        sessionIdUsed: "session-1",
      },
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
      markTimedOutDuringCompaction: () => {},
      runAbortDeadlineAtMs: Date.now() + 60_000,
      runAbortSignal: new AbortController().signal,
      isProbeSession: true,
      sessionAgentId: "main",
      abortable: async (promise) => await promise,
      prePromptMessageCount: 0,
      toolSearchTargetTranscriptProjections: [],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        retention: "long",
      },
      shouldFlushForContextEngine: false,
    });

    expect(removeTrailingEntries).not.toHaveBeenCalled();
    expect(activeSession.agent.state.messages).toEqual(rebuiltMessages);
    expect(activeSession.messages).toEqual(rebuiltMessages);
    expect(result.promptError).toBe(promptError);
    expect(result.promptError).toMatchObject({ replaySafe: true });
  });

  it("records the effective cache retention after a cache-bearing main-session turn", async () => {
    const runId = "run-cache-evidence";
    const providerCallStartedAt = 1_699_999_955_000;
    getProviderPromptState(runId).lastAttempt = {
      scopeDigest: "scope",
      digest: "payload",
      byteWeight: 1,
      cachePrefixIdentity: "provider-cache-prefix-identity-main",
      cacheRequestOptionsIdentity: "request-options-identity-main",
      providerMessageIdentity: "provider-message-identity-main",
      providerCallStartedAt,
    };
    const usage = {
      input: 1_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 90_000,
      cacheWrite1h: 90_000,
      contextUsage: { state: "available" as const, promptTokens: 91_000, totalTokens: 91_100 },
      total: 91_100,
    };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage,
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    };
    const messages = [assistant];
    const appendCustomEntry = vi.fn();
    const sessionManager = {
      appendCustomEntry,
      buildSessionContext: () => ({ messages }),
      getEntries: () => [],
      removeTrailingEntries: vi.fn(() => 0),
    };
    const activeSession = {
      agent: { state: { messages } },
      isCompacting: false,
      isStreaming: false,
      messages,
      sessionId: "session-1",
    };

    const result = await settleEmbeddedAttemptStream({
      attempt: {
        config: {},
        runId,
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        model: { api: "anthropic-messages" },
        resolvedApiKey: "sk-ant-test",
      } as never,
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: { waitForSessionEvents: async () => {} } as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      subscription: {
        toolMetas: [],
        waitForCompactionRetry: async () => undefined,
        isCompactionInFlight: () => false,
        getCompactionCount: () => 0,
        getCurrentAttemptAssistant: () => assistant,
        getUsageTotals: () => usage,
        getLastAssistantUsage: () => usage,
      } as never,
      state: {
        promptError: null,
        promptErrorSource: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
      },
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
      markTimedOutDuringCompaction: () => {},
      runAbortDeadlineAtMs: Date.now() + 60_000,
      runAbortSignal: new AbortController().signal,
      isProbeSession: false,
      sessionAgentId: "main",
      abortable: async (promise) => await promise,
      prePromptMessageCount: 0,
      toolSearchTargetTranscriptProjections: [],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        identity: "prompt-identity-main",
        retention: "long",
      },
      shouldFlushForContextEngine: false,
    });

    expect(appendCustomEntry).toHaveBeenCalledWith(
      "openclaw.prompt-cache",
      expect.objectContaining({
        timestamp: providerCallStartedAt,
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        cacheRetention: "long",
        promptIdentity: "prompt-identity-main",
        providerCachePrefixIdentity: "provider-cache-prefix-identity-main",
        requestOptionsIdentity: "request-options-identity-main",
        providerMessageIdentity: "provider-message-identity-main",
        authFingerprint: expect.any(String),
        cacheRead: 0,
        cacheWrite: 90_000,
        cacheWrite1h: 90_000,
        promptTokens: 91_000,
        confirmedCachedTokens: 90_000,
        evidenceId: expect.any(String),
      }),
    );
    expect(result.promptCache?.lastCacheTouchAt).toBe(providerCallStartedAt);
    clearProviderPromptState(runId);
  });

  it("re-reads abort state after post-turn session draining", async () => {
    let aborted = false;
    await completeEmbeddedAttemptAfterTurn({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      } as never,
      activeSession: {} as never,
      sessionManager: { appendCustomEntry: vi.fn() } as never,
      sessionLockController: {
        waitForSessionEvents: async () => {
          aborted = true;
        },
      } as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      state: {
        promptError: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        contextEngineAfterTurnCheckpoint: null,
        compactionOccurredThisAttempt: false,
      },
      readLifecycleState: () => ({
        aborted,
        timedOut: aborted,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
      }),
      runtime: {
        effectiveWorkspace: "/tmp/workspace",
        agentDir: "/tmp/agent",
        sessionAgentId: "main",
        resolveActiveContextEnginePluginId: () => undefined,
        shouldRecordCompletedBootstrapTurn: false,
        cacheTrace: null,
        anthropicPayloadLogger: null,
        hookAgentId: "main",
        diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } as never,
        skillWorkshopAvailable: false,
        hookRunner: null,
        promptStartedAt: Date.now(),
      },
    });

    expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ success: false }),
      }),
    );
  });

  it("skips agent_end side effects for settled-turn finalization", async () => {
    await completeEmbeddedAttemptAfterTurn({
      attempt: {
        operation: "settled-tool-finalization",
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      } as never,
      activeSession: {} as never,
      sessionManager: { appendCustomEntry: vi.fn() } as never,
      sessionLockController: { waitForSessionEvents: async () => undefined } as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      state: {
        promptError: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        contextEngineAfterTurnCheckpoint: null,
        compactionOccurredThisAttempt: false,
      },
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
      }),
      runtime: {
        effectiveWorkspace: "/tmp/workspace",
        agentDir: "/tmp/agent",
        sessionAgentId: "main",
        resolveActiveContextEnginePluginId: () => undefined,
        shouldRecordCompletedBootstrapTurn: false,
        cacheTrace: null,
        anthropicPayloadLogger: null,
        hookAgentId: "main",
        diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } as never,
        skillWorkshopAvailable: false,
        hookRunner: null,
        promptStartedAt: Date.now(),
      },
    });

    expect(hoisted.runAgentEndSideEffects).not.toHaveBeenCalled();
  });
});
