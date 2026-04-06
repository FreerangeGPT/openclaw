import { prependAssociativeRecallBlockToText } from "./memory-prepend-queue.js";

const TELEGRAM_UPDATE_MESSAGE_KEYS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "business_message",
  "edited_business_message",
] as const;

type TelegramMessageField = "text" | "caption";

type TelegramInjectionTarget = {
  messageKey: (typeof TELEGRAM_UPDATE_MESSAGE_KEYS)[number];
  field: TelegramMessageField;
};

function resolveTelegramInjectionTarget(update: unknown): TelegramInjectionTarget | undefined {
  if (!update || typeof update !== "object") {
    return undefined;
  }

  const record = update as Record<string, unknown>;
  for (const messageKey of TELEGRAM_UPDATE_MESSAGE_KEYS) {
    const message = record[messageKey];
    if (!message || typeof message !== "object") {
      continue;
    }
    const typedMessage = message as Record<string, unknown>;
    for (const field of ["text", "caption"] as const) {
      const value = typedMessage[field];
      if (typeof value === "string" && value.trim()) {
        return { messageKey, field };
      }
    }
  }

  return undefined;
}

export function prependAssociativeRecallToTelegramUpdate(params: {
  update: unknown;
  recallBlock?: string;
}): {
  update: unknown;
  didInject: boolean;
  target?: `${(typeof TELEGRAM_UPDATE_MESSAGE_KEYS)[number]}.${TelegramMessageField}`;
} {
  const target = resolveTelegramInjectionTarget(params.update);
  if (!target || !params.recallBlock?.trim()) {
    return { update: params.update, didInject: false };
  }

  const record = params.update as Record<string, unknown>;
  const message = record[target.messageKey] as Record<string, unknown>;
  const originalValue = message[target.field];
  if (typeof originalValue !== "string" || !originalValue.trim()) {
    return { update: params.update, didInject: false };
  }

  const nextValue = prependAssociativeRecallBlockToText({
    body: originalValue,
    recallBlock: params.recallBlock,
  });
  if (nextValue === originalValue) {
    return { update: params.update, didInject: false };
  }

  return {
    update: {
      ...record,
      [target.messageKey]: {
        ...message,
        [target.field]: nextValue,
      },
    },
    didInject: true,
    target: `${target.messageKey}.${target.field}`,
  };
}
