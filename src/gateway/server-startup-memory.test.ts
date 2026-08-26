/** Gateway startup memory-service tests. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const { getMemorySearchManagerMock, resolveMemorySearchConfigMock } = vi.hoisted(() => ({
  getMemorySearchManagerMock: vi.fn(),
  resolveMemorySearchConfigMock: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries: (cfg: OpenClawConfig) => cfg.agents?.list ?? [],
  listAgentIds: (cfg: OpenClawConfig) => cfg.agents?.list?.map((entry) => entry.id) ?? ["main"],
  resolveDefaultAgentId: (cfg: OpenClawConfig) =>
    cfg.agents?.list?.find((entry) => entry.default)?.id ?? "main",
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: resolveMemorySearchConfigMock,
}));

import { startGatewayMemoryBackend } from "./server-startup-memory.js";

function createGatewayLogMock() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("startGatewayMemoryBackend", () => {
  beforeEach(() => {
    getMemorySearchManagerMock.mockClear();
    resolveMemorySearchConfigMock.mockReset().mockReturnValue({
      store: { vector: { enabled: true, execution: "in-process" } },
    });
  });

  it("skips initialization when memory backend is not qmd", async () => {
    const log = createGatewayLogMock();
    await startGatewayMemoryBackend({
      cfg: { agents: { list: [{ id: "main", default: true }] }, memory: { backend: "builtin" } },
      log,
    });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps qmd managers lazy under the fixed startup policy", async () => {
    const log = createGatewayLogMock();
    await startGatewayMemoryBackend({
      cfg: { agents: { list: [{ id: "main", default: true }] }, memory: { backend: "qmd" } },
      log,
    });

    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warms an opted-in builtin vector worker before Gateway readiness", async () => {
    const warmVectorSearch = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({
      manager: { warmVectorSearch },
      error: undefined,
    });
    resolveMemorySearchConfigMock.mockReturnValue({
      store: { vector: { enabled: true, execution: "child-process" } },
    });
    const log = createGatewayLogMock();

    await startGatewayMemoryBackend({
      cfg: { agents: { list: [{ id: "main", default: true }] }, memory: { backend: "builtin" } },
      log,
    });

    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "main",
      purpose: "default",
    });
    expect(warmVectorSearch).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(log.info).toHaveBeenCalledWith(
      'builtin memory vector worker warmed for 1 agent: "main"',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps Gateway startup available when builtin vector warmup fails", async () => {
    getMemorySearchManagerMock.mockResolvedValue({
      manager: {
        warmVectorSearch: vi.fn(async () => {
          throw new Error("worker unavailable");
        }),
      },
      error: undefined,
    });
    resolveMemorySearchConfigMock.mockReturnValue({
      store: { vector: { enabled: true, execution: "child-process" } },
    });
    const log = createGatewayLogMock();

    await startGatewayMemoryBackend({
      cfg: { agents: { list: [{ id: "main", default: true }] }, memory: { backend: "builtin" } },
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("builtin memory vector worker warmup failed"),
    );
  });
});
