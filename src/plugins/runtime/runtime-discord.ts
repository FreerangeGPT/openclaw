import {
  discordMessageActions,
  getThreadBindingManager,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "../../plugin-sdk/discord-runtime-bindings.js";
import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeSurface,
} from "../../shared/lazy-runtime.js";
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

const loadRuntimeDiscordDirectory = createLazyRuntimeSurface(
  () => import("./runtime-discord-directory.runtime.js"),
  ({ runtimeDiscordDirectory }) => runtimeDiscordDirectory,
);
const loadRuntimeDiscordProvider = createLazyRuntimeSurface(
  () => import("./runtime-discord-provider.runtime.js"),
  ({ runtimeDiscordProvider }) => runtimeDiscordProvider,
);
const loadRuntimeDiscordSend = createLazyRuntimeSurface(
  () => import("./runtime-discord-send.runtime.js"),
  ({ runtimeDiscordSend }) => runtimeDiscordSend,
);

const bindDiscordDirectoryMethod = createLazyRuntimeMethodBinder(loadRuntimeDiscordDirectory);
const bindDiscordProviderMethod = createLazyRuntimeMethodBinder(loadRuntimeDiscordProvider);
const bindDiscordSendMethod = createLazyRuntimeMethodBinder(loadRuntimeDiscordSend);

const auditChannelPermissionsLazy = bindDiscordDirectoryMethod(
  (runtimeDiscordDirectory) => runtimeDiscordDirectory.auditChannelPermissions,
);
const listDirectoryGroupsLiveLazy = bindDiscordDirectoryMethod(
  (runtimeDiscordDirectory) => runtimeDiscordDirectory.listDirectoryGroupsLive,
);
const listDirectoryPeersLiveLazy = bindDiscordDirectoryMethod(
  (runtimeDiscordDirectory) => runtimeDiscordDirectory.listDirectoryPeersLive,
);
const probeDiscordLazy = bindDiscordProviderMethod(
  (runtimeDiscordProvider) => runtimeDiscordProvider.probeDiscord,
);
const resolveChannelAllowlistLazy = bindDiscordDirectoryMethod(
  (runtimeDiscordDirectory) => runtimeDiscordDirectory.resolveChannelAllowlist,
);
const resolveUserAllowlistLazy = bindDiscordDirectoryMethod(
  (runtimeDiscordDirectory) => runtimeDiscordDirectory.resolveUserAllowlist,
);
const sendComponentMessageLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.sendComponentMessage,
);
const sendMessageDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.sendMessageDiscord,
);
const sendPollDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.sendPollDiscord,
);
const monitorDiscordProviderLazy = bindDiscordProviderMethod(
  (runtimeDiscordProvider) => runtimeDiscordProvider.monitorDiscordProvider,
);
const sendTypingDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.typing.pulse,
);
const editMessageDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.conversationActions.editMessage,
);
const deleteMessageDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.conversationActions.deleteMessage,
);
const pinMessageDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.conversationActions.pinMessage,
);
const unpinMessageDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.conversationActions.unpinMessage,
);
const createThreadDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.conversationActions.createThread,
);
const editChannelDiscordLazy = bindDiscordSendMethod(
  (runtimeDiscordSend) => runtimeDiscordSend.conversationActions.editChannel,
);

export function createRuntimeDiscord(): PluginRuntimeChannel["discord"] {
  return {
    messageActions: discordMessageActions,
    auditChannelPermissions: auditChannelPermissionsLazy,
    listDirectoryGroupsLive: listDirectoryGroupsLiveLazy,
    listDirectoryPeersLive: listDirectoryPeersLiveLazy,
    probeDiscord: probeDiscordLazy,
    resolveChannelAllowlist: resolveChannelAllowlistLazy,
    resolveUserAllowlist: resolveUserAllowlistLazy,
    sendComponentMessage: sendComponentMessageLazy,
    sendMessageDiscord: sendMessageDiscordLazy,
    sendPollDiscord: sendPollDiscordLazy,
    monitorDiscordProvider: monitorDiscordProviderLazy,
    threadBindings: {
      getManager: getThreadBindingManager,
      resolveIdleTimeoutMs: resolveThreadBindingIdleTimeoutMs,
      resolveInactivityExpiresAt: resolveThreadBindingInactivityExpiresAt,
      resolveMaxAgeMs: resolveThreadBindingMaxAgeMs,
      resolveMaxAgeExpiresAt: resolveThreadBindingMaxAgeExpiresAt,
      setIdleTimeoutBySessionKey: setThreadBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setThreadBindingMaxAgeBySessionKey,
      unbindBySessionKey: unbindThreadBindingsBySessionKey,
    },
    typing: {
      pulse: sendTypingDiscordLazy,
      start: async ({ channelId, accountId, cfg, intervalMs }) =>
        await createDiscordTypingLease({
          channelId,
          accountId,
          cfg,
          intervalMs,
          pulse: async ({ channelId, accountId, cfg }) =>
            void (await sendTypingDiscordLazy(channelId, { accountId, cfg })),
        }),
    },
    conversationActions: {
      editMessage: editMessageDiscordLazy,
      deleteMessage: deleteMessageDiscordLazy,
      pinMessage: pinMessageDiscordLazy,
      unpinMessage: unpinMessageDiscordLazy,
      createThread: createThreadDiscordLazy,
      editChannel: editChannelDiscordLazy,
    },
  };
}
