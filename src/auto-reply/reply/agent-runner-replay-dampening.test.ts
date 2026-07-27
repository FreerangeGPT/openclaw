import { describe, expect, it } from "vitest";
import {
  EXPENSIVE_REPLAY_PROMPT_TOKENS,
  formatExpensiveReplayMessage,
  shouldDampenExpensiveReplay,
} from "./agent-runner-replay-dampening.js";

describe("shouldDampenExpensiveReplay", () => {
  it("dampens a replay at the large-prompt threshold", () => {
    const decision = shouldDampenExpensiveReplay({
      promptTokens: EXPENSIVE_REPLAY_PROMPT_TOKENS,
    });

    expect(decision).toEqual({
      dampen: true,
      promptTokens: EXPENSIVE_REPLAY_PROMPT_TOKENS,
      threshold: EXPENSIVE_REPLAY_PROMPT_TOKENS,
    });
    expect(formatExpensiveReplayMessage(decision)).toContain("50,000 tokens");
  });

  it("does not dampen small or stale prompt estimates", () => {
    expect(shouldDampenExpensiveReplay({ promptTokens: 49_999 }).dampen).toBe(false);
    expect(shouldDampenExpensiveReplay({ promptTokens: undefined }).dampen).toBe(false);
  });
});
