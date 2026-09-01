import type { AgentMessage } from "../agents/runtime/index.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  publishTranscriptUpdate,
  resolveSessionEntryAccessTarget,
  withTranscriptWriteLock,
} from "../config/sessions/session-accessor.js";
import type { ItemParam } from "./open-responses.schema.js";

export const ROBOT_SPEECH_INTERRUPTION_TYPE = "openclaw.robot_speech_interruption";
export const CLIENT_TOOL_SETTLE_ONLY_METADATA_KEY = "openclaw.client_tool_settle_only";

const MAX_TURN_TEXT_CHARS = 128_000;
const MAX_SPEECH_CALLS = 64;
const ROBOT_SPEECH_TOOL_NAMES = new Set(["robot_speak", "reachy_speak"]);

export type RobotSpeechCallSpan = {
  call_id: string;
  emitted_text: string;
  source_text: string;
  spoken_text: string;
  turn_end: number;
  turn_start: number;
};

export type RobotSpeechInterruptionSettlement = {
  discard_unheard_suffix: true;
  heard_text: string;
  reason: string;
  speech_calls: RobotSpeechCallSpan[];
  status: "interrupted";
  turn_text: string;
  type: typeof ROBOT_SPEECH_INTERRUPTION_TYPE;
  version: 1;
};

type TranscriptMessageEvent = {
  id: string;
  message: AgentMessage;
  type: "message";
};

type AssistantToolCallMessage = AgentMessage & {
  content: unknown[];
  role: "assistant";
};

export type RobotSpeechInterruptionRewritePlan = {
  marker: "[interrupted by user]";
  replacements: Array<{ entryId: string; message: AgentMessage }>;
};

export type RobotSpeechInterruptionSettlementResult = {
  changed: boolean;
  heardChars: number;
  reason?: string;
  rewrittenEntries: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTranscriptMessageEvent(value: unknown): TranscriptMessageEvent | undefined {
  if (!isRecord(value) || value.type !== "message" || typeof value.id !== "string") {
    return undefined;
  }
  const message = value.message;
  if (!isRecord(message) || typeof message.role !== "string") {
    return undefined;
  }
  return value as unknown as TranscriptMessageEvent;
}

function cloneMessage(message: AgentMessage): AgentMessage {
  return structuredClone(message);
}

function parseCallSpan(value: unknown): RobotSpeechCallSpan | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const callId = value.call_id;
  const emittedText = value.emitted_text;
  const sourceText = value.source_text;
  const spokenText = value.spoken_text;
  const turnStart = value.turn_start;
  const turnEnd = value.turn_end;
  if (
    typeof callId !== "string" ||
    callId.length === 0 ||
    typeof emittedText !== "string" ||
    typeof sourceText !== "string" ||
    typeof spokenText !== "string" ||
    typeof turnStart !== "number" ||
    !Number.isSafeInteger(turnStart) ||
    turnStart < 0 ||
    typeof turnEnd !== "number" ||
    !Number.isSafeInteger(turnEnd) ||
    turnEnd < turnStart
  ) {
    return undefined;
  }
  return {
    call_id: callId,
    emitted_text: emittedText,
    source_text: sourceText,
    spoken_text: spokenText,
    turn_end: turnEnd,
    turn_start: turnStart,
  };
}

export function parseRobotSpeechInterruptionSettlement(
  value: unknown,
): RobotSpeechInterruptionSettlement | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.type !== ROBOT_SPEECH_INTERRUPTION_TYPE ||
    value.version !== 1 ||
    value.status !== "interrupted" ||
    value.discard_unheard_suffix !== true ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    typeof value.turn_text !== "string" ||
    value.turn_text.length > MAX_TURN_TEXT_CHARS ||
    typeof value.heard_text !== "string" ||
    !value.turn_text.startsWith(value.heard_text) ||
    !Array.isArray(value.speech_calls) ||
    value.speech_calls.length === 0 ||
    value.speech_calls.length > MAX_SPEECH_CALLS
  ) {
    return undefined;
  }
  const speechCalls = value.speech_calls.map(parseCallSpan);
  if (speechCalls.some((call) => !call)) {
    return undefined;
  }
  const calls = speechCalls as RobotSpeechCallSpan[];
  const callIds = new Set<string>();
  let previousEnd = 0;
  for (const call of calls) {
    if (
      callIds.has(call.call_id) ||
      call.turn_start !== previousEnd ||
      call.turn_end > value.turn_text.length ||
      value.turn_text.slice(call.turn_start, call.turn_end) !== call.emitted_text ||
      !call.emitted_text.endsWith(call.spoken_text) ||
      call.emitted_text.slice(0, call.emitted_text.length - call.spoken_text.length).trim().length >
        0
    ) {
      return undefined;
    }
    callIds.add(call.call_id);
    previousEnd = call.turn_end;
  }
  if (previousEnd !== value.turn_text.length) {
    return undefined;
  }
  return {
    discard_unheard_suffix: true,
    heard_text: value.heard_text,
    reason: value.reason,
    speech_calls: calls,
    status: "interrupted",
    turn_text: value.turn_text,
    type: ROBOT_SPEECH_INTERRUPTION_TYPE,
    version: 1,
  };
}

export function extractRobotSpeechInterruptionSettlement(
  input: string | ItemParam[],
): RobotSpeechInterruptionSettlement | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const candidates = input.flatMap((item) => {
    if (item.type !== "function_call_output" || typeof item.output !== "string") {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(item.output);
      const settlement = parseRobotSpeechInterruptionSettlement(parsed);
      return settlement ? [settlement] : [];
    } catch {
      return [];
    }
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function heardTextForCall(
  settlement: RobotSpeechInterruptionSettlement,
  call: RobotSpeechCallSpan,
): string {
  if (settlement.heard_text.length <= call.turn_start) {
    return "";
  }
  const heardEmitted = settlement.heard_text.slice(
    call.turn_start,
    Math.min(call.turn_end, settlement.heard_text.length),
  );
  const joinPrefix = call.emitted_text.slice(0, call.emitted_text.length - call.spoken_text.length);
  const heardSpoken = heardEmitted.startsWith(joinPrefix)
    ? heardEmitted.slice(joinPrefix.length)
    : heardEmitted;
  if (!call.spoken_text.startsWith(heardSpoken)) {
    throw new Error(`heard_text is not a prefix of robot speech call ${call.call_id}`);
  }
  return heardSpoken;
}

function toolResultText(params: {
  heardText: string;
  interrupted: boolean;
  reason: string;
}): string {
  if (!params.interrupted) {
    return JSON.stringify({ status: "done", speech: "heard", heard_text: params.heardText });
  }
  return JSON.stringify({
    status: "interrupted",
    reason: params.reason,
    heard_text: params.heardText,
    marker: "[interrupted by user]",
  });
}

function isPendingRobotToolResult(
  message: AgentMessage,
  params: { callId: string; toolName: string },
): boolean {
  if (
    message.role !== "toolResult" ||
    message.toolCallId !== params.callId ||
    message.toolName !== params.toolName ||
    message.isError ||
    message.content.length !== 1 ||
    message.content[0]?.type !== "text"
  ) {
    return false;
  }
  try {
    const result: unknown = JSON.parse(message.content[0].text);
    return (
      isRecord(result) &&
      result.status === "pending" &&
      (result.tool === undefined || result.tool === params.toolName)
    );
  } catch {
    return false;
  }
}

function findLatestToolResultEvent(
  transcriptEvents: readonly TranscriptMessageEvent[],
  params: { afterEventIndex: number; callId: string },
): TranscriptMessageEvent | undefined {
  return transcriptEvents.findLast(
    (candidate, index) =>
      index > params.afterEventIndex &&
      candidate.message.role === "toolResult" &&
      candidate.message.toolCallId === params.callId,
  );
}

/**
 * Build an all-or-nothing rewrite of the exact robot_speak calls named by call id.
 *
 * The call id chooses the occurrence. Exact source-text equality plus the full-turn
 * prefix proof prevents a repeated phrase from selecting the wrong historical call.
 */
export function buildRobotSpeechInterruptionRewritePlan(
  events: readonly unknown[],
  settlement: RobotSpeechInterruptionSettlement,
): RobotSpeechInterruptionRewritePlan {
  const transcriptEvents = events
    .map(asTranscriptMessageEvent)
    .filter(Boolean) as TranscriptMessageEvent[];
  const lastUserEventIndex = transcriptEvents.findLastIndex(
    (event) => event.message.role === "user",
  );
  const activeTranscriptEvents = transcriptEvents.slice(lastUserEventIndex + 1);
  const activeRobotCallIds = activeTranscriptEvents.flatMap((event, activeIndex) => {
    if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) {
      return [];
    }
    const eventIndex = lastUserEventIndex + 1 + activeIndex;
    return event.message.content.flatMap((block) => {
      if (
        !isRecord(block) ||
        block.type !== "toolCall" ||
        typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        !ROBOT_SPEECH_TOOL_NAMES.has(block.name)
      ) {
        return [];
      }
      const resultEvent = findLatestToolResultEvent(transcriptEvents, {
        afterEventIndex: eventIndex,
        callId: block.id,
      });
      return resultEvent &&
        isPendingRobotToolResult(resultEvent.message, {
          callId: block.id,
          toolName: block.name,
        })
        ? [block.id]
        : [];
    });
  });
  const settlementCallIds = settlement.speech_calls.map((call) => call.call_id);
  if (
    activeRobotCallIds.length !== settlementCallIds.length ||
    activeRobotCallIds.some((callId, index) => callId !== settlementCallIds[index])
  ) {
    throw new Error("speech settlement does not match the active robot speech call sequence");
  }
  const replacements = new Map<string, AgentMessage>();
  let interruptionMarked = false;

  for (const call of settlement.speech_calls) {
    const matches: Array<{
      blockIndex: number;
      event: TranscriptMessageEvent;
      eventIndex: number;
    }> = [];
    for (const event of activeTranscriptEvents) {
      const eventIndex = transcriptEvents.indexOf(event);
      if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) {
        continue;
      }
      for (const [blockIndex, block] of event.message.content.entries()) {
        if (
          !isRecord(block) ||
          block.type !== "toolCall" ||
          block.id !== call.call_id ||
          typeof block.name !== "string" ||
          !ROBOT_SPEECH_TOOL_NAMES.has(block.name)
        ) {
          continue;
        }
        const args = isRecord(block.arguments)
          ? block.arguments
          : isRecord(block.input)
            ? block.input
            : undefined;
        if (args?.text === call.source_text) {
          matches.push({ blockIndex, event, eventIndex });
        }
      }
    }
    const match = matches.at(-1);
    if (!match) {
      throw new Error(`no matching robot_speak transcript call for ${call.call_id}`);
    }

    const heardText = heardTextForCall(settlement, call);
    const interrupted = heardText.length < call.spoken_text.length;
    const matchedAssistantMessage = match.event.message;
    if (
      matchedAssistantMessage.role !== "assistant" ||
      !Array.isArray(matchedAssistantMessage.content)
    ) {
      throw new Error(`robot_speak transcript call ${call.call_id} has no content array`);
    }
    const matchedBlock = matchedAssistantMessage.content[match.blockIndex];
    if (!isRecord(matchedBlock) || typeof matchedBlock.name !== "string") {
      throw new Error(`robot_speak transcript call ${call.call_id} is malformed`);
    }
    const toolResultEvent = findLatestToolResultEvent(transcriptEvents, {
      afterEventIndex: match.eventIndex,
      callId: call.call_id,
    });
    if (
      !toolResultEvent ||
      !isPendingRobotToolResult(toolResultEvent.message, {
        callId: call.call_id,
        toolName: matchedBlock.name,
      })
    ) {
      throw new Error(`robot_speak transcript call ${call.call_id} has no matching pending result`);
    }
    const assistantMessage = (replacements.get(match.event.id) ??
      cloneMessage(match.event.message)) as AssistantToolCallMessage;
    if (!Array.isArray(assistantMessage.content)) {
      throw new Error(`robot_speak transcript call ${call.call_id} has no content array`);
    }
    const block = assistantMessage.content[match.blockIndex];
    if (!isRecord(block)) {
      throw new Error(`robot_speak transcript call ${call.call_id} is malformed`);
    }
    const nextBlock: Record<string, unknown> = { ...block };
    if (isRecord(block.arguments)) {
      nextBlock.arguments = { ...block.arguments, text: heardText };
    }
    if (isRecord(block.input)) {
      nextBlock.input = { ...block.input, text: heardText };
    }
    assistantMessage.content[match.blockIndex] = nextBlock as never;
    replacements.set(match.event.id, assistantMessage);

    const toolResult =
      replacements.get(toolResultEvent.id) ?? cloneMessage(toolResultEvent.message);
    if (toolResult.role === "toolResult") {
      toolResult.content = [
        {
          type: "text",
          text: toolResultText({
            heardText,
            interrupted,
            reason: settlement.reason,
          }),
        },
      ];
      toolResult.isError = false;
      replacements.set(toolResultEvent.id, toolResult);
    }
    interruptionMarked ||= interrupted;
  }

  if (!interruptionMarked && settlement.heard_text.length < settlement.turn_text.length) {
    throw new Error("interruption settlement did not truncate any robot_speak call");
  }
  return {
    marker: "[interrupted by user]",
    replacements: [...replacements].map(([entryId, message]) => ({ entryId, message })),
  };
}

export async function settleRobotSpeechInterruption(params: {
  agentId: string;
  sessionKey: string;
  settlement: RobotSpeechInterruptionSettlement;
}): Promise<RobotSpeechInterruptionSettlementResult> {
  const cfg = getRuntimeConfig();
  const target = resolveSessionEntryAccessTarget({ cfg, sessionKey: params.sessionKey });
  const sessionId = target.entry?.sessionId;
  if (!sessionId) {
    return {
      changed: false,
      heardChars: params.settlement.heard_text.length,
      reason: "session transcript is unavailable",
      rewrittenEntries: 0,
    };
  }
  if (target.agentId !== params.agentId) {
    return {
      changed: false,
      heardChars: params.settlement.heard_text.length,
      reason: "session agent does not match request agent",
      rewrittenEntries: 0,
    };
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
  const scope = {
    agentId: target.agentId,
    sessionId,
    sessionKey: target.storeKey,
    storePath,
  };
  try {
    let lastRewrittenEntryId: string | undefined;
    const rewrittenEntries = await withTranscriptWriteLock(scope, async (transcript) => {
      const events = await transcript.readEvents();
      const plan = buildRobotSpeechInterruptionRewritePlan(events, params.settlement);
      const replacements = new Map(
        plan.replacements.map((replacement) => [replacement.entryId, replacement.message]),
      );
      let rewritten = 0;
      const nextEvents = events.map((event) => {
        const transcriptEvent = asTranscriptMessageEvent(event);
        const replacement = transcriptEvent ? replacements.get(transcriptEvent.id) : undefined;
        if (!transcriptEvent || !replacement) {
          return event;
        }
        rewritten += 1;
        lastRewrittenEntryId = transcriptEvent.id;
        return Object.assign({}, event as Record<string, unknown>, {
          message: replacement,
        });
      });
      if (rewritten !== replacements.size) {
        throw new Error("robot speech transcript changed before settlement");
      }
      await transcript.replaceEvents(nextEvents);
      return rewritten;
    });
    await publishTranscriptUpdate(scope, {
      agentId: scope.agentId,
      ...(lastRewrittenEntryId ? { messageId: lastRewrittenEntryId } : {}),
      sessionKey: scope.sessionKey,
      target: {
        agentId: scope.agentId,
        sessionId: scope.sessionId,
        sessionKey: scope.sessionKey,
      },
    });
    return {
      changed: rewrittenEntries > 0,
      heardChars: params.settlement.heard_text.length,
      rewrittenEntries,
    };
  } catch (error) {
    return {
      changed: false,
      heardChars: params.settlement.heard_text.length,
      reason: error instanceof Error ? error.message : String(error),
      rewrittenEntries: 0,
    };
  }
}
