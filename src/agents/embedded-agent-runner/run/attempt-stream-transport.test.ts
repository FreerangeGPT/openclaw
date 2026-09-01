import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  appendMainSessionPromptCacheEvidence,
  assertMainSessionCacheKeeperEvidenceFresh,
} from "../prompt-cache-evidence.js";
import { wrapStreamFnWithProviderPromptState } from "../provider-prompt-state.js";
import { observeCacheKeeperStream, observeProviderPromptStream } from "./attempt-stream-settle.js";

describe("cache keeper stream observation", () => {
  it("refreshes live evidence when the caller consumes result() without iterating", async () => {
    const establishedAt = 1_700_000_000_000;
    const providerCallStartedAt = establishedAt + 55 * 60_000;
    const appendCustomEntry = vi.fn();
    expect(
      appendMainSessionPromptCacheEvidence({
        sessionManager: { appendCustomEntry },
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "anthropic",
        modelId: "claude-opus-4-8",
        cacheRetention: "long",
        promptIdentity: "prompt-identity",
        providerCachePrefixIdentity: "provider-cache-prefix-identity",
        requestOptionsIdentity: "request-options-identity",
        providerMessageIdentity: "provider-message-identity",
        authFingerprint: "auth-fingerprint",
        timestamp: establishedAt,
        cacheRead: 0,
        cacheWrite: 90_000,
        cacheWrite1h: 90_000,
        promptTokens: 90_000,
      }),
    ).toBe(true);
    const written = appendCustomEntry.mock.calls[0]?.[1] as { evidenceId: string } | undefined;
    if (!written) {
      throw new Error("expected prompt-cache evidence");
    }
    const evidenceId = written.evidenceId;
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: {
        input: 1_000,
        output: 100,
        cacheRead: 90_000,
        cacheWrite: 0,
        cacheWrite1h: 0,
        contextUsage: { state: "available", promptTokens: 91_000, totalTokens: 91_100 },
        totalTokens: 91_100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: providerCallStartedAt,
    });

    const result = await observeCacheKeeperStream({
      stream,
      evidenceId,
      readProviderCallStartedAt: () => providerCallStartedAt,
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(() =>
      assertMainSessionCacheKeeperEvidenceFresh(
        evidenceId,
        providerCallStartedAt + 59 * 60_000,
        false,
      ),
    ).not.toThrow();
  });
});

describe("provider prompt stream observation", () => {
  it("pairs a response when onPayload runs after the transport returns its stream", async () => {
    const model = {
      id: "claude-opus-4-8",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    } as Model;
    const stream = createAssistantMessageEventStream();
    const recordResponse = vi.fn();
    let emitResponse: (() => Promise<void>) | undefined;
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, _context, options) => {
        emitResponse = async () => {
          await options?.onPayload?.({ model: model.id, messages: [] }, model);
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          });
        };
        return stream;
      },
      state: { providerCallCount: 0 },
      effectiveContextTokenBudget: 128_000,
      observeProviderStream: (providerStream, readSnapshot) =>
        observeProviderPromptStream({
          stream: providerStream,
          readSnapshot,
          replayRecorder: {
            enabled: true,
            recordRequest: vi.fn(),
            recordResponse,
            flush: async () => undefined,
          },
        }),
    });

    const observed = await wrapped(model, { messages: [], tools: [] });
    expect(emitResponse).toBeDefined();
    await emitResponse?.();
    await observed.result();

    expect(recordResponse).toHaveBeenCalledOnce();
    expect(recordResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ stopReason: "stop" }),
        snapshot: expect.objectContaining({ providerCallSequence: 1 }),
      }),
    );
  });

  it("records one completion with that provider call's usage", async () => {
    const recordEvent = vi.fn();
    const recordResponse = vi.fn();
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: {
        input: 1_000,
        output: 10,
        cacheRead: 51_352,
        cacheWrite: 31_498,
        totalTokens: 83_860,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
    });
    const snapshot = {
      scopeDigest: "scope",
      digest: "payload",
      byteWeight: 100,
      cachePrefixIdentity: "prefix",
      cacheRequestOptionsIdentity: "options",
      cacheTree: {
        version: 1,
        tools: { blockCount: 44, identity: "tools" },
        system: { blockCount: 2, identity: "system" },
        messages: { blockCount: 10, messageCount: 10, identity: "messages" },
        breakpoints: [],
      },
      providerCallSequence: 3,
      providerCallStartedAt: Date.now(),
    } as const;

    const observed = observeProviderPromptStream({
      stream,
      readSnapshot: () => snapshot,
      recordEvent,
      replayRecorder: {
        enabled: true,
        recordRequest: vi.fn(),
        recordResponse,
        flush: async () => undefined,
      },
    });
    await observed.result();
    await observed.result();

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      "provider.call.completed",
      expect.objectContaining({
        providerCallSequence: 3,
        usage: expect.objectContaining({ cacheRead: 51_352, cacheWrite: 31_498 }),
      }),
    );
    expect(recordResponse).toHaveBeenCalledTimes(1);
  });

  it("records cancellation when iteration closes before a terminal event", async () => {
    const recordEvent = vi.fn();
    const recordResponse = vi.fn();
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "start",
      partial: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    const snapshot = {
      scopeDigest: "scope",
      digest: "payload",
      byteWeight: 100,
      cachePrefixIdentity: "prefix",
      cacheRequestOptionsIdentity: "options",
      cacheTree: {
        version: 1,
        tools: { blockCount: 0, identity: "tools" },
        system: { blockCount: 0, identity: "system" },
        messages: { blockCount: 1, messageCount: 1, identity: "messages" },
        breakpoints: [],
      },
      providerCallSequence: 4,
      providerCallStartedAt: Date.now(),
    } as const;
    const observed = observeProviderPromptStream({
      stream,
      readSnapshot: () => snapshot,
      recordEvent,
      replayRecorder: {
        enabled: true,
        recordRequest: vi.fn(),
        recordResponse,
        flush: async () => undefined,
      },
    });

    for await (const event of observed) {
      expect(event.type).toBe("start");
      break;
    }

    expect(recordEvent).toHaveBeenCalledWith(
      "provider.call.completed",
      expect.objectContaining({
        providerCallSequence: 4,
        error: "provider stream closed before a terminal event",
      }),
    );
    expect(recordResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: "provider stream closed before a terminal event",
        }),
      }),
    );
  });

  it("records the provider's terminal error message instead of synthetic cancellation", async () => {
    const recordEvent = vi.fn();
    const recordResponse = vi.fn();
    const errorMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: {
        input: 1_000,
        output: 0,
        cacheRead: 51_352,
        cacheWrite: 0,
        totalTokens: 52_352,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "provider overloaded",
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", reason: "error", error: errorMessage });
    stream.end();
    const snapshot = {
      scopeDigest: "scope",
      digest: "payload",
      byteWeight: 100,
      cachePrefixIdentity: "prefix",
      cacheRequestOptionsIdentity: "options",
      cacheTree: {
        version: 1,
        tools: { blockCount: 0, identity: "tools" },
        system: { blockCount: 0, identity: "system" },
        messages: { blockCount: 1, messageCount: 1, identity: "messages" },
        breakpoints: [],
      },
      providerCallSequence: 5,
      providerCallStartedAt: Date.now(),
    } as const;
    const observed = observeProviderPromptStream({
      stream,
      readSnapshot: () => snapshot,
      recordEvent,
      replayRecorder: {
        enabled: true,
        recordRequest: vi.fn(),
        recordResponse,
        flush: async () => undefined,
      },
    });

    const events = [];
    for await (const event of observed) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", reason: "error", error: errorMessage }]);
    expect(recordEvent).toHaveBeenCalledWith(
      "provider.call.completed",
      expect.objectContaining({
        providerCallSequence: 5,
        error: "provider overloaded",
      }),
    );
    expect(recordResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        message: errorMessage,
        error: "provider overloaded",
      }),
    );
  });
});
