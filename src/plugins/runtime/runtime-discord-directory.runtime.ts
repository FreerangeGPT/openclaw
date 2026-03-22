import { auditDiscordChannelPermissions } from "../../plugin-sdk/discord-runtime-directory.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../plugin-sdk/discord-runtime-directory.js";
import { resolveDiscordChannelAllowlist } from "../../plugin-sdk/discord-runtime-directory.js";
import { resolveDiscordUserAllowlist } from "../../plugin-sdk/discord-runtime-directory.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export const runtimeDiscordDirectory = {
  auditChannelPermissions: auditDiscordChannelPermissions,
  listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
  listDirectoryPeersLive: listDiscordDirectoryPeersLive,
  resolveChannelAllowlist: resolveDiscordChannelAllowlist,
  resolveUserAllowlist: resolveDiscordUserAllowlist,
} satisfies Pick<
  PluginRuntimeChannel["discord"],
  | "auditChannelPermissions"
  | "listDirectoryGroupsLive"
  | "listDirectoryPeersLive"
  | "resolveChannelAllowlist"
  | "resolveUserAllowlist"
>;
