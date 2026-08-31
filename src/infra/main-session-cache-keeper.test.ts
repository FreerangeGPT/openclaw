import type { AnthropicPromptCacheTouchResult } from "@openclaw/ai/transports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS,
  MAIN_SESSION_CACHE_TOUCH_RETRY_DELAYS_MS,
  MAIN_SESSION_CACHE_TOUCH_WATCHDOG_MS,
  MainSessionCacheKeeperRuntime,
  type MainSessionCacheKeeperDeps,
  type MainSessionCacheTouchStage,
} from "./main-session-cache-keeper.js";

const START_MS = Date.UTC(2026, 7, 5, 12, 0, 0);

function createTouchResult(): AnthropicPromptCacheTouchResult {
  return {
    mode: "max-tokens-zero",
    usage: {
      input: 8,
      output: 0,
      cacheRead: 12_000,
      cacheWrite: 0,
      totalTokens: 12_008,
      cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
    },
  };
}

function createStage(overrides: Partial<MainSessionCacheTouchStage> = {}) {
  return {
    agentId: "main",
    apiKey: "sk-ant-test",
    model: {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    },
    payload: {
      model: "claude-opus-5",
      max_tokens: 32_000,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "stable main prefix",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
    },
    providerCallStartedAt: Date.now(),
    runId: "run-1",
    sessionFile: "/tmp/main-session.jsonl",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    ...overrides,
  } satisfies MainSessionCacheTouchStage;
}

function createRuntime(
  params: {
    leafId?: { value: string | null };
    persistObservation?: MainSessionCacheKeeperDeps["persistObservation"];
    readActiveLeafId?: MainSessionCacheKeeperDeps["readActiveLeafId"];
    refreshEvidence?: MainSessionCacheKeeperDeps["refreshEvidence"];
    touch?: MainSessionCacheKeeperDeps["touch"];
  } = {},
) {
  const leafId = params.leafId ?? { value: "assistant-1" };
  const touch = params.touch ?? vi.fn(async () => createTouchResult());
  const persistObservation =
    params.persistObservation ?? vi.fn(async () => "cache-touch-observation-1");
  const refreshEvidence = params.refreshEvidence ?? vi.fn(() => true);
  const deps: MainSessionCacheKeeperDeps = {
    clearInterval: (timer) => clearInterval(timer),
    clearTimeout: (timer) => clearTimeout(timer),
    now: Date.now,
    persistObservation,
    readActiveLeafId: params.readActiveLeafId ?? vi.fn(async () => leafId.value),
    refreshEvidence,
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    touch,
  };
  return {
    leafId,
    persistObservation,
    refreshEvidence,
    runtime: new MainSessionCacheKeeperRuntime(deps),
    touch,
  };
}

describe("main session cache keeper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses one precise timer for the first touch at 45 minutes", async () => {
    const { runtime, touch, persistObservation, refreshEvidence } = createRuntime();
    runtime.start();
    expect(runtime.stage(createStage())).toBe(true);
    expect(
      runtime.commit({
        runId: "run-1",
        anchorId: "assistant-1",
        expectedCachedTokens: 12_000,
        promptCacheEvidenceId: "evidence-1",
      }),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS - 1);
    expect(touch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(touch).toHaveBeenCalledTimes(1);
    expect(refreshEvidence).toHaveBeenCalledWith({
      confirmedCachedTokens: 12_000,
      evidenceId: "evidence-1",
      timestamp: START_MS + MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS,
    });
    expect(persistObservation).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedAtMs: START_MS + MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS }),
      expect.objectContaining({ attempt: 1, confirmedAtMs: START_MS + 45 * 60_000 }),
    );
    runtime.stop();
  });

  it("does not double-count one-hour writes within generic cache-write usage", async () => {
    const touch = vi.fn(async () => {
      const result = createTouchResult();
      return {
        ...result,
        usage: {
          ...result.usage,
          cacheRead: 0,
          cacheWrite: 12_000,
          cacheWrite1h: 12_000,
        },
      };
    });
    const { runtime, refreshEvidence } = createRuntime({ touch });
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });

    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);

    expect(refreshEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedCachedTokens: 12_000 }),
    );
    runtime.stop();
  });

  it("drops stale live evidence after one successful provider touch", async () => {
    const refreshEvidence = vi.fn(() => false);
    const { runtime, touch, persistObservation } = createRuntime({ refreshEvidence });
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "missing-evidence",
    });

    await vi.advanceTimersByTimeAsync(2 * MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);

    expect(touch).toHaveBeenCalledOnce();
    expect(refreshEvidence).toHaveBeenCalledOnce();
    expect(persistObservation).not.toHaveBeenCalled();
    runtime.stop();
  });

  it("does not repeat a paid touch when post-touch leaf verification fails", async () => {
    const readActiveLeafId = vi
      .fn<MainSessionCacheKeeperDeps["readActiveLeafId"]>()
      .mockResolvedValueOnce("assistant-1")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const { runtime, touch, refreshEvidence, persistObservation } = createRuntime({
      readActiveLeafId,
    });
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });

    await vi.advanceTimersByTimeAsync(2 * MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);

    expect(touch).toHaveBeenCalledOnce();
    expect(refreshEvidence).not.toHaveBeenCalled();
    expect(persistObservation).not.toHaveBeenCalled();
    runtime.stop();
  });

  it("retries hard failures at +5, +3, +2, and +1 minutes", async () => {
    const attemptTimes: number[] = [];
    const touch = vi.fn(async () => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length < 5) {
        throw new Error("provider unavailable");
      }
      return createTouchResult();
    });
    const { runtime, persistObservation } = createRuntime({ touch });
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });

    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);
    for (const delayMs of MAIN_SESSION_CACHE_TOUCH_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delayMs);
    }

    expect(attemptTimes.map((timestamp) => timestamp - START_MS)).toEqual([
      45 * 60_000,
      50 * 60_000,
      53 * 60_000,
      55 * 60_000,
      56 * 60_000,
    ]);
    expect(persistObservation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attempt: 5 }),
    );
    runtime.stop();
  });

  it("drops an exhausted parent instead of hammering the provider", async () => {
    const touch = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { runtime } = createRuntime({ touch });
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });

    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);
    for (const delayMs of MAIN_SESSION_CACHE_TOUCH_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delayMs);
    }
    await vi.advanceTimersByTimeAsync(2 * MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);

    expect(touch).toHaveBeenCalledTimes(5);
    runtime.stop();
  });

  it("blocks the old parent while a fresher main payload is in flight", async () => {
    const { runtime, touch } = createRuntime();
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });

    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS - 60_000);
    runtime.stage(
      createStage({
        providerCallStartedAt: Date.now(),
        runId: "run-2",
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000 + MAIN_SESSION_CACHE_TOUCH_WATCHDOG_MS);
    expect(touch).not.toHaveBeenCalled();

    runtime.commit({
      runId: "run-2",
      anchorId: "assistant-2",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-2",
    });
    runtime.stop();
  });

  it("drops a parent when the active main leaf no longer matches", async () => {
    const leafId = { value: "assistant-1" as string | null };
    const { runtime, touch } = createRuntime({ leafId });
    runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });
    leafId.value = "new-user-turn";

    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);

    expect(touch).not.toHaveBeenCalled();
    runtime.stop();
  });

  it("invalidates captured model and credential state on config reload", async () => {
    const { runtime, touch } = createRuntime();
    const handle = runtime.start();
    runtime.stage(createStage());
    runtime.commit({
      runId: "run-1",
      anchorId: "assistant-1",
      expectedCachedTokens: 12_000,
      promptCacheEvidenceId: "evidence-1",
    });

    handle.updateConfig();
    await vi.advanceTimersByTimeAsync(MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS);

    expect(touch).not.toHaveBeenCalled();
    runtime.stop();
  });
});
