import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Usage } from "../../llm/types.js";
import { fingerprintResolvedProviderAuth } from "../execution-auth-binding.js";

export const PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE = "openclaw.prompt-cache";

export type PromptCacheEvidenceData = {
  evidenceId: string;
  timestamp: number;
  provider: string;
  modelId: string;
  cacheRetention: "long";
  promptIdentity: string;
  providerCachePrefixIdentity: string;
  requestOptionsIdentity: string;
  providerMessageIdentity: string;
  authFingerprint: string;
  authProfileId?: string;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  promptTokens: number;
  confirmedCachedTokens: number;
};

type LivePromptCacheEvidence = {
  data: PromptCacheEvidenceData;
  lastConfirmedTimestamp: number;
};

const LONG_CACHE_TTL_MS = 60 * 60_000;
const MAX_UNCACHED_PROMPT_TOKENS = 10_000;
const MAX_LIVE_EVIDENCE = 512;
const liveEvidenceById = new Map<string, LivePromptCacheEvidence>();

type PromptCacheInvalidationReason = "cache-not-long" | "cache-unconfirmed" | "keeper-unverified";

function normalizeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function readPromptCacheEvidenceData(value: unknown): PromptCacheEvidenceData | undefined {
  const data = value as Partial<PromptCacheEvidenceData> | undefined;
  const evidenceId = normalizeOptionalString(data?.evidenceId);
  const timestamp = normalizeTokenCount(data?.timestamp);
  const provider = normalizeOptionalString(data?.provider);
  const modelId = normalizeOptionalString(data?.modelId);
  const cacheRetention = data?.cacheRetention;
  const promptIdentity = normalizeOptionalString(data?.promptIdentity);
  const providerCachePrefixIdentity = normalizeOptionalString(data?.providerCachePrefixIdentity);
  const requestOptionsIdentity = normalizeOptionalString(data?.requestOptionsIdentity);
  const providerMessageIdentity = normalizeOptionalString(data?.providerMessageIdentity);
  const authFingerprint = normalizeOptionalString(data?.authFingerprint);
  const authProfileId = normalizeOptionalString(data?.authProfileId);
  const cacheRead = normalizeTokenCount(data?.cacheRead);
  const cacheWrite = normalizeTokenCount(data?.cacheWrite);
  const cacheWrite1h = normalizeTokenCount(data?.cacheWrite1h);
  const promptTokens = normalizeTokenCount(data?.promptTokens);
  const confirmedCachedTokens = normalizeTokenCount(data?.confirmedCachedTokens);
  if (
    !evidenceId ||
    timestamp === undefined ||
    !provider ||
    !modelId ||
    cacheRetention !== "long" ||
    !promptIdentity ||
    !providerCachePrefixIdentity ||
    !requestOptionsIdentity ||
    !providerMessageIdentity ||
    !authFingerprint ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite1h === undefined ||
    promptTokens === undefined ||
    promptTokens <= 0 ||
    confirmedCachedTokens === undefined ||
    confirmedCachedTokens <= 0
  ) {
    return undefined;
  }
  return {
    evidenceId,
    timestamp,
    provider,
    modelId,
    cacheRetention,
    promptIdentity,
    providerCachePrefixIdentity,
    requestOptionsIdentity,
    providerMessageIdentity,
    authFingerprint,
    ...(authProfileId ? { authProfileId } : {}),
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    promptTokens,
    confirmedCachedTokens,
  };
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= MAX_LIVE_EVIDENCE) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

function appendMainSessionPromptCacheInvalidation(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => unknown;
  };
  cacheRetention?: "none" | "short" | "long";
  reason: PromptCacheInvalidationReason;
  timestamp?: number;
}): false {
  params.sessionManager.appendCustomEntry?.(PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE, {
    kind: "invalidated",
    reason: params.reason,
    cacheRetention: params.cacheRetention ?? "unknown",
    timestamp: normalizeTokenCount(params.timestamp) ?? Date.now(),
  });
  return false;
}

export function fingerprintPromptCacheCredential(params: {
  apiKey?: string;
  authProfileId?: string;
}): string | undefined {
  const apiKey = normalizeOptionalString(params.apiKey);
  if (!apiKey) {
    return undefined;
  }
  return fingerprintResolvedProviderAuth({
    apiKey,
    profileId: normalizeOptionalString(params.authProfileId),
    source: "embedded-prompt-cache",
    mode: "api-key",
  });
}

function resolveConfirmedLongCacheTokens(params: {
  hasFreshConfirmedLongEntry: boolean;
  promptTokens: number;
  cacheRead: number;
  cacheWrite1h: number;
}): number | undefined {
  const requiredCachedTokens = Math.max(1, params.promptTokens - MAX_UNCACHED_PROMPT_TOKENS);
  return params.cacheWrite1h >= requiredCachedTokens
    ? params.cacheWrite1h
    : params.hasFreshConfirmedLongEntry &&
        params.cacheRead + params.cacheWrite1h >= requiredCachedTokens
      ? Math.min(Number.MAX_SAFE_INTEGER, params.cacheRead + params.cacheWrite1h)
      : undefined;
}

export function matchesLivePromptCacheEvidence(candidate: PromptCacheEvidenceData): boolean {
  const live = liveEvidenceById.get(candidate.evidenceId);
  return (
    live !== undefined &&
    live.data.timestamp === candidate.timestamp &&
    live.data.provider === candidate.provider &&
    live.data.modelId === candidate.modelId &&
    live.data.cacheRetention === candidate.cacheRetention &&
    live.data.promptIdentity === candidate.promptIdentity &&
    live.data.providerCachePrefixIdentity === candidate.providerCachePrefixIdentity &&
    live.data.requestOptionsIdentity === candidate.requestOptionsIdentity &&
    live.data.providerMessageIdentity === candidate.providerMessageIdentity &&
    live.data.authFingerprint === candidate.authFingerprint &&
    live.data.authProfileId === candidate.authProfileId &&
    live.data.cacheRead === candidate.cacheRead &&
    live.data.cacheWrite === candidate.cacheWrite &&
    live.data.cacheWrite1h === candidate.cacheWrite1h &&
    live.data.promptTokens === candidate.promptTokens &&
    live.data.confirmedCachedTokens === candidate.confirmedCachedTokens
  );
}

export function resolveLivePromptCacheEvidenceTimestamp(
  candidate: PromptCacheEvidenceData,
): number | undefined {
  return matchesLivePromptCacheEvidence(candidate)
    ? liveEvidenceById.get(candidate.evidenceId)?.lastConfirmedTimestamp
    : undefined;
}

/** Advances the live TTL only after a successful provider response proves covering cache use. */
export function refreshLivePromptCacheEvidence(params: {
  evidenceId: string;
  timestamp: number;
  usage?: Usage;
}): boolean {
  const live = liveEvidenceById.get(params.evidenceId);
  const timestamp = normalizeTokenCount(params.timestamp);
  const promptTokens =
    params.usage?.contextUsage?.state === "available"
      ? normalizeTokenCount(params.usage.contextUsage.promptTokens)
      : undefined;
  const cacheRead = normalizeTokenCount(params.usage?.cacheRead);
  const cacheWrite1h = normalizeTokenCount(params.usage?.cacheWrite1h) ?? 0;
  if (
    !live ||
    timestamp === undefined ||
    timestamp < live.lastConfirmedTimestamp ||
    promptTokens === undefined ||
    cacheRead === undefined ||
    resolveConfirmedLongCacheTokens({
      hasFreshConfirmedLongEntry: true,
      promptTokens,
      cacheRead,
      cacheWrite1h,
    }) === undefined
  ) {
    return false;
  }
  live.lastConfirmedTimestamp = timestamp;
  return true;
}

export class MainSessionCacheKeeperIdentityMismatchError extends Error {
  readonly replaySafe: boolean;

  constructor(params?: { replaySafe?: boolean }) {
    super("Main-session cache keeper skipped because prompt or credential identity changed.");
    this.name = "MainSessionCacheKeeperIdentityMismatchError";
    this.replaySafe = params?.replaySafe !== false;
  }
}

function findMainSessionCacheKeeperIdentityMismatchError(
  error: unknown,
): MainSessionCacheKeeperIdentityMismatchError | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      current instanceof MainSessionCacheKeeperIdentityMismatchError ||
      (typeof current === "object" &&
        (current as { name?: unknown }).name === "MainSessionCacheKeeperIdentityMismatchError")
    ) {
      return current as MainSessionCacheKeeperIdentityMismatchError;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return undefined;
}

export function isMainSessionCacheKeeperIdentityMismatchError(
  error: unknown,
): error is MainSessionCacheKeeperIdentityMismatchError {
  return findMainSessionCacheKeeperIdentityMismatchError(error) !== undefined;
}

export function isReplaySafeMainSessionCacheKeeperIdentityMismatch(error: unknown): boolean {
  return findMainSessionCacheKeeperIdentityMismatchError(error)?.replaySafe === true;
}

export function invalidateLivePromptCacheEvidence(evidenceId: string): void {
  liveEvidenceById.delete(evidenceId);
}

/** Rechecks the provider TTL at every model-call boundary, including tool continuations. */
export function assertMainSessionCacheKeeperEvidenceFresh(
  evidenceId: string,
  nowMs = Date.now(),
  replaySafe = true,
): void {
  const evidence = liveEvidenceById.get(evidenceId);
  const ageMs = evidence ? nowMs - evidence.lastConfirmedTimestamp : Number.POSITIVE_INFINITY;
  if (!evidence || ageMs < 0 || ageMs >= LONG_CACHE_TTL_MS) {
    throw new MainSessionCacheKeeperIdentityMismatchError({ replaySafe });
  }
}

/** Rejects before provider I/O when the heartbeat is no longer the proven cache request shape. */
export function assertMainSessionCacheKeeperIdentity(params: {
  evidenceId: string;
  promptIdentity: string;
  authFingerprint?: string;
}): void {
  const evidence = liveEvidenceById.get(params.evidenceId);
  if (
    !evidence ||
    !params.authFingerprint ||
    evidence.data.promptIdentity !== params.promptIdentity ||
    evidence.data.authFingerprint !== params.authFingerprint
  ) {
    throw new MainSessionCacheKeeperIdentityMismatchError();
  }
}

/** Rejects the final provider payload when any cache-affecting provider identity changed. */
export function assertMainSessionCacheKeeperProviderIdentity(params: {
  evidenceId: string;
  providerCachePrefixIdentity: string;
  requestOptionsIdentity: string;
  providerMessageLongCachePrefixIndex?: number;
  providerMessagePrefixIdentities: readonly string[];
  providerMessageTokenUpperBounds: readonly number[];
  replaySafe?: boolean;
}): void {
  const evidence = liveEvidenceById.get(params.evidenceId);
  if (
    !evidence ||
    evidence.data.providerCachePrefixIdentity !== params.providerCachePrefixIdentity ||
    evidence.data.requestOptionsIdentity !== params.requestOptionsIdentity
  ) {
    throw new MainSessionCacheKeeperIdentityMismatchError({ replaySafe: params.replaySafe });
  }
  const previouslyUncachedTokens = Math.max(
    0,
    evidence.data.promptTokens - evidence.data.confirmedCachedTokens,
  );
  const remainingUncachedAllowance = Math.max(
    0,
    MAX_UNCACHED_PROMPT_TOKENS - previouslyUncachedTokens,
  );
  const baselineMessageCount = params.providerMessagePrefixIdentities.indexOf(
    evidence.data.providerMessageIdentity,
  );
  const hasValidContinuityShape =
    params.providerMessagePrefixIdentities.length ===
      params.providerMessageTokenUpperBounds.length + 1 &&
    baselineMessageCount >= 0 &&
    Number.isSafeInteger(params.providerMessageLongCachePrefixIndex) &&
    (params.providerMessageLongCachePrefixIndex ?? -1) >= baselineMessageCount &&
    (params.providerMessageLongCachePrefixIndex ?? Number.POSITIVE_INFINITY) <=
      params.providerMessageTokenUpperBounds.length;
  const appendedMessageTokenUpperBound = hasValidContinuityShape
    ? params.providerMessageTokenUpperBounds
        .slice(baselineMessageCount)
        .reduce(
          (total, value) =>
            Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(total + value)
              ? total + value
              : Number.POSITIVE_INFINITY,
          0,
        )
    : Number.POSITIVE_INFINITY;
  if (appendedMessageTokenUpperBound > remainingUncachedAllowance) {
    throw new MainSessionCacheKeeperIdentityMismatchError({ replaySafe: params.replaySafe });
  }
}

/**
 * Revalidates the transcript after the keeper owns the session lock.
 * Only its already-admitted user turn may follow the preflight active leaf.
 */
export function assertMainSessionCacheKeeperTranscriptAnchor(params: {
  currentLeaf:
    | { id: string; parentId: string | null; type: string; message?: { role?: unknown } }
    | undefined;
  expectedParentId?: string;
  persistedUserMessageId?: string;
}): void {
  const leaf = params.currentLeaf;
  if (
    !params.expectedParentId ||
    !params.persistedUserMessageId ||
    leaf?.id !== params.persistedUserMessageId ||
    leaf.parentId !== params.expectedParentId ||
    leaf.type !== "message" ||
    leaf.message?.role !== "user"
  ) {
    throw new MainSessionCacheKeeperIdentityMismatchError();
  }
}

export function isCanonicalAgentMainSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): boolean {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const canonical = canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey,
  });
  const expected =
    params.cfg.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId });
  return canonical === expected;
}

function hasActiveBranchLongCacheEvidence(params: {
  entries: readonly unknown[] | undefined;
  timestamp: number;
  promptIdentity: string;
  providerCachePrefixIdentity: string;
  requestOptionsIdentity: string;
  authFingerprint: string;
}): boolean {
  if (!params.entries) {
    return false;
  }
  for (const entry of params.entries.toReversed()) {
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type === "custom" && record.customType === PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE) {
      const candidate = readPromptCacheEvidenceData(record.data);
      const lastConfirmedTimestamp = candidate
        ? resolveLivePromptCacheEvidenceTimestamp(candidate)
        : undefined;
      return Boolean(
        candidate &&
        lastConfirmedTimestamp !== undefined &&
        candidate.promptIdentity === params.promptIdentity &&
        candidate.providerCachePrefixIdentity === params.providerCachePrefixIdentity &&
        candidate.requestOptionsIdentity === params.requestOptionsIdentity &&
        candidate.authFingerprint === params.authFingerprint &&
        params.timestamp >= lastConfirmedTimestamp &&
        params.timestamp - lastConfirmedTimestamp < LONG_CACHE_TTL_MS,
      );
    }
    if (
      record.type === "compaction" ||
      record.type === "reset" ||
      record.type === "branch_summary" ||
      record.type === "model_change" ||
      record.type === "thinking_level_change"
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Persists the retention that produced a cache-bearing main-dialogue response.
 * The heartbeat keeper must not promote an old short-TTL hit after a config reload.
 */
export function appendMainSessionPromptCacheEvidence(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => unknown;
    getBranch?: () => readonly unknown[];
  };
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  provider: string;
  modelId: string;
  cacheRetention?: "none" | "short" | "long";
  promptIdentity?: string;
  providerCachePrefixIdentity?: string;
  requestOptionsIdentity?: string;
  providerMessageIdentity?: string;
  authFingerprint?: string;
  authProfileId?: string;
  runKind?: string;
  cacheKeeperEvidenceId?: string;
  timestamp?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  promptTokens?: number;
}): boolean {
  if (!isCanonicalAgentMainSession(params)) {
    return false;
  }
  if (params.runKind === "heartbeat" && !normalizeOptionalString(params.cacheKeeperEvidenceId)) {
    return appendMainSessionPromptCacheInvalidation({
      sessionManager: params.sessionManager,
      cacheRetention: params.cacheRetention,
      reason: "keeper-unverified",
      timestamp: params.timestamp,
    });
  }
  const timestamp = normalizeTokenCount(params.timestamp);
  const promptIdentity = normalizeOptionalString(params.promptIdentity);
  const providerCachePrefixIdentity = normalizeOptionalString(params.providerCachePrefixIdentity);
  const requestOptionsIdentity = normalizeOptionalString(params.requestOptionsIdentity);
  const providerMessageIdentity = normalizeOptionalString(params.providerMessageIdentity);
  const authFingerprint = normalizeOptionalString(params.authFingerprint);
  const promptTokens = normalizeTokenCount(params.promptTokens);
  const cacheRead = normalizeTokenCount(params.cacheRead);
  const cacheWrite1h = normalizeTokenCount(params.cacheWrite1h);
  if (params.cacheRetention !== "long") {
    return appendMainSessionPromptCacheInvalidation({
      sessionManager: params.sessionManager,
      cacheRetention: params.cacheRetention,
      reason: "cache-not-long",
      timestamp: params.timestamp,
    });
  }
  if (
    timestamp === undefined ||
    !promptIdentity ||
    !providerCachePrefixIdentity ||
    !requestOptionsIdentity ||
    !providerMessageIdentity ||
    !authFingerprint ||
    promptTokens === undefined ||
    cacheRead === undefined ||
    cacheWrite1h === undefined
  ) {
    return appendMainSessionPromptCacheInvalidation({
      sessionManager: params.sessionManager,
      cacheRetention: params.cacheRetention,
      reason: "cache-unconfirmed",
      timestamp: params.timestamp,
    });
  }
  const confirmedCachedTokens = resolveConfirmedLongCacheTokens({
    hasFreshConfirmedLongEntry: hasActiveBranchLongCacheEvidence({
      entries: params.sessionManager.getBranch?.(),
      timestamp,
      promptIdentity,
      providerCachePrefixIdentity,
      requestOptionsIdentity,
      authFingerprint,
    }),
    promptTokens,
    cacheRead,
    cacheWrite1h,
  });
  if (confirmedCachedTokens === undefined) {
    return appendMainSessionPromptCacheInvalidation({
      sessionManager: params.sessionManager,
      cacheRetention: params.cacheRetention,
      reason: "cache-unconfirmed",
      timestamp: params.timestamp,
    });
  }
  const data = readPromptCacheEvidenceData({
    evidenceId: crypto.randomUUID(),
    timestamp,
    provider: params.provider,
    modelId: params.modelId,
    cacheRetention: params.cacheRetention,
    promptIdentity,
    providerCachePrefixIdentity,
    requestOptionsIdentity,
    providerMessageIdentity,
    authFingerprint,
    authProfileId: params.authProfileId,
    cacheRead,
    cacheWrite: params.cacheWrite,
    cacheWrite1h,
    promptTokens,
    confirmedCachedTokens,
  });
  if (!data) {
    return appendMainSessionPromptCacheInvalidation({
      sessionManager: params.sessionManager,
      cacheRetention: params.cacheRetention,
      reason: "cache-unconfirmed",
      timestamp: params.timestamp,
    });
  }
  if (!params.sessionManager.appendCustomEntry) {
    return false;
  }
  params.sessionManager.appendCustomEntry(PROMPT_CACHE_EVIDENCE_CUSTOM_TYPE, data);
  setBoundedMap(liveEvidenceById, data.evidenceId, {
    data,
    lastConfirmedTimestamp: data.timestamp,
  });
  return true;
}
