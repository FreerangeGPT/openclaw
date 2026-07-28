import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { invokeHeartbeatWithMemoryPrepend } from "./heartbeat-memory-prepend.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueMemoryPrepend, hasPendingMemoryPrepend } from "./memory-prepend-queue.js";
import { resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce memory prepend", () => {
  it("defers memory that arrives after a non-isolated run was prepared", async () => {
    await withTempHeartbeatSandbox(async () => {
      enqueueMemoryPrepend({ agentId: "main", text: "Arrived after prepare" });
      const invoke = vi.fn(async (prompt: string) => ({ text: prompt }));

      const result = await invokeHeartbeatWithMemoryPrepend({
        agentId: "main",
        enabled: false,
        prompt: "Heartbeat prompt",
        invoke,
        admissionSkipped: () => false,
      });

      expect(result).toEqual({ text: "Heartbeat prompt" });
      expect(invoke).toHaveBeenCalledWith("Heartbeat prompt");
      expect(hasPendingMemoryPrepend({ agentId: "main" })).toBe(true);
    });
  });

  it("prepends surfaced memory blocks and commits the queue after a successful run", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });

      enqueueMemoryPrepend({
        agentId: "main",
        text: "Remember the launch checklist.",
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      const calledCtx = replySpy.mock.calls[0]?.[0] as { Body?: string } | undefined;
      expect(calledCtx?.Body).toContain("[Associative recall]");
      expect(calledCtx?.Body).toContain("Remember the launch checklist.");
      expect(calledCtx?.Body).toContain("Current time:");
      expect(
        (replySpy.mock.calls[0]?.[0] as { SessionKey?: string } | undefined)?.SessionKey,
      ).toMatch(/:heartbeat$/);
      expect(hasPendingMemoryPrepend({ agentId: "main" })).toBe(false);
    });
  });

  it("keeps the queue intact when the heartbeat run fails before completion", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });

      enqueueMemoryPrepend({
        agentId: "main",
        text: "Remember the incident timeline.",
      });

      replySpy.mockRejectedValue(new Error("boom"));

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn(),
        },
      });

      expect(result).toEqual({ status: "failed", reason: "boom" });
      expect(hasPendingMemoryPrepend({ agentId: "main" })).toBe(true);
    });
  });

  it("keeps the queue intact when the provider resolves with an error payload", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueMemoryPrepend({
        agentId: "main",
        text: "Remember the resolved provider error.",
      });
      replySpy.mockResolvedValue({ text: "provider failed", isError: true });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn(),
        },
      });

      expect(result.status).toBe("failed");
      expect(hasPendingMemoryPrepend({ agentId: "main" })).toBe(true);
    });
  });

  it("does not fail a successful heartbeat when queue commit throws", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueMemoryPrepend({
        agentId: "main",
        text: "Retry after heartbeat commit failure.",
      });
      replySpy.mockImplementation(async () => {
        openOpenClawAgentDatabase({ agentId: "main" }).db.exec(
          "ALTER TABLE memory_prepend_queue RENAME TO memory_prepend_queue_blocked;",
        ); // sqlite-allow-raw -- Force only the post-run queue commit to fail.
        return { text: "HEARTBEAT_OK" };
      });

      let result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
      try {
        result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          deps: {
            getReplyFromConfig: replySpy,
            telegram: vi.fn(),
          },
        });
      } finally {
        openOpenClawAgentDatabase({ agentId: "main" }).db.exec(
          "ALTER TABLE memory_prepend_queue_blocked RENAME TO memory_prepend_queue;",
        ); // sqlite-allow-raw -- Restore the canonical fixture after the injected failure.
      }

      expect(result.status).toBe("ran");
      expect(
        hasPendingMemoryPrepend({
          agentId: "main",
          now: Date.now() + 16 * 60_000,
        }),
      ).toBe(true);
    });
  });
});
