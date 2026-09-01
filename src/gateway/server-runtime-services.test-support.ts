import { vi } from "vitest";

export function createLog() {
  return {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export const createTestCron = () => ({ start: vi.fn<() => Promise<void>>(async () => {}) });

export function createTestCronState(
  cron: { start: () => Promise<void> } = createTestCron(),
  cronEnabled = true,
) {
  return {
    cron,
    storePath: "/tmp/cron.json",
    cronEnabled,
  } as never;
}

export function createTestCronReconciliation(complete: () => Promise<void> = async () => {}) {
  const completeMock = vi.fn<() => Promise<void>>(complete);
  return {
    arm: vi.fn<() => { complete: () => Promise<void> }>(() => ({ complete: completeMock })),
    complete: completeMock,
    invalidate: vi.fn(),
  };
}

export function createMaintenanceHandles() {
  return {
    tickInterval: setInterval(() => undefined, 60_000),
    healthInterval: setInterval(() => undefined, 60_000),
    dedupeCleanup: setInterval(() => undefined, 60_000),
    startMediaCleanup: vi.fn(async () => undefined),
    stopMediaCleanup: vi.fn(async () => "drained" as const),
    worktreeCleanup: setInterval(() => undefined, 60_000),
    skillUsageCleanup: vi.fn(),
  };
}
