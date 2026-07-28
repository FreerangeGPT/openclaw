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

  it("shifts text entity offsets by the prepended UTF-16 code-unit length", () => {
    const recallBlock = "[Associative recall]\n🧠 remember this";
    const update = {
      update_id: 1,
      message: {
        message_id: 2,
        text: "/start hello",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    };

    const result = prependAssociativeRecallToTelegramUpdate({ update, recallBlock });
    const message = (result.update as typeof update).message;

    expect(message.entities).toEqual([
      { type: "bot_command", offset: recallBlock.length + 2, length: 6 },
    ]);
    expect(update.message.entities[0]?.offset).toBe(0);
  });

  it("shifts caption entities without mutating the original update", () => {
    const recallBlock = "[Associative recall]\n🧠 caption memory";
    const update = {
      update_id: 1,
      channel_post: {
        message_id: 2,
        caption: "OpenClaw",
        caption_entities: [{ type: "bold", offset: 0, length: 8 }],
      },
    };

    const result = prependAssociativeRecallToTelegramUpdate({ update, recallBlock });
    const channelPost = (result.update as typeof update).channel_post;

    expect(channelPost.caption_entities).toEqual([
      { type: "bold", offset: recallBlock.length + 2, length: 8 },
    ]);
    expect(update.channel_post.caption_entities[0]?.offset).toBe(0);
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
