import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  appendMainSessionPromptCacheEvidence,
  assertMainSessionCacheKeeperEvidenceFresh,
} from "../prompt-cache-evidence.js";
import { observeCacheKeeperStream } from "./attempt-stream-transport.js";

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
      providerCallStartedAt,
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
