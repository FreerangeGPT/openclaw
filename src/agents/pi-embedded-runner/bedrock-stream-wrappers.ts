import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";

const AWS_MAX_ATTEMPTS_ENV = "AWS_MAX_ATTEMPTS";
let bedrockSingleAttemptDepth = 0;
type BedrockCacheRetention = "none" | "short" | "long";
type BedrockPayload = {
  system?: unknown;
  messages?: unknown;
};

function buildBedrockCachePoint(cacheRetention: BedrockCacheRetention): {
  cachePoint: { type: "default"; ttl?: "1h" };
} {
  return {
    cachePoint: {
      type: "default",
      ...(cacheRetention === "long" ? { ttl: "1h" as const } : {}),
    },
  };
}

function hasBedrockCachePoint(blocks: unknown[]): boolean {
  return blocks.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return "cachePoint" in block;
  });
}

export function appendExplicitBedrockCachePoints(
  payload: unknown,
  cacheRetention: BedrockCacheRetention | undefined,
): unknown {
  if (
    cacheRetention === undefined ||
    cacheRetention === "none" ||
    !payload ||
    typeof payload !== "object"
  ) {
    return payload;
  }

  const record = payload as BedrockPayload;
  if (
    Array.isArray(record.system) &&
    record.system.length > 0 &&
    !hasBedrockCachePoint(record.system)
  ) {
    record.system.push(buildBedrockCachePoint(cacheRetention));
  }

  const messages = Array.isArray(record.messages) ? record.messages : [];
  const lastUserMessage = messages
    .slice()
    .toReversed()
    .find((message): message is { role?: unknown; content?: unknown } => {
      if (!message || typeof message !== "object") {
        return false;
      }
      return String((message as { role?: unknown }).role ?? "").toLowerCase() === "user";
    });
  if (
    lastUserMessage &&
    Array.isArray(lastUserMessage.content) &&
    !hasBedrockCachePoint(lastUserMessage.content)
  ) {
    lastUserMessage.content.push(buildBedrockCachePoint(cacheRetention));
  }

  return payload;
}

function acquireBedrockSingleAttemptEnv(): (() => void) | undefined {
  if (typeof process === "undefined" || process.env[AWS_MAX_ATTEMPTS_ENV]) {
    return undefined;
  }
  bedrockSingleAttemptDepth += 1;
  process.env[AWS_MAX_ATTEMPTS_ENV] = "1";
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    bedrockSingleAttemptDepth = Math.max(0, bedrockSingleAttemptDepth - 1);
    if (bedrockSingleAttemptDepth === 0) {
      delete process.env[AWS_MAX_ATTEMPTS_ENV];
    }
  };
}

function releaseAfterStreamResult<T>(stream: T, release: () => void): T {
  if (
    !stream ||
    typeof stream !== "object" ||
    typeof (stream as { result?: unknown }).result !== "function"
  ) {
    release();
    return stream;
  }

  const streamRecord = stream as T & { result: (...args: unknown[]) => Promise<unknown> };
  const result = streamRecord.result;
  streamRecord.result = async (...args: unknown[]) => {
    try {
      return await result.apply(stream, args);
    } finally {
      release();
    }
  };
  return stream;
}

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const shouldPreserveCache =
      options?.cacheRetention !== undefined || process.env.AWS_BEDROCK_FORCE_CACHE === "1";
    const cacheRetention =
      options?.cacheRetention === "none" ||
      options?.cacheRetention === "short" ||
      options?.cacheRetention === "long"
        ? options.cacheRetention
        : process.env.AWS_BEDROCK_FORCE_CACHE === "1"
          ? "short"
          : undefined;
    const onPayload =
      cacheRetention && cacheRetention !== "none"
        ? async (payload: unknown, payloadModel: unknown) => {
            const nextPayload = await options?.onPayload?.(payload, payloadModel as never);
            return appendExplicitBedrockCachePoints(nextPayload ?? payload, cacheRetention);
          }
        : options?.onPayload;
    const releaseSingleAttemptEnv = acquireBedrockSingleAttemptEnv();
    try {
      const stream = underlying(model, context, {
        ...options,
        ...(onPayload ? { onPayload } : {}),
        ...(shouldPreserveCache ? {} : { cacheRetention: "none" }),
      });
      return releaseSingleAttemptEnv
        ? releaseAfterStreamResult(stream, releaseSingleAttemptEnv)
        : stream;
    } catch (error) {
      releaseSingleAttemptEnv?.();
      throw error;
    }
  };
}

export { isAnthropicBedrockModel };
