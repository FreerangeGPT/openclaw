/**
 * Settles async tools and compaction, then snapshots the completed stream.
 */
import { formatErrorMessage } from "../../../infra/errors.js";
import { commitMainSessionCacheTouch } from "../../../infra/main-session-cache-keeper.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { AgentSession, SessionManager } from "../../sessions/index.js";
import { projectToolSearchTargetTranscriptMessages } from "../../tool-search.js";
import { hasNonzeroUsage, normalizeUsage, type NormalizedUsage } from "../../usage.js";
import { isRunnerAbortError } from "../abort.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import {
  appendMainSessionPromptCacheEvidence,
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
  type CacheKeeperHeartbeatAckDiscard,
  type CacheKeeperTurnRollback,
  discardPureMainSessionHeartbeatAckTurn,
  flushSessionManagerTranscript,
  normalizeCompactionRecoveryTranscriptTail,
  rollbackReplaySafeMainSessionCacheKeeperTurn,
} from "./attempt-transcript-helpers.js";
import {
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type CompletionRequiredAsyncTaskWaitResult,
} from "./attempt.async-tasks.js";
import {
  buildContextEnginePromptCacheInfo,
  findCurrentAttemptAssistantMessage,
  findLatestUncompactedAttemptUsageSnapshot,
  resolvePromptCacheTouchTimestamp,
} from "./attempt.context-engine-helpers.js";
import type { createEmbeddedAttemptSessionLockController } from "./attempt.session-lock.js";
import { appendAttemptCacheTtlIfNeeded } from "./attempt.thread-helpers.js";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";
import { selectCompactionTimeoutSnapshot } from "./compaction-timeout.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
type AttemptSessionLockController = Awaited<
  ReturnType<typeof createEmbeddedAttemptSessionLockController>
>;
type PromptCacheRetention = Parameters<typeof buildContextEnginePromptCacheInfo>[0]["retention"];
type ToolSearchTargetTranscriptProjections = Parameters<
  typeof projectToolSearchTargetTranscriptMessages
>[1];
type WithOwnedSessionWriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type StreamSettleResult = {
  promptError: unknown;
  promptErrorSource: AgentRunAttemptFailureSource | null;
  timedOutDuringCompaction: boolean;
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

export async function settleEmbeddedAttemptStream(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  sessionLockController: AttemptSessionLockController;
  withOwnedSessionWriteLock: WithOwnedSessionWriteLock;
  subscription: EmbeddedAttemptSubscription;
  state: {
    promptError: unknown;
    promptErrorSource: AgentRunAttemptFailureSource | null;
    yieldAborted: boolean;
    sessionIdUsed: string;
  };
  readLifecycleState: () => {
    aborted: boolean;
    timedOut: boolean;
    timedOutDuringCompaction: boolean;
  };
  markTimedOutDuringCompaction: () => void;
  runAbortDeadlineAtMs: number;
  runAbortSignal: AbortSignal;
  isProbeSession: boolean;
  sessionAgentId: string;
  onBlockReplyFlush?: (payload: {
    reason: "pre_compaction";
    attemptAccepted: boolean;
  }) => Promise<void> | void;
  abortable: <T>(promise: Promise<T>) => Promise<T>;
  prePromptMessageCount: number;
  toolSearchTargetTranscriptProjections: ToolSearchTargetTranscriptProjections;
  cache: {
    observabilityEnabled: boolean;
    changesForTurn: PromptCacheChange[] | null;
    identity?: string;
    retention: PromptCacheRetention;
  };
  shouldFlushForContextEngine: boolean;
}): Promise<StreamSettleResult> {
  const { attempt, activeSession, sessionManager, subscription, state } = input;
  let { promptError, promptErrorSource, sessionIdUsed } = state;

  if (
    shouldWaitForCompletionRequiredAsyncTasks({
      sessionKey: attempt.sessionKey,
      toolMetas: subscription.toolMetas,
      yieldDetected: state.yieldAborted,
    })
  ) {
    const getAsyncStartedToolMetas = () =>
      subscription.toolMetas
        .filter(
          (
            entry,
          ): entry is {
            toolName: string;
            asyncStarted?: boolean;
            asyncTaskRunId?: string;
            asyncTaskId?: string;
          } => typeof entry.toolName === "string" && entry.toolName.trim().length > 0,
        )
        .map((entry) => ({
          toolName: entry.toolName,
          asyncStarted: entry.asyncStarted,
          asyncTaskRunId: entry.asyncTaskRunId,
          asyncTaskId: entry.asyncTaskId,
        }));
    const completionRequiredAsyncDeadlineAtMs = Math.max(
      Date.now(),
      input.runAbortDeadlineAtMs - 500,
    );
    let asyncTaskWait: CompletionRequiredAsyncTaskWaitResult;
    try {
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: completionRequiredAsyncDeadlineAtMs,
        abortSignal: input.runAbortSignal,
      });
    } catch (err) {
      if (!input.readLifecycleState().timedOut || !isRunnerAbortError(err)) {
        throw err;
      }
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: Date.now(),
      });
    }
    if (asyncTaskWait.timedOutRunIds.length > 0) {
      promptError = new Error(
        `Timed out waiting for async task completion: ${asyncTaskWait.timedOutRunIds.join(", ")}`,
      );
      promptErrorSource = "prompt";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    } else if (asyncTaskWait.waitedRunIds.length > 0) {
      await input.sessionLockController.waitForSessionEvents(activeSession);
    }
  }

  // Snapshot only outside compaction. Compaction rewrites history in place and
  // cannot be allowed to leave the timeout result with a half-written view.
  const wasCompactingBefore = activeSession.isCompacting;
  const snapshot = activeSession.messages.slice();
  const wasCompactingAfter = activeSession.isCompacting;
  const preCompactionSnapshot = wasCompactingBefore || wasCompactingAfter ? null : snapshot;
  const preCompactionSessionId = activeSession.sessionId;
  const aggregateTimeoutMs = 60_000;

  try {
    if (input.onBlockReplyFlush) {
      const currentAssistant = findCurrentAttemptAssistantMessage({
        messagesSnapshot: snapshot,
        prePromptMessageCount: input.prePromptMessageCount,
      });
      const attemptAccepted =
        !promptError &&
        !input.readLifecycleState().aborted &&
        !input.readLifecycleState().timedOut &&
        !state.yieldAborted &&
        currentAssistant?.stopReason === "stop";
      await input.onBlockReplyFlush({ reason: "pre_compaction", attemptAccepted });
    }

    const compactionRetryWait = state.yieldAborted
      ? { timedOut: false }
      : await waitForCompactionRetryWithAggregateTimeout({
          waitForCompactionRetry: subscription.waitForCompactionRetry,
          abortable: input.abortable,
          aggregateTimeoutMs,
          isCompactionRetryStillActive: () =>
            hasActiveCompactionRetryWork({
              isCompactionInFlight: subscription.isCompactionInFlight(),
              isSessionStreaming: activeSession.isStreaming,
            }),
        });
    if (compactionRetryWait.timedOut) {
      input.markTimedOutDuringCompaction();
      if (!input.isProbeSession) {
        log.warn(
          `compaction retry aggregate timeout (${aggregateTimeoutMs}ms): ` +
            `proceeding with pre-compaction state runId=${attempt.runId} sessionId=${attempt.sessionId}`,
        );
      }
    }
  } catch (err) {
    if (!isRunnerAbortError(err)) {
      throw err;
    }
    if (!promptError) {
      promptError = err;
      promptErrorSource = "compaction";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
    }
    if (!input.isProbeSession) {
      log.debug(`compaction wait aborted: runId=${attempt.runId} sessionId=${attempt.sessionId}`);
    }
  }

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

  await input.sessionLockController.waitForSessionEvents(activeSession);
  await input.withOwnedSessionWriteLock(async () => {
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
      // Never isolate-replay unless the unanswered synthetic turn was removed
      // under the same session lock; otherwise the main branch would be corrupted.
      promptError = new MainSessionCacheKeeperIdentityMismatchError({
        reason: "turn-rollback-failed",
        replaySafe: false,
      });
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
      // A partial rewind would make the next cache identity ambiguous. Preserve
      // the transcript and surface a hard failure instead of continuing silently.
      promptError = new MainSessionCacheKeeperIdentityMismatchError({
        reason: "turn-rollback-failed",
        replaySafe: false,
      });
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
      preCompactionSnapshot,
      preCompactionSessionId,
      currentSnapshot: activeSession.messages.slice(),
      currentSessionId: activeSession.sessionId,
    });
    if (timedOutDuringCompaction && !input.isProbeSession) {
      log.warn(
        `using ${snapshotSelection.source} snapshot: timed out during compaction ` +
          `runId=${attempt.runId} sessionId=${attempt.sessionId}`,
      );
    }
    messagesSnapshot = projectToolSearchTargetTranscriptMessages(
      snapshotSelection.messagesSnapshot,
      input.toolSearchTargetTranscriptProjections,
    );
    sessionIdUsed = snapshotSelection.sessionIdUsed;
    lastAssistant = messagesSnapshot
      .slice()
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
          // Cache reads are provider-call measurements. Comparing an accumulated
          // tool-loop total with one later call manufactures false cache drops.
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
      if (cacheKeeperHeartbeatAckDiscard !== "discarded") {
        try {
          appendMainSessionPromptCacheEvidence({
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
          });
        } catch (entryErr) {
          // Missing provenance makes the next large heartbeat isolate; the answer
          // itself has already completed and must not be failed by diagnostics.
          log.warn(`failed to persist prompt cache evidence: ${String(entryErr)}`);
        }
      } else {
        // The stream observer already refreshed the original evidence in memory,
        // whose message identity matches the restored branch. Evidence is
        // intentionally process-local: after restart no transcript marker alone
        // may authorize a main-cache request, fresh timestamp or otherwise.
      }
      const expectedCachedTokens =
        (lastCallUsage?.cacheRead ?? 0) + (lastCallUsage?.cacheWrite ?? 0);
      const anchorId = sessionManager.getLeafId();
      if (anchorId && expectedCachedTokens > 0) {
        commitMainSessionCacheTouch({
          anchorId,
          expectedCachedTokens,
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
    timedOutDuringCompaction: input.readLifecycleState().timedOutDuringCompaction,
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
