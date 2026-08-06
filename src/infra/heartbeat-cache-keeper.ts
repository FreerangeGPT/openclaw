import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { isAuthProfileAvailableForProviders } from "../agents/auth-profiles/session-override.js";
import {
  PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE,
  readPromptCacheEvidenceData,
  resolveLivePromptCacheEvidenceTimestamp,
} from "../agents/embedded-agent-runner/prompt-cache-evidence.js";
import { resolveMainSessionCacheRetention } from "../agents/embedded-agent-runner/prompt-cache-retention.js";
import { resolveModelExtraParamSources } from "../agents/model-extra-params.js";
import { parseModelRef } from "../agents/model-selection.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import {
  resolveMergedModelProviderConfig,
  resolveMergedModelProviderModels,
} from "../config/model-provider-config.js";
import { findSessionTranscriptActiveEvent } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { estimateStringChars, estimateTokensFromChars } from "../utils/cjk-chars.js";
import {
  shouldAutoIsolateMainSessionHeartbeat,
  shouldSkipExpensiveMainSessionHeartbeat,
  shouldUseIsolatedHeartbeatSession,
  type ExpensiveMainSessionHeartbeatSkip,
} from "./heartbeat-cost-guard.js";
import { isCronSystemEvent, isExecCompletionEvent } from "./heartbeat-events-filter.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import type { HeartbeatRunScope } from "./heartbeat-run-scope.js";
import { heartbeatLog, type HeartbeatConfig } from "./heartbeat-runner-config.js";
import { resolveHeartbeatRunPrompt, type HeartbeatPreflight } from "./heartbeat-runner-prompt.js";
import { resolveHeartbeatIntervalMs } from "./heartbeat-summary.js";
import type { HeartbeatScheduledTask } from "./heartbeat-wake.js";

type CacheRetention = "none" | "short" | "long" | undefined;

const SHORT_CACHE_RETENTION_TTL_MS = 5 * 60_000;
const LONG_CACHE_RETENTION_TTL_MS = 60 * 60_000;
const MAX_CACHE_KEEPER_UNCACHED_TOKENS = 10_000;
const HEARTBEAT_PROMPT_TOKEN_ESTIMATE_SAFETY_MARGIN = 1.2;

export function resolveCacheKeeperCacheViable(params: {
  cacheRetention: CacheRetention;
  cachedTokens?: number;
  intervalMs: number;
  lastCacheTouchAt?: number;
  nowMs: number;
  pendingPromptTokens?: number;
  totalTokens?: number;
}): boolean {
  if (params.cacheRetention === undefined || params.cacheRetention === "none") {
    return false;
  }
  const ttlMs =
    params.cacheRetention === "long" ? LONG_CACHE_RETENTION_TTL_MS : SHORT_CACHE_RETENTION_TTL_MS;
  const lastCacheTouchAt =
    typeof params.lastCacheTouchAt === "number" ? params.lastCacheTouchAt : null;
  const cacheAgeMs = lastCacheTouchAt === null ? null : params.nowMs - lastCacheTouchAt;
  const cachedTokens =
    typeof params.cachedTokens === "number" && Number.isFinite(params.cachedTokens)
      ? Math.max(0, params.cachedTokens)
      : null;
  const totalTokens =
    typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
      ? Math.max(0, params.totalTokens)
      : null;
  const pendingPromptTokens =
    typeof params.pendingPromptTokens === "number" && Number.isFinite(params.pendingPromptTokens)
      ? Math.max(0, params.pendingPromptTokens)
      : 0;
  return (
    params.intervalMs < ttlMs &&
    cacheAgeMs !== null &&
    cacheAgeMs >= 0 &&
    cacheAgeMs < ttlMs &&
    lastCacheTouchAt !== null &&
    cachedTokens !== null &&
    totalTokens !== null &&
    // The last output/current tail was not part of the prior request. Permit a
    // bounded tail, but never let a small static-prefix hit authorize the dialogue.
    cachedTokens >=
      Math.max(0, totalTokens + pendingPromptTokens - MAX_CACHE_KEEPER_UNCACHED_TOKENS)
  );
}

function estimateHeartbeatPromptTokens(prompt: string): number {
  const baseEstimate = estimateTokensFromChars(estimateStringChars(prompt));
  return Math.ceil(baseEstimate * HEARTBEAT_PROMPT_TOKEN_ESTIMATE_SAFETY_MARGIN);
}

function resolveHeartbeatModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
}) {
  const sessionModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  const heartbeatModelOverride = normalizeOptionalString(params.heartbeat?.model);
  return heartbeatModelOverride
    ? (parseModelRef(heartbeatModelOverride, sessionModel.provider) ?? sessionModel)
    : sessionModel;
}

function resolveHeartbeatCacheRetention(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeatModel: { provider: string; model: string };
}): CacheRetention {
  const heartbeatModel = params.heartbeatModel;
  const provider = normalizeLowercaseStringOrEmpty(heartbeatModel.provider);
  const modelId = normalizeCacheTouchModelId(heartbeatModel.model, provider);
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  const modelConfig = resolveMergedModelProviderModels({
    models: providerConfig?.models,
    normalizeModelId: (configuredModelId) =>
      normalizeCacheTouchModelId(configuredModelId, provider),
  }).get(modelId);
  const modelApi =
    modelConfig?.api ??
    providerConfig?.api ??
    (provider === "anthropic" ? "anthropic-messages" : undefined);
  const baseUrl = modelConfig?.baseUrl ?? providerConfig?.baseUrl;
  const { defaultParams, modelParams, agentParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider,
    modelId,
    agentId: params.agentId,
  });
  const extraParams = Object.assign({}, defaultParams, modelParams, agentParams);
  return resolveMainSessionCacheRetention(
    Object.keys(extraParams).length > 0 ? extraParams : undefined,
    provider,
    modelApi,
    modelId,
    undefined,
    baseUrl,
  );
}

function normalizeCacheTouchModelId(value: unknown, provider: string): string {
  const modelId = normalizeLowercaseStringOrEmpty(value);
  const providerPrefix = `${normalizeLowercaseStringOrEmpty(provider)}/`;
  return modelId.startsWith(providerPrefix) ? modelId.slice(providerPrefix.length) : modelId;
}

type CacheEvidence =
  | {
      kind: "cache-touch";
      authProfileId?: string;
      cachedTokens: number;
      evidenceId: string;
      timestamp: number;
    }
  | { kind: "invalidated" };

function resolveCacheEvidence(
  event: unknown,
  heartbeatModel: { provider: string; model: string },
  heartbeatCacheRetention: CacheRetention,
): CacheEvidence | null {
  const record = event as {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
    message?: Record<string, unknown>;
  };
  const expectedProvider = normalizeLowercaseStringOrEmpty(heartbeatModel.provider);
  const expectedModel = normalizeCacheTouchModelId(heartbeatModel.model, expectedProvider);
  if (record.type === "custom" && record.customType === PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE) {
    const candidate = readPromptCacheEvidenceData(record.data);
    const liveTimestamp = candidate
      ? resolveLivePromptCacheEvidenceTimestamp(candidate)
      : undefined;
    const matchesModel =
      candidate !== undefined &&
      normalizeLowercaseStringOrEmpty(candidate.provider) === expectedProvider &&
      normalizeCacheTouchModelId(candidate.modelId, expectedProvider) === expectedModel;
    if (
      matchesModel &&
      candidate.cacheRetention === heartbeatCacheRetention &&
      liveTimestamp !== undefined
    ) {
      return {
        kind: "cache-touch",
        ...(candidate.authProfileId ? { authProfileId: candidate.authProfileId } : {}),
        cachedTokens: candidate.confirmedCachedTokens,
        evidenceId: candidate.evidenceId,
        timestamp: liveTimestamp,
      };
    }
    // A newer evidence marker with different retention/model provenance blocks
    // older hits from being reused after a config or model change.
    return { kind: "invalidated" };
  }
  if (
    record.message !== undefined ||
    record.type === "compaction" ||
    record.type === "reset" ||
    record.type === "branch_summary" ||
    record.type === "model_change" ||
    record.type === "thinking_level_change"
  ) {
    // Any newer model-facing transcript mutation means an older cache touch
    // no longer proves the prompt assembled from the active branch is warm.
    return { kind: "invalidated" };
  }
  return null;
}

function resolveLastCacheTouch(params: {
  agentId: string;
  entry?: SessionEntry;
  storePath: string;
  heartbeatModel: { provider: string; model: string };
  heartbeatCacheRetention: CacheRetention;
}): (Extract<CacheEvidence, { kind: "cache-touch" }> & { transcriptAnchorId: string }) | undefined {
  if (!params.entry?.sessionId) {
    return undefined;
  }
  let match: { activeLeafEntryId: string | null; event: unknown } | undefined;
  try {
    match = findSessionTranscriptActiveEvent(
      {
        agentId: params.agentId,
        sessionId: params.entry.sessionId,
        storePath: params.storePath,
      },
      (event) =>
        resolveCacheEvidence(event, params.heartbeatModel, params.heartbeatCacheRetention) !== null,
    );
  } catch {
    // A rebuilding transcript projection cannot prove that this main-session cache is warm.
    return undefined;
  }
  const evidence = match
    ? resolveCacheEvidence(match.event, params.heartbeatModel, params.heartbeatCacheRetention)
    : null;
  return evidence?.kind === "cache-touch" && match?.activeLeafEntryId
    ? { ...evidence, transcriptAnchorId: match.activeLeafEntryId }
    : undefined;
}

export async function resolveHeartbeatCacheKeeperPolicy(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
  storePath: string;
  nowMs: number;
}) {
  const preserveMainSessionCache =
    params.heartbeat?.isolatedSession !== true && params.heartbeat?.lightContext !== true;
  const heartbeatIntervalMs = resolveHeartbeatIntervalMs(params.cfg, undefined, params.heartbeat);
  const heartbeatModel = resolveHeartbeatModel(params);
  const heartbeatCacheRetention = resolveHeartbeatCacheRetention({ ...params, heartbeatModel });
  const observedLastCacheTouch = preserveMainSessionCache
    ? resolveLastCacheTouch({
        ...params,
        heartbeatModel,
        heartbeatCacheRetention,
      })
    : undefined;
  const lastCacheTouch =
    observedLastCacheTouch?.authProfileId &&
    !isAuthProfileAvailableForProviders({
      cfg: params.cfg,
      provider: heartbeatModel.provider,
      agentDir: resolveAgentDir(params.cfg, params.agentId),
      profileId: observedLastCacheTouch.authProfileId,
      forModel: heartbeatModel.model,
    })
      ? undefined
      : observedLastCacheTouch;
  const cacheKeeperCacheViable = preserveMainSessionCache
    ? heartbeatIntervalMs !== null &&
      resolveCacheKeeperCacheViable({
        cacheRetention: heartbeatCacheRetention,
        cachedTokens: lastCacheTouch?.cachedTokens,
        intervalMs: heartbeatIntervalMs,
        lastCacheTouchAt: lastCacheTouch?.timestamp,
        nowMs: params.nowMs,
        totalTokens: params.entry?.totalTokensFresh === true ? params.entry.totalTokens : undefined,
      })
    : undefined;
  return {
    preserveMainSessionCache,
    heartbeatIntervalMs,
    heartbeatCacheRetention,
    heartbeatModel,
    lastCacheTouch,
    cacheKeeperCacheViable,
    nowMs: params.nowMs,
  };
}

type HeartbeatCacheKeeperPolicy = Awaited<ReturnType<typeof resolveHeartbeatCacheKeeperPolicy>>;

export async function resolvePromptAwareHeartbeatCacheKeeperPolicy(
  params: Parameters<typeof resolveHeartbeatCacheKeeperPolicy>[0] & {
    preflight: HeartbeatPreflight;
    runScope: HeartbeatRunScope;
    scheduledTasks: readonly HeartbeatScheduledTask[];
  },
): Promise<HeartbeatCacheKeeperPolicy> {
  const policy = await resolveHeartbeatCacheKeeperPolicy(params);
  if (policy.cacheKeeperCacheViable !== true) {
    return policy;
  }
  const heartbeatIntervalMs = policy.heartbeatIntervalMs;
  if (heartbeatIntervalMs === null) {
    return { ...policy, cacheKeeperCacheViable: false };
  }
  const promptCandidates = [false, true].map(
    (canRelayToUser) =>
      resolveHeartbeatRunPrompt({
        cfg: params.cfg,
        heartbeat: params.heartbeat,
        preflight: params.preflight,
        canRelayToUser,
        startedAt: params.nowMs,
        scheduledTasks: params.scheduledTasks,
        heartbeatScratchContent: params.preflight.heartbeatScratchContent,
        // A main-session keeper preserves the ordinary dialogue tool prefix.
        useHeartbeatResponseTool: false,
        runScope: params.runScope,
      }).prompt,
  );
  const pendingPromptTokens = Math.max(
    0,
    ...promptCandidates.map((prompt) =>
      prompt === null ? 0 : estimateHeartbeatPromptTokens(prompt),
    ),
  );
  return {
    ...policy,
    cacheKeeperCacheViable: resolveCacheKeeperCacheViable({
      cacheRetention: policy.heartbeatCacheRetention,
      cachedTokens: policy.lastCacheTouch?.cachedTokens,
      intervalMs: heartbeatIntervalMs,
      lastCacheTouchAt: policy.lastCacheTouch?.timestamp,
      nowMs: policy.nowMs,
      // Routing depends on this result, so project both delivery prompt forms
      // before choosing main-session keeper versus isolated execution.
      pendingPromptTokens,
      totalTokens: params.entry?.totalTokensFresh === true ? params.entry.totalTokens : undefined,
    }),
  };
}

export function resolveHeartbeatCacheKeeperReplyOptions(params: {
  autoIsolatedMainSession: boolean;
  heartbeat?: HeartbeatConfig;
  mainSessionCacheKeeper: boolean;
  policy: HeartbeatCacheKeeperPolicy;
  useIsolatedSession: boolean;
}) {
  const mainSessionCacheKeeperModelOverride = params.mainSessionCacheKeeper
    ? `${params.policy.heartbeatModel.provider}/${params.policy.heartbeatModel.model}`
    : undefined;
  const heartbeatModelOverride =
    mainSessionCacheKeeperModelOverride ?? normalizeOptionalString(params.heartbeat?.model);
  // Canonical-main fallback reuses one lightweight prefix across fresh runs.
  // Retain 1h there because the heartbeat cadence outlives Anthropic's 5m TTL.
  const heartbeatCacheRetentionOverride =
    params.useIsolatedSession && params.policy.heartbeatCacheRetention === "long"
      ? params.autoIsolatedMainSession
        ? ("long" as const)
        : ("short" as const)
      : undefined;
  return {
    ...(heartbeatModelOverride ? { heartbeatModelOverride } : {}),
    ...(heartbeatCacheRetentionOverride ? { heartbeatCacheRetentionOverride } : {}),
    ...(mainSessionCacheKeeperModelOverride ? { heartbeatModelFallbacksDisabled: true } : {}),
    ...(params.mainSessionCacheKeeper && params.policy.lastCacheTouch
      ? {
          heartbeatPromptCacheEvidenceId: params.policy.lastCacheTouch.evidenceId,
          heartbeatPromptCacheTranscriptAnchorId: params.policy.lastCacheTouch.transcriptAnchorId,
          ...(params.policy.lastCacheTouch.authProfileId
            ? { heartbeatAuthProfileOverride: params.policy.lastCacheTouch.authProfileId }
            : {}),
        }
      : {}),
  };
}

type HeartbeatCostGuardPreflight = {
  pendingEventEntries: readonly { text: string }[];
  hasTaggedCronEvents: boolean;
  dueCommitments: readonly unknown[];
  isCronWake: boolean;
  isExecEventWake: boolean;
};

type HeartbeatCostGuardSessionEntry = {
  totalTokens?: number;
  totalTokensFresh?: boolean;
};

export function resolveHeartbeatSessionIsolation(params: {
  heartbeat?: HeartbeatConfig;
  policy: HeartbeatCacheKeeperPolicy;
  entry?: HeartbeatCostGuardSessionEntry;
  preflight: HeartbeatCostGuardPreflight;
  scheduledTaskCount: number;
  wakeSource?: string;
  hasMemoryPrepend: boolean;
}) {
  const hasExecCompletion = params.preflight.pendingEventEntries.some((event) =>
    isExecCompletionEvent(event.text),
  );
  const hasCronEvents =
    params.preflight.hasTaggedCronEvents ||
    params.preflight.pendingEventEntries.some((event) => isCronSystemEvent(event.text));
  const guardFacts = {
    preserveMainSessionCache: params.policy.preserveMainSessionCache,
    cacheKeeperCacheViable: params.policy.cacheKeeperCacheViable,
    totalTokens: params.entry?.totalTokens,
    totalTokensFresh: params.entry?.totalTokensFresh,
    hasExecCompletion,
    hasCronEvents,
    hasDueCommitments: params.preflight.dueCommitments.length > 0,
    hasScheduledTasks: params.scheduledTaskCount > 0,
    isCronEventReason: params.preflight.isCronWake,
    isExecEventReason: params.preflight.isExecEventWake,
    isManualReason: params.wakeSource === "manual",
  };
  const autoIsolatedMainSession = shouldAutoIsolateMainSessionHeartbeat({
    ...guardFacts,
    configuredIsolated: params.heartbeat?.isolatedSession,
  });
  const useIsolatedSession = shouldUseIsolatedHeartbeatSession({
    configuredIsolated: params.heartbeat?.isolatedSession,
    hasMemoryPrepend: params.hasMemoryPrepend,
    autoIsolatedMainSession: Boolean(autoIsolatedMainSession),
  });
  const mainSessionCacheKeeper =
    !useIsolatedSession && params.policy.cacheKeeperCacheViable === true;
  return {
    autoIsolatedMainSession,
    mainSessionCacheKeeper,
    useIsolatedSession,
  };
}

export function resolveExpensiveMainSessionHeartbeatSkip(params: {
  runPrompt: {
    prompt: string | null;
    hasExecCompletion: boolean;
    hasCronEvents: boolean;
    hasDueCommitments: boolean;
  };
  policy: HeartbeatCacheKeeperPolicy;
  entry?: HeartbeatCostGuardSessionEntry;
  preflight: Pick<HeartbeatCostGuardPreflight, "isCronWake" | "isExecEventWake">;
  scheduledTaskCount: number;
  wakeSource?: string;
  useIsolatedSession: boolean;
}) {
  if (params.runPrompt.prompt === null) {
    return null;
  }
  if (
    !params.useIsolatedSession &&
    params.policy.cacheKeeperCacheViable !== true &&
    params.policy.preserveMainSessionCache &&
    params.policy.heartbeatCacheRetention === "long"
  ) {
    // A canonical-main heartbeat may append only to a live, identity-bound 1h
    // prefix. This is deliberately size-independent: a cheap synthetic turn
    // cannot bootstrap trustworthy cache evidence for the real main prefix.
    return {
      kind: "failed",
      reason: params.policy.lastCacheTouch
        ? ("cache-evidence-not-viable" as const)
        : ("cache-evidence-missing" as const),
      details: {
        cacheRetention: params.policy.heartbeatCacheRetention,
        heartbeatIntervalMs: params.policy.heartbeatIntervalMs,
        totalTokens: params.entry?.totalTokens,
        totalTokensFresh: params.entry?.totalTokensFresh,
      },
    } as const;
  }
  const cacheKeeperCacheViable =
    params.policy.cacheKeeperCacheViable === true && params.policy.heartbeatIntervalMs !== null
      ? resolveCacheKeeperCacheViable({
          cacheRetention: params.policy.heartbeatCacheRetention,
          cachedTokens: params.policy.lastCacheTouch?.cachedTokens,
          intervalMs: params.policy.heartbeatIntervalMs,
          lastCacheTouchAt: params.policy.lastCacheTouch?.timestamp,
          nowMs: params.policy.nowMs,
          // The session count predates this user message. Project it here so a
          // large monitor prompt cannot turn a warm keeper into a cold rewrite.
          pendingPromptTokens: estimateHeartbeatPromptTokens(params.runPrompt.prompt),
          totalTokens:
            params.entry?.totalTokensFresh === true ? params.entry.totalTokens : undefined,
        })
      : params.policy.cacheKeeperCacheViable;
  const skip = shouldSkipExpensiveMainSessionHeartbeat({
    prompt: params.runPrompt.prompt,
    preserveMainSessionCache: params.policy.preserveMainSessionCache,
    cacheKeeperCacheViable,
    totalTokens: params.entry?.totalTokens,
    totalTokensFresh: params.entry?.totalTokensFresh,
    hasExecCompletion: params.runPrompt.hasExecCompletion,
    hasCronEvents: params.runPrompt.hasCronEvents,
    hasDueCommitments: params.runPrompt.hasDueCommitments,
    hasScheduledTasks: params.scheduledTaskCount > 0,
    isCronEventReason: params.preflight.isCronWake,
    isExecEventReason: params.preflight.isExecEventWake,
    isManualReason: params.wakeSource === "manual",
    useIsolatedSession: params.useIsolatedSession,
  });
  return skip ? ({ kind: "skipped", ...skip } as const) : null;
}

export function reportExpensiveMainSessionHeartbeatSkip(params: {
  agentId: string;
  heartbeatIntervalMs: number | null;
  cacheRetention: CacheRetention;
  sessionKey: string;
  skip: ExpensiveMainSessionHeartbeatSkip & { kind: "skipped" };
  startedAt: number;
}) {
  heartbeatLog.warn("heartbeat: skipping large routine main-session run", {
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    cacheRetention: params.cacheRetention,
    heartbeatIntervalMs: params.heartbeatIntervalMs,
    ...params.skip,
  });
  emitHeartbeatEvent({
    status: "skipped",
    reason: "full-context-heartbeat-guard",
    durationMs: Date.now() - params.startedAt,
  });
  return { kind: "skipped", reason: "full-context-heartbeat-guard" } as const;
}
