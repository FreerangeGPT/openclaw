import crypto from "node:crypto";
import type { OpenClawConfig } from "../../../config/config.js";
import { joinPresentTextSegments } from "../../../shared/text/join-segments.js";
import { resolveAnthropicPayloadPolicy } from "../../anthropic-payload-policy.js";
import { normalizeStructuredPromptSection } from "../../prompt-cache-stability.js";
import { splitSystemPromptCacheBoundary } from "../../system-prompt-cache-boundary.js";
import type { PromptCacheChange, PromptCacheToolShape } from "../prompt-cache-observability.js";

export const ATTEMPT_CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export function composeSystemPromptWithHookContext(params: {
  baseSystemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}): string | undefined {
  const prependSystem =
    typeof params.prependSystemContext === "string"
      ? normalizeStructuredPromptSection(params.prependSystemContext)
      : "";
  const appendSystem =
    typeof params.appendSystemContext === "string"
      ? normalizeStructuredPromptSection(params.appendSystemContext)
      : "";
  if (!prependSystem && !appendSystem) {
    return undefined;
  }
  return joinPresentTextSegments([prependSystem, params.baseSystemPrompt, appendSystem], {
    trim: true,
  });
}

export function resolveAttemptSpawnWorkspaceDir(params: {
  sandbox?: {
    enabled?: boolean;
    workspaceAccess?: string;
  } | null;
  resolvedWorkspace: string;
}): string | undefined {
  return params.sandbox?.enabled && params.sandbox.workspaceAccess !== "rw"
    ? params.resolvedWorkspace
    : undefined;
}

export function shouldUseOpenAIWebSocketTransport(params: {
  provider: string;
  modelApi?: string | null;
}): boolean {
  // openai-codex normalizes to the ChatGPT backend HTTP path, not the public
  // OpenAI Responses websocket endpoint. Keep it on HTTP until a provider-
  // specific websocket target exists and is verified end-to-end.
  return params.modelApi === "openai-responses" && params.provider === "openai";
}

export function shouldAppendAttemptCacheTtl(params: {
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
}): boolean {
  if (params.timedOutDuringCompaction || params.compactionOccurredThisAttempt) {
    return false;
  }
  return (
    params.config?.agents?.defaults?.contextPruning?.mode === "cache-ttl" &&
    params.isCacheTtlEligibleProvider(params.provider, params.modelId, params.modelApi)
  );
}

type AttemptCacheRetention = "none" | "short" | "long";

function digestText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function resolveBaseUrlHost(baseUrl: string | undefined): string | undefined {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return undefined;
  }
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function buildPromptCacheShape(
  systemPrompt: string | undefined,
): Record<string, unknown> | undefined {
  if (typeof systemPrompt !== "string") {
    return undefined;
  }
  const split = splitSystemPromptCacheBoundary(systemPrompt);
  if (!split) {
    return {
      hasBoundary: false,
      systemPromptChars: systemPrompt.length,
      systemPromptDigest: digestText(systemPrompt),
    };
  }
  return {
    hasBoundary: true,
    stablePrefixChars: split.stablePrefix.length,
    stablePrefixDigest: digestText(split.stablePrefix),
    dynamicSuffixChars: split.dynamicSuffix.length,
    dynamicSuffixDigest: digestText(split.dynamicSuffix),
  };
}

function buildToolShape(params: {
  toolNames?: string[];
  toolShapes?: PromptCacheToolShape[];
}): Record<string, unknown> | undefined {
  if (Array.isArray(params.toolShapes)) {
    const normalized = params.toolShapes
      .map((tool) => ({ name: tool.name.trim(), digest: tool.digest }))
      .filter((tool) => tool.name.length > 0 && tool.digest.length > 0)
      .toSorted((left, right) =>
        left.name === right.name
          ? left.digest.localeCompare(right.digest)
          : left.name.localeCompare(right.name),
      );
    return {
      count: normalized.length,
      digest: digestText(JSON.stringify(normalized)),
    };
  }
  if (!Array.isArray(params.toolNames)) {
    return undefined;
  }
  const normalized = params.toolNames
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .toSorted();
  return {
    count: normalized.length,
    digest: digestText(JSON.stringify(normalized)),
  };
}

function resolveAnthropicCacheControlDiagnostics(params: {
  provider: string;
  modelApi?: string;
  baseUrl?: string;
  cacheRetention?: AttemptCacheRetention;
}): Record<string, unknown> | undefined {
  if (params.modelApi !== "anthropic-messages") {
    return undefined;
  }
  const policy = resolveAnthropicPayloadPolicy({
    provider: params.provider,
    api: params.modelApi,
    baseUrl: params.baseUrl,
    cacheRetention: params.cacheRetention,
    enableCacheControl: true,
  });
  return {
    cacheControl: policy.cacheControl ?? null,
    hasOneHourTtl: policy.cacheControl?.ttl === "1h",
  };
}

export function appendAttemptCacheTtlIfNeeded(params: {
  sessionManager: {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  timedOutDuringCompaction: boolean;
  compactionOccurredThisAttempt: boolean;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  modelApi?: string;
  baseUrl?: string;
  cacheRetention?: AttemptCacheRetention;
  streamStrategy?: string;
  transport?: string;
  systemPrompt?: string;
  toolNames?: string[];
  toolShapes?: PromptCacheToolShape[];
  promptCacheChanges?: PromptCacheChange[] | null;
  previousCacheRead?: number | null;
  isCacheTtlEligibleProvider: (provider: string, modelId: string, modelApi?: string) => boolean;
  now?: number;
}): boolean {
  if (!shouldAppendAttemptCacheTtl(params)) {
    return false;
  }
  const baseUrlHost = resolveBaseUrlHost(params.baseUrl);
  const promptCache = buildPromptCacheShape(params.systemPrompt);
  const tools = buildToolShape({ toolNames: params.toolNames, toolShapes: params.toolShapes });
  const anthropic = resolveAnthropicCacheControlDiagnostics({
    provider: params.provider,
    modelApi: params.modelApi,
    baseUrl: params.baseUrl,
    cacheRetention: params.cacheRetention,
  });
  params.sessionManager.appendCustomEntry?.(ATTEMPT_CACHE_TTL_CUSTOM_TYPE, {
    timestamp: params.now ?? Date.now(),
    provider: params.provider,
    modelId: params.modelId,
    ...(params.modelApi ? { modelApi: params.modelApi } : {}),
    ...(baseUrlHost ? { baseUrlHost } : {}),
    ...(params.cacheRetention ? { cacheRetention: params.cacheRetention } : {}),
    ...(params.streamStrategy ? { streamStrategy: params.streamStrategy } : {}),
    ...(params.transport ? { transport: params.transport } : {}),
    ...(typeof params.previousCacheRead === "number"
      ? { previousCacheRead: params.previousCacheRead }
      : {}),
    ...(promptCache ? { promptCache } : {}),
    ...(tools ? { tools } : {}),
    ...(anthropic ? { anthropic } : {}),
    ...(params.promptCacheChanges?.length
      ? {
          promptCacheChanges: params.promptCacheChanges.map((change) => ({
            code: change.code,
            detail: change.detail,
          })),
        }
      : {}),
  });
  return true;
}
