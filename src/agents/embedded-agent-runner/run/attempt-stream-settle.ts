/**
 * Prepares transport before streaming and settles the completed stream afterward.
 * It may assume session runtime ownership and provider inputs are established.
 */
import { resolveCompactionReplayEligibility } from "@openclaw/ai/transports";
import {
  discardMainSessionCacheTouch,
  stageMainSessionCacheTouch,
} from "../../../infra/main-session-cache-keeper.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { resolveProviderTextTransforms } from "../../../plugins/provider-runtime.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import type { AgentRunAttemptFailureSource } from "../../agent-run-terminal-outcome.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import type { ProviderReplayRecorder } from "../../provider-replay-log.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { AgentSession, SessionManager, SettingsManager } from "../../sessions/index.js";
import { isRunnerAbortError } from "../abort.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
  resolveExtraParams,
  resolvePreparedExtraParams,
} from "../extra-params.js";
import { log } from "../logger.js";
import {
  assertMainSessionCacheKeeperEvidenceFresh,
  assertMainSessionCacheKeeperProviderIdentity,
  isCanonicalAgentMainSession,
} from "../prompt-cache-evidence.js";
import type { PromptCacheChange } from "../prompt-cache-observability.js";
import {
  resolveCacheRetention,
  resolveMainSessionCacheRetention,
} from "../prompt-cache-retention.js";
import {
  type ProviderPromptState,
  wrapStreamFnWithProviderPromptState,
} from "../provider-prompt-state.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import type { ProviderThinkLevel } from "../utils.js";
import { joinWithRunLivenessDeadline, RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import {
  shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks,
  type CompletionRequiredAsyncTaskWaitResult,
} from "./attempt-async-tasks.js";
import { findCurrentAttemptAssistantMessage } from "./attempt-context-engine-helpers.js";
import {
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
} from "./attempt-run-decisions.js";
import {
  observeCacheKeeperStream,
  observeProviderPromptStream,
  recordProviderPromptCompletion,
} from "./attempt-stream-observation.js";
import {
  settleEmbeddedAttemptTranscript,
  type AttemptTranscriptSettleResult,
  type PromptCacheRetention,
} from "./attempt-stream-transcript-settle.js";
import {
  hasActiveCompactionRetryWork,
  waitForCompactionRetryWithAggregateTimeout,
} from "./compaction-retry-aggregate-timeout.js";
import { materializeProviderContext } from "./images.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export { observeCacheKeeperStream, observeProviderPromptStream };

/**
 * Settles async tools and compaction, then snapshots the completed stream.
 */
type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type StreamSettleResult = AttemptTranscriptSettleResult & {
  timedOutDuringCompaction: boolean;
  successfulNestedToolNames: string[];
};

export async function settleEmbeddedAttemptStream(input: {
  attempt: EmbeddedRunAttemptParams;
  activeSession: AgentSession;
  sessionManager: SessionManager;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
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
  nestedToolActivities: readonly NestedToolActivity[];
  cache: {
    observabilityEnabled: boolean;
    changesForTurn: PromptCacheChange[] | null;
    identity?: string;
    retention: PromptCacheRetention;
  };
  shouldFlushForContextEngine: boolean;
}): Promise<StreamSettleResult> {
  const { attempt, activeSession, sessionManager, subscription, state } = input;
  const { sessionIdUsed } = state;
  let { promptError, promptErrorSource } = state;

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
      // Timeouts AND user aborts must still settle so the attempt reaches
      // after-turn (transcript flush, agent-end side effects). Rethrowing here
      // unwinds the whole lane task and silently starves every agent_end
      // consumer for aborted runs.
      const lifecycle = input.readLifecycleState();
      if ((!lifecycle.timedOut && !lifecycle.aborted) || !isRunnerAbortError(err)) {
        throw err;
      }
      asyncTaskWait = await waitForCompletionRequiredAsyncTasks({
        getToolMetas: getAsyncStartedToolMetas,
        sessionKey: attempt.sessionKey,
        deadlineAtMs: Date.now(),
      });
    }
    // An aborted run legitimately leaves async tasks unfinished; stamping a
    // timeout failure here would reclassify the abort as an errored completion.
    if (asyncTaskWait.timedOutRunIds.length > 0 && !input.readLifecycleState().aborted) {
      promptError = new Error(
        `Timed out waiting for async task completion: ${asyncTaskWait.timedOutRunIds.join(", ")}`,
      );
      promptErrorSource = "prompt";
      state.promptError = promptError;
      state.promptErrorSource = promptErrorSource;
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
      // The flush rides the same delivery chain the finalize-phase join just
      // bounded; a wedged lane (including the supported blockReplyTimeoutMs: 0
      // path) must not park settlement until the 48h run budget either.
      await joinWithRunLivenessDeadline({
        joinWork: () => input.onBlockReplyFlush?.({ reason: "pre_compaction", attemptAccepted }),
        runAbortSignal: input.runAbortSignal,
        onTimeout: () => {
          log.warn(
            `block-reply flush did not settle within ${RUN_LIVENESS_JOIN_TIMEOUT_MS}ms; ` +
              `proceeding with settlement: runId=${attempt.runId}`,
          );
        },
      });
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

  const transcript = await settleEmbeddedAttemptTranscript({
    attempt,
    activeSession,
    sessionManager,
    withOwnedTranscriptWrite: input.withOwnedTranscriptWrite,
    subscription,
    state,
    readLifecycleState: input.readLifecycleState,
    isProbeSession: input.isProbeSession,
    sessionAgentId: input.sessionAgentId,
    prePromptMessageCount: input.prePromptMessageCount,
    cache: input.cache,
    shouldFlushForContextEngine: input.shouldFlushForContextEngine,
    preCompactionSnapshot,
    preCompactionSessionId,
    promptError,
    promptErrorSource,
    sessionIdUsed,
  });
  return {
    ...transcript,
    timedOutDuringCompaction: input.readLifecycleState().timedOutDuringCompaction,
    successfulNestedToolNames: [
      ...new Set(
        input.nestedToolActivities.flatMap(({ details }) =>
          details.isError ? [] : [details.toolName],
        ),
      ),
    ],
  };
}

/**
 * Selects and configures the provider transport for one embedded attempt.
 */
export async function prepareEmbeddedAttemptTransport(input: {
  attempt: EmbeddedRunAttemptParams;
  session: AgentSession;
  settingsManager: SettingsManager;
  providerThinkingLevel: ProviderThinkLevel | undefined;
  onCurrentTurnImageFailure?: (count: number) => void;
  sessionAgentId: string;
  workspaceDir: string;
  workspaceOnly: boolean;
  agentDir: string;
  abortSignal: AbortSignal;
  getProviderRuntimeHandle: () => ProviderRuntimePluginHandle;
  sandboxSessionKey: string;
  sandbox?: SandboxContext | null;
  codeModeControlsEnabled: boolean;
  providerPromptState: {
    state: ProviderPromptState;
    effectiveContextTokenBudget: number;
    recordEvent?: (type: string, data?: Record<string, unknown>) => void;
  };
  providerReplayRecorder?: ProviderReplayRecorder | null;
}) {
  const attempt = input.attempt;
  const session = input.session;
  // Rebuild each turn from the session's original stream base so prior-turn
  // wrappers do not pin us to stale provider/API transport behavior.
  const defaultSessionStreamFn = resolveEmbeddedAgentBaseStreamFn({
    session,
  });
  const resolvedTransport = resolveExplicitSettingsTransport({
    settingsManager: input.settingsManager,
    sessionTransport: session.agent.transport,
  });
  const resolvedExtraParams = resolveExtraParams({
    cfg: attempt.config,
    provider: attempt.provider,
    modelId: attempt.modelId,
    agentId: input.sessionAgentId,
  });
  const configuredAndRunExtraParams = {
    ...resolvedExtraParams,
    ...attempt.streamParams,
  };
  const mainSessionCacheRetention = isCanonicalAgentMainSession({
    cfg: attempt.config ?? {},
    agentId: input.sessionAgentId,
    sessionKey: attempt.sessionKey,
  })
    ? resolveMainSessionCacheRetention(
        configuredAndRunExtraParams,
        attempt.provider,
        attempt.model.api,
        attempt.modelId,
        undefined,
        attempt.model.baseUrl,
      )
    : undefined;
  const streamExtraParamsOverride = {
    ...attempt.streamParams,
    ...(mainSessionCacheRetention ? { cacheRetention: mainSessionCacheRetention } : {}),
    fastMode: attempt.fastMode,
  };
  const preparedRuntimeExtraParams = attempt.runtimePlan?.transport.resolveExtraParams({
    extraParamsOverride: streamExtraParamsOverride,
    thinkingLevel: input.providerThinkingLevel,
    agentId: input.sessionAgentId,
    workspaceDir: input.workspaceDir,
    model: attempt.model,
    resolvedTransport,
  });
  const effectiveExtraParams =
    preparedRuntimeExtraParams ??
    resolvePreparedExtraParams({
      cfg: attempt.config,
      provider: attempt.provider,
      modelId: attempt.modelId,
      extraParamsOverride: streamExtraParamsOverride,
      thinkingLevel: input.providerThinkingLevel,
      agentId: input.sessionAgentId,
      agentDir: input.agentDir,
      workspaceDir: input.workspaceDir,
      resolvedExtraParams,
      model: attempt.model,
      resolvedTransport,
    });
  const providerStreamFn = registerProviderStreamForModel({
    model: attempt.model,
    cfg: attempt.config,
    agentDir: input.agentDir,
    workspaceDir: input.workspaceDir,
  });
  const directProviderStreamFn = providerStreamFn
    ? wrapStreamFnWithMessageTransform(
        providerStreamFn,
        (messages) => messages,
        ({ context, ...provider }) =>
          materializeProviderContext({
            ...provider,
            context,
            workspaceDir: input.workspaceDir,
            workspaceOnly: input.workspaceOnly,
            localRoots: input.workspaceOnly
              ? undefined
              : getAgentScopedMediaLocalRoots(attempt.config ?? {}, input.sessionAgentId),
            onCurrentTurnImageFailure: input.onCurrentTurnImageFailure,
            sandbox:
              input.sandbox?.enabled && input.sandbox.fsBridge
                ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
                : undefined,
          }),
      )
    : undefined;
  const transportApiKey = await resolveEmbeddedAgentApiKey({
    provider: attempt.model.provider,
    resolvedApiKey: attempt.resolvedApiKey,
    authStorage: attempt.authStorage,
  });
  const streamStrategy = describeEmbeddedAgentStreamStrategy({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn: directProviderStreamFn,
    model: attempt.model,
    resolvedApiKey: transportApiKey,
  });
  // A fallback attempt must not leave its predecessor eligible for an out-of-band touch.
  discardMainSessionCacheTouch(attempt.runId);
  session.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn: directProviderStreamFn,
    sessionId: attempt.sessionId,
    promptCacheKey: attempt.promptCacheKey,
    signal: input.abortSignal,
    model: attempt.model,
    resolvedApiKey: attempt.resolvedApiKey,
    transportAuthAvailable: Boolean(transportApiKey?.trim()),
    authProfileId: resolveAttemptStreamAuthProfileId(attempt),
    authStorage: attempt.authStorage,
  });
  const promptCacheKeeperEvidenceId = attempt.promptCacheKeeperEvidenceId;
  const mainSessionKey = attempt.sessionKey;
  let cacheKeeperProviderCalls = 0;
  const shouldStageMainSessionCacheTouch =
    mainSessionCacheRetention === "long" &&
    attempt.trigger === "user" &&
    Boolean(mainSessionKey) &&
    streamStrategy === "boundary-aware:anthropic-messages" &&
    !promptCacheKeeperEvidenceId;
  // Install inside provider/config wrappers so their full onPayload chain runs
  // before admission hashes the request body that the built-in transport sends.
  session.agent.streamFn = wrapStreamFnWithProviderPromptState({
    streamFn: session.agent.streamFn,
    ...input.providerPromptState,
    observeProviderPayload: ({ headers, model, payload, providerCallStartedAt, snapshot }) => {
      input.providerPromptState.recordEvent?.("provider.call.started", {
        providerCallSequence: snapshot.providerCallSequence,
        providerCallStartedAt,
        payloadIdentity: snapshot.digest,
        payloadBytes: snapshot.byteWeight,
        cachePrefixIdentity: snapshot.cachePrefixIdentity,
        cacheRequestOptionsIdentity: snapshot.cacheRequestOptionsIdentity,
        ...(snapshot.providerMessageIdentity
          ? { providerMessageIdentity: snapshot.providerMessageIdentity }
          : {}),
        cacheTree: snapshot.cacheTree,
      });
      input.providerReplayRecorder?.recordRequest({ model, payload, snapshot });
      if (
        shouldStageMainSessionCacheTouch &&
        mainSessionKey &&
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload)
      ) {
        try {
          stageMainSessionCacheTouch({
            agentId: input.sessionAgentId,
            apiKey: transportApiKey ?? "",
            ...(headers ? { headers } : {}),
            model: model as EmbeddedRunAttemptParams["model"] & {
              api: "anthropic-messages";
            },
            payload: payload as Record<string, unknown>,
            providerCallStartedAt,
            runId: attempt.runId,
            sessionId: attempt.sessionId,
            sessionKey: mainSessionKey,
            storePath: attempt.sessionTarget?.storePath ?? "",
          });
        } catch (error) {
          // Advisory cache maintenance must never fail the foreground request.
          log.warn(`failed to stage main cache-touch parent: ${String(error)}`);
        }
      }
    },
    observeProviderStream: (stream, readSnapshot) => {
      const cacheObservedStream = promptCacheKeeperEvidenceId
        ? observeCacheKeeperStream({
            stream,
            evidenceId: promptCacheKeeperEvidenceId,
            readProviderCallStartedAt: () => readSnapshot()?.providerCallStartedAt,
          })
        : stream;
      return observeProviderPromptStream({
        stream: cacheObservedStream,
        readSnapshot,
        recordEvent: input.providerPromptState.recordEvent,
        replayRecorder: input.providerReplayRecorder,
      });
    },
    observeProviderError: (error, snapshot) => {
      recordProviderPromptCompletion({
        snapshot,
        recordEvent: input.providerPromptState.recordEvent,
        replayRecorder: input.providerReplayRecorder,
        error,
      });
    },
    ...(promptCacheKeeperEvidenceId
      ? {
          assertCacheIdentity: (
            identity: {
              cachePrefixIdentity: string;
              cacheRequestOptionsIdentity: string;
              providerMessageIdentity?: string;
              messageContinuity: {
                deepestLongCachePrefixIndex?: number;
                prefixIdentities: readonly string[];
                tokenUpperBounds: readonly number[];
              };
            },
            providerCallStartedAt: number,
          ) => {
            const replaySafe = cacheKeeperProviderCalls === 0;
            assertMainSessionCacheKeeperEvidenceFresh(
              promptCacheKeeperEvidenceId,
              providerCallStartedAt,
              replaySafe,
            );
            assertMainSessionCacheKeeperProviderIdentity({
              evidenceId: promptCacheKeeperEvidenceId,
              providerCachePrefixIdentity: identity.cachePrefixIdentity,
              requestOptionsIdentity: identity.cacheRequestOptionsIdentity,
              providerMessageLongCachePrefixIndex:
                identity.messageContinuity.deepestLongCachePrefixIndex,
              providerMessagePrefixIdentities: identity.messageContinuity.prefixIdentities,
              providerMessageTokenUpperBounds: identity.messageContinuity.tokenUpperBounds,
              replaySafe,
            });
            cacheKeeperProviderCalls += 1;
          },
        }
      : {}),
  });
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: attempt.provider,
    config: attempt.config,
    workspaceDir: input.workspaceDir,
    runtimeHandle: input.getProviderRuntimeHandle(),
  });
  if (providerTextTransforms?.input?.length) {
    session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: session.agent.streamFn,
      input: providerTextTransforms.input,
      transformSystemPrompt: false,
    });
  }
  const nativeWebSearchPolicyContext = {
    webSearchEnabled: attempt.disableTools !== true && attempt.toolOverrides?.webSearch !== false,
    runtimeToolAllowlist: attempt.toolsAllow,
    sessionKey: input.sandboxSessionKey,
    sandboxToolPolicy: input.sandbox?.tools,
    messageProvider: resolveAttemptToolPolicyMessageProvider(attempt),
    agentAccountId: attempt.agentAccountId,
    groupId: attempt.groupId,
    groupChannel: attempt.groupChannel,
    groupSpace: attempt.groupSpace,
    spawnedBy: attempt.spawnedBy,
    senderId: attempt.senderId,
    senderName: attempt.senderName,
    senderUsername: attempt.senderUsername,
    senderE164: attempt.senderE164,
  };

  applyExtraParamsToAgent(
    session.agent,
    attempt.config,
    attempt.provider,
    attempt.modelId,
    streamExtraParamsOverride,
    input.providerThinkingLevel,
    input.sessionAgentId,
    input.workspaceDir,
    attempt.model,
    input.agentDir,
    resolvedTransport,
    {
      preparedExtraParams: effectiveExtraParams,
      nativeWebSearchPolicyContext,
    },
  );
  if (input.codeModeControlsEnabled) {
    session.agent.streamFn = createCodexNativeWebSearchWrapper(session.agent.streamFn, {
      config: attempt.config,
      agentDir: input.agentDir,
      agentId: input.sessionAgentId,
      ...nativeWebSearchPolicyContext,
      codeModeToolSurfaceEnabled: true,
    });
  }
  if (promptCacheKeeperEvidenceId) {
    const streamWithCacheIdentity = session.agent.streamFn;
    session.agent.streamFn = async (model, context, options) => {
      assertMainSessionCacheKeeperEvidenceFresh(
        promptCacheKeeperEvidenceId,
        Date.now(),
        cacheKeeperProviderCalls === 0,
      );
      return streamWithCacheIdentity(model, context, options);
    };
  }
  const effectivePromptCacheRetention = resolveCacheRetention(
    effectiveExtraParams,
    attempt.provider,
    attempt.model.api,
    attempt.modelId,
  );
  const agentTransportOverride = resolveAgentTransportOverride({
    settingsManager: input.settingsManager,
    effectiveExtraParams,
  });
  const effectiveAgentTransport = agentTransportOverride ?? session.agent.transport;
  if (agentTransportOverride && session.agent.transport !== agentTransportOverride) {
    const previousTransport = session.agent.transport;
    log.debug(
      `embedded agent transport override: ${previousTransport} -> ${agentTransportOverride} ` +
        `(${attempt.provider}/${attempt.modelId})`,
    );
  }
  session.agent.transport = effectiveAgentTransport;
  return {
    compactionReplayEnabled: resolveCompactionReplayEligibility(attempt.model, {
      extraParams: effectiveExtraParams,
      apiKey: transportApiKey,
    }),
    effectiveAgentTransport,
    effectiveExtraParams,
    effectivePromptCacheRetention,
    providerTextTransforms,
    streamStrategy,
  };
}
