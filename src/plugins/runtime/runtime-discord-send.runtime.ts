import { editChannelDiscord } from "../../plugin-sdk/discord-runtime-send.js";
import { sendDiscordComponentMessage } from "../../plugin-sdk/discord-runtime-send.js";
import {
  createThreadDiscord,
  deleteMessageDiscord,
  editMessageDiscord,
  pinMessageDiscord,
  unpinMessageDiscord,
} from "../../plugin-sdk/discord-runtime-send.js";
import { sendMessageDiscord, sendPollDiscord } from "../../plugin-sdk/discord-runtime-send.js";
import { sendTypingDiscord } from "../../plugin-sdk/discord-runtime-send.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export const runtimeDiscordSend = {
  sendComponentMessage: sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  typing: {
    pulse: sendTypingDiscord,
  },
  conversationActions: {
    editMessage: editMessageDiscord,
    deleteMessage: deleteMessageDiscord,
    pinMessage: pinMessageDiscord,
    unpinMessage: unpinMessageDiscord,
    createThread: createThreadDiscord,
    editChannel: editChannelDiscord,
  },
} satisfies Pick<
  PluginRuntimeChannel["discord"],
  "sendComponentMessage" | "sendMessageDiscord" | "sendPollDiscord"
> & {
  typing: Pick<PluginRuntimeChannel["discord"]["typing"], "pulse">;
  conversationActions: Pick<
    PluginRuntimeChannel["discord"]["conversationActions"],
    "editMessage" | "deleteMessage" | "pinMessage" | "unpinMessage" | "createThread" | "editChannel"
  >;
};
