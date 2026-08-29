/**
 * Private-local runtime seam for adopting queued associative recall into an agent turn.
 *
 * Keep the SQLite implementation lazy so channel startup does not load the agent database stack.
 */

export type PreparedAgentTurnMemoryPrepend = {
  body: string;
  databasePath: string;
  includedFragments: number;
  truncated: boolean;
  commit: () => Promise<{
    applied: boolean;
    reason: "updated" | "cleared" | "noop" | "already_finalized" | "claim_lost";
  }>;
  release: () => Promise<{
    applied: boolean;
    reason: "released" | "noop" | "already_finalized" | "claim_lost";
  }>;
};

/** Claim queued recall for one agent and prepend it to the model-facing body. */
export async function prepareAgentTurnMemoryPrepend(params: {
  agentId: string;
  body: string;
}): Promise<PreparedAgentTurnMemoryPrepend> {
  const { prepareMemoryPrependQueueDrain, prependAssociativeRecallBlockToText } =
    await import("../infra/memory-prepend-queue.js");
  const prepared = await prepareMemoryPrependQueueDrain({ agentId: params.agentId });
  return {
    body: prependAssociativeRecallBlockToText({
      body: params.body,
      recallBlock: prepared.block,
    }),
    databasePath: prepared.databasePath,
    includedFragments: prepared.includedFragments,
    truncated: prepared.truncated,
    commit: prepared.commit,
    release: prepared.release,
  };
}
