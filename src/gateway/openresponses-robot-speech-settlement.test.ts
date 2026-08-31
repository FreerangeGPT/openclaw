import { describe, expect, it } from "vitest";
import {
  buildRobotSpeechInterruptionRewritePlan,
  parseRobotSpeechInterruptionSettlement,
  type RobotSpeechInterruptionSettlement,
} from "./openresponses-robot-speech-settlement.js";

function assistantCall(entryId: string, callId: string, text: string) {
  return {
    id: entryId,
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: callId,
          name: "robot_speak",
          arguments: { text },
        },
      ],
    },
  };
}

function userMessage(entryId: string, text = "Speak to me.") {
  return {
    id: entryId,
    type: "message",
    message: { role: "user", content: text },
  };
}

function pendingResult(entryId: string, callId: string, toolName = "robot_speak") {
  return {
    id: entryId,
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: [{ type: "text", text: JSON.stringify({ status: "pending", tool: toolName }) }],
      isError: false,
    },
  };
}

function minimalPendingResult(entryId: string, callId: string) {
  const result = pendingResult(entryId, callId);
  return {
    ...result,
    message: {
      ...result.message,
      content: [{ type: "text", text: JSON.stringify({ status: "pending" }) }],
    },
  };
}

function settlement(
  overrides: Partial<RobotSpeechInterruptionSettlement> = {},
): RobotSpeechInterruptionSettlement {
  return {
    type: "openclaw.robot_speech_interruption",
    version: 1,
    status: "interrupted",
    discard_unheard_suffix: true,
    reason: "user_barged_in",
    turn_text: "Please wait. Please listen carefully.",
    heard_text: "Please wait. Please lis",
    speech_calls: [
      {
        call_id: "call-first",
        source_text: "Please wait.",
        spoken_text: "Please wait.",
        emitted_text: "Please wait.",
        turn_start: 0,
        turn_end: 12,
      },
      {
        call_id: "call-second",
        source_text: "Please listen carefully.",
        spoken_text: "Please listen carefully.",
        emitted_text: " Please listen carefully.",
        turn_start: 12,
        turn_end: 37,
      },
    ],
    ...overrides,
  };
}

function singleCallSettlement(): RobotSpeechInterruptionSettlement {
  return settlement({
    turn_text: "Please listen carefully.",
    heard_text: "Please lis",
    speech_calls: [
      {
        call_id: "call-second",
        source_text: "Please listen carefully.",
        spoken_text: "Please listen carefully.",
        emitted_text: "Please listen carefully.",
        turn_start: 0,
        turn_end: 24,
      },
    ],
  });
}

describe("robot speech interruption settlement", () => {
  it("requires heard_text to be the exact full-turn prefix", () => {
    expect(
      parseRobotSpeechInterruptionSettlement({
        ...settlement(),
        heard_text: "Please listen",
      }),
    ).toBeUndefined();
    expect(parseRobotSpeechInterruptionSettlement(settlement())).toBeDefined();
  });

  it("requires speech spans to cover the full turn without gaps", () => {
    const withGap = settlement();
    withGap.speech_calls[1] = { ...withGap.speech_calls[1]!, turn_start: 13 };
    expect(parseRobotSpeechInterruptionSettlement(withGap)).toBeUndefined();

    const missingSuffix = settlement({
      turn_text: "Please wait. Please listen carefully. Unaccounted",
    });
    expect(parseRobotSpeechInterruptionSettlement(missingSuffix)).toBeUndefined();
  });

  it("uses call ids plus exact source text when phrases repeat", () => {
    const events = [
      assistantCall("assistant-old", "call-old", "Please listen carefully."),
      pendingResult("result-old", "call-old"),
      userMessage("user-current"),
      assistantCall("assistant-first", "call-first", "Please wait."),
      pendingResult("result-first", "call-first"),
      assistantCall("assistant-second", "call-second", "Please listen carefully."),
      pendingResult("result-second", "call-second"),
    ];

    const plan = buildRobotSpeechInterruptionRewritePlan(events, settlement());
    const replacements = new Map(plan.replacements.map((item) => [item.entryId, item.message]));

    expect(replacements.has("assistant-old")).toBe(false);
    const first = replacements.get("assistant-first") as unknown as {
      content: Array<{ arguments: { text: string } }>;
    };
    expect(first.content[0]?.arguments.text).toBe("Please wait.");
    const second = replacements.get("assistant-second") as unknown as {
      content: Array<{ arguments: { text: string } }>;
    };
    expect(second.content[0]?.arguments.text).toBe("Please lis");
    const secondResult = replacements.get("result-second") as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(secondResult.content[0]?.text ?? "{}")).toMatchObject({
      status: "interrupted",
      heard_text: "Please lis",
      marker: "[interrupted by user]",
    });
  });

  it("rejects a call id whose stored source text does not match", () => {
    const events = [
      userMessage("user-current"),
      assistantCall("assistant-first", "call-first", "Different text."),
      pendingResult("result-first", "call-first"),
      assistantCall("assistant-second", "call-second", "Please listen carefully."),
      pendingResult("result-second", "call-second"),
    ];
    expect(() => buildRobotSpeechInterruptionRewritePlan(events, settlement())).toThrow(
      "no matching robot_speak transcript call for call-first",
    );
  });

  it("requires every active robot call and its matching pending result", () => {
    const baseEvents = [
      userMessage("user-current"),
      assistantCall("assistant-first", "call-first", "Please wait."),
      pendingResult("result-first", "call-first"),
      assistantCall("assistant-second", "call-second", "Please listen carefully."),
      pendingResult("result-second", "call-second"),
    ];

    expect(() =>
      buildRobotSpeechInterruptionRewritePlan(baseEvents.slice(0, -1), settlement()),
    ).toThrow("speech settlement does not match the active robot speech call sequence");

    const wrongToolResult = structuredClone(baseEvents);
    wrongToolResult[4] = pendingResult("result-second", "call-second", "reachy_speak");
    expect(() => buildRobotSpeechInterruptionRewritePlan(wrongToolResult, settlement())).toThrow(
      "speech settlement does not match the active robot speech call sequence",
    );

    const completedToolResult = structuredClone(baseEvents);
    const completedResult = pendingResult("result-second", "call-second");
    completedToolResult[4] = {
      ...completedResult,
      message: {
        ...completedResult.message,
        content: [{ type: "text", text: JSON.stringify({ status: "done", tool: "robot_speak" }) }],
      },
    };
    expect(() =>
      buildRobotSpeechInterruptionRewritePlan(completedToolResult, settlement()),
    ).toThrow("speech settlement does not match the active robot speech call sequence");

    expect(() =>
      buildRobotSpeechInterruptionRewritePlan(
        [
          userMessage("user-current"),
          assistantCall("assistant-first", "call-first", "Please wait."),
          minimalPendingResult("result-first", "call-first"),
          assistantCall("assistant-second", "call-second", "Please listen carefully."),
          minimalPendingResult("result-second", "call-second"),
        ],
        settlement(),
      ),
    ).not.toThrow();

    const omittedCallSettlement = settlement({
      speech_calls: settlement().speech_calls.slice(0, 1),
    });
    expect(() =>
      buildRobotSpeechInterruptionRewritePlan(baseEvents, omittedCallSettlement),
    ).toThrow("speech settlement does not match the active robot speech call sequence");
  });

  it("settles only pending speech calls after finalized calls in the same user turn", () => {
    const completedFirst = pendingResult("result-first", "call-first");
    completedFirst.message.content = [
      { type: "text", text: JSON.stringify({ status: "done", tool: "robot_speak" }) },
    ];
    const events = [
      userMessage("user-current"),
      assistantCall("assistant-first", "call-first", "Please wait."),
      completedFirst,
      assistantCall("assistant-second", "call-second", "Please listen carefully."),
      pendingResult("result-second", "call-second"),
    ];

    const plan = buildRobotSpeechInterruptionRewritePlan(events, singleCallSettlement());
    expect(plan.replacements.map((replacement) => replacement.entryId)).toEqual([
      "assistant-second",
      "result-second",
    ]);
  });

  it("rejects stale speech calls from before the current user turn", () => {
    const events = [
      assistantCall("assistant-first", "call-first", "Please wait."),
      pendingResult("result-first", "call-first"),
      assistantCall("assistant-second", "call-second", "Please listen carefully."),
      pendingResult("result-second", "call-second"),
      userMessage("user-later", "New request."),
    ];

    expect(() => buildRobotSpeechInterruptionRewritePlan(events, settlement())).toThrow(
      "speech settlement does not match the active robot speech call sequence",
    );
  });
});
