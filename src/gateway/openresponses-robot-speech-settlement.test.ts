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

function pendingResult(entryId: string, callId: string) {
  return {
    id: entryId,
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "robot_speak",
      content: [{ type: "text", text: '{"status":"pending"}' }],
      isError: false,
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

  it("uses call ids plus exact source text when phrases repeat", () => {
    const events = [
      assistantCall("assistant-old", "call-old", "Please listen carefully."),
      pendingResult("result-old", "call-old"),
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
      assistantCall("assistant-first", "call-first", "Different text."),
      pendingResult("result-first", "call-first"),
      assistantCall("assistant-second", "call-second", "Please listen carefully."),
      pendingResult("result-second", "call-second"),
    ];
    expect(() => buildRobotSpeechInterruptionRewritePlan(events, settlement())).toThrow(
      "no matching robot_speak transcript call for call-first",
    );
  });
});
