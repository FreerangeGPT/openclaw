/**
 * Selects and configures the provider transport for one embedded attempt.
 */
import {
  discardMainSessionCacheTouch,
  stageMainSessionCacheTouch,
} from "../../../infra/main-session-cache-keeper.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import type { AssistantMessageEventStreamLike } from "../../../llm/types.js";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import { resolveProviderTextTransforms } from "../../../plugins/provider-runtime.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { AgentSession, SettingsManager } from "../../sessions/index.js";
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
  refreshLivePromptCacheEvidence,
} from "../prompt-cache-evidence.js";
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
import {
  resolveAttemptStreamAuthProfileId,
  resolveAttemptToolPolicyMessageProvider,
} from "./attempt.run-decisions.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function observeCacheKeeperStream(params: {
  stream: AssistantMessageEventStreamLike;
  evidenceId: string;
  providerCallStartedAt: number;
}): AssistantMessageEventStreamLike {
  let refreshAttempted = false;
  const refreshEvidence = (
    usage: Parameters<typeof refreshLivePromptCacheEvidence>[0]["usage"],
  ) => {
    if (refreshAttempted) {
      return;
    }
    refreshAttempted = true;
    refreshLivePromptCacheEvidence({
      evidenceId: params.evidenceId,
      timestamp: params.providerCallStartedAt,
      usage,
    });
  };
  return {
    result: async () => {
      const message = await params.stream.result();
      refreshEvidence(message.usage);
      return message;
    },
    async *[Symbol.asyncIterator]() {
      for await (const event of params.stream) {
        if (event.type === "done") {
          refreshEvidence(event.message.usage);
        }
        yield event;
      }
    },
  };
}

export async function prepareEmbeddedAttemptTransport(input: {
  attempt: EmbeddedRunAttemptParams;
  session: AgentSession;
  settingsManager: SettingsManager;
  providerThinkingLevel: ProviderThinkLevel | undefined;
  sessionAgentId: string;
  workspaceDir: string;
  agentDir: string;
  abortSignal: AbortSignal;
  getProviderRuntimeHandle: () => ProviderRuntimePluginHandle;
  sandboxSessionKey: string;
  sandbox?: SandboxContext | null;
  codeModeControlsEnabled: boolean;
  providerPromptState: {
    state: ProviderPromptState;
    effectiveContextTokenBudget: number;
  };
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
  const transportApiKey = await resolveEmbeddedAgentApiKey({
    provider: attempt.model.provider,
    resolvedApiKey: attempt.resolvedApiKey,
    authStorage: attempt.authStorage,
  });
  const streamStrategy = describeEmbeddedAgentStreamStrategy({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    model: attempt.model,
    resolvedApiKey: transportApiKey,
  });
  // A fallback attempt must not leave the prior provider payload blocking the
  // last confirmed main parent while this attempt selects a different route.
  discardMainSessionCacheTouch(attempt.runId);
  session.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
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
  // Install inside provider/config wrappers so their full onPayload chain runs
  // before admission hashes the request body that the built-in transport sends.
  session.agent.streamFn = wrapStreamFnWithProviderPromptState({
    streamFn: session.agent.streamFn,
    ...input.providerPromptState,
    ...(mainSessionCacheRetention === "long" &&
    attempt.trigger === "user" &&
    mainSessionKey &&
    streamStrategy === "boundary-aware:anthropic-messages" &&
    !promptCacheKeeperEvidenceId
      ? {
          observeProviderPayload: ({
            headers,
            model,
            payload,
            providerCallStartedAt,
          }: {
            headers?: Record<string, string>;
            model: EmbeddedRunAttemptParams["model"];
            payload: unknown;
            providerCallStartedAt: number;
          }) => {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
              return;
            }
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
                sessionFile: attempt.sessionFile,
                sessionId: attempt.sessionId,
                sessionKey: mainSessionKey,
              });
            } catch (error) {
              // Cache maintenance is advisory; payload capture must never fail
              // the foreground main request it is intended to protect.
              log.warn(`failed to stage main cache-touch parent: ${String(error)}`);
            }
          },
        }
      : {}),
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
            // Payload hooks may be asynchronous. Recheck the one-hour proof at
            // the literal final-payload boundary so an expired cache cannot dispatch.
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
          observeProviderStream: (stream, providerCallStartedAt) =>
            observeCacheKeeperStream({
              stream,
              evidenceId: promptCacheKeeperEvidenceId,
              providerCallStartedAt,
            }),
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
  return {
    effectiveAgentTransport,
    effectiveExtraParams,
    effectivePromptCacheRetention,
    providerTextTransforms,
    streamStrategy,
  };
}
