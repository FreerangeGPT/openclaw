import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { compactEmbeddedPiSession, runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { resolveSandboxConfigForAgent, resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import {
  derivePromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveFreshSessionTotalTokens,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { logVerbose } from "../../globals.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { resolveMemoryFlushPlan } from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import type { VerboseLevel } from "../thinking.js";
import type { GetReplyOptions } from "../types.js";
import {
  buildEmbeddedRunExecutionParams,
  resolveModelFallbackOptions,
} from "./agent-runner-utils.js";
import {
  hasAlreadyFlushedForCurrentCompaction,
  resolveMemoryFlushContextWindowTokens,
  shouldRunMemoryFlush,
  shouldRunPreflightCompaction,
} from "./memory-flush.js";
import { readPostCompactionContext } from "./post-compaction-context.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { incrementCompactionCount } from "./session-updates.js";

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = prompt?.trim();
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  const tokens = estimateMessagesTokens([message]);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return undefined;
  }
  return Math.ceil(tokens);
}

export function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

export type SessionTranscriptUsageSnapshot = {
  promptTokens?: number;
  outputTokens?: number;
};

// Keep a generous near-threshold window so large assistant outputs still trigger
// transcript reads in time to flip memory-flush gating when needed.
const TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS = 8192;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;
const MEMORY_FLUSH_TAIL_MAX_CHARS = 20_000;
const MEMORY_FLUSH_MESSAGE_MAX_CHARS = 4_000;

function truncateForMemoryFlush(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const headChars = Math.max(0, Math.floor(maxChars * 0.4));
  const tailChars = Math.max(0, maxChars - headChars - 32);
  return `${value.slice(0, headChars)}\n...[truncated for memory flush]...\n${value.slice(-tailChars)}`;
}

function stringifyMemoryFlushContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.content === "string") {
            return record.content;
          }
          if (typeof record.type === "string") {
            return `[${record.type}]`;
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
  }
  return "";
}

function buildMemoryFlushTranscriptTail(params: {
  sessionFile?: string;
  sessionId?: string;
  storePath?: string;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  let messages: AgentMessage[];
  try {
    messages = readSessionMessages(
      sessionId,
      params.storePath,
      params.sessionFile,
    ) as AgentMessage[];
  } catch {
    return undefined;
  }
  const chunks: string[] = [];
  let totalChars = 0;
  for (const message of messages.toReversed()) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
      continue;
    }
    const text = truncateForMemoryFlush(
      stringifyMemoryFlushContent(message.content).trim(),
      MEMORY_FLUSH_MESSAGE_MAX_CHARS,
    );
    if (!text) {
      continue;
    }
    const chunk = `${message.role}: ${text}`;
    const nextTotal = totalChars + chunk.length + 2;
    if (nextTotal > MEMORY_FLUSH_TAIL_MAX_CHARS && chunks.length > 0) {
      break;
    }
    chunks.push(
      nextTotal > MEMORY_FLUSH_TAIL_MAX_CHARS
        ? truncateForMemoryFlush(chunk, MEMORY_FLUSH_TAIL_MAX_CHARS - totalChars)
        : chunk,
    );
    totalChars += Math.min(chunk.length, MEMORY_FLUSH_TAIL_MAX_CHARS - totalChars) + 2;
    if (totalChars >= MEMORY_FLUSH_TAIL_MAX_CHARS) {
      break;
    }
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return chunks.toReversed().join("\n\n");
}

function buildMemoryFlushPrompt(params: {
  basePrompt: string;
  mainSessionFile?: string;
  mainSessionId?: string;
  storePath?: string;
}): string {
  const tail = buildMemoryFlushTranscriptTail({
    sessionFile: params.mainSessionFile,
    sessionId: params.mainSessionId,
    storePath: params.storePath,
  });
  if (!tail) {
    return params.basePrompt;
  }
  return [
    params.basePrompt,
    "Recent transcript tail for memory flush (bounded; use only for extracting durable memory, not for replying to the user):",
    tail,
  ].join("\n\n");
}

function buildMemoryFlushSidecarRun(
  run: FollowupRun["run"],
  flushRunId: string,
): FollowupRun["run"] {
  const sidecarSessionId = `memory-flush-${flushRunId}`;
  const sidecarSessionKey = run.sessionKey ? `${run.sessionKey}:memory-flush` : undefined;
  const sessionDir = path.dirname(run.sessionFile);
  return {
    ...run,
    sessionId: sidecarSessionId,
    ...(sidecarSessionKey ? { sessionKey: sidecarSessionKey } : {}),
    sessionFile: path.join(sessionDir, `${sidecarSessionId}.jsonl`),
  };
}

function parseUsageFromTranscriptLine(line: string): ReturnType<typeof normalizeUsage> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: { usage?: UsageLike };
      usage?: UsageLike;
    };
    const usageRaw = parsed.message?.usage ?? parsed.usage;
    const usage = normalizeUsage(usageRaw);
    if (usage && hasNonzeroUsage(usage)) {
      return usage;
    }
  } catch {
    // ignore bad lines
  }
  return undefined;
}

function resolveSessionLogPath(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): string | undefined {
  if (!sessionId) {
    return undefined;
  }

  try {
    const transcriptPath = (
      sessionEntry as (SessionEntry & { transcriptPath?: string }) | undefined
    )?.transcriptPath?.trim();
    const sessionFile = sessionEntry?.sessionFile?.trim() || transcriptPath;
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const pathOpts = resolveSessionFilePathOptions({
      agentId,
      storePath: opts?.storePath,
    });
    // Normalize sessionFile through resolveSessionFilePath so relative entries
    // are resolved against the sessions dir/store layout, not process.cwd().
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : sessionEntry,
      pathOpts,
    );
  } catch {
    return undefined;
  }
}

function deriveTranscriptUsageSnapshot(
  usage: ReturnType<typeof normalizeUsage> | undefined,
): SessionTranscriptUsageSnapshot | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokens = derivePromptTokens(usage);
  const outputRaw = usage.output;
  const outputTokens =
    typeof outputRaw === "number" && Number.isFinite(outputRaw) && outputRaw > 0
      ? outputRaw
      : undefined;
  if (!(typeof promptTokens === "number") && !(typeof outputTokens === "number")) {
    return undefined;
  }
  return {
    promptTokens,
    outputTokens,
  };
}

type SessionLogSnapshot = {
  byteSize?: number;
  usage?: SessionTranscriptUsageSnapshot;
};

async function appendPostCompactionRefreshPrompt(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
}): Promise<void> {
  const refreshPrompt = await readPostCompactionContext(
    params.followupRun.run.workspaceDir,
    params.cfg,
  );
  if (!refreshPrompt) {
    return;
  }

  const existingPrompt = params.followupRun.run.extraSystemPrompt?.trim();
  if (existingPrompt?.includes(refreshPrompt)) {
    return;
  }

  params.followupRun.run.extraSystemPrompt = [existingPrompt, refreshPrompt]
    .filter(Boolean)
    .join("\n\n");
}

async function readSessionLogSnapshot(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  opts?: { storePath?: string };
  includeByteSize: boolean;
  includeUsage: boolean;
}): Promise<SessionLogSnapshot> {
  const logPath = resolveSessionLogPath(
    params.sessionId,
    params.sessionEntry,
    params.sessionKey,
    params.opts,
  );
  if (!logPath) {
    return {};
  }

  const snapshot: SessionLogSnapshot = {};

  if (params.includeByteSize) {
    try {
      const stat = await fs.promises.stat(logPath);
      const size = Math.floor(stat.size);
      snapshot.byteSize = Number.isFinite(size) && size >= 0 ? size : undefined;
    } catch {
      snapshot.byteSize = undefined;
    }
  }

  if (params.includeUsage) {
    try {
      const lastUsage = await readLastNonzeroUsageFromSessionLog(logPath);
      snapshot.usage = deriveTranscriptUsageSnapshot(lastUsage);
    } catch {
      snapshot.usage = undefined;
    }
  }

  return snapshot;
}

async function readLastNonzeroUsageFromSessionLog(logPath: string) {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const stat = await handle.stat();
    let position = stat.size;
    let leadingPartial = "";
    while (position > 0) {
      const chunkSize = Math.min(TRANSCRIPT_TAIL_CHUNK_BYTES, position);
      const start = position - chunkSize;
      const buffer = Buffer.allocUnsafe(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, start);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.toString("utf-8", 0, bytesRead);
      const combined = `${chunk}${leadingPartial}`;
      const lines = combined.split(/\n+/);
      leadingPartial = lines.shift() ?? "";
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const usage = parseUsageFromTranscriptLine(lines[i] ?? "");
        if (usage) {
          return usage;
        }
      }
      position = start;
    }
    return parseUsageFromTranscriptLine(leadingPartial);
  } finally {
    await handle.close();
  }
}

function estimatePromptTokensFromSessionTranscript(params: {
  sessionId?: string;
  storePath?: string;
  sessionFile?: string;
}): number | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  try {
    const messages = readSessionMessages(
      sessionId,
      params.storePath,
      params.sessionFile,
    ) as AgentMessage[];
    if (messages.length === 0) {
      return undefined;
    }
    const estimatedTokens = estimateMessagesTokens(messages);
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
      return undefined;
    }
    return Math.ceil(estimatedTokens);
  } catch {
    return undefined;
  }
}

export async function readPromptTokensFromSessionLog(
  sessionId?: string,
  sessionEntry?: SessionEntry,
  sessionKey?: string,
  opts?: { storePath?: string },
): Promise<SessionTranscriptUsageSnapshot | undefined> {
  const snapshot = await readSessionLogSnapshot({
    sessionId,
    sessionEntry,
    sessionKey,
    opts,
    includeByteSize: false,
    includeUsage: true,
  });
  return snapshot.usage;
}

export async function runPreflightCompactionIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation: ReplyOperation;
}): Promise<SessionEntry | undefined> {
  if (!params.sessionKey) {
    return params.sessionEntry;
  }

  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry?.sessionId) {
    return entry ?? params.sessionEntry;
  }

  if (params.isHeartbeat) {
    return entry ?? params.sessionEntry;
  }

  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  const reserveTokensFloor =
    memoryFlushPlan?.reserveTokensFloor ??
    params.cfg.agents?.defaults?.compaction?.reserveTokensFloor ??
    20_000;
  const softThresholdTokens = memoryFlushPlan?.softThresholdTokens ?? 4_000;
  const freshPersistedTokens = resolveFreshSessionTotalTokens(entry);
  const persistedTotalTokens = entry.totalTokens;
  const hasPersistedTotalTokens =
    typeof persistedTotalTokens === "number" &&
    Number.isFinite(persistedTotalTokens) &&
    persistedTotalTokens > 0;
  const shouldUseTranscriptFallback = entry.totalTokensFresh === false || !hasPersistedTotalTokens;
  if (!shouldUseTranscriptFallback) {
    return entry ?? params.sessionEntry;
  }
  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const transcriptPromptTokens =
    typeof freshPersistedTokens === "number"
      ? undefined
      : estimatePromptTokensFromSessionTranscript({
          sessionId: entry.sessionId,
          storePath: params.storePath,
          sessionFile: entry.sessionFile ?? params.followupRun.run.sessionFile,
        });
  const projectedTokenCount =
    typeof transcriptPromptTokens === "number"
      ? resolveEffectivePromptTokens(transcriptPromptTokens, undefined, promptTokenEstimate)
      : undefined;
  const tokenCountForCompaction =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  const threshold = contextWindowTokens - reserveTokensFloor - softThresholdTokens;
  logVerbose(
    `preflightCompaction check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${threshold} ` +
      `isHeartbeat=${params.isHeartbeat} ` +
      `persistedFresh=${entry?.totalTokensFresh === true} ` +
      `transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"}`,
  );

  const shouldCompact = shouldRunPreflightCompaction({
    entry,
    tokenCount: tokenCountForCompaction,
    contextWindowTokens,
    reserveTokensFloor,
    softThresholdTokens,
  });
  if (!shouldCompact) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `preflightCompaction triggered: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForCompaction ?? freshPersistedTokens ?? "undefined"} ` +
      `threshold=${threshold}`,
  );

  params.replyOperation.setPhase("preflight_compacting");
  const sessionFile = resolveSessionLogPath(
    entry.sessionId,
    entry.sessionFile ? entry : { ...entry, sessionFile: params.followupRun.run.sessionFile },
    params.sessionKey ?? params.followupRun.run.sessionKey,
    { storePath: params.storePath },
  );
  const result = await compactEmbeddedPiSession({
    sessionId: entry.sessionId,
    sessionKey: params.sessionKey,
    allowGatewaySubagentBinding: true,
    messageChannel: params.followupRun.run.messageProvider,
    groupId: entry.groupId ?? params.followupRun.run.groupId,
    groupChannel: entry.groupChannel ?? params.followupRun.run.groupChannel,
    groupSpace: entry.space ?? params.followupRun.run.groupSpace,
    sessionFile: sessionFile ?? params.followupRun.run.sessionFile,
    workspaceDir: params.followupRun.run.workspaceDir,
    agentDir: params.followupRun.run.agentDir,
    config: params.cfg,
    skillsSnapshot: entry.skillsSnapshot ?? params.followupRun.run.skillsSnapshot,
    provider: params.followupRun.run.provider,
    model: params.followupRun.run.model,
    thinkLevel: params.followupRun.run.thinkLevel,
    bashElevated: params.followupRun.run.bashElevated,
    trigger: "budget",
    currentTokenCount: tokenCountForCompaction,
    senderIsOwner: params.followupRun.run.senderIsOwner,
    ownerNumbers: params.followupRun.run.ownerNumbers,
    abortSignal: params.replyOperation.abortSignal,
  });

  if (!result?.ok || !result.compacted) {
    logVerbose(
      `preflightCompaction skipped: sessionKey=${params.sessionKey} reason=${result?.reason ?? "not_compacted"}`,
    );
    return entry ?? params.sessionEntry;
  }

  await incrementCompactionCount({
    cfg: params.cfg,
    sessionEntry: entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    tokensAfter: result.result?.tokensAfter,
  });
  await appendPostCompactionRefreshPrompt({
    cfg: params.cfg,
    followupRun: params.followupRun,
  });
  entry = params.sessionStore?.[params.sessionKey] ?? entry;
  return entry ?? params.sessionEntry;
}

export async function runMemoryFlushIfNeeded(params: {
  cfg: OpenClawConfig;
  followupRun: FollowupRun;
  promptForEstimate?: string;
  sessionCtx: TemplateContext;
  opts?: GetReplyOptions;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isHeartbeat: boolean;
  replyOperation: ReplyOperation;
}): Promise<SessionEntry | undefined> {
  const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
  if (!memoryFlushPlan) {
    return params.sessionEntry;
  }

  const memoryFlushWritable = (() => {
    if (!params.sessionKey) {
      return true;
    }
    const runtime = resolveSandboxRuntimeStatus({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
    if (!runtime.sandboxed) {
      return true;
    }
    const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, runtime.agentId);
    return sandboxCfg.workspaceAccess === "rw";
  })();

  const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat;
  let entry =
    params.sessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  const contextWindowTokens = resolveMemoryFlushContextWindowTokens({
    modelId: params.followupRun.run.model ?? params.defaultModel,
    agentCfgContextTokens: params.agentCfgContextTokens,
  });

  const promptTokenEstimate = estimatePromptTokensForMemoryFlush(
    params.promptForEstimate ?? params.followupRun.prompt,
  );
  const persistedPromptTokensRaw = entry?.totalTokens;
  const persistedPromptTokens =
    typeof persistedPromptTokensRaw === "number" &&
    Number.isFinite(persistedPromptTokensRaw) &&
    persistedPromptTokensRaw > 0
      ? persistedPromptTokensRaw
      : undefined;
  const hasFreshPersistedPromptTokens =
    typeof persistedPromptTokens === "number" && entry?.totalTokensFresh === true;

  const flushThreshold =
    contextWindowTokens - memoryFlushPlan.reserveTokensFloor - memoryFlushPlan.softThresholdTokens;

  // When totals are stale/unknown, derive prompt + last output from transcript so memory
  // flush can still be evaluated against projected next-input size.
  //
  // When totals are fresh, only read the transcript when we're close enough to the
  // threshold that missing the last output tokens could flip the decision.
  const shouldReadTranscriptForOutput =
    canAttemptFlush &&
    entry &&
    hasFreshPersistedPromptTokens &&
    typeof promptTokenEstimate === "number" &&
    Number.isFinite(promptTokenEstimate) &&
    flushThreshold > 0 &&
    (persistedPromptTokens ?? 0) + promptTokenEstimate >=
      flushThreshold - TRANSCRIPT_OUTPUT_READ_BUFFER_TOKENS;

  const shouldReadTranscript = Boolean(
    canAttemptFlush && entry && (!hasFreshPersistedPromptTokens || shouldReadTranscriptForOutput),
  );

  const forceFlushTranscriptBytes = memoryFlushPlan.forceFlushTranscriptBytes;
  const shouldCheckTranscriptSizeForForcedFlush = Boolean(
    canAttemptFlush &&
    entry &&
    Number.isFinite(forceFlushTranscriptBytes) &&
    forceFlushTranscriptBytes > 0,
  );
  const shouldReadSessionLog = shouldReadTranscript || shouldCheckTranscriptSizeForForcedFlush;
  const sessionLogSnapshot = shouldReadSessionLog
    ? await readSessionLogSnapshot({
        sessionId: params.followupRun.run.sessionId,
        sessionEntry: entry,
        sessionKey: params.sessionKey ?? params.followupRun.run.sessionKey,
        opts: { storePath: params.storePath },
        includeByteSize: shouldCheckTranscriptSizeForForcedFlush,
        includeUsage: shouldReadTranscript,
      })
    : undefined;
  const transcriptByteSize = sessionLogSnapshot?.byteSize;
  const shouldForceFlushByTranscriptSize =
    typeof transcriptByteSize === "number" && transcriptByteSize >= forceFlushTranscriptBytes;

  const transcriptUsageSnapshot = sessionLogSnapshot?.usage;
  const transcriptPromptTokens = transcriptUsageSnapshot?.promptTokens;
  const transcriptOutputTokens = transcriptUsageSnapshot?.outputTokens;
  const hasReliableTranscriptPromptTokens =
    typeof transcriptPromptTokens === "number" &&
    Number.isFinite(transcriptPromptTokens) &&
    transcriptPromptTokens > 0;
  const shouldPersistTranscriptPromptTokens =
    hasReliableTranscriptPromptTokens &&
    (!hasFreshPersistedPromptTokens ||
      (transcriptPromptTokens ?? 0) > (persistedPromptTokens ?? 0));

  if (entry && shouldPersistTranscriptPromptTokens) {
    const nextEntry = {
      ...entry,
      totalTokens: transcriptPromptTokens,
      totalTokensFresh: true,
    };
    entry = nextEntry;
    if (params.sessionKey && params.sessionStore) {
      params.sessionStore[params.sessionKey] = nextEntry;
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({ totalTokens: transcriptPromptTokens, totalTokensFresh: true }),
        });
        if (updatedEntry) {
          entry = updatedEntry;
          if (params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist derived prompt totalTokens: ${String(err)}`);
      }
    }
  }

  const promptTokensSnapshot = Math.max(
    hasFreshPersistedPromptTokens ? (persistedPromptTokens ?? 0) : 0,
    hasReliableTranscriptPromptTokens ? (transcriptPromptTokens ?? 0) : 0,
  );
  const hasFreshPromptTokensSnapshot =
    promptTokensSnapshot > 0 &&
    (hasFreshPersistedPromptTokens || hasReliableTranscriptPromptTokens);

  const projectedTokenCount = hasFreshPromptTokensSnapshot
    ? resolveEffectivePromptTokens(
        promptTokensSnapshot,
        transcriptOutputTokens,
        promptTokenEstimate,
      )
    : undefined;
  const tokenCountForFlush =
    typeof projectedTokenCount === "number" &&
    Number.isFinite(projectedTokenCount) &&
    projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;

  // Diagnostic logging to understand why memory flush may not trigger.
  logVerbose(
    `memoryFlush check: sessionKey=${params.sessionKey} ` +
      `tokenCount=${tokenCountForFlush ?? "undefined"} ` +
      `contextWindow=${contextWindowTokens} threshold=${flushThreshold} ` +
      `isHeartbeat=${params.isHeartbeat} memoryFlushWritable=${memoryFlushWritable} ` +
      `compactionCount=${entry?.compactionCount ?? 0} memoryFlushCompactionCount=${entry?.memoryFlushCompactionCount ?? "undefined"} ` +
      `persistedPromptTokens=${persistedPromptTokens ?? "undefined"} persistedFresh=${entry?.totalTokensFresh === true} ` +
      `promptTokensEst=${promptTokenEstimate ?? "undefined"} transcriptPromptTokens=${transcriptPromptTokens ?? "undefined"} transcriptOutputTokens=${transcriptOutputTokens ?? "undefined"} ` +
      `projectedTokenCount=${projectedTokenCount ?? "undefined"} transcriptBytes=${transcriptByteSize ?? "undefined"} ` +
      `forceFlushTranscriptBytes=${forceFlushTranscriptBytes} forceFlushByTranscriptSize=${shouldForceFlushByTranscriptSize}`,
  );

  const shouldFlushMemory =
    (memoryFlushWritable &&
      !params.isHeartbeat &&
      shouldRunMemoryFlush({
        entry,
        tokenCount: tokenCountForFlush,
        contextWindowTokens,
        reserveTokensFloor: memoryFlushPlan.reserveTokensFloor,
        softThresholdTokens: memoryFlushPlan.softThresholdTokens,
      })) ||
    (shouldForceFlushByTranscriptSize &&
      entry != null &&
      !hasAlreadyFlushedForCurrentCompaction(entry));

  if (!shouldFlushMemory) {
    return entry ?? params.sessionEntry;
  }

  logVerbose(
    `memoryFlush triggered: sessionKey=${params.sessionKey} tokenCount=${tokenCountForFlush ?? "undefined"} threshold=${flushThreshold}`,
  );

  params.replyOperation.setPhase("memory_flushing");
  let activeSessionEntry = entry ?? params.sessionEntry;
  const activeSessionStore = params.sessionStore;
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    activeSessionEntry?.systemPromptReport ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.systemPromptReport : undefined),
  );
  const flushRunId = crypto.randomUUID();
  let memoryCompactionCompleted = false;
  const memoryFlushNowMs = Date.now();
  const activeMemoryFlushPlan =
    resolveMemoryFlushPlan({
      cfg: params.cfg,
      nowMs: memoryFlushNowMs,
    }) ?? memoryFlushPlan;
  const memoryFlushWritePath = activeMemoryFlushPlan.relativePath;
  const flushSystemPrompt = [
    params.followupRun.run.extraSystemPrompt,
    activeMemoryFlushPlan.systemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  const memoryFlushRun = buildMemoryFlushSidecarRun(params.followupRun.run, flushRunId);
  if (memoryFlushRun.sessionKey) {
    registerAgentRunContext(flushRunId, {
      sessionKey: memoryFlushRun.sessionKey,
      verboseLevel: params.resolvedVerboseLevel,
    });
  }
  const memoryFlushPrompt = buildMemoryFlushPrompt({
    basePrompt: activeMemoryFlushPlan.prompt,
    mainSessionFile: params.followupRun.run.sessionFile,
    mainSessionId: params.followupRun.run.sessionId,
    storePath: params.storePath,
  });
  try {
    await runWithModelFallback({
      ...resolveModelFallbackOptions(memoryFlushRun),
      runId: flushRunId,
      run: async (provider, model, runOptions) => {
        const { embeddedContext, senderContext, runBaseParams } = buildEmbeddedRunExecutionParams({
          run: memoryFlushRun,
          sessionCtx: params.sessionCtx,
          hasRepliedRef: params.opts?.hasRepliedRef,
          provider,
          model,
          runId: flushRunId,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
        });
        const result = await runEmbeddedPiAgent({
          ...embeddedContext,
          ...senderContext,
          ...runBaseParams,
          allowGatewaySubagentBinding: true,
          silentExpected: true,
          trigger: "memory",
          memoryFlushWritePath,
          prompt: memoryFlushPrompt,
          extraSystemPrompt: flushSystemPrompt,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature:
            bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
          abortSignal: params.replyOperation.abortSignal,
          replyOperation: params.replyOperation,
          onAgentEvent: (evt) => {
            if (evt.stream === "compaction") {
              const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
              if (phase === "end") {
                memoryCompactionCompleted = true;
              }
            }
          },
        });
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    let memoryFlushCompactionCount =
      activeSessionEntry?.compactionCount ??
      (params.sessionKey ? activeSessionStore?.[params.sessionKey]?.compactionCount : 0) ??
      0;
    if (memoryCompactionCompleted) {
      logVerbose("memoryFlush sidecar compacted its isolated transcript; main session unchanged");
    }
    if (params.storePath && params.sessionKey) {
      try {
        const updatedEntry = await updateSessionStoreEntry({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          update: async () => ({
            memoryFlushAt: Date.now(),
            memoryFlushCompactionCount,
          }),
        });
        if (updatedEntry) {
          activeSessionEntry = updatedEntry;
          params.followupRun.run.sessionId = updatedEntry.sessionId;
          params.replyOperation.updateSessionId(updatedEntry.sessionId);
          if (updatedEntry.sessionFile) {
            params.followupRun.run.sessionFile = updatedEntry.sessionFile;
          }
        }
      } catch (err) {
        logVerbose(`failed to persist memory flush metadata: ${String(err)}`);
      }
    }
  } catch (err) {
    logVerbose(`memory flush run failed: ${String(err)}`);
  }

  return activeSessionEntry;
}
