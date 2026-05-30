import { beforeEach, describe, expect, it } from "vitest";
import {
  beginPromptCacheObservation,
  collectPromptCacheToolNames,
  collectPromptCacheToolShapes,
  completePromptCacheObservation,
  detectPromptCacheAnomaly,
  resetPromptCacheObservabilityForTest,
} from "./prompt-cache-observability.js";

describe("prompt cache observability", () => {
  beforeEach(() => {
    resetPromptCacheObservabilityForTest();
  });

  it("collects trimmed tool names only", () => {
    expect(
      collectPromptCacheToolNames([{ name: " read " }, { name: "" }, {}, { name: "write" }]),
    ).toEqual(["read", "write"]);
  });

  it("detects tool schema changes even when names are unchanged", () => {
    const firstTools = collectPromptCacheToolShapes([
      {
        name: "read",
        description: "read a file",
        parameters: { properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);
    const nextTools = collectPromptCacheToolShapes([
      {
        name: "read",
        description: "read a file",
        parameters: {
          properties: { path: { type: "string" }, offset: { type: "number" } },
          required: ["path"],
        },
      },
    ]);

    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
      toolShapes: firstTools,
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 8_000 },
    });

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
      toolShapes: nextTools,
    });

    expect(second.changes).toEqual([{ code: "tools", detail: "tool set changed with same count" }]);
  });

  it("tracks cache-relevant changes and reports a real cache-read drop", () => {
    const first = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });

    expect(first.changes).toBeNull();
    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 8_000 },
      }),
    ).toBeNull();

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read", "write"],
    });

    expect(second.changes?.map((change) => change.code)).toEqual([
      "cacheRetention",
      "transport",
      "systemPrompt",
    ]);

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: [
        { code: "cacheRetention", detail: "long -> short" },
        { code: "transport", detail: "sse -> websocket" },
        { code: "systemPrompt", detail: "system prompt digest changed" },
      ],
    });
  });

  it("suppresses cache-break events for small drops", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 5_000 },
    });

    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      modelApi: "anthropic-messages",
      streamStrategy: "boundary-aware:anthropic-messages",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        usage: { cacheRead: 4_600 },
      }),
    ).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read", "write"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      usage: { cacheRead: 8_000 },
    });

    const second = beginPromptCacheObservation({
      sessionId: "session-1",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["write", "read"],
    });

    expect(second.changes).toBeNull();
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    beginPromptCacheObservation({
      sessionId: "session-0",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-0",
      usage: { cacheRead: 8_000 },
    });

    for (let index = 1; index <= 513; index += 1) {
      beginPromptCacheObservation({
        sessionId: `session-${index}`,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        streamStrategy: "boundary-aware:openai-responses",
        systemPrompt: `stable system ${index}`,
        toolNames: ["read"],
      });
    }

    const restarted = beginPromptCacheObservation({
      sessionId: "session-0",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      streamStrategy: "boundary-aware:openai-responses",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });

    expect(restarted.previousCacheRead).toBeNull();
    expect(restarted.changes).toBeNull();
  });

  it("ignores missing usage and preserves the previous cache-read baseline", () => {
    beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "sse",
      systemPrompt: "stable system",
      toolNames: ["read"],
    });
    completePromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      usage: { cacheRead: 8_000 },
    });

    beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
    });

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
      }),
    ).toBeNull();

    const resumed = beginPromptCacheObservation({
      sessionId: "session-1",
      sessionKey: "agent:main",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      cacheRetention: "short",
      streamStrategy: "boundary-aware:openai-responses",
      transport: "websocket",
      systemPrompt: "stable system with hook change",
      toolNames: ["read"],
    });

    expect(resumed.previousCacheRead).toBe(8_000);
    expect(resumed.changes).toBeNull();

    expect(
      completePromptCacheObservation({
        sessionId: "session-1",
        sessionKey: "agent:main",
        usage: { cacheRead: 2_000 },
      }),
    ).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 2_000,
      changes: null,
    });
  });

  it("flags cold and recent large cache writes", () => {
    expect(
      detectPromptCacheAnomaly({
        usage: { cacheRead: 0, cacheWrite: 80_000, total: 81_000 },
        secondsSincePreviousAssistant: 42,
      }),
    ).toEqual({
      reasons: ["cold-large-cache-write", "recent-large-cache-write"],
      cacheRead: 0,
      cacheWrite: 80_000,
      secondsSincePreviousAssistant: 42,
      totalTokens: 81_000,
    });
  });

  it("flags wasted no-reply and heartbeat cache writes", () => {
    expect(
      detectPromptCacheAnomaly({
        assistantTexts: ['{"action":"NO_REPLY"}'],
        usage: { cacheRead: 0, cacheWrite: 80_000 },
      })?.reasons,
    ).toEqual(["cold-large-cache-write", "wasted-no-reply-cache-write"]);
    expect(
      detectPromptCacheAnomaly({
        assistantTexts: ["<b>HEARTBEAT_OK</b>"],
        usage: { cacheRead: 20_000, cacheWrite: 80_000 },
      })?.reasons,
    ).toEqual(["wasted-heartbeat-cache-write"]);
  });

  it("does not flag small cache writes", () => {
    expect(
      detectPromptCacheAnomaly({
        assistantTexts: ["NO_REPLY"],
        usage: { cacheRead: 0, cacheWrite: 49_999 },
      }),
    ).toBeNull();
  });
});
