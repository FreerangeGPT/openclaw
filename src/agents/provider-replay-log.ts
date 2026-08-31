/**
 * Opt-in, unredacted provider request/response JSONL capture for offline replay.
 *
 * This artifact intentionally contains the exact model-visible payload. It is
 * disabled by default and must never include transport headers or credentials.
 */
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { redactAgentDiagnosticPayload } from "./diagnostic-redaction.js";
import type { ProviderPromptSnapshot } from "./embedded-agent-runner/provider-prompt-state.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

type ProviderReplayWriter = QueuedFileWriter;

type ProviderReplayBase = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
};

type ProviderReplayRequest = {
  model: Model;
  payload: unknown;
  snapshot: ProviderPromptSnapshot;
};

type ProviderReplayResponse = {
  message?: unknown;
  error?: unknown;
  snapshot: ProviderPromptSnapshot;
};

export type ProviderReplayRecorder = {
  enabled: true;
  recordRequest: (params: ProviderReplayRequest) => void;
  recordResponse: (params: ProviderReplayResponse) => void;
  flush: () => Promise<void>;
};

const writers = new Map<string, ProviderReplayWriter>();
const warnedPaths = new Set<string>();
const log = createSubsystemLogger("agent/provider-replay");

function getWriter(filePath: string): ProviderReplayWriter {
  return getQueuedFileWriter(writers, filePath);
}

function serializeError(error: unknown): unknown {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : error;
  return redactAgentDiagnosticPayload(diagnostic);
}

function serializeMessage(message: unknown): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  if (record.stopReason !== "error" && record.stopReason !== "aborted") {
    return message;
  }
  return {
    ...record,
    ...(record.errorMessage === undefined
      ? {}
      : { errorMessage: redactAgentDiagnosticPayload(record.errorMessage) }),
    ...(record.errorBody === undefined
      ? {}
      : { errorBody: redactAgentDiagnosticPayload(record.errorBody) }),
    ...(record.diagnostics === undefined
      ? {}
      : { diagnostics: redactAgentDiagnosticPayload(record.diagnostics) }),
  };
}

/** Creates an exact provider replay recorder only after explicit operator opt-in. */
export function createProviderReplayRecorder(
  params: ProviderReplayBase & {
    env?: NodeJS.ProcessEnv;
    writer?: ProviderReplayWriter;
  },
): ProviderReplayRecorder | null {
  const env = params.env ?? process.env;
  const enabled = env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG?.trim().toLowerCase() === "raw";
  if (!enabled) {
    return null;
  }
  // Never inherit the redacted Anthropic logger's destination override: that
  // sink may have weaker access or retention policy than this raw artifact.
  const filePath = path.join(resolveStateDir(env), "logs", "provider-replay.jsonl");
  const writer = params.writer ?? getWriter(filePath);
  const base = {
    schema: "openclaw-provider-replay",
    schemaVersion: 1,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  } as const;
  let recordingEnabled = true;
  const disableAfterSinkFailure = (operation: "flush" | "write") => {
    if (!recordingEnabled) {
      return;
    }
    // Replay capture is optional diagnostics. Disable it after a sink failure
    // so logging can never change the foreground provider call's outcome.
    recordingEnabled = false;
    log.warn(`provider replay logging disabled after a ${operation} failure`, {
      filePath: writer.filePath,
    });
  };
  const record = (event: Record<string, unknown>) => {
    if (!recordingEnabled) {
      return;
    }
    try {
      const line = safeJsonStringify(event);
      if (line) {
        writer.write(`${line}\n`);
      }
    } catch {
      disableAfterSinkFailure("write");
    }
  };
  const requestId = (snapshot: ProviderPromptSnapshot) =>
    `${params.runId ?? params.sessionId ?? "provider"}:${snapshot.providerCallSequence}`;

  if (!warnedPaths.has(writer.filePath)) {
    warnedPaths.add(writer.filePath);
    log.warn("FULL provider replay logging enabled; output contains unredacted prompt content", {
      filePath: writer.filePath,
    });
  }
  return {
    enabled: true,
    recordRequest: ({ model, payload, snapshot }) => {
      record({
        ...base,
        ts: new Date().toISOString(),
        stage: "request",
        requestId: requestId(snapshot),
        providerCallSequence: snapshot.providerCallSequence,
        providerCallStartedAt: snapshot.providerCallStartedAt,
        payloadIdentity: snapshot.digest,
        payloadBytes: snapshot.byteWeight,
        cachePrefixIdentity: snapshot.cachePrefixIdentity,
        cacheRequestOptionsIdentity: snapshot.cacheRequestOptionsIdentity,
        cacheTree: snapshot.cacheTree,
        model: {
          id: model.id,
          provider: model.provider,
          api: model.api,
        },
        payload,
      });
    },
    recordResponse: ({ message, error, snapshot }) => {
      record({
        ...base,
        ts: new Date().toISOString(),
        stage: "response",
        requestId: requestId(snapshot),
        providerCallSequence: snapshot.providerCallSequence,
        providerCallStartedAt: snapshot.providerCallStartedAt,
        ...(message === undefined ? {} : { message: serializeMessage(message) }),
        ...(error === undefined ? {} : { error: serializeError(error) }),
      });
    },
    flush: async () => {
      if (!recordingEnabled) {
        return;
      }
      try {
        await writer.flush();
      } catch {
        disableAfterSinkFailure("flush");
      }
    },
  };
}
