import { describe, expect, it } from "vitest";
import {
  shouldSkipExpensiveMainSessionHeartbeat,
  shouldUseIsolatedHeartbeatSession,
} from "./heartbeat-cost-guard.js";

function baseParams(
  overrides: Partial<Parameters<typeof shouldSkipExpensiveMainSessionHeartbeat>[0]> = {},
) {
  return {
    prompt: "Read HEARTBEAT.md",
    totalTokens: 80_000,
    totalTokensFresh: true,
    hasExecCompletion: false,
    hasCronEvents: false,
    hasHeartbeatInstructions: false,
    hasTasks: false,
    isCronEventReason: false,
    isExecEventReason: false,
    isManualReason: false,
    isWakeReason: false,
    useIsolatedSession: false,
    ...overrides,
  };
}

describe("heartbeat cost guard", () => {
  it("skips high-token main-session heartbeat when no actionable work is pending", () => {
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
    { hasHeartbeatInstructions: true },
    { hasTasks: true },
    { isCronEventReason: true },
    { isExecEventReason: true },
    { isManualReason: true },
    { isWakeReason: true },
    { totalTokens: 49_999 },
    { totalTokensFresh: false },
  ])("allows actionable or low-confidence heartbeat %#", (overrides) => {
    expect(shouldSkipExpensiveMainSessionHeartbeat(baseParams(overrides))).toBeNull();
  });

  it.each([
    { configuredIsolated: true, hasMemoryPrepend: false, expected: true },
    { configuredIsolated: false, hasMemoryPrepend: true, expected: true },
    { configuredIsolated: undefined, hasMemoryPrepend: true, expected: true },
    { configuredIsolated: false, hasMemoryPrepend: false, expected: false },
  ])("resolves heartbeat isolation %#", (params) => {
    expect(shouldUseIsolatedHeartbeatSession(params)).toBe(params.expected);
  });
});
