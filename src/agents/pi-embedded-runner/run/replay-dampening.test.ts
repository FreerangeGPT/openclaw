import { describe, expect, it } from "vitest";
import {
  EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS,
  EXPENSIVE_REPLAY_CONTEXT_RATIO,
  EXPENSIVE_REPLAY_PROMPT_TOKENS,
  formatExpensiveReplayMessage,
  shouldDampenExpensiveReplay,
} from "./replay-dampening.js";

describe("shouldDampenExpensiveReplay", () => {
  it("dampens non-reducing retries after a large cache write", () => {
    const decision = shouldDampenExpensiveReplay({
      retryKind: "assistant-profile-rotation",
      failoverReason: "timeout",
      usage: {
        cacheRead: 0,
        cacheWrite: EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS,
      },
      promptTokens: 40_000,
      contextWindowTokens: 200_000,
    });

    expect(decision.dampen).toBe(true);
    expect(decision.reasons).toContain(`cacheWrite>=${EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS}`);
    expect(decision.cacheWriteTokens).toBe(EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS);
  });

  it("dampens when prompt size alone makes a replay risky", () => {
    const decision = shouldDampenExpensiveReplay({
      retryKind: "planning-only",
      promptTokens: EXPENSIVE_REPLAY_PROMPT_TOKENS,
      contextWindowTokens: 200_000,
    });

    expect(decision.dampen).toBe(true);
    expect(decision.reasons).toContain(`promptTokens>=${EXPENSIVE_REPLAY_PROMPT_TOKENS}`);
  });

  it("dampens high-context retries even below the absolute token threshold", () => {
    const promptTokens = 33_000;
    const contextWindowTokens = 50_000;
    const decision = shouldDampenExpensiveReplay({
      retryKind: "thinking-level",
      promptTokens,
      contextWindowTokens,
    });

    expect(promptTokens / contextWindowTokens).toBeGreaterThanOrEqual(
      EXPENSIVE_REPLAY_CONTEXT_RATIO,
    );
    expect(decision.dampen).toBe(true);
    expect(decision.reasons).toContain(`contextRatio>=${EXPENSIVE_REPLAY_CONTEXT_RATIO}`);
  });

  it("does not dampen small retries", () => {
    const decision = shouldDampenExpensiveReplay({
      retryKind: "auth-refresh",
      usage: {
        cacheRead: 9_000,
        cacheWrite: 0,
      },
      promptTokens: 10_000,
      contextWindowTokens: 200_000,
    });

    expect(decision.dampen).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("supports transient HTTP retry dampening for outer runner replays", () => {
    const decision = shouldDampenExpensiveReplay({
      retryKind: "transient-http",
      promptTokens: EXPENSIVE_REPLAY_PROMPT_TOKENS,
      contextWindowTokens: 200_000,
    });

    expect(decision.dampen).toBe(true);
    expect(formatExpensiveReplayMessage(decision)).toContain(
      "Automatic retry suppressed (transient-http)",
    );
  });
});

describe("formatExpensiveReplayMessage", () => {
  it("summarizes cache-write and prompt-token evidence", () => {
    const message = formatExpensiveReplayMessage({
      dampen: true,
      retryKind: "model-fallback",
      failoverReason: "overloaded",
      reasons: ["cacheWrite>=50000"],
      cacheWriteTokens: 123_456,
      promptTokens: 150_000,
      contextWindowTokens: 200_000,
    });

    expect(message).toContain("Automatic retry suppressed");
    expect(message).toContain("123,456");
    expect(message).toContain("150,000");
  });
});
