import { describe, expect, it } from "vitest";
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
    { isCronEventReason: true },
    { isExecEventReason: true },
    { isManualReason: true },
    { totalTokens: 49_999 },
    { totalTokensFresh: false },
  ])("allows actionable or low-confidence heartbeat %#", (overrides) => {
    expect(shouldSkipExpensiveMainSessionHeartbeat(baseParams(overrides))).toBeNull();
  });

  it.each([{ hasHeartbeatInstructions: true }, { hasTasks: true }])(
    "still skips large explicit main-session heartbeat with %#",
    (overrides) => {
      expect(shouldSkipExpensiveMainSessionHeartbeat(baseParams(overrides))).toEqual({
        totalTokens: 80_000,
        threshold: 50_000,
        promptChars: "Read HEARTBEAT.md".length,
      });
    },
  );

  it("skips high-token wake heartbeat when no actionable event is pending", () => {
    expect(
      shouldSkipExpensiveMainSessionHeartbeat(
        baseParams({
          isWakeReason: true,
        }),
      ),
    ).toEqual({
      totalTokens: 80_000,
      threshold: 50_000,
      promptChars: "Read HEARTBEAT.md".length,
    });
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

  it.each([
    { configuredIsolated: true },
    { configuredIsolated: false },
    { hasExecCompletion: true },
    { hasCronEvents: true },
    { isCronEventReason: true },
    { isExecEventReason: true },
    { isManualReason: true },
    { totalTokens: 49_999 },
    { totalTokensFresh: false },
  ])("does not auto-isolate explicit, actionable, or low-confidence heartbeat %#", (overrides) => {
    expect(
      shouldAutoIsolateMainSessionHeartbeat({
        ...baseParams(),
        configuredIsolated: undefined,
        ...overrides,
      }),
    ).toBeNull();
  });

  it("auto-isolates high-token wake heartbeat when no actionable event is pending", () => {
    expect(
      shouldAutoIsolateMainSessionHeartbeat({
        ...baseParams({
          isWakeReason: true,
        }),
        configuredIsolated: undefined,
      }),
    ).toEqual({
      totalTokens: 80_000,
      threshold: 50_000,
    });
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
