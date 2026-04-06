import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resolveMemoryPrependQueuePath } from "./memory-prepend-queue.js";
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

      const queuePath = resolveMemoryPrependQueuePath({ workspaceDir: tmpDir });
      await fs.mkdir(path.dirname(queuePath), { recursive: true });
      await fs.writeFile(
        queuePath,
        `${JSON.stringify({ text: "Remember the launch checklist." })}\n`,
        "utf-8",
      );

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
      await expect(fs.stat(queuePath)).rejects.toMatchObject({ code: "ENOENT" });
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

      const queuePath = resolveMemoryPrependQueuePath({ workspaceDir: tmpDir });
      await fs.mkdir(path.dirname(queuePath), { recursive: true });
      await fs.writeFile(
        queuePath,
        `${JSON.stringify({ text: "Remember the incident timeline." })}\n`,
        "utf-8",
      );

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
      await expect(fs.readFile(queuePath, "utf-8")).resolves.toContain(
        "Remember the incident timeline.",
      );
    });
  });
});
