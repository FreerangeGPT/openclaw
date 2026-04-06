import { describe, expect, it } from "vitest";
import { prependAssociativeRecallToTelegramUpdate } from "./memory-prepend-telegram.js";

describe("memory prepend Telegram helper", () => {
  it("prepends associative recall to message text", () => {
    const result = prependAssociativeRecallToTelegramUpdate({
      update: {
        update_id: 1,
        message: {
          message_id: 2,
          text: "hello from telegram",
        },
      },
      recallBlock: "[Associative recall]\nremember this",
    });

    expect(result.didInject).toBe(true);
    expect(result.target).toBe("message.text");
    expect(
      ((result.update as { message?: { text?: string } }).message?.text ?? "").startsWith(
        "[Associative recall]\nremember this\n\nhello from telegram",
      ),
    ).toBe(true);
  });

  it("falls back to caption when text is missing", () => {
    const result = prependAssociativeRecallToTelegramUpdate({
      update: {
        update_id: 1,
        message: {
          message_id: 2,
          caption: "photo caption",
        },
      },
      recallBlock: "[Associative recall]\nremember this",
    });

    expect(result.didInject).toBe(true);
    expect(result.target).toBe("message.caption");
    expect(
      ((result.update as { message?: { caption?: string } }).message?.caption ?? "").startsWith(
        "[Associative recall]\nremember this\n\nphoto caption",
      ),
    ).toBe(true);
  });

  it("leaves updates without text-like fields unchanged", () => {
    const update = {
      update_id: 1,
      callback_query: {
        id: "cb",
      },
    };
    const result = prependAssociativeRecallToTelegramUpdate({
      update,
      recallBlock: "[Associative recall]\nremember this",
    });

    expect(result.didInject).toBe(false);
    expect(result.update).toBe(update);
  });
});
