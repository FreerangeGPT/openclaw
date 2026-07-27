export const EXPENSIVE_REPLAY_PROMPT_TOKENS = 50_000;

export type ExpensiveReplayDecision = {
  dampen: boolean;
  promptTokens: number | undefined;
  threshold: number;
};

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function shouldDampenExpensiveReplay(params: {
  promptTokens?: number | null;
}): ExpensiveReplayDecision {
  const promptTokens = positiveInt(params.promptTokens);
  return {
    dampen: promptTokens !== undefined && promptTokens >= EXPENSIVE_REPLAY_PROMPT_TOKENS,
    promptTokens,
    threshold: EXPENSIVE_REPLAY_PROMPT_TOKENS,
  };
}

export function formatExpensiveReplayMessage(decision: ExpensiveReplayDecision): string {
  const promptSize =
    decision.promptTokens === undefined
      ? ""
      : ` Current prompt size: ${decision.promptTokens.toLocaleString()} tokens.`;
  return (
    "Automatic overload retry suppressed to avoid another large prompt-cache write." +
    promptSize +
    " Compact, reset, or retry manually after checking cache health."
  );
}
