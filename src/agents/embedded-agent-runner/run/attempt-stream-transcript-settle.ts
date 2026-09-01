import { formatErrorMessage } from "../../../infra/errors.js";
import { commitMainSessionCacheTouch } from "../../../infra/main-session-cache-keeper.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import { hasNonzeroUsage, normalizeUsage, type NormalizedUsage } from "../../usage.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import {
  appendMainSessionPromptCacheEvidenceWithData,
  fingerprintPromptCacheCredential,
  MainSessionCacheKeeperIdentityMismatchError,
  refreshLivePromptCacheEvidence,
} from "../prompt-cache-evidence.js";
import {
  completePromptCacheObservation,
  type PromptCacheBreak,
  type PromptCacheChange,
} from "../prompt-cache-observability.js";
import { getProviderPromptState } from "../provider-prompt-state.js";
import {
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  findLatestUncompactedAttemptUsageSnapshot,
  resolvePromptCacheTouchTimestamp,
} from "./attempt-context-engine-helpers.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt-thread-helpers.js";
import {
  type CacheKeeperHeartbeatAckDiscard,
  type CacheKeeperTurnRollback,
  discardPureMainSessionHeartbeatAckTurn,
  flushSessionManagerTranscript,
  normalizeCompactionRecoveryTranscriptTail,
  rollbackReplaySafeMainSessionCacheKeeperTurn,
} from "./attempt-transcript-helpers.js";
import { selectCompactionTimeoutSnapshot } from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
export type PromptCacheRetention = Parameters<
  typeof buildContextEnginePromptCacheInfo
>[0]["retention"];

export type AttemptTranscriptSettleResult = {
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  compactionOccurredThisAttempt: boolean;
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  lastAssistant: EmbeddedRunAttemptResult["lastAssistant"];
  currentAttemptAssistant: EmbeddedRunAttemptResult["currentAttemptAssistant"];
  currentAttemptCompletedAssistant: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  attemptUsage: EmbeddedRunAttemptResult["attemptUsage"];
  cacheBreak: PromptCacheBreak | null;
  lastCallUsage: NormalizedUsage | undefined;
  promptCache: EmbeddedRunAttemptResult["promptCache"];
};

export async function settleEmbeddedAttemptTranscript(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  withOwnedTranscriptWrite: <T>(operation: () => Promise<T> | T) => Promise<T>;
  subscription: EmbeddedAttemptSubscription;
  state: {
    promptError: unknown;
    promptErrorSource: AgentRunAttemptFailureSource | null;
    yieldAborted: boolean;
  };
  readLifecycleState: () => {
    aborted: boolean;
    timedOut: boolean;
    timedOutDuringCompaction: boolean;
  };
  isProbeSession: boolean;
  sessionAgentId: string;
  prePromptMessageCount: number;
  cache: {
    observabilityEnabled: boolean;
    changesForTurn: PromptCacheChange[] | null;
    identity?: string;
    retention: PromptCacheRetention;
  };
  shouldFlushForContextEngine: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  sessionIdUsed: string;
}): Promise<AttemptTranscriptSettleResult> {
  const { attempt, activeSession, sessionManager, subscription, state } = input;
  let { promptError, promptErrorSource, sessionIdUsed } = input;
  let compactionOccurredThisAttempt = false;
  let messagesSnapshot: AgentMessage[] = [];
  let lastAssistant: AssistantMessage | undefined;
  let currentAttemptAssistant: AssistantMessage | undefined;
  let currentAttemptCompletedAssistant: AssistantMessage | undefined;
  let attemptUsage: EmbeddedRunAttemptResult["attemptUsage"];
  let cacheBreak: PromptCacheBreak | null = null;
  let lastCallUsage: NormalizedUsage | undefined;
  let promptCache: EmbeddedRunAttemptResult["promptCache"];
  let cacheKeeperTurnRollback: CacheKeeperTurnRollback = "not-replayable";
  let cacheKeeperHeartbeatAckDiscard: CacheKeeperHeartbeatAckDiscard = "not-discardable";

  await input.withOwnedTranscriptWrite(async () => {
    const lifecycleState = input.readLifecycleState();
    const { timedOutDuringCompaction } = lifecycleState;
    compactionOccurredThisAttempt = subscription.getCompactionCount() > 0;
    currentAttemptCompletedAssistant = subscription.getCurrentAttemptAssistant();
    const providerPromptAttempt = getProviderPromptState(attempt.runId).lastAttempt;
    const cacheRefreshConfirmed = Boolean(
      attempt.promptCacheKeeperEvidenceId &&
      providerPromptAttempt &&
      currentAttemptCompletedAssistant &&
      refreshLivePromptCacheEvidence({
        evidenceId: attempt.promptCacheKeeperEvidenceId,
        timestamp: providerPromptAttempt.providerCallStartedAt,
        usage: currentAttemptCompletedAssistant.usage,
      }),
    );

    if (timedOutDuringCompaction) {
      const removedEntries = normalizeCompactionRecoveryTranscriptTail({
        activeSession,
        sessionManager,
      });
      if (removedEntries > 0 && !input.isProbeSession) {
        log.warn(
          `normalized compaction timeout transcript tail: removedEntries=${removedEntries} ` +
            `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
        );
      }
    }

    cacheKeeperTurnRollback = rollbackReplaySafeMainSessionCacheKeeperTurn({
      activeSession,
      attempt,
      promptError,
      sessionManager,
    });
    if (cacheKeeperTurnRollback === "rollback-failed") {
      promptError = createCacheKeeperRollbackError();
      promptErrorSource = "prompt";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    }

    cacheKeeperHeartbeatAckDiscard = discardPureMainSessionHeartbeatAckTurn({
      activeSession,
      attempt,
      cacheRefreshConfirmed,
      compactionOccurredThisAttempt,
      interrupted: lifecycleState.aborted || lifecycleState.timedOut || state.yieldAborted,
      promptError,
      sessionManager,
      toolActivityCount: subscription.toolMetas.length,
    });
    if (cacheKeeperHeartbeatAckDiscard === "discard-failed") {
      promptError = createCacheKeeperRollbackError();
      promptErrorSource = "prompt";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    } else {
      appendAttemptCacheTtlIfNeeded({
        sessionManager,
        timedOutDuringCompaction,
        compactionOccurredThisAttempt,
        config: attempt.config,
        provider: attempt.provider,
        modelId: attempt.modelId,
        modelApi: attempt.model.api,
        isCacheTtlEligibleProvider,
      });
    }

    const snapshotSelection = selectCompactionTimeoutSnapshot({
      timedOutDuringCompaction,
      preCompactionSnapshot: input.preCompactionSnapshot,
      preCompactionSessionId: input.preCompactionSessionId,
      currentSnapshot: activeSession.messages.slice(),
      currentSessionId: activeSession.sessionId,
    });
    if (timedOutDuringCompaction && !input.isProbeSession) {
      log.warn(
        `using ${snapshotSelection.source} snapshot: timed out during compaction ` +
          `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
      );
    }
    messagesSnapshot = snapshotSelection.messagesSnapshot;
    sessionIdUsed = snapshotSelection.sessionIdUsed;
    lastAssistant = messagesSnapshot
      .toReversed()
      .find((message): message is AssistantMessage => message.role === "assistant");
    currentAttemptAssistant =
      cacheKeeperHeartbeatAckDiscard === "discarded"
        ? currentAttemptCompletedAssistant
        : findCurrentAttemptAssistantMessage({
            messagesSnapshot,
            prePromptMessageCount: input.prePromptMessageCount,
          });
    attemptUsage = subscription.getUsageTotals();
    const transcriptUsageSnapshot = findLatestUncompactedAttemptUsageSnapshot({
      messagesSnapshot,
      prePromptMessageCount: input.prePromptMessageCount,
      compactionOccurred: compactionOccurredThisAttempt,
    });
    const completedAssistantUsage = normalizeUsage(currentAttemptCompletedAssistant?.usage);
    const subscriptionLastCallUsage = subscription.getLastAssistantUsage();
    lastCallUsage = hasNonzeroUsage(subscriptionLastCallUsage)
      ? subscriptionLastCallUsage
      : hasNonzeroUsage(completedAssistantUsage)
        ? completedAssistantUsage
        : transcriptUsageSnapshot?.usage;
    cacheBreak = input.cache.observabilityEnabled
      ? completePromptCacheObservation({
          sessionId: attempt.sessionId,
          promptCacheKey: attempt.promptCacheKey,
          sessionKey: attempt.sessionKey,
          // Cache reads are provider-call measurements, not tool-loop totals.
          usage: lastCallUsage,
        })
      : null;
    // Keep cache timing bound to the assistant that supplied the exact usage.
    // A terminal zero-usage abort must not advance TTL for the previous call.
    const usageAssistant = hasNonzeroUsage(completedAssistantUsage)
      ? currentAttemptCompletedAssistant
      : transcriptUsageSnapshot?.assistant;
    const exactPromptTokens =
      usageAssistant?.usage.contextUsage?.state === "available"
        ? usageAssistant.usage.contextUsage.promptTokens
        : undefined;
    const promptCacheObservation =
      input.cache.observabilityEnabled &&
      (cacheBreak || input.cache.changesForTurn || typeof lastCallUsage?.cacheRead === "number")
        ? {
            broke: Boolean(cacheBreak),
            ...(typeof cacheBreak?.previousCacheRead === "number"
              ? { previousCacheRead: cacheBreak.previousCacheRead }
              : {}),
            ...(typeof cacheBreak?.cacheRead === "number"
              ? { cacheRead: cacheBreak.cacheRead }
              : typeof lastCallUsage?.cacheRead === "number"
                ? { cacheRead: lastCallUsage.cacheRead }
                : {}),
            changes: cacheBreak?.changes ?? input.cache.changesForTurn,
          }
        : undefined;
    const fallbackLastCacheTouchAt = readLastCacheTtlTimestamp(sessionManager, {
      provider: attempt.provider,
      modelId: attempt.modelId,
    });
    promptCache = buildContextEnginePromptCacheInfo({
      retention: input.cache.retention,
      lastCallUsage,
      observation: promptCacheObservation,
      lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
        lastCallUsage,
        assistantTimestamp:
          providerPromptAttempt?.providerCallStartedAt ?? usageAssistant?.timestamp,
        fallbackLastCacheTouchAt,
      }),
    });

    const cacheEvidenceAssistantSucceeded =
      usageAssistant !== undefined &&
      usageAssistant.stopReason !== "error" &&
      usageAssistant.stopReason !== "aborted";
    if (
      !promptError &&
      !lifecycleState.aborted &&
      !lifecycleState.timedOut &&
      !state.yieldAborted &&
      !compactionOccurredThisAttempt &&
      cacheEvidenceAssistantSucceeded
    ) {
      let promptCacheEvidenceId = attempt.promptCacheKeeperEvidenceId;
      if (cacheKeeperHeartbeatAckDiscard !== "discarded") {
        // Only a discarded no-op keeper turn can retain its original evidence.
        promptCacheEvidenceId = undefined;
        try {
          promptCacheEvidenceId = appendMainSessionPromptCacheEvidenceWithData({
            sessionManager,
            cfg: attempt.config ?? {},
            agentId: input.sessionAgentId,
            sessionKey: attempt.sessionKey,
            provider: attempt.provider,
            modelId: attempt.modelId,
            cacheRetention: input.cache.retention,
            promptIdentity: input.cache.identity,
            providerCachePrefixIdentity: providerPromptAttempt?.cachePrefixIdentity,
            requestOptionsIdentity: providerPromptAttempt?.cacheRequestOptionsIdentity,
            providerMessageIdentity: providerPromptAttempt?.providerMessageIdentity,
            authFingerprint: fingerprintPromptCacheCredential({
              apiKey: attempt.resolvedApiKey,
              authProfileId: attempt.authProfileId,
            }),
            authProfileId: attempt.authProfileId,
            runKind: attempt.trigger,
            cacheKeeperEvidenceId: attempt.promptCacheKeeperEvidenceId,
            timestamp: providerPromptAttempt?.providerCallStartedAt,
            cacheRead: lastCallUsage?.cacheRead,
            cacheWrite: lastCallUsage?.cacheWrite,
            cacheWrite1h: usageAssistant?.usage.cacheWrite1h,
            promptTokens: exactPromptTokens,
          })?.evidenceId;
        } catch (entryErr) {
          // Missing provenance only forces the next large heartbeat to isolate.
          log.warn(`failed to persist prompt cache evidence: ${String(entryErr)}`);
        }
      }
      const expectedCachedTokens =
        (lastCallUsage?.cacheRead ?? 0) + (lastCallUsage?.cacheWrite ?? 0);
      const anchorId = sessionManager.getLeafId();
      if (anchorId && promptCacheEvidenceId && expectedCachedTokens > 0) {
        commitMainSessionCacheTouch({
          anchorId,
          expectedCachedTokens,
          promptCacheEvidenceId,
          runId: attempt.runId,
        });
      }
    }

    if (
      promptError &&
      promptErrorSource === "prompt" &&
      !compactionOccurredThisAttempt &&
      cacheKeeperTurnRollback !== "rolled-back"
    ) {
      try {
        sessionManager.appendCustomEntry("openclaw:prompt-error", {
          timestamp: Date.now(),
          runId: attempt.runId,
          sessionId: attempt.sessionId,
          provider: attempt.provider,
          model: attempt.modelId,
          api: attempt.model.api,
          error: formatErrorMessage(promptError),
        });
      } catch (entryErr) {
        log.warn(`failed to persist prompt error entry: ${String(entryErr)}`);
      }
    }

    if (input.shouldFlushForContextEngine) {
      flushSessionManagerTranscript(sessionManager);
    }
  });

  return {
    promptError,
    promptErrorSource,
    compactionOccurredThisAttempt,
    messagesSnapshot,
    sessionIdUsed,
    lastAssistant,
    currentAttemptAssistant,
    currentAttemptCompletedAssistant,
    attemptUsage,
    cacheBreak,
    lastCallUsage,
    promptCache,
  };
}

function createCacheKeeperRollbackError(): MainSessionCacheKeeperIdentityMismatchError {
  return new MainSessionCacheKeeperIdentityMismatchError({
    reason: "turn-rollback-failed",
    replaySafe: false,
  });
}
