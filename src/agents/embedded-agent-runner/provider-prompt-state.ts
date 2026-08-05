import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import type { AssistantMessageEventStreamLike } from "../../llm/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { stableStringify } from "../stable-stringify.js";

export type ProviderPromptSnapshot = {
  scopeDigest: string;
  digest: string;
  byteWeight: number;
  cachePrefixIdentity: string;
  cacheRequestOptionsIdentity: string;
  providerMessageIdentity?: string;
  providerCallStartedAt: number;
};

type ProviderPromptCandidate = Omit<ProviderPromptSnapshot, "providerCallStartedAt">;

export type ProviderMessageContinuity = {
  deepestLongCachePrefixIndex?: number;
  prefixIdentities: readonly string[];
  tokenUpperBounds: readonly number[];
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
};

const PROVIDER_PROMPT_STATES_KEY = Symbol.for("openclaw.providerPromptStates");
const providerPromptStates = resolveGlobalSingleton(
  PROVIDER_PROMPT_STATES_KEY,
  () => new Map<string, ProviderPromptState>(),
);

class ProviderPromptRetryNoProgressError extends Error {
  constructor(payloadBytes: number) {
    super(
      "Context overflow: refusing to resend the byte-identical provider payload after a " +
        `context rejection (payloadBytes=${payloadBytes}).`,
    );
    this.name = "ProviderPromptRetryNoProgressError";
  }
}

function digest(serialized: string): string {
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function createProviderPromptState(): ProviderPromptState {
  return {};
}

const CACHE_REQUEST_OPTION_KEYS = [
  "thinking",
  "output_config",
  "tool_choice",
  "service_tier",
] as const;

/**
 * Fingerprints the final provider options whose changes invalidate Anthropic message caches.
 * Message/system/tool bytes are guarded separately so ordinary dialogue growth stays eligible.
 */
function fingerprintCacheRequestOptions(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const cacheRequestOptions: Record<string, unknown> = {};
  if (record) {
    for (const key of CACHE_REQUEST_OPTION_KEYS) {
      if (record[key] !== undefined) {
        cacheRequestOptions[key] = record[key];
      }
    }
  }
  return digest(stableStringify(cacheRequestOptions));
}

/** Captures every system and tool byte covered by the later message breakpoint. */
function fingerprintCachePrefix(payload: unknown): string {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  return digest(
    stableStringify({
      system: record?.system ?? null,
      tools: record?.tools ?? null,
    }),
  );
}

function hasOneHourCacheControl(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cacheControl = (value as Record<string, unknown>).cache_control;
  return (
    cacheControl !== null &&
    typeof cacheControl === "object" &&
    !Array.isArray(cacheControl) &&
    (cacheControl as Record<string, unknown>).type === "ephemeral" &&
    (cacheControl as Record<string, unknown>).ttl === "1h"
  );
}

function hasOneHourMessageBreakpoint(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  if (hasOneHourCacheControl(message)) {
    return true;
  }
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) && content.some(hasOneHourCacheControl);
}

function projectMessageWithoutCacheControl(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const { cache_control: _messageCacheControl, ...messageWithoutCacheControl } = record;
  const content = record.content;
  if (!Array.isArray(content)) {
    return messageWithoutCacheControl;
  }
  return {
    ...messageWithoutCacheControl,
    content: content.map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return block;
      }
      const { cache_control: _cacheControl, ...rest } = block as Record<string, unknown>;
      return rest;
    }),
  };
}

/**
 * Builds a hash chain for exact prior-message continuity and a byte-based upper
 * bound for each appended message. One tokenizer token cannot encode zero bytes.
 */
function snapshotProviderMessages(payload: unknown): {
  identity?: string;
  continuity: ProviderMessageContinuity;
} {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  let identity = digest("provider-messages:v1");
  let deepestLongCachePrefixIndex: number | undefined;
  const prefixIdentities = [identity];
  const tokenUpperBounds: number[] = [];
  for (const message of messages) {
    // Cache-control markers move to the newest breakpoint on later requests;
    // strip only that protocol field so an unchanged earlier message still matches.
    const serialized = stableStringify(projectMessageWithoutCacheControl(message));
    identity = digest(`${identity}\0${serialized}`);
    prefixIdentities.push(identity);
    if (hasOneHourMessageBreakpoint(message)) {
      deepestLongCachePrefixIndex = prefixIdentities.length - 1;
    }
    // Include a separator byte as a conservative bound for array framing.
    tokenUpperBounds.push(Buffer.byteLength(serialized) + 1);
  }
  return {
    identity:
      deepestLongCachePrefixIndex === undefined
        ? undefined
        : prefixIdentities[deepestLongCachePrefixIndex],
    continuity: {
      ...(deepestLongCachePrefixIndex === undefined ? {} : { deepestLongCachePrefixIndex }),
      prefixIdentities,
      tokenUpperBounds,
    },
  };
}

/** Returns run-local retry state; restarts and new run ids intentionally have no baseline. */
export function getProviderPromptState(runId: string): ProviderPromptState {
  const existing = providerPromptStates.get(runId);
  if (existing) {
    return existing;
  }
  const created = createProviderPromptState();
  providerPromptStates.set(runId, created);
  return created;
}

export function clearProviderPromptState(runId: string): void {
  providerPromptStates.delete(runId);
}

/** Captures the final provider request identity without retaining payload content. */
function snapshotProviderPrompt(params: {
  model: Model;
  payload: unknown;
  effectiveContextTokenBudget: number;
}): { snapshot: ProviderPromptCandidate; messageContinuity: ProviderMessageContinuity } {
  const scope = stableStringify({
    provider: params.model.provider,
    api: params.model.api,
    model: params.model.id,
    baseUrl: params.model.baseUrl,
    effectiveContextTokenBudget: params.effectiveContextTokenBudget,
  });
  const serialized = stableStringify(params.payload);
  const providerMessages = snapshotProviderMessages(params.payload);
  return {
    snapshot: {
      scopeDigest: digest(scope),
      digest: digest(serialized),
      byteWeight: Buffer.byteLength(serialized),
      cachePrefixIdentity: fingerprintCachePrefix(params.payload),
      cacheRequestOptionsIdentity: fingerprintCacheRequestOptions(params.payload),
      ...(providerMessages.identity ? { providerMessageIdentity: providerMessages.identity } : {}),
    },
    messageContinuity: providerMessages.continuity,
  };
}

/** Rejects only an exact replay of the last provider-rejected request body. */
function assertProviderPromptRetryProgress(
  state: ProviderPromptState,
  candidate: ProviderPromptCandidate,
): void {
  const rejected = state.lastRejected;
  if (!rejected || rejected.scopeDigest !== candidate.scopeDigest) {
    return;
  }
  if (rejected.digest === candidate.digest) {
    throw new ProviderPromptRetryNoProgressError(candidate.byteWeight);
  }
}

function beginProviderPromptAttempt(state: ProviderPromptState): void {
  // A transport that does not implement onPayload must not leave a stale body
  // eligible to be marked as the current provider rejection.
  state.lastAttempt = undefined;
}

function recordProviderPromptAttempt(
  state: ProviderPromptState,
  snapshot: ProviderPromptSnapshot,
): void {
  state.lastAttempt = snapshot;
}

export function markLastProviderPromptContextRejected(
  state: ProviderPromptState,
): ProviderPromptSnapshot | undefined {
  const attempted = state.lastAttempt;
  if (attempted) {
    state.lastRejected = attempted;
  }
  return attempted;
}

/** Observes the request body after every provider wrapper and caller payload hook. */
export function wrapStreamFnWithProviderPromptState(params: {
  streamFn: StreamFn;
  state: ProviderPromptState;
  effectiveContextTokenBudget: number;
  assertCacheIdentity?: (
    identity: Pick<
      ProviderPromptSnapshot,
      "cachePrefixIdentity" | "cacheRequestOptionsIdentity" | "providerMessageIdentity"
    > & { messageContinuity: ProviderMessageContinuity },
    providerCallStartedAt: number,
  ) => void;
  observeProviderStream?: (
    stream: AssistantMessageEventStreamLike,
    providerCallStartedAt: number,
  ) => AssistantMessageEventStreamLike;
  observeProviderPayload?: (params: {
    headers?: Record<string, string>;
    model: Model;
    payload: unknown;
    providerCallStartedAt: number;
  }) => void;
}): StreamFn {
  return async (model, context, options) => {
    beginProviderPromptAttempt(params.state);
    const originalOnPayload = options?.onPayload;
    let providerCallStartedAt: number | undefined;
    const stream = await params.streamFn(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement === undefined ? payload : replacement;
        const { snapshot, messageContinuity } = snapshotProviderPrompt({
          model: payloadModel,
          payload: finalPayload,
          effectiveContextTokenBudget: params.effectiveContextTokenBudget,
        });
        assertProviderPromptRetryProgress(params.state, snapshot);
        // This runs after every payload hook but before provider I/O. A keeper
        // must never authorize a cold request after stable-prefix or option drift.
        providerCallStartedAt = Date.now();
        const attemptedSnapshot = { ...snapshot, providerCallStartedAt };
        params.assertCacheIdentity?.(
          {
            cachePrefixIdentity: attemptedSnapshot.cachePrefixIdentity,
            cacheRequestOptionsIdentity: attemptedSnapshot.cacheRequestOptionsIdentity,
            providerMessageIdentity: attemptedSnapshot.providerMessageIdentity,
            messageContinuity,
          },
          providerCallStartedAt,
        );
        const headers = (options as { headers?: Record<string, string> } | undefined)?.headers;
        params.observeProviderPayload?.({
          ...(headers ? { headers } : {}),
          model: payloadModel,
          payload: finalPayload,
          providerCallStartedAt,
        });
        recordProviderPromptAttempt(params.state, attemptedSnapshot);
        return finalPayload;
      },
    });
    return providerCallStartedAt === undefined || !params.observeProviderStream
      ? stream
      : params.observeProviderStream(stream, providerCallStartedAt);
  };
}
