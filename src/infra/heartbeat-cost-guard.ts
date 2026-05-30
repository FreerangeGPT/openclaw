export const FULL_CONTEXT_HEARTBEAT_TOKEN_GUARD = 50_000;

export type ExpensiveMainSessionHeartbeatSkip = {
  promptChars: number;
  threshold: number;
  totalTokens: number;
};

export type AutoIsolatedMainSessionHeartbeat = {
  threshold: number;
  totalTokens: number;
};

export function shouldUseIsolatedHeartbeatSession(params: {
  configuredIsolated?: boolean;
  hasMemoryPrepend: boolean;
  autoIsolatedMainSession?: boolean;
}): boolean {
  return (
    params.configuredIsolated === true ||
    params.hasMemoryPrepend ||
    params.autoIsolatedMainSession === true
  );
}

function resolveFreshPromptTokens(params: {
  totalTokens?: number;
  totalTokensFresh?: boolean;
}): number | null {
  if (params.totalTokensFresh === false) {
    return null;
  }
  const totalTokens = params.totalTokens;
  return typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0
    ? totalTokens
    : null;
}

export function shouldAutoIsolateMainSessionHeartbeat(params: {
  configuredIsolated?: boolean;
  preserveMainSessionCache: boolean;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
  isCronEventReason: boolean;
  isExecEventReason: boolean;
  isManualReason: boolean;
  isWakeReason: boolean;
}): AutoIsolatedMainSessionHeartbeat | null {
  if (params.configuredIsolated !== undefined) {
    return null;
  }
  if (params.preserveMainSessionCache) {
    return null;
  }
  if (
    params.hasExecCompletion ||
    params.hasCronEvents ||
    params.isExecEventReason ||
    params.isCronEventReason ||
    params.isManualReason
  ) {
    return null;
  }
  const totalTokens = resolveFreshPromptTokens(params);
  if (totalTokens === null || totalTokens < FULL_CONTEXT_HEARTBEAT_TOKEN_GUARD) {
    return null;
  }
  return {
    totalTokens,
    threshold: FULL_CONTEXT_HEARTBEAT_TOKEN_GUARD,
  };
}

export function shouldSkipExpensiveMainSessionHeartbeat(params: {
  prompt: string;
  preserveMainSessionCache: boolean;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  hasExecCompletion: boolean;
  hasCronEvents: boolean;
  hasHeartbeatInstructions: boolean;
  hasTasks: boolean;
  isCronEventReason: boolean;
  isExecEventReason: boolean;
  isManualReason: boolean;
  isWakeReason: boolean;
  useIsolatedSession: boolean;
}): ExpensiveMainSessionHeartbeatSkip | null {
  if (params.useIsolatedSession) {
    return null;
  }
  if (params.preserveMainSessionCache) {
    return null;
  }
  if (
    params.hasExecCompletion ||
    params.hasCronEvents ||
    params.isExecEventReason ||
    params.isCronEventReason ||
    params.isManualReason
  ) {
    return null;
  }
  const totalTokens = resolveFreshPromptTokens(params);
  if (totalTokens === null || totalTokens < FULL_CONTEXT_HEARTBEAT_TOKEN_GUARD) {
    return null;
  }
  return {
    totalTokens,
    threshold: FULL_CONTEXT_HEARTBEAT_TOKEN_GUARD,
    promptChars: params.prompt.length,
  };
}
