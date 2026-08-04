import { describe, expect, it } from "vitest";
import { resolveCacheKeeperCacheViable } from "./heartbeat-cache-keeper.js";
import {
  shouldAutoIsolateMainSessionHeartbeat,
  shouldSkipExpensiveMainSessionHeartbeat,
  shouldUseIsolatedHeartbeatSession,
} from "./heartbeat-cost-guard.js";

function baseParams(
  overrides: Partial<Parameters<typeof shouldSkipExpensiveMainSessionHeartbeat>[0]> = {},
) {
  return {
    prompt: "Read HEARTBEAT.md",
    preserveMainSessionCache: false,
    cacheKeeperCacheViable: undefined,
    totalTokens: 80_000,
    totalTokensFresh: true,
    hasExecCompletion: false,
    hasCronEvents: false,
    hasDueCommitments: false,
    hasScheduledTasks: false,
    isCronEventReason: false,
    isExecEventReason: false,
    isManualReason: false,
    useIsolatedSession: false,
    ...overrides,
  };
}

describe("heartbeat cost guard", () => {
  it.each([
    {
      cacheRetention: "long" as const,
      intervalMs: 15 * 60_000,
      lastCacheTouchAt: 9 * 60_000,
      expected: true,
    },
    {
      cacheRetention: "long" as const,
      intervalMs: 60 * 60_000,
      lastCacheTouchAt: 9 * 60_000,
      expected: false,
    },
    {
      cacheRetention: "short" as const,
      intervalMs: 4 * 60_000,
      lastCacheTouchAt: 9 * 60_000,
      expected: true,
    },
    {
      cacheRetention: "short" as const,
      intervalMs: 5 * 60_000,
      lastCacheTouchAt: 9 * 60_000,
      expected: false,
    },
    {
      cacheRetention: "none" as const,
      intervalMs: 60_000,
      lastCacheTouchAt: 9 * 60_000,
      expected: false,
    },
    {
      cacheRetention: undefined,
      intervalMs: 60_000,
      lastCacheTouchAt: 9 * 60_000,
      expected: false,
    },
    {
      cacheRetention: "long" as const,
      intervalMs: 15 * 60_000,
      lastCacheTouchAt: undefined,
      expected: false,
    },
    {
      cacheRetention: "long" as const,
      intervalMs: 15 * 60_000,
      lastCacheTouchAt: -50 * 60_000,
      expected: false,
    },
  ])("checks whether cache retention outlives heartbeat cadence %#", (params) => {
    expect(
      resolveCacheKeeperCacheViable({
        ...params,
        cachedTokens: 90_000,
        nowMs: 10 * 60_000,
        totalTokens: 96_083,
      }),
    ).toBe(params.expected);
  });

  it.each([
    { cachedTokens: 86_083, expected: true },
    { cachedTokens: 86_082, expected: false },
    { cachedTokens: 1, expected: false },
  ])("requires cached volume to cover the guarded dialogue %#", ({ cachedTokens, expected }) => {
    expect(
      resolveCacheKeeperCacheViable({
        cacheRetention: "long",
        cachedTokens,
        intervalMs: 15 * 60_000,
        lastCacheTouchAt: 9 * 60_000,
        nowMs: 10 * 60_000,
        totalTokens: 96_083,
      }),
    ).toBe(expected);
  });

  it("includes the pending heartbeat prompt in the uncached-token allowance", () => {
    const base = {
      cacheRetention: "long" as const,
      cachedTokens: 90_000,
      intervalMs: 15 * 60_000,
      lastCacheTouchAt: 9 * 60_000,
      nowMs: 10 * 60_000,
      totalTokens: 96_083,
    };
    expect(resolveCacheKeeperCacheViable({ ...base, pendingPromptTokens: 3_917 })).toBe(true);
    expect(resolveCacheKeeperCacheViable({ ...base, pendingPromptTokens: 3_918 })).toBe(false);
  });

  it("skips high-token lightweight main-session heartbeat when no actionable work is pending", () => {
    expect(shouldSkipExpensiveMainSessionHeartbeat(baseParams())).toEqual({
      totalTokens: 80_000,
      threshold: 50_000,
      promptChars: "Read HEARTBEAT.md".length,
    });
  });

  it("allows isolated heartbeat even when the main session is large", () => {
    expect(
      shouldSkipExpensiveMainSessionHeartbeat(baseParams({ useIsolatedSession: true })),
    ).toBeNull();
  });

  it.each([
    { hasExecCompletion: true },
    { hasCronEvents: true },
    { hasDueCommitments: true },
    { hasScheduledTasks: true },
    { isCronEventReason: true },
    { isExecEventReason: true },
    { isManualReason: true },
    { totalTokens: 49_999 },
    { totalTokensFresh: false },
    { totalTokensFresh: undefined },
  ])("allows actionable or low-confidence heartbeat %#", (overrides) => {
    expect(shouldSkipExpensiveMainSessionHeartbeat(baseParams(overrides))).toBeNull();
  });

  it("auto-isolates large routine heartbeats when isolation is not explicitly configured", () => {
    expect(
      shouldAutoIsolateMainSessionHeartbeat({
        ...baseParams(),
        configuredIsolated: undefined,
      }),
    ).toEqual({
      totalTokens: 80_000,
      threshold: 50_000,
    });
  });

  it("preserves a large main session when its cache-keeper cadence is viable", () => {
    const params = baseParams({
      preserveMainSessionCache: true,
      cacheKeeperCacheViable: true,
    });
    expect(shouldSkipExpensiveMainSessionHeartbeat(params)).toBeNull();
    expect(
      shouldAutoIsolateMainSessionHeartbeat({
        ...params,
        configuredIsolated: undefined,
      }),
    ).toBeNull();
  });

  it("reports a nonviable cache keeper when guarding a large routine heartbeat", () => {
    const params = baseParams({
      preserveMainSessionCache: true,
      cacheKeeperCacheViable: false,
    });
    expect(shouldSkipExpensiveMainSessionHeartbeat(params)).toEqual({
      totalTokens: 80_000,
      threshold: 50_000,
      promptChars: "Read HEARTBEAT.md".length,
      cacheKeeperCacheViable: false,
    });
    expect(
      shouldAutoIsolateMainSessionHeartbeat({
        ...params,
        configuredIsolated: undefined,
      }),
    ).toEqual({
      totalTokens: 80_000,
      threshold: 50_000,
      cacheKeeperCacheViable: false,
    });
  });

  it.each([
    { configuredIsolated: true },
    { configuredIsolated: false },
    { hasExecCompletion: true },
    { hasCronEvents: true },
    { hasDueCommitments: true },
    { hasScheduledTasks: true },
    { isCronEventReason: true },
    { isExecEventReason: true },
    { isManualReason: true },
    { totalTokens: 49_999 },
    { totalTokensFresh: false },
    { totalTokensFresh: undefined },
  ])("does not auto-isolate explicit, actionable, or low-confidence heartbeat %#", (overrides) => {
    expect(
      shouldAutoIsolateMainSessionHeartbeat({
        ...baseParams(),
        configuredIsolated: undefined,
        ...overrides,
      }),
    ).toBeNull();
  });

  it.each([
    {
      configuredIsolated: true,
      hasMemoryPrepend: false,
      autoIsolatedMainSession: false,
      expected: true,
    },
    {
      configuredIsolated: false,
      hasMemoryPrepend: true,
      autoIsolatedMainSession: false,
      expected: true,
    },
    {
      configuredIsolated: undefined,
      hasMemoryPrepend: true,
      autoIsolatedMainSession: false,
      expected: true,
    },
    {
      configuredIsolated: undefined,
      hasMemoryPrepend: false,
      autoIsolatedMainSession: true,
      expected: true,
    },
    {
      configuredIsolated: false,
      hasMemoryPrepend: false,
      autoIsolatedMainSession: false,
      expected: false,
    },
  ])("resolves heartbeat isolation %#", (params) => {
    expect(shouldUseIsolatedHeartbeatSession(params)).toBe(params.expected);
  });
});
