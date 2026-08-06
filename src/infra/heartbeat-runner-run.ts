import {
  invalidateLivePromptCacheEvidence,
  isMainSessionCacheKeeperIdentityMismatchError,
  readMainSessionCacheKeeperMismatch,
  type MainSessionCacheKeeperMismatchReason,
} from "../agents/embedded-agent-runner/prompt-cache-evidence.js";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import { markCommitmentsAttempted } from "../commitments/store.js";
import { formatErrorMessage } from "./errors.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import {
  isHeartbeatTypingEnabled,
  heartbeatLog,
  resolveHeartbeatAckMaxChars,
  resolveHeartbeatChannelPlugin,
  resolveHeartbeatTypingIntervalSeconds,
} from "./heartbeat-runner-config.js";
import {
  classifyHeartbeatAgentOutcome,
  finalizeHeartbeatOutcome,
} from "./heartbeat-runner-delivery.js";
import {
  invokeHeartbeatAgentRun,
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "./heartbeat-runner-execution.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import { HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT, type HeartbeatRunResult } from "./heartbeat-wake.js";
import { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";

const log = heartbeatLog;

function failClosedOnHeartbeatCacheMismatch(params: {
  accountId?: string;
  agentId: string;
  cacheEvidenceId?: string;
  channel?: string;
  details?: Record<string, unknown>;
  durationMs: number;
  reason: MainSessionCacheKeeperMismatchReason;
  replaySafe?: boolean;
  sessionKey: string;
}): HeartbeatRunResult {
  const failureReason = `main-session-heartbeat-${params.reason}`;
  const details = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    reason: params.reason,
    ...(params.replaySafe !== undefined ? { replaySafe: params.replaySafe } : {}),
    ...(params.cacheEvidenceId ? { cacheEvidenceId: params.cacheEvidenceId } : {}),
    ...params.details,
  };
  log.error(`!!!!! FAILING CLOSED ON HEARTBEAT MISMATCH: ${params.reason}`, details);
  emitHeartbeatEvent({
    status: "failed",
    reason: failureReason,
    durationMs: params.durationMs,
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
    indicatorType: resolveIndicatorType("failed"),
  });
  return { status: "failed", reason: failureReason };
}

export async function runHeartbeatOnce(opts: HeartbeatRunOptions): Promise<HeartbeatRunResult> {
  const wake = await resolveHeartbeatWakeStage(opts);
  if (wake.kind === "skipped") {
    return { status: "skipped", reason: wake.reason };
  }
  const prepared = await prepareHeartbeatRunStage(wake);
  if (prepared.kind === "skipped") {
    return { status: "skipped", reason: prepared.reason };
  }
  if (prepared.kind === "failed") {
    return failClosedOnHeartbeatCacheMismatch({
      agentId: wake.agentId,
      sessionKey: wake.preflight.session.sessionKey,
      reason: prepared.reason,
      details: prepared.details,
      durationMs: Date.now() - wake.startedAt,
    });
  }
  const { cfg, agentId, heartbeat, startedAt } = wake;
  const { delivery, visibility, replyPrefix, runSessionKey } = prepared;
  const { outboundPolicySessionKey, hasRelayableExecCompletion } = prepared;
  const { hasDueCommitments, dueCommitmentIds } = prepared;

  if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "alerts-disabled",
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
    });
    return { status: "skipped", reason: "alerts-disabled" };
  }
  await markCommitmentsAttempted({ cfg, ids: dueCommitmentIds, nowMs: startedAt });

  const resolveHeartbeatResponsePrefix = () =>
    resolveResponsePrefixTemplate(
      replyPrefix.responsePrefix,
      replyPrefix.responsePrefixContextProvider(),
    );
  const resolveHeartbeatOkText = () => {
    const responsePrefix = resolveHeartbeatResponsePrefix();
    return responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
  };
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId,
    sessionKey: runSessionKey,
    policySessionKey: outboundPolicySessionKey,
  });
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, agentId);
  const canAttemptHeartbeatOk = Boolean(
    !hasDueCommitments && visibility.showOk && delivery.channel !== "none" && delivery.to,
  );
  const hasChatDelivery = Boolean(
    delivery.channel !== "none" && delivery.to && (visibility.showAlerts || visibility.showOk),
  );
  const heartbeatTypingIntervalSeconds = resolveHeartbeatTypingIntervalSeconds(cfg);
  const heartbeatChannelPlugin =
    delivery.channel !== "none" ? resolveHeartbeatChannelPlugin(delivery.channel) : undefined;
  const heartbeatTyping =
    delivery.channel !== "none" &&
    isHeartbeatTypingEnabled({
      cfg,
      agentId,
      hasChatDelivery,
    })
      ? createHeartbeatTypingCallbacks({
          cfg,
          target: {
            channel: delivery.channel,
            ...(delivery.to !== undefined ? { to: delivery.to } : {}),
            ...(delivery.accountId !== undefined ? { accountId: delivery.accountId } : {}),
            ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
          },
          ...(heartbeatChannelPlugin ? { plugin: heartbeatChannelPlugin } : {}),
          ...(opts.deps ? { deps: opts.deps } : {}),
          ...(heartbeatTypingIntervalSeconds !== undefined
            ? { typingIntervalSeconds: heartbeatTypingIntervalSeconds }
            : {}),
          log,
        })
      : undefined;
  const maybeSendHeartbeatOk = async () => {
    if (!canAttemptHeartbeatOk || delivery.channel === "none" || !delivery.to) {
      return false;
    }
    try {
      const heartbeatPlugin = resolveHeartbeatChannelPlugin(delivery.channel);
      if (heartbeatPlugin?.heartbeat?.checkReady) {
        const readiness = await heartbeatPlugin.heartbeat.checkReady({
          cfg,
          accountId: delivery.accountId,
          deps: opts.deps,
        });
        if (!readiness.ok) {
          return false;
        }
      }
      const send = await sendDurableMessageBatch({
        cfg,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
        payloads: [{ text: resolveHeartbeatOkText() }],
        session: outboundSession,
        identity: outboundIdentity,
        deps: opts.deps,
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      return true;
    } catch (err) {
      log.warn(`heartbeat: HEARTBEAT_OK delivery failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  try {
    await heartbeatTyping?.onReplyStart();
    const agentRun = await invokeHeartbeatAgentRun(opts, wake, prepared);
    if (agentRun.kind === "busy") {
      emitHeartbeatEvent({
        status: "skipped",
        reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT };
    }
    const outcome = classifyHeartbeatAgentOutcome({
      agentRun,
      hasRelayableExecCompletion,
      responsePrefix: resolveHeartbeatResponsePrefix(),
      ackMaxChars: resolveHeartbeatAckMaxChars(cfg, heartbeat),
    });
    return await finalizeHeartbeatOutcome({
      opts,
      wake,
      prepared,
      outcome,
      maybeSendHeartbeatOk,
      outboundSession,
      outboundIdentity,
    });
  } catch (err) {
    const cacheEvidenceId = (
      prepared.cacheKeeperReplyOptions as { heartbeatPromptCacheEvidenceId?: string }
    ).heartbeatPromptCacheEvidenceId;
    if (cacheEvidenceId && isMainSessionCacheKeeperIdentityMismatchError(err)) {
      invalidateLivePromptCacheEvidence(cacheEvidenceId);
      const mismatch = readMainSessionCacheKeeperMismatch(err);
      if (mismatch) {
        return failClosedOnHeartbeatCacheMismatch({
          agentId,
          sessionKey: runSessionKey,
          reason: mismatch.reason,
          replaySafe: mismatch.replaySafe,
          cacheEvidenceId,
          durationMs: Date.now() - startedAt,
          ...(delivery.channel !== "none" ? { channel: delivery.channel } : {}),
          ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
        });
      }
    }
    const reason = formatErrorMessage(err);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  } finally {
    heartbeatTyping?.onCleanup?.();
  }
}
