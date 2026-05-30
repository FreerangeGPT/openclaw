import type { FailoverReason } from "../../pi-embedded-helpers.js";
import type { NormalizedUsage } from "../../usage.js";

export const EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS = 50_000;
export const EXPENSIVE_REPLAY_PROMPT_TOKENS = 50_000;
export const EXPENSIVE_REPLAY_CONTEXT_RATIO = 0.65;

export type ExpensiveReplayKind =
  | "auth-refresh"
  | "prompt-profile-rotation"
  | "assistant-profile-rotation"
  | "thinking-level"
  | "model-fallback"
  | "planning-only"
  | "transient-http";

export type ExpensiveReplayDecision = {
  dampen: boolean;
  reasons: string[];
  retryKind: ExpensiveReplayKind;
  failoverReason?: FailoverReason | null;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  promptTokens?: number;
  contextWindowTokens?: number;
};

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function shouldDampenExpensiveReplay(params: {
  retryKind: ExpensiveReplayKind;
  failoverReason?: FailoverReason | null;
  usage?: NormalizedUsage | null;
  promptTokens?: number | null;
  contextWindowTokens?: number | null;
}): ExpensiveReplayDecision {
  const cacheWriteTokens = positiveInt(params.usage?.cacheWrite);
  const cacheReadTokens = positiveInt(params.usage?.cacheRead);
  const promptTokens = positiveInt(params.promptTokens);
  const contextWindowTokens = positiveInt(params.contextWindowTokens);
  const reasons: string[] = [];

  if (
    cacheWriteTokens !== undefined &&
    cacheWriteTokens >= EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS
  ) {
    reasons.push(`cacheWrite>=${EXPENSIVE_REPLAY_CACHE_WRITE_TOKENS}`);
  }

  if (promptTokens !== undefined && promptTokens >= EXPENSIVE_REPLAY_PROMPT_TOKENS) {
    reasons.push(`promptTokens>=${EXPENSIVE_REPLAY_PROMPT_TOKENS}`);
  }

  if (
    promptTokens !== undefined &&
    contextWindowTokens !== undefined &&
    promptTokens / contextWindowTokens >= EXPENSIVE_REPLAY_CONTEXT_RATIO
  ) {
    reasons.push(`contextRatio>=${EXPENSIVE_REPLAY_CONTEXT_RATIO}`);
  }

  return {
    dampen: reasons.length > 0,
    reasons,
    retryKind: params.retryKind,
    failoverReason: params.failoverReason,
    cacheWriteTokens,
    cacheReadTokens,
    promptTokens,
    contextWindowTokens,
  };
}

export function formatExpensiveReplayMessage(decision: ExpensiveReplayDecision): string {
  const parts = [
    `Automatic retry suppressed (${decision.retryKind}) to avoid another large prompt-cache write.`,
  ];
  if (decision.cacheWriteTokens !== undefined) {
    parts.push(`Previous cache write: ${decision.cacheWriteTokens.toLocaleString()} tokens.`);
  }
  if (decision.promptTokens !== undefined) {
    parts.push(`Prompt size: ${decision.promptTokens.toLocaleString()} tokens.`);
  }
  parts.push("Compact, reset, or retry manually after checking cache health.");
  return parts.join(" ");
}
