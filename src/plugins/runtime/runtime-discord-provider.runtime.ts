import { monitorDiscordProvider } from "../../plugin-sdk/discord-runtime-provider.js";
import { probeDiscord } from "../../plugin-sdk/discord-runtime-provider.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export const runtimeDiscordProvider = {
  monitorDiscordProvider,
  probeDiscord,
} satisfies Pick<PluginRuntimeChannel["discord"], "monitorDiscordProvider" | "probeDiscord">;
