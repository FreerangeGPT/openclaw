import { formatErrorMessage } from "../../../infra/errors.js";
import type { AssistantMessageEventStreamLike } from "../../../llm/types.js";
import type { ProviderReplayRecorder } from "../../provider-replay-log.js";
import { refreshLivePromptCacheEvidence } from "../prompt-cache-evidence.js";
import type { ProviderPromptSnapshot } from "../provider-prompt-state.js";

export function recordProviderPromptCompletion(params: {
  snapshot: ProviderPromptSnapshot;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
  replayRecorder?: ProviderReplayRecorder | null;
  message?: unknown;
  error?: unknown;
}): void {
  const messageRecord =
    params.message && typeof params.message === "object" && !Array.isArray(params.message)
      ? (params.message as Record<string, unknown>)
      : undefined;
  params.recordEvent?.("provider.call.completed", {
    providerCallSequence: params.snapshot.providerCallSequence,
    providerCallStartedAt: params.snapshot.providerCallStartedAt,
    durationMs: Math.max(0, Date.now() - params.snapshot.providerCallStartedAt),
    ...(messageRecord?.usage ? { usage: messageRecord.usage } : {}),
    ...(typeof messageRecord?.stopReason === "string"
      ? { stopReason: messageRecord.stopReason }
      : {}),
    ...(params.error === undefined ? {} : { error: formatErrorMessage(params.error) }),
  });
  params.replayRecorder?.recordResponse({
    snapshot: params.snapshot,
    ...(params.message === undefined ? {} : { message: params.message }),
    ...(params.error === undefined ? {} : { error: params.error }),
  });
}

export function observeProviderPromptStream(params: {
  stream: AssistantMessageEventStreamLike;
  readSnapshot: () => ProviderPromptSnapshot | undefined;
  recordEvent?: (type: string, data?: Record<string, unknown>) => void;
  replayRecorder?: ProviderReplayRecorder | null;
}): AssistantMessageEventStreamLike {
  let settled = false;
  const settle = (message?: unknown, error?: unknown) => {
    if (settled) {
      return;
    }
    const snapshot = params.readSnapshot();
    if (!snapshot) {
      return;
    }
    settled = true;
    recordProviderPromptCompletion({
      snapshot,
      recordEvent: params.recordEvent,
      replayRecorder: params.replayRecorder,
      ...(message === undefined ? {} : { message }),
      ...(error === undefined ? {} : { error }),
    });
  };
  return {
    result: async () => {
      try {
        const message = await params.stream.result();
        settle(message);
        return message;
      } catch (error) {
        settle(undefined, error);
        throw error;
      }
    },
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of params.stream) {
          if (event.type === "done") {
            settle(event.message);
          } else if (event.type === "error") {
            settle(event.error, event.error.errorMessage ?? event.reason);
          }
          yield event;
        }
      } catch (error) {
        settle(undefined, error);
        throw error;
      } finally {
        if (!settled) {
          settle(undefined, new Error("provider stream closed before a terminal event"));
        }
      }
    },
  };
}

export function observeCacheKeeperStream(params: {
  stream: AssistantMessageEventStreamLike;
  evidenceId: string;
  readProviderCallStartedAt: () => number | undefined;
}): AssistantMessageEventStreamLike {
  let refreshAttempted = false;
  const refreshEvidence = (
    usage: Parameters<typeof refreshLivePromptCacheEvidence>[0]["usage"],
  ) => {
    if (refreshAttempted) {
      return;
    }
    const providerCallStartedAt = params.readProviderCallStartedAt();
    if (providerCallStartedAt === undefined) {
      return;
    }
    refreshAttempted = true;
    refreshLivePromptCacheEvidence({
      evidenceId: params.evidenceId,
      timestamp: providerCallStartedAt,
      usage,
    });
  };
  return {
    result: async () => {
      const message = await params.stream.result();
      refreshEvidence(message.usage);
      return message;
    },
    async *[Symbol.asyncIterator]() {
      for await (const event of params.stream) {
        if (event.type === "done") {
          refreshEvidence(event.message.usage);
        }
        yield event;
      }
    },
  };
}
