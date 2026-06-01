import crypto from "node:crypto";
import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";

type PayloadLogStage = "request" | "response" | "usage";

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
  scope: "all" | "anthropic";
};

type PayloadLogWriter = QueuedFileWriter;

const writers = new Map<string, PayloadLogWriter>();
const log = createSubsystemLogger("agent/anthropic-payload");

function resolveOptionalBoolean(value: string | undefined, fallback: boolean | undefined) {
  return parseBooleanValue(value) ?? fallback;
}

function resolvePayloadLogConfig(params: {
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): PayloadLogConfig {
  const providerConfig = params.cfg?.diagnostics?.providerPayloadLog;
  const providerEnabled =
    parseBooleanValue(params.env.OPENCLAW_PROVIDER_PAYLOAD_LOG) ??
    providerConfig?.enabled ??
    false;
  const legacyAnthropicEnabled =
    parseBooleanValue(params.env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG) ?? false;
  const enabled = providerEnabled || legacyAnthropicEnabled;
  const scope = providerEnabled ? "all" : "anthropic";
  const providerFileOverride =
    params.env.OPENCLAW_PROVIDER_PAYLOAD_LOG_FILE?.trim() || providerConfig?.filePath?.trim();
  const legacyFileOverride = params.env.OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE?.trim();
  const fileOverride = providerEnabled ? providerFileOverride : legacyFileOverride;
  const fileName = providerEnabled ? "provider-payload.jsonl" : "anthropic-payload.jsonl";
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(params.env), "logs", fileName);

  return {
    enabled,
    filePath,
    includeRequest:
      resolveOptionalBoolean(
        params.env.OPENCLAW_PROVIDER_PAYLOAD_LOG_REQUEST,
        providerConfig?.includeRequest,
      ) ?? true,
    includeResponse:
      resolveOptionalBoolean(
        params.env.OPENCLAW_PROVIDER_PAYLOAD_LOG_RESPONSE,
        providerConfig?.includeResponse,
      ) ?? true,
    includeUsage:
      resolveOptionalBoolean(
        params.env.OPENCLAW_PROVIDER_PAYLOAD_LOG_USAGE,
        providerConfig?.includeUsage,
      ) ?? true,
    scope,
  };
}

function getWriter(filePath: string): PayloadLogWriter {
  return getQueuedFileWriter(writers, filePath);
}

function formatError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error) ?? "unknown error";
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

function isAnthropicModel(model: Model<Api> | undefined | null): boolean {
  return (model as { api?: unknown })?.api === "anthropic-messages";
}

function shouldLogModel(model: Model<Api> | undefined | null, scope: PayloadLogConfig["scope"]) {
  return scope === "all" || isAnthropicModel(model);
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

function findAssistantUsage(message: AgentMessage | null): Record<string, unknown> | null {
  const usage = (message as { usage?: unknown } | null)?.usage;
  return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
}

export type AnthropicPayloadLogger = {
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
  const cfg = resolvePayloadLogConfig({ cfg: params.cfg, env });
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
      if (!shouldLogModel(model, cfg.scope)) {
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
    const usage = findAssistantUsage(assistantMessage);
    const errorMessage = formatError(error);
    if (assistantMessage && cfg.includeResponse) {
      const response = sanitizeDiagnosticPayload(assistantMessage);
      record({
        ...base,
        ts: new Date().toISOString(),
        stage: "response",
        response,
        responseDigest: digest(response),
        error: errorMessage,
      });
    } else if (errorMessage && cfg.includeResponse) {
      record({
        ...base,
        ts: new Date().toISOString(),
        stage: "response",
        error: errorMessage,
      });
    }
    if (cfg.includeUsage) {
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
      record({
        ...base,
        ts: new Date().toISOString(),
        stage: "usage",
        usage,
        error: errorMessage,
      });
      log.info("provider usage", {
        runId: params.runId,
        sessionId: params.sessionId,
        usage,
      });
    }
  };

  log.info("provider payload logger enabled", { filePath: writer.filePath, scope: cfg.scope });
  return { enabled: true, wrapStreamFn, recordUsage };
}
