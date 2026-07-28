import { resolveHeartbeatTerminalToolFailure } from "../auto-reply/heartbeat-reply-payload.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { formatErrorMessage } from "./errors.js";
import { heartbeatLog } from "./heartbeat-runner-config.js";
import {
  prepareMemoryPrependQueueDrain,
  prependAssociativeRecallBlockToText,
  type PreparedMemoryPrependQueueDrain,
} from "./memory-prepend-queue.js";

const log = heartbeatLog;

async function prepareHeartbeatMemoryPrepend(
  agentId: string,
): Promise<PreparedMemoryPrependQueueDrain> {
  return await prepareMemoryPrependQueueDrain({ agentId });
}

async function releaseHeartbeatMemoryPrepend(
  prepared: PreparedMemoryPrependQueueDrain,
): Promise<void> {
  try {
    const result = await prepared.release();
    if (!result.applied && result.reason !== "noop" && result.reason !== "already_finalized") {
      log.warn("heartbeat: memory prepend queue release skipped", {
        reason: result.reason,
        path: prepared.databasePath,
      });
    }
  } catch (error) {
    log.warn("heartbeat: memory prepend queue release failed", {
      error: formatErrorMessage(error),
      path: prepared.databasePath,
    });
  }
}

function hasHeartbeatReplyError(replyResult: ReplyPayload | ReplyPayload[] | undefined): boolean {
  const payloads = Array.isArray(replyResult) ? replyResult : [replyResult];
  return payloads.some((payload) => payload?.isError === true);
}

async function finalizeHeartbeatMemoryPrepend(params: {
  prepared: PreparedMemoryPrependQueueDrain;
  replyResult: ReplyPayload | ReplyPayload[] | undefined;
  admissionSkipped: boolean;
}): Promise<void> {
  if (!params.prepared.block) {
    return;
  }
  const succeeded =
    !params.admissionSkipped &&
    !resolveHeartbeatTerminalToolFailure(params.replyResult) &&
    !hasHeartbeatReplyError(params.replyResult);
  if (!succeeded) {
    await releaseHeartbeatMemoryPrepend(params.prepared);
    return;
  }
  try {
    const result = await params.prepared.commit();
    if (!result.applied && result.reason !== "noop" && result.reason !== "already_finalized") {
      log.warn("heartbeat: memory prepend queue commit skipped", {
        reason: result.reason,
        path: params.prepared.databasePath,
      });
    }
  } catch (error) {
    log.warn("heartbeat: memory prepend queue commit failed", {
      error: formatErrorMessage(error),
      path: params.prepared.databasePath,
    });
  }
}

export async function invokeHeartbeatWithMemoryPrepend<
  T extends ReplyPayload | ReplyPayload[] | undefined,
>(params: {
  agentId: string;
  enabled: boolean;
  prompt: string;
  invoke: (promptWithMemoryPrepend: string) => Promise<T>;
  admissionSkipped: () => boolean;
}): Promise<T> {
  if (!params.enabled) {
    return await params.invoke(params.prompt);
  }
  const prepared = await prepareHeartbeatMemoryPrepend(params.agentId);
  const promptWithMemoryPrepend = prependAssociativeRecallBlockToText({
    body: params.prompt,
    recallBlock: prepared.block,
  });
  let replyResult: T;
  try {
    replyResult = await params.invoke(promptWithMemoryPrepend);
  } catch (error) {
    await releaseHeartbeatMemoryPrepend(prepared);
    throw error;
  }
  await finalizeHeartbeatMemoryPrepend({
    prepared,
    replyResult,
    admissionSkipped: params.admissionSkipped(),
  });
  return replyResult;
}
