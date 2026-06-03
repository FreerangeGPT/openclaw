import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import type { AgentMessage, StreamFn } from "./runtime/index.js";

type PayloadLogStage = "request" | "response" | "usage";
type PayloadLogScope = "anthropic" | "provider";

type PayloadLogEvent = {
  ts: string;
  stage: PayloadLogStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  payload?: unknown;
  response?: unknown;
  usage?: Record<string, unknown>;
  error?: string;
  payloadDigest?: string;
  responseDigest?: string;
};

type PayloadLogConfig = {
  enabled: boolean;
  filePath: string;
  includeRequest: boolean;
  includeResponse: boolean;
  includeUsage: boolean;
  scope: PayloadLogScope;
};

type PayloadLogWriter = QueuedFileWriter;

const writers = new Map<string, PayloadLogWriter>();
const log = createSubsystemLogger("agent/provider-payload");

function resolveBooleanOverride(
  cfgValue: boolean | undefined,
  envValue: string | undefined,
  defaultValue: boolean,
): boolean {
  return parseBooleanValue(envValue) ?? cfgValue ?? defaultValue;
}

function resolvePayloadLogConfig(env: NodeJS.ProcessEnv, cfg?: OpenClawConfig): PayloadLogConfig {
  const providerCfg = cfg?.diagnostics?.providerPayloadLog;
  const providerEnabled =
    parseBooleanValue(env.OPENCLAW_PROVIDER_PAYLOAD_LOG) ?? providerCfg?.enabled ?? false;
  if (providerEnabled) {
    const fileOverride =
      env.OPENCLAW_PROVIDER_PAYLOAD_LOG_FILE?.trim() || providerCfg?.filePath?.trim();
    return {
      enabled: true,
      filePath: fileOverride
        ? resolveUserPath(fileOverride)
        : path.join(resolveStateDir(env), "logs", "provider-payload.jsonl"),
      includeRequest: resolveBooleanOverride(
        providerCfg?.includeRequest,
        env.OPENCLAW_PROVIDER_PAYLOAD_LOG_REQUEST,
        true,
      ),
      includeResponse: resolveBooleanOverride(
        providerCfg?.includeResponse,
        env.OPENCLAW_PROVIDER_PAYLOAD_LOG_RESPONSE,
        true,
      ),
      includeUsage: resolveBooleanOverride(
        providerCfg?.includeUsage,
        env.OPENCLAW_PROVIDER_PAYLOAD_LOG_USAGE,
        true,
      ),
      scope: "provider",
    };
  }

  const legacyEnabled = parseBooleanValue(env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG) ?? false;
  const fileOverride = env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE?.trim();
  return {
    enabled: legacyEnabled,
    filePath: fileOverride
      ? resolveUserPath(fileOverride)
      : path.join(resolveStateDir(env), "logs", "anthropic-payload.jsonl"),
    includeRequest: true,
    includeResponse: false,
    includeUsage: true,
    scope: "anthropic",
  };
}

function getWriter(filePath: string): PayloadLogWriter {
  return getQueuedFileWriter(writers, filePath);
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    const redacted = sanitizeDiagnosticPayload(error.message);
    return typeof redacted === "string" ? redacted : error.message;
  }
  if (typeof error === "string") {
    const redacted = sanitizeDiagnosticPayload(error);
    return typeof redacted === "string" ? redacted : error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(sanitizeDiagnosticPayload(error)) ?? "unknown error";
  }
  return undefined;
}

function digest(value: unknown): string | undefined {
  const serialized = safeJsonStringify(value);
  if (!serialized) {
    return undefined;
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function isAnthropicModel(model: Model | undefined | null): boolean {
  return (model as { api?: unknown })?.api === "anthropic-messages";
}

function findLastAssistantUsage(messages: AgentMessage[]): Record<string, unknown> | null {
  const msg = findLastAssistantMessage(messages);
  const usage = (msg as { usage?: unknown } | null)?.usage;
  return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
}

function findLastAssistantMessage(messages: AgentMessage[]): AgentMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i] as { role?: unknown };
    if (msg?.role === "assistant") {
      return messages[i] ?? null;
    }
  }
  return null;
}

type AnthropicPayloadLogger = {
  enabled: true;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
  recordUsage: (messages: AgentMessage[], error?: unknown) => void;
};

export function createAnthropicPayloadLogger(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: PayloadLogWriter;
}): AnthropicPayloadLogger | null {
  const env = params.env ?? process.env;
  const cfg = resolvePayloadLogConfig(env, params.cfg);
  if (!cfg.enabled) {
    return null;
  }

  const writer = params.writer ?? getWriter(cfg.filePath);
  const base: Omit<PayloadLogEvent, "ts" | "stage"> = {
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    workspaceDir: params.workspaceDir,
  };

  const record = (event: PayloadLogEvent) => {
    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const wrapStreamFn: AnthropicPayloadLogger["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      if (cfg.scope === "anthropic" && !isAnthropicModel(model)) {
        return streamFn(model, context, options);
      }
      const nextOnPayload = (payload: unknown) => {
        if (cfg.includeRequest) {
          const redactedPayload = sanitizeDiagnosticPayload(payload);
          record({
            ...base,
            ts: new Date().toISOString(),
            stage: "request",
            payload: redactedPayload,
            payloadDigest: digest(redactedPayload),
          });
        }
        return options?.onPayload?.(payload, model);
      };
      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };
    return wrapped;
  };

  const recordUsage: AnthropicPayloadLogger["recordUsage"] = (messages, error) => {
    const assistantMessage = findLastAssistantMessage(messages);
    const usage = findLastAssistantUsage(messages);
    const errorMessage = formatError(error);
    if (cfg.includeResponse) {
      if (assistantMessage) {
        const response = sanitizeDiagnosticPayload(assistantMessage);
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "response",
          response,
          responseDigest: digest(response),
          error: errorMessage,
        });
      } else if (errorMessage) {
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "response",
          error: errorMessage,
        });
      }
    }
    if (!cfg.includeUsage) {
      return;
    }
    if (!usage) {
      if (errorMessage) {
        record({
          ...base,
          ts: new Date().toISOString(),
          stage: "usage",
          error: errorMessage,
        });
      }
      return;
    }
    const sanitizedUsage = sanitizeDiagnosticPayload(usage) as Record<string, unknown>;
    record({
      ...base,
      ts: new Date().toISOString(),
      stage: "usage",
      usage: sanitizedUsage,
      error: errorMessage,
    });
    log.info("provider usage", {
      runId: params.runId,
      sessionId: params.sessionId,
      usage: sanitizedUsage,
    });
  };

  log.info("provider payload logger enabled", { filePath: writer.filePath, scope: cfg.scope });
  return { enabled: true, wrapStreamFn, recordUsage };
}
