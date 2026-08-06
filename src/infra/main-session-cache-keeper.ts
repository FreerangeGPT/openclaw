import {
  isAnthropicPromptCacheTouchPayload,
  isDirectAnthropicPromptCacheTouchModel,
  touchAnthropicPromptCache,
  type AnthropicPromptCacheTouchResult,
} from "@openclaw/ai/transports";
import { MAIN_SESSION_CACHE_TOUCH_CUSTOM_TYPE } from "../agents/embedded-agent-runner/cache-ttl.js";
import { acquireSessionWriteLock } from "../agents/session-write-lock.js";
import { SessionManager } from "../agents/sessions/index.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export { MAIN_SESSION_CACHE_TOUCH_CUSTOM_TYPE };
export const MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS = 45 * 60_000;
export const MAIN_SESSION_CACHE_TOUCH_WATCHDOG_MS = 3 * 60_000;
export const MAIN_SESSION_CACHE_TOUCH_RETRY_DELAYS_MS = [
  5 * 60_000,
  3 * 60_000,
  2 * 60_000,
  60_000,
] as const;

const log = createSubsystemLogger("gateway/main-cache-keeper");

type CacheTouchModel = Model<"anthropic-messages">;

export type MainSessionCacheTouchStage = {
  agentId: string;
  apiKey: string;
  headers?: Record<string, string>;
  model: CacheTouchModel;
  payload: Record<string, unknown>;
  providerCallStartedAt: number;
  runId: string;
  sessionFile: string;
  sessionId: string;
  sessionKey: string;
};

export type MainSessionCacheTouchParent = MainSessionCacheTouchStage & {
  anchorId: string;
  confirmedAtMs: number;
  expectedCachedTokens: number;
  generation: string;
  hardFailures: number;
  nextAttemptAtMs: number;
};

export type CacheTouchObservation = {
  attempt: number;
  confirmedAtMs: number;
  expectedCachedTokens: number;
  result: AnthropicPromptCacheTouchResult;
};

export type MainSessionCacheKeeperDeps = {
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  persistObservation: (
    parent: MainSessionCacheTouchParent,
    observation: CacheTouchObservation,
  ) => Promise<string | undefined>;
  readActiveLeafId: (parent: MainSessionCacheTouchParent) => Promise<string | null>;
  setInterval: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  touch: (parent: MainSessionCacheTouchParent) => Promise<AnthropicPromptCacheTouchResult>;
};

async function readActiveLeafId(parent: MainSessionCacheTouchParent): Promise<string | null> {
  return SessionManager.open(parent.sessionFile).getLeafId();
}

async function persistCacheTouchObservation(
  parent: MainSessionCacheTouchParent,
  observation: CacheTouchObservation,
): Promise<string | undefined> {
  let lock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;
  try {
    // Metadata persistence is optional and must yield immediately to a foreground main turn.
    lock = await acquireSessionWriteLock({ sessionFile: parent.sessionFile, timeoutMs: 100 });
    const manager = SessionManager.open(parent.sessionFile);
    if (manager.getLeafId() !== parent.anchorId) {
      return undefined;
    }
    const usage = observation.result.usage;
    return manager.appendCustomEntry(MAIN_SESSION_CACHE_TOUCH_CUSTOM_TYPE, {
      timestamp: observation.confirmedAtMs,
      agentId: parent.agentId,
      sessionId: parent.sessionId,
      provider: parent.model.provider,
      modelId: parent.model.id,
      mode: observation.result.mode,
      attempt: observation.attempt,
      expectedCachedTokens: observation.expectedCachedTokens,
      usage: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        cacheWrite1h: usage.cacheWrite1h,
        totalTokens: usage.totalTokens,
        costUsd: usage.cost.total,
      },
    });
  } finally {
    await lock?.release();
  }
}

function createDefaultDeps(): MainSessionCacheKeeperDeps {
  return {
    clearInterval: (timer) => clearInterval(timer),
    clearTimeout: (timer) => clearTimeout(timer),
    now: Date.now,
    persistObservation: persistCacheTouchObservation,
    readActiveLeafId,
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    touch: (parent) =>
      touchAnthropicPromptCache({
        model: parent.model,
        payload: parent.payload,
        apiKey: parent.apiKey,
        ...(parent.headers ? { headers: parent.headers } : {}),
      }),
  };
}

export class MainSessionCacheKeeperRuntime {
  private readonly activeRunByAgent = new Map<string, string>();
  private readonly inFlightAgents = new Set<string>();
  private readonly parents = new Map<string, MainSessionCacheTouchParent>();
  private readonly stagedByRun = new Map<string, MainSessionCacheTouchStage>();
  private preciseTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: MainSessionCacheKeeperDeps = createDefaultDeps()) {}

  start(): { stop: () => void; updateConfig: () => void } {
    if (!this.running) {
      this.running = true;
      this.watchdogTimer = this.deps.setInterval(
        () => this.reconcile(),
        MAIN_SESSION_CACHE_TOUCH_WATCHDOG_MS,
      );
      this.watchdogTimer.unref?.();
      this.reconcile();
    }
    return { stop: () => this.stop(), updateConfig: () => this.invalidateAll() };
  }

  stop(): void {
    this.running = false;
    if (this.preciseTimer) {
      this.deps.clearTimeout(this.preciseTimer);
      this.preciseTimer = null;
    }
    if (this.watchdogTimer) {
      this.deps.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.invalidateAll();
  }

  invalidateAll(): void {
    // Model, endpoint, and credential changes cannot reuse a parent captured
    // under the previous config snapshot. The next main turn creates a new one.
    this.activeRunByAgent.clear();
    this.inFlightAgents.clear();
    this.parents.clear();
    this.stagedByRun.clear();
    this.reconcile();
  }

  stage(candidate: MainSessionCacheTouchStage): boolean {
    if (
      !candidate.apiKey.trim() ||
      !isDirectAnthropicPromptCacheTouchModel(candidate.model) ||
      !isAnthropicPromptCacheTouchPayload(candidate.payload)
    ) {
      this.discard(candidate.runId);
      return false;
    }
    const stage = {
      ...candidate,
      ...(candidate.headers ? { headers: { ...candidate.headers } } : {}),
      payload: structuredClone(candidate.payload),
    };
    this.stagedByRun.set(candidate.runId, stage);
    this.activeRunByAgent.set(candidate.agentId, candidate.runId);
    this.reconcile();
    return true;
  }

  commit(params: { anchorId: string; expectedCachedTokens: number; runId: string }): boolean {
    const staged = this.stagedByRun.get(params.runId);
    if (
      !staged ||
      !params.anchorId ||
      !Number.isFinite(params.expectedCachedTokens) ||
      params.expectedCachedTokens <= 0
    ) {
      return false;
    }
    const expectedCachedTokens = Math.floor(params.expectedCachedTokens);
    const generation = `${staged.runId}:${staged.providerCallStartedAt}`;
    const current = this.parents.get(staged.agentId);
    if (!current || staged.providerCallStartedAt >= current.confirmedAtMs) {
      this.parents.set(staged.agentId, {
        ...staged,
        anchorId: params.anchorId,
        confirmedAtMs: staged.providerCallStartedAt,
        expectedCachedTokens,
        generation,
        hardFailures: 0,
        nextAttemptAtMs: staged.providerCallStartedAt + MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS,
      });
    }
    this.stagedByRun.delete(params.runId);
    if (this.activeRunByAgent.get(staged.agentId) === params.runId) {
      this.activeRunByAgent.delete(staged.agentId);
    }
    this.reconcile();
    return true;
  }

  discard(runId: string): void {
    const staged = this.stagedByRun.get(runId);
    this.stagedByRun.delete(runId);
    if (staged && this.activeRunByAgent.get(staged.agentId) === runId) {
      this.activeRunByAgent.delete(staged.agentId);
      this.reconcile();
    }
  }

  private reconcile(): void {
    if (!this.running) {
      return;
    }
    if (this.preciseTimer) {
      this.deps.clearTimeout(this.preciseTimer);
      this.preciseTimer = null;
    }
    const nowMs = this.deps.now();
    const due = [...this.parents.values()]
      .filter(
        (parent) => Number.isFinite(parent.nextAttemptAtMs) && parent.nextAttemptAtMs <= nowMs,
      )
      .toSorted((left, right) => left.nextAttemptAtMs - right.nextAttemptAtMs);
    const runnable = due.find(
      (parent) =>
        !this.activeRunByAgent.has(parent.agentId) && !this.inFlightAgents.has(parent.agentId),
    );
    if (runnable) {
      this.inFlightAgents.add(runnable.agentId);
      void this.execute(runnable).finally(() => {
        this.inFlightAgents.delete(runnable.agentId);
        this.reconcile();
      });
      return;
    }
    const nextAtMs = Math.min(
      ...[...this.parents.values()].map((parent) => parent.nextAttemptAtMs).filter(Number.isFinite),
    );
    if (!Number.isFinite(nextAtMs)) {
      return;
    }
    const blockedDue = due.length > 0;
    const delayMs = blockedDue
      ? MAIN_SESSION_CACHE_TOUCH_WATCHDOG_MS
      : Math.max(0, nextAtMs - nowMs);
    this.preciseTimer = this.deps.setTimeout(() => {
      this.preciseTimer = null;
      this.reconcile();
    }, delayMs);
    this.preciseTimer.unref?.();
  }

  private async execute(parent: MainSessionCacheTouchParent): Promise<void> {
    const liveParent = this.parents.get(parent.agentId);
    if (!liveParent || liveParent.generation !== parent.generation) {
      return;
    }
    let activeLeafId: string | null;
    try {
      activeLeafId = await this.deps.readActiveLeafId(parent);
    } catch (error) {
      parent.nextAttemptAtMs = this.deps.now() + MAIN_SESSION_CACHE_TOUCH_WATCHDOG_MS;
      log.debug(`main cache-touch leaf check deferred: ${String(error)}`);
      return;
    }
    if (activeLeafId !== parent.anchorId) {
      this.parents.delete(parent.agentId);
      log.debug(
        `main cache-touch parent superseded: agent=${parent.agentId} session=${parent.sessionId}`,
      );
      return;
    }

    const attemptStartedAtMs = this.deps.now();
    try {
      const result = await this.deps.touch(parent);
      const confirmedCachedTokens = result.usage.cacheRead + result.usage.cacheWrite;
      if (confirmedCachedTokens < parent.expectedCachedTokens) {
        throw new Error(
          `cache coverage ${confirmedCachedTokens} below expected ${parent.expectedCachedTokens}`,
        );
      }
      const current = this.parents.get(parent.agentId);
      if (!current || current.generation !== parent.generation) {
        return;
      }
      const attempt = current.hardFailures + 1;
      current.confirmedAtMs = attemptStartedAtMs;
      current.hardFailures = 0;
      current.nextAttemptAtMs = attemptStartedAtMs + MAIN_SESSION_CACHE_TOUCH_INTERVAL_MS;
      const anchorId = await this.deps
        .persistObservation(current, {
          attempt,
          confirmedAtMs: attemptStartedAtMs,
          expectedCachedTokens: parent.expectedCachedTokens,
          result,
        })
        .catch((error: unknown) => {
          log.debug(`main cache-touch observation not persisted: ${String(error)}`);
          return undefined;
        });
      if (anchorId && this.parents.get(parent.agentId)?.generation === parent.generation) {
        current.anchorId = anchorId;
      }
      log.info(
        `main cache touched: agent=${parent.agentId} session=${parent.sessionId} ` +
          `mode=${result.mode} cacheRead=${result.usage.cacheRead} ` +
          `cacheWrite=${result.usage.cacheWrite} costUsd=${result.usage.cost.total.toFixed(6)}`,
      );
    } catch (error) {
      const current = this.parents.get(parent.agentId);
      if (!current || current.generation !== parent.generation) {
        return;
      }
      const retryDelayMs = MAIN_SESSION_CACHE_TOUCH_RETRY_DELAYS_MS[current.hardFailures];
      current.hardFailures += 1;
      if (retryDelayMs === undefined) {
        // Five failed provider attempts are the complete safety window. Drop
        // the payload and credential until a new foreground main turn succeeds.
        this.parents.delete(parent.agentId);
      } else {
        current.nextAttemptAtMs = attemptStartedAtMs + retryDelayMs;
      }
      const retryDescription =
        retryDelayMs === undefined ? "retries exhausted" : `retryInMs=${retryDelayMs}`;
      log.warn(
        `main cache touch failed: agent=${parent.agentId} session=${parent.sessionId} ` +
          `attempt=${current.hardFailures} ${retryDescription} error=${String(error)}`,
      );
    }
  }
}

const MAIN_SESSION_CACHE_KEEPER_KEY = Symbol.for("openclaw.mainSessionCacheKeeper");
const mainSessionCacheKeeper = resolveGlobalSingleton(
  MAIN_SESSION_CACHE_KEEPER_KEY,
  () => new MainSessionCacheKeeperRuntime(),
);

export function startMainSessionCacheKeeper(): { stop: () => void; updateConfig: () => void } {
  return mainSessionCacheKeeper.start();
}

export function stageMainSessionCacheTouch(candidate: MainSessionCacheTouchStage): boolean {
  return mainSessionCacheKeeper.stage(candidate);
}

export function commitMainSessionCacheTouch(params: {
  anchorId: string;
  expectedCachedTokens: number;
  runId: string;
}): boolean {
  return mainSessionCacheKeeper.commit(params);
}

export function discardMainSessionCacheTouch(runId: string): void {
  mainSessionCacheKeeper.discard(runId);
}
