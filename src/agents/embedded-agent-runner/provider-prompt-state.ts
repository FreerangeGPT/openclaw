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
  cacheTree: ProviderPromptCacheTree;
  providerMessageIdentity?: string;
  providerCallSequence: number;
  providerCallStartedAt: number;
};

type ProviderPromptCandidate = Omit<
  ProviderPromptSnapshot,
  "providerCallSequence" | "providerCallStartedAt"
>;

export type ProviderPromptCacheBreakpoint = {
  layer: "tools" | "system" | "messages";
  blockIndex: number;
  messageIndex?: number;
  contentIndex?: number;
  ttl: "5m" | "1h";
  prefixIdentity: string;
  /** Anthropic searches this breakpoint and at most the preceding 19 blocks. */
  lookbackPrefixIdentities: readonly string[];
};

export type ProviderPromptCacheTree = {
  version: 1;
  tools: { blockCount: number; identity: string };
  system: { blockCount: number; identity: string };
  messages: { blockCount: number; messageCount: number; identity: string };
  breakpoints: readonly ProviderPromptCacheBreakpoint[];
};

export type ProviderMessageContinuity = {
  deepestLongCachePrefixIndex?: number;
  prefixIdentities: readonly string[];
  tokenUpperBounds: readonly number[];
};

export type ProviderPromptState = {
  lastAttempt?: ProviderPromptSnapshot;
  lastRejected?: ProviderPromptSnapshot;
  providerCallCount: number;
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
  return { providerCallCount: 0 };
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

function readCacheControlTtl(value: unknown): "5m" | "1h" | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const cacheControl = (value as Record<string, unknown>).cache_control;
  if (!cacheControl || typeof cacheControl !== "object" || Array.isArray(cacheControl)) {
    return undefined;
  }
  const record = cacheControl as Record<string, unknown>;
  if (record.type !== "ephemeral") {
    return undefined;
  }
  return record.ttl === "1h" ? "1h" : "5m";
}

function projectWithoutCacheControl(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const { cache_control: _cacheControl, ...rest } = value as Record<string, unknown>;
  return rest;
}

type ProviderCacheBlock = {
  layer: ProviderPromptCacheBreakpoint["layer"];
  blockIndex: number;
  messageIndex?: number;
  contentIndex?: number;
  value: unknown;
  ttl?: "5m" | "1h";
};

function snapshotLayer(value: unknown): { blockCount: number; identity: string } {
  const blocks = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return {
    blockCount: blocks.length,
    identity: digest(stableStringify(blocks.map(projectWithoutCacheControl))),
  };
}

function collectProviderCacheBlocks(payload: unknown): ProviderCacheBlock[] {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const blocks: ProviderCacheBlock[] = [];
  const tools = Array.isArray(record?.tools) ? record.tools : [];
  for (const [blockIndex, tool] of tools.entries()) {
    const ttl = readCacheControlTtl(tool);
    blocks.push({
      layer: "tools",
      blockIndex,
      value: projectWithoutCacheControl(tool),
      ...(ttl ? { ttl } : {}),
    });
  }
  const system = Array.isArray(record?.system)
    ? record.system
    : record?.system === undefined
      ? []
      : [record.system];
  for (const [blockIndex, systemBlock] of system.entries()) {
    const ttl = readCacheControlTtl(systemBlock);
    blocks.push({
      layer: "system",
      blockIndex,
      value: projectWithoutCacheControl(systemBlock),
      ...(ttl ? { ttl } : {}),
    });
  }
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  let messageBlockIndex = 0;
  for (const [messageIndex, message] of messages.entries()) {
    const messageRecord =
      message && typeof message === "object" && !Array.isArray(message)
        ? (message as Record<string, unknown>)
        : undefined;
    const messageWithoutContent = messageRecord
      ? projectWithoutCacheControl(
          Object.fromEntries(Object.entries(messageRecord).filter(([key]) => key !== "content")),
        )
      : message;
    const content = Array.isArray(messageRecord?.content)
      ? messageRecord.content
      : [messageRecord?.content ?? null];
    for (const [contentIndex, contentBlock] of content.entries()) {
      const blockTtl = readCacheControlTtl(contentBlock);
      const messageTtl =
        contentIndex === content.length - 1 ? readCacheControlTtl(message) : undefined;
      blocks.push({
        layer: "messages",
        blockIndex: messageBlockIndex,
        messageIndex,
        contentIndex,
        value: {
          ...(contentIndex === 0 ? { message: messageWithoutContent } : {}),
          content: projectWithoutCacheControl(contentBlock),
        },
        ...((blockTtl ?? messageTtl) ? { ttl: blockTtl ?? messageTtl } : {}),
      });
      messageBlockIndex += 1;
    }
  }
  return blocks;
}

function isAutomaticCacheEligibleBlock(block: ProviderCacheBlock): boolean {
  const value = block.value;
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const content = (value as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content.length > 0;
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return block.layer === "tools";
  }
  const contentRecord = content as Record<string, unknown>;
  if (contentRecord.type === "thinking" || contentRecord.type === "redacted_thinking") {
    return false;
  }
  return (
    contentRecord.type !== "text" ||
    (typeof contentRecord.text === "string" && contentRecord.text.length > 0)
  );
}

/** Captures the exact 20 lookup positions, counting the breakpoint first, without content. */
function snapshotProviderCacheTree(payload: unknown): ProviderPromptCacheTree {
  const record =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const blocks = collectProviderCacheBlocks(payload);
  const automaticTtl = readCacheControlTtl(payload);
  if (automaticTtl) {
    const automaticTarget = blocks.findLast(isAutomaticCacheEligibleBlock);
    if (automaticTarget && !automaticTarget.ttl) {
      automaticTarget.ttl = automaticTtl;
    }
  }
  const prefixIdentities: string[] = [];
  const breakpoints: ProviderPromptCacheBreakpoint[] = [];
  let prefixIdentity = digest("provider-cache-tree:v1");
  for (const block of blocks) {
    prefixIdentity = digest(`${prefixIdentity}\0${block.layer}\0${stableStringify(block.value)}`);
    prefixIdentities.push(prefixIdentity);
    if (!block.ttl) {
      continue;
    }
    breakpoints.push({
      layer: block.layer,
      blockIndex: block.blockIndex,
      ...(block.messageIndex === undefined ? {} : { messageIndex: block.messageIndex }),
      ...(block.contentIndex === undefined ? {} : { contentIndex: block.contentIndex }),
      ttl: block.ttl,
      prefixIdentity,
      lookbackPrefixIdentities: prefixIdentities.slice(-20).toReversed(),
    });
  }
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const messageBlocks = blocks.filter((block) => block.layer === "messages");
  return {
    version: 1,
    tools: snapshotLayer(record?.tools),
    system: snapshotLayer(record?.system),
    messages: {
      blockCount: messageBlocks.length,
      messageCount: messages.length,
      identity: digest(stableStringify(messages.map(projectMessageWithoutCacheControl))),
    },
    breakpoints,
  };
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
      cacheTree: snapshotProviderCacheTree(params.payload),
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
    snapshot: ProviderPromptSnapshot,
  ) => AssistantMessageEventStreamLike;
  observeProviderError?: (error: unknown, snapshot: ProviderPromptSnapshot) => void;
  observeProviderPayload?: (params: {
    headers?: Record<string, string>;
    model: Model;
    payload: unknown;
    providerCallStartedAt: number;
    snapshot: ProviderPromptSnapshot;
  }) => void;
}): StreamFn {
  return async (model, context, options) => {
    beginProviderPromptAttempt(params.state);
    const originalOnPayload = options?.onPayload;
    let providerCallStartedAt: number | undefined;
    let providerPromptSnapshot: ProviderPromptSnapshot | undefined;
    let providerPayloadObserved = false;
    let stream: AssistantMessageEventStreamLike;
    try {
      stream = await params.streamFn(model, context, {
        ...options,
        onPayload: async (payload, payloadModel) => {
          if (providerPromptSnapshot && providerPayloadObserved) {
            // A second payload in one stream invocation represents an internal
            // retry. Close the prior request before tracking the returned stream.
            params.observeProviderError?.(
              new Error("provider payload superseded before stream returned"),
              providerPromptSnapshot,
            );
            providerPromptSnapshot = undefined;
            providerPayloadObserved = false;
          }
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
          const attemptedSnapshot: ProviderPromptSnapshot = {
            ...snapshot,
            providerCallSequence: (params.state.providerCallCount ?? 0) + 1,
            providerCallStartedAt,
          };
          params.state.providerCallCount = attemptedSnapshot.providerCallSequence;
          providerPromptSnapshot = attemptedSnapshot;
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
            snapshot: attemptedSnapshot,
          });
          providerPayloadObserved = true;
          recordProviderPromptAttempt(params.state, attemptedSnapshot);
          return finalPayload;
        },
      });
    } catch (error) {
      if (providerPromptSnapshot && providerPayloadObserved) {
        params.observeProviderError?.(error, providerPromptSnapshot);
      }
      throw error;
    }
    return !providerPromptSnapshot || !params.observeProviderStream
      ? stream
      : params.observeProviderStream(
          stream,
          providerPromptSnapshot.providerCallStartedAt,
          providerPromptSnapshot,
        );
  };
}
