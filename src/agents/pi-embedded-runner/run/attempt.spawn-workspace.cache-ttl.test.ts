import { describe, expect, it, vi } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../system-prompt-cache-boundary.js";
import {
  appendAttemptCacheTtlIfNeeded,
  ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
} from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt cache-ttl tracking after compaction", () => {
  it("skips cache-ttl append when compaction completed during the attempt", async () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: true,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });

    expect(appended).toBe(false);
    expect(sessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
      expect.anything(),
    );
  });

  it("appends cache-ttl when no compaction completed during the attempt", async () => {
    const sessionManager = {
      appendCustomEntry: vi.fn(),
    };
    const appended = appendAttemptCacheTtlIfNeeded({
      sessionManager,
      timedOutDuringCompaction: false,
      compactionOccurredThisAttempt: false,
      config: {
        agents: {
          defaults: {
            contextPruning: {
              mode: "cache-ttl",
            },
          },
        },
      },
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      modelApi: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1/messages",
      cacheRetention: "long",
      streamStrategy: "boundary-aware:anthropic-messages",
      transport: "sse",
      systemPrompt: `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic`,
      toolNames: [" write ", "read"],
      toolShapes: [
        { name: "write", digest: "shape-write" },
        { name: "read", digest: "shape-read" },
      ],
      promptCacheChanges: [{ code: "tools", detail: "2 -> 3 tools" }],
      previousCacheRead: 42_000,
      isCacheTtlEligibleProvider: () => true,
      now: 123,
    });

    expect(appended).toBe(true);
    expect(sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      ATTEMPT_CACHE_TTL_CUSTOM_TYPE,
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-sonnet-4-20250514",
        modelApi: "anthropic-messages",
        baseUrlHost: "api.anthropic.com",
        cacheRetention: "long",
        streamStrategy: "boundary-aware:anthropic-messages",
        transport: "sse",
        previousCacheRead: 42_000,
        anthropic: {
          cacheControl: { type: "ephemeral", ttl: "1h" },
          hasOneHourTtl: true,
        },
        promptCache: expect.objectContaining({
          hasBoundary: true,
          stablePrefixChars: "stable".length,
          stablePrefixDigest: expect.any(String),
          dynamicSuffixChars: "dynamic".length,
          dynamicSuffixDigest: expect.any(String),
        }),
        tools: {
          count: 2,
          digest: expect.any(String),
        },
        promptCacheChanges: [{ code: "tools", detail: "2 -> 3 tools" }],
        timestamp: 123,
      }),
    );
    const data = sessionManager.appendCustomEntry.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(data).not.toHaveProperty("systemPrompt");
    expect(data).not.toHaveProperty("toolNames");
    expect(data).not.toHaveProperty("toolShapes");
  });
});
