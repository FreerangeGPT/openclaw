import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendMainSessionPromptCacheEvidence,
  MainSessionCacheKeeperIdentityMismatchError,
} from "../agents/embedded-agent-runner/prompt-cache-evidence.js";
import type { OpenClawConfig } from "../config/config.js";
import { appendTranscriptEvent } from "../config/sessions/session-accessor.js";
import {
  appendExactAssistantMessageToSessionTranscript,
  type SessionTranscriptAssistantMessage,
} from "../config/sessions/transcript.js";
import { heartbeatLog } from "./heartbeat-runner-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createConfig(params: {
  workspace: string;
  storePath: string;
  isolatedSession?: boolean;
  cacheRetention?: "none" | "short" | "long";
  anthropicBaseUrl?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspace,
        model: { primary: "anthropic/claude-opus-4-8" },
        heartbeat: {
          every: "15m",
          target: "telegram",
          isolatedSession: params.isolatedSession,
        },
      },
      entries: {
        main: {
          default: true,
          ...(params.cacheRetention ? { params: { cacheRetention: params.cacheRetention } } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    ...(params.anthropicBaseUrl
      ? {
          models: {
            providers: {
              anthropic: {
                api: "anthropic-messages",
                baseUrl: params.anthropicBaseUrl,
                models: [],
              },
            },
          },
        }
      : {}),
    session: { store: params.storePath },
  };
}

async function seedLargeSession(
  storePath: string,
  cfg: OpenClawConfig,
  overrides: Partial<Parameters<typeof seedMainSessionStore>[2]> = {},
) {
  return await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
    totalTokens: 96_083,
    totalTokensFresh: true,
    ...overrides,
  });
}

async function seedCacheTouch(params: {
  storePath: string;
  sessionKey: string;
  provider?: string;
  model?: string;
  timestamp?: number;
  cachedTokens?: number;
  cacheRetention?: "short" | "long";
  authProfileId?: string;
}) {
  const cachedTokens = params.cachedTokens ?? 90_000;
  const message: SessionTranscriptAssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Previous reply" }],
    api: "anthropic-messages",
    provider: params.provider ?? "anthropic",
    model: params.model ?? "claude-opus-4-8",
    usage: {
      input: 1,
      output: 1,
      cacheRead: cachedTokens,
      cacheWrite: 0,
      totalTokens: cachedTokens + 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: params.timestamp ?? Date.now(),
  };
  const result = await appendExactAssistantMessageToSessionTranscript({
    agentId: "main",
    sessionKey: params.sessionKey,
    expectedSessionId: "sid",
    storePath: params.storePath,
    message,
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  const evidenceId = `cache-evidence-${result.messageId}`;
  let evidenceData: unknown;
  appendMainSessionPromptCacheEvidence({
    sessionManager: {
      appendCustomEntry: (_customType, data) => {
        evidenceData = data;
      },
    },
    cfg: {},
    agentId: "main",
    sessionKey: params.sessionKey,
    timestamp: message.timestamp,
    provider: message.provider,
    modelId: message.model,
    cacheRetention: params.cacheRetention ?? "long",
    promptIdentity: "main-prompt-identity",
    providerCachePrefixIdentity: "main-provider-cache-prefix-identity",
    requestOptionsIdentity: "main-request-options-identity",
    providerMessageIdentity: "main-provider-message-identity",
    authFingerprint: "main-auth-fingerprint",
    authProfileId: params.authProfileId,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    cacheWrite1h: cachedTokens,
    promptTokens: 96_083,
  });
  await appendTranscriptEvent(
    {
      agentId: "main",
      sessionId: "sid",
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      type: "custom",
      customType: "openclaw.prompt-cache",
      id: evidenceId,
      parentId: result.messageId,
      timestamp: new Date().toISOString(),
      data:
        evidenceData ??
        ({
          evidenceId,
          timestamp: message.timestamp,
          provider: message.provider,
          modelId: message.model,
          cacheRetention: params.cacheRetention ?? "long",
          promptIdentity: "unconfirmed-prompt-identity",
          providerCachePrefixIdentity: "unconfirmed-provider-cache-prefix-identity",
          requestOptionsIdentity: "unconfirmed-request-options-identity",
          providerMessageIdentity: "unconfirmed-provider-message-identity",
          authFingerprint: "unconfirmed-auth-fingerprint",
          cacheRead: cachedTokens,
          cacheWrite: 0,
          cacheWrite1h: cachedTokens,
          promptTokens: 96_083,
          confirmedCachedTokens: cachedTokens,
        } as const),
    },
  );
  return evidenceId;
}

describe("runHeartbeatOnce large-session cost guard", () => {
  it("isolates a routine 15-minute heartbeat from a large main session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath });
      const sessionKey = await seedLargeSession(storePath, cfg);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).toMatchObject({
        isHeartbeat: true,
        bootstrapContextMode: "lightweight",
      });
      expect(replySpy.mock.calls[0]?.[1]).toMatchObject({
        heartbeatCacheRetentionOverride: "long",
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
    });
  });

  it("keeps a scheduled 15-minute long-retention cache keeper on the main session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const infoSpy = vi.spyOn(heartbeatLog, "info").mockImplementation(() => {});
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        cacheRetention: "long",
      });
      const sessionKey = await seedLargeSession(storePath, cfg);
      const transcriptAnchorId = await seedCacheTouch({ storePath, sessionKey });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        tasks: [{ jobId: "job-status", name: "status", prompt: "Check deployment status" }],
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({ SessionKey: sessionKey });
      expect(replySpy.mock.calls[0]?.[1]).toMatchObject({
        isHeartbeat: true,
        heartbeatModelOverride: "anthropic/claude-opus-4-8",
        heartbeatModelFallbacksDisabled: true,
        heartbeatPromptCacheEvidenceId: expect.any(String),
        heartbeatPromptCacheTranscriptAnchorId: transcriptAnchorId,
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatCacheRetentionOverride");
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("enableHeartbeatTool");
      expect(replySpy.mock.calls[0]?.[1]?.bootstrapContextMode).toBeUndefined();
      expect(infoSpy).toHaveBeenCalledWith(
        "heartbeat: cache keeper prepared",
        expect.objectContaining({
          agentId: "main",
          sessionKey,
          cacheEvidenceId: expect.any(String),
          transcriptAnchorId,
          authProfilePinned: false,
          modelFallbacksDisabled: true,
        }),
      );
    });
  });

  it("isolates when the cache-pinned auth profile is no longer available", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath, cacheRetention: "long" });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey, authProfileId: "anthropic:removed" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatAuthProfileOverride");
    });
  });

  it("isolates a keeper whose pending monitor prompt exceeds the warm-cache allowance", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg = createConfig({
          workspace: tmpDir,
          storePath,
          cacheRetention: "long",
        });
        const sessionKey = await seedLargeSession(storePath, cfg);
        await seedCacheTouch({ storePath, sessionKey });

        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          deps: {
            getReplyFromConfig: replySpy,
            telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
          },
        });

        expect(result.status).toBe("ran");
        expect(replySpy).toHaveBeenCalledOnce();
        expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
          SessionKey: `${sessionKey}:heartbeat`,
        });
        expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
      },
      { heartbeatScratchContent: `- ${"x".repeat(16_000)}\n` },
    );
  });

  it("does not implicitly buy one-hour retention on a custom Anthropic endpoint", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        anthropicBaseUrl: "https://anthropic-proxy.example/v1",
      });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatCacheRetentionOverride");
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
    });
  });

  it("fails closed on a late cache identity mismatch without replaying", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey });
      replySpy.mockRejectedValueOnce(
        new MainSessionCacheKeeperIdentityMismatchError({
          reason: "provider-payload-identity-changed",
        }),
      );

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "main-session-heartbeat-provider-payload-identity-changed",
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({ SessionKey: sessionKey });
    });
  });

  it("fails closed after a late cache identity mismatch when main-session use is explicit", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath, isolatedSession: false });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey });
      replySpy.mockRejectedValueOnce(new MainSessionCacheKeeperIdentityMismatchError());

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "main-session-heartbeat-prompt-or-credential-identity-changed",
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("does not replay a cache freshness failure after provider work has started", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey });
      replySpy.mockRejectedValueOnce(
        new MainSessionCacheKeeperIdentityMismatchError({ replaySafe: false }),
      );

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "main-session-heartbeat-prompt-or-credential-identity-changed",
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("auto-isolates when only a small static prefix was cached", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath, cacheRetention: "long" });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey, cachedTokens: 1_000 });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
    });
  });

  it("does not promote a short-retention cache touch after config changes to long", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath, cacheRetention: "long" });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({ storePath, sessionKey, cacheRetention: "short" });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
    });
  });

  it("auto-isolates a long-retention cache keeper after its last cache touch expires", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const nowMs = Date.now();
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        cacheRetention: "long",
      });
      const sessionKey = await seedLargeSession(storePath, cfg);
      await seedCacheTouch({
        storePath,
        sessionKey,
        timestamp: nowMs - 61 * 60_000,
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          nowMs: () => nowMs,
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
    });
  });

  it("auto-isolates after compaction invalidates an otherwise recent cache touch", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({ workspace: tmpDir, storePath, cacheRetention: "long" });
      const sessionKey = await seedLargeSession(storePath, cfg);
      const cacheTouchId = await seedCacheTouch({ storePath, sessionKey });
      await appendTranscriptEvent(
        { agentId: "main", sessionId: "sid", sessionKey, storePath },
        {
          type: "compaction",
          id: "compaction-after-cache-touch",
          parentId: cacheTouchId,
          timestamp: new Date().toISOString(),
          summary: "Fresh compacted context",
          firstKeptEntryId: cacheTouchId,
          tokensBefore: 96_083,
        },
      );
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
    });
  });

  it("uses the persisted session model when checking the latest cache touch", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        cacheRetention: "long",
      });
      const sessionKey = await seedLargeSession(storePath, cfg, {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        modelOverrideSource: "user",
      });
      await seedCacheTouch({ storePath, sessionKey });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
    });
  });

  it("downgrades an explicitly isolated heartbeat when the main agent uses long retention", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        isolatedSession: true,
        cacheRetention: "long",
      });
      const sessionKey = await seedLargeSession(storePath, cfg);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: `${sessionKey}:heartbeat`,
      });
      expect(replySpy.mock.calls[0]?.[1]).toMatchObject({
        isHeartbeat: true,
        heartbeatCacheRetentionOverride: "short",
      });
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatModelFallbacksDisabled");
    });
  });

  it("preserves explicit no-cache policy for an isolated heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        isolatedSession: true,
        cacheRetention: "none",
      });
      await seedLargeSession(storePath, cfg);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[1]).not.toHaveProperty("heartbeatCacheRetentionOverride");
    });
  });

  it("fails closed when explicit main-session use has no live cache evidence", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        isolatedSession: false,
      });
      await seedLargeSession(storePath, cfg);

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "main-session-heartbeat-cache-evidence-missing",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("does not use a small synthetic heartbeat to bootstrap main-session evidence", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        isolatedSession: false,
      });
      await seedLargeSession(storePath, cfg, {
        totalTokens: 200,
        totalTokensFresh: true,
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "main-session-heartbeat-cache-evidence-missing",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("fails a manual main heartbeat before provider I/O when cache proof is missing", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        isolatedSession: false,
      });
      await seedLargeSession(storePath, cfg);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "manual",
        intent: "manual",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: async () => ({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result).toEqual({
        status: "failed",
        reason: "main-session-heartbeat-cache-evidence-missing",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });
});
