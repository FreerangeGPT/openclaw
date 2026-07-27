import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

function createConfig(params: {
  workspace: string;
  storePath: string;
  isolatedSession?: boolean;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspace,
        heartbeat: {
          every: "15m",
          target: "telegram",
          isolatedSession: params.isolatedSession,
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: params.storePath },
  };
}

async function seedLargeSession(storePath: string, cfg: OpenClawConfig) {
  return await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
    totalTokens: 96_083,
    totalTokensFresh: true,
  });
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
    });
  });

  it("skips the same routine run when main-session use is explicitly required", async () => {
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
        status: "skipped",
        reason: "full-context-heartbeat-guard",
      });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("keeps manual heartbeats on the explicitly configured main session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createConfig({
        workspace: tmpDir,
        storePath,
        isolatedSession: false,
      });
      const sessionKey = await seedLargeSession(storePath, cfg);
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

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({ SessionKey: sessionKey });
    });
  });
});
