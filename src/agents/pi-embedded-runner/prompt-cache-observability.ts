import crypto from "node:crypto";
import type { NormalizedUsage } from "../usage.js";

export type PromptCacheChangeCode =
  | "cacheRetention"
  | "model"
  | "streamStrategy"
  | "systemPrompt"
  | "tools"
  | "transport";

export type PromptCacheChange = {
  code: PromptCacheChangeCode;
  detail: string;
};

export type PromptCacheSnapshot = {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  cacheRetention?: "none" | "short" | "long";
  streamStrategy: string;
  transport?: string;
  systemPromptDigest: string;
  toolDigest: string;
  toolCount: number;
  toolShapeDigests: string[];
  toolNames: string[];
};

export type PromptCacheToolShape = {
  digest: string;
  name: string;
};

export type PromptCacheObservationStart = {
  snapshot: PromptCacheSnapshot;
  changes: PromptCacheChange[] | null;
  previousCacheRead: number | null;
};

export type PromptCacheBreak = {
  previousCacheRead: number;
  cacheRead: number;
  changes: PromptCacheChange[] | null;
};

export type PromptCacheAnomalyReason =
  | "cold-large-cache-write"
  | "recent-large-cache-write"
  | "wasted-heartbeat-cache-write"
  | "wasted-no-reply-cache-write";

export type PromptCacheAnomaly = {
  cacheRead: number;
  cacheWrite: number;
  reasons: PromptCacheAnomalyReason[];
  secondsSincePreviousAssistant?: number;
  totalTokens?: number;
};

type PromptCacheTracker = {
  snapshot: PromptCacheSnapshot;
  lastCacheRead: number | null;
  pendingChanges: PromptCacheChange[] | null;
};

const trackers = new Map<string, PromptCacheTracker>();
const MAX_TRACKERS = 512;

const MIN_CACHE_BREAK_TOKEN_DROP = 1_000;
const MAX_STABLE_CACHE_READ_RATIO = 0.95;
export const LARGE_CACHE_WRITE_ALERT_TOKENS = 50_000;
export const RECENT_CACHE_WRITE_ALERT_SECONDS = 300;

function digestText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildTrackerKey(params: { sessionKey?: string; sessionId: string }): string {
  return params.sessionKey?.trim() || params.sessionId;
}

function buildToolDigest(toolShapes: PromptCacheToolShape[]): string {
  // Treat diagnostics as set-stable here: order changes alone should not look
  // like a real cache break when the same tool set is still present.
  return digestText(
    JSON.stringify(
      toolShapes
        .map((tool) => ({ name: tool.name, digest: tool.digest }))
        .toSorted((left, right) =>
          left.name === right.name
            ? left.digest.localeCompare(right.digest)
            : left.name.localeCompare(right.name),
        ),
    ),
  );
}

function setTracker(key: string, tracker: PromptCacheTracker): void {
  if (trackers.has(key)) {
    trackers.delete(key);
  } else if (trackers.size >= MAX_TRACKERS) {
    const oldestKey = trackers.keys().next().value;
    if (typeof oldestKey === "string") {
      trackers.delete(oldestKey);
    }
  }
  trackers.set(key, tracker);
}

function diffSnapshots(
  previous: PromptCacheSnapshot,
  next: PromptCacheSnapshot,
): PromptCacheChange[] | null {
  const changes: PromptCacheChange[] = [];
  if (previous.provider !== next.provider || previous.modelId !== next.modelId) {
    changes.push({
      code: "model",
      detail: `${previous.provider}/${previous.modelId} -> ${next.provider}/${next.modelId}`,
    });
  } else if ((previous.modelApi ?? null) !== (next.modelApi ?? null)) {
    changes.push({
      code: "model",
      detail: `${previous.modelApi ?? "unknown"} -> ${next.modelApi ?? "unknown"}`,
    });
  }
  if (previous.cacheRetention !== next.cacheRetention) {
    changes.push({
      code: "cacheRetention",
      detail: `${previous.cacheRetention ?? "default"} -> ${next.cacheRetention ?? "default"}`,
    });
  }
  if (previous.transport !== next.transport) {
    changes.push({
      code: "transport",
      detail: `${previous.transport ?? "default"} -> ${next.transport ?? "default"}`,
    });
  }
  if (previous.streamStrategy !== next.streamStrategy) {
    changes.push({
      code: "streamStrategy",
      detail: `${previous.streamStrategy} -> ${next.streamStrategy}`,
    });
  }
  if (previous.systemPromptDigest !== next.systemPromptDigest) {
    changes.push({
      code: "systemPrompt",
      detail: "system prompt digest changed",
    });
  }
  if (previous.toolDigest !== next.toolDigest) {
    changes.push({
      code: "tools",
      detail:
        previous.toolCount === next.toolCount
          ? "tool set changed with same count"
          : `${previous.toolCount} -> ${next.toolCount} tools`,
    });
  }
  return changes.length > 0 ? changes : null;
}

export function collectPromptCacheToolNames(tools: Array<{ name?: string }>): string[] {
  return tools.map((tool) => tool.name?.trim()).filter((name): name is string => Boolean(name));
}

export function collectPromptCacheToolShapes(
  tools: Array<{
    description?: unknown;
    input_schema?: unknown;
    name?: string;
    parameters?: unknown;
  }>,
): PromptCacheToolShape[] {
  return tools.flatMap((tool) => {
    const name = tool.name?.trim();
    if (!name) {
      return [];
    }
    return [
      {
        name,
        digest: digestText(
          stableStringify({
            name,
            description: tool.description,
            input_schema: tool.input_schema,
            parameters: tool.parameters,
          }),
        ),
      },
    ];
  });
}

export function beginPromptCacheObservation(params: {
  sessionId: string;
  sessionKey?: string;
  provider: string;
  modelId: string;
  modelApi?: string | null;
  cacheRetention?: "none" | "short" | "long";
  streamStrategy: string;
  transport?: string;
  systemPrompt: string;
  toolNames?: string[];
  toolShapes?: PromptCacheToolShape[];
}): PromptCacheObservationStart {
  const key = buildTrackerKey(params);
  const toolShapes =
    params.toolShapes ??
    params.toolNames?.map((name) => ({
      name,
      digest: digestText(stableStringify({ name })),
    })) ??
    [];
  const toolNames = params.toolNames ?? toolShapes.map((tool) => tool.name);
  const snapshot: PromptCacheSnapshot = {
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    cacheRetention: params.cacheRetention,
    streamStrategy: params.streamStrategy,
    transport: params.transport,
    systemPromptDigest: digestText(params.systemPrompt),
    toolDigest: buildToolDigest(toolShapes),
    toolCount: toolShapes.length,
    toolShapeDigests: toolShapes.map((tool) => tool.digest),
    toolNames: [...toolNames],
  };
  const previous = trackers.get(key);
  const changes = previous ? diffSnapshots(previous.snapshot, snapshot) : null;
  setTracker(key, {
    snapshot,
    lastCacheRead: previous?.lastCacheRead ?? null,
    pendingChanges: changes,
  });
  return {
    snapshot,
    changes,
    previousCacheRead: previous?.lastCacheRead ?? null,
  };
}

export function completePromptCacheObservation(params: {
  sessionId: string;
  sessionKey?: string;
  usage?: NormalizedUsage;
}): PromptCacheBreak | null {
  const key = buildTrackerKey(params);
  const tracker = trackers.get(key);
  if (!tracker) {
    return null;
  }

  const cacheRead = params.usage?.cacheRead;
  if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead)) {
    tracker.pendingChanges = null;
    return null;
  }
  const previousCacheRead = tracker.lastCacheRead;
  tracker.lastCacheRead = cacheRead;

  if (previousCacheRead == null || previousCacheRead <= 0) {
    tracker.pendingChanges = null;
    return null;
  }

  const tokenDrop = previousCacheRead - cacheRead;
  const hasMeaningfulDrop =
    cacheRead < previousCacheRead * MAX_STABLE_CACHE_READ_RATIO &&
    tokenDrop >= MIN_CACHE_BREAK_TOKEN_DROP;
  const result = hasMeaningfulDrop
    ? {
        previousCacheRead,
        cacheRead,
        changes: tracker.pendingChanges,
      }
    : null;
  tracker.pendingChanges = null;
  return result;
}

function normalizeAssistantText(texts: string[] | undefined): string {
  return texts?.join("\n").trim() ?? "";
}

function isNoReplyText(text: string): boolean {
  if (text.trim().toUpperCase() === "NO_REPLY") {
    return true;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { action?: unknown }).action === "NO_REPLY" &&
      Object.keys(parsed as Record<string, unknown>).length === 1
    );
  } catch {
    return false;
  }
}

function isHeartbeatOkText(text: string): boolean {
  const withoutMarkup = text.replace(/<[^>]*>/g, "").trim();
  return /^HEARTBEAT_OK(?:\b|$)/i.test(withoutMarkup);
}

export function detectPromptCacheAnomaly(params: {
  assistantTexts?: string[];
  secondsSincePreviousAssistant?: number | null;
  usage?: NormalizedUsage;
}): PromptCacheAnomaly | null {
  const cacheWrite = params.usage?.cacheWrite;
  if (
    typeof cacheWrite !== "number" ||
    !Number.isFinite(cacheWrite) ||
    cacheWrite < LARGE_CACHE_WRITE_ALERT_TOKENS
  ) {
    return null;
  }

  const cacheRead =
    typeof params.usage?.cacheRead === "number" && Number.isFinite(params.usage.cacheRead)
      ? params.usage.cacheRead
      : 0;
  const reasons: PromptCacheAnomalyReason[] = [];
  if (cacheRead <= 0) {
    reasons.push("cold-large-cache-write");
  }

  const secondsSincePreviousAssistant =
    typeof params.secondsSincePreviousAssistant === "number" &&
    Number.isFinite(params.secondsSincePreviousAssistant)
      ? Math.max(0, Math.floor(params.secondsSincePreviousAssistant))
      : undefined;
  if (
    secondsSincePreviousAssistant !== undefined &&
    secondsSincePreviousAssistant <= RECENT_CACHE_WRITE_ALERT_SECONDS
  ) {
    reasons.push("recent-large-cache-write");
  }

  const assistantText = normalizeAssistantText(params.assistantTexts);
  if (isNoReplyText(assistantText)) {
    reasons.push("wasted-no-reply-cache-write");
  } else if (isHeartbeatOkText(assistantText)) {
    reasons.push("wasted-heartbeat-cache-write");
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    reasons,
    cacheRead,
    cacheWrite,
    ...(secondsSincePreviousAssistant !== undefined ? { secondsSincePreviousAssistant } : {}),
    ...(typeof params.usage?.total === "number" && Number.isFinite(params.usage.total)
      ? { totalTokens: params.usage.total }
      : {}),
  };
}

export function resetPromptCacheObservabilityForTest(): void {
  trackers.clear();
}
