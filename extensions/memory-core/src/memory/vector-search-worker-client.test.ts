// Memory Core tests cover isolated vector-search process lifecycle and secret boundaries.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, fork: forkMock };
});

import { VectorSearchWorkerClient } from "./vector-search-worker-client.js";

type WorkerMessage = { id: number; type: "initialize" | "search" | "close" };

function createChild(params?: { hangInitialize?: boolean; hangSearch?: boolean; pid?: number }) {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    pid: params?.pid ?? 1234,
    disconnect: vi.fn(function (this: { connected: boolean }) {
      this.connected = false;
    }),
    kill: vi.fn(function (
      this: EventEmitter & { signalCode: NodeJS.Signals | null },
      signal: NodeJS.Signals,
    ) {
      this.signalCode = signal;
      queueMicrotask(() => {
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
      });
      return true;
    }),
    send: vi.fn(function (
      this: EventEmitter,
      message: WorkerMessage,
      callback: (error?: Error | null) => void,
    ) {
      callback();
      if (
        (message.type === "initialize" && params?.hangInitialize) ||
        (message.type === "search" && params?.hangSearch)
      ) {
        return true;
      }
      queueMicrotask(() =>
        this.emit("message", {
          id: message.id,
          ok: true,
          ...(message.type === "search" ? { value: [] } : {}),
        }),
      );
      return true;
    }),
  });
  return child;
}

function searchParams() {
  return {
    providerModel: "test-model",
    queryVec: [1, 0],
    limit: 2,
    snippetMaxChars: 200,
    sources: ["memory" as const],
    nativeEligible: true,
  };
}

const originalExecArgv = [...process.execArgv];
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalHome = process.env.HOME;

describe("VectorSearchWorkerClient", () => {
  beforeEach(() => {
    forkMock.mockReset();
  });

  afterEach(() => {
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  });

  it("forks built workers without credentials, HOME, or inherited Node argv", async () => {
    const child = createChild();
    forkMock.mockReturnValue(child);
    process.env.OPENAI_API_KEY = "must-not-cross-process-boundary";
    process.env.HOME = "/credential-bearing-home";
    process.execArgv.push(
      "--inspect",
      "--eval",
      "process.env.OPENAI_API_KEY",
      "--env-file",
      "/credential-bearing-env",
      "--require",
      "/credential-bearing-preload.cjs",
    );
    const client = new VectorSearchWorkerClient({
      databasePath: "/tmp/memory.sqlite",
      workerScriptPath: "/mock/vector-worker.cjs",
    });

    await client.initialize();

    const options = forkMock.mock.calls[0]?.[2];
    expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options?.env).not.toHaveProperty("HOME");
    expect(options?.execArgv).toEqual([]);
    await client.close();
  });

  it("allows only the trusted tsx loader flags for source workers", async () => {
    const child = createChild();
    forkMock.mockReturnValue(child);
    process.execArgv.push(
      "--import",
      "tsx",
      "--conditions=development",
      "--enable-source-maps",
      "--env-file=/credential-bearing-env",
      "--import=/credential-bearing-preload.mjs",
    );
    const client = new VectorSearchWorkerClient({
      databasePath: "/tmp/memory.sqlite",
      workerScriptPath: "/mock/vector-worker.ts",
    });

    await client.initialize();

    expect(forkMock.mock.calls[0]?.[2]?.execArgv).toEqual([
      "--conditions",
      "development",
      "--import",
      "tsx",
      "--conditions=development",
      "--enable-source-maps",
    ]);
    await client.close();
  });

  it("terminates a worker when initialization is aborted", async () => {
    const first = createChild({ hangInitialize: true, pid: 1001 });
    const second = createChild({ pid: 1002 });
    forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new VectorSearchWorkerClient({
      databasePath: "/tmp/memory.sqlite",
      workerScriptPath: "/mock/vector-worker.cjs",
    });
    const controller = new AbortController();
    const initializing = client.initialize(controller.signal);
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));

    controller.abort(new Error("warmup timed out"));

    await expect(initializing).rejects.toThrow("warmup timed out");
    await expect(client.search(searchParams())).resolves.toEqual([]);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(client.status()).toMatchObject({ pid: 1002, starts: 2 });
    await client.close();
  });

  it("kills an aborted worker and respawns before the next search", async () => {
    const first = createChild({ hangSearch: true, pid: 1001 });
    const second = createChild({ pid: 1002 });
    forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new VectorSearchWorkerClient({
      databasePath: "/tmp/memory.sqlite",
      workerScriptPath: "/mock/vector-worker.cjs",
    });
    const controller = new AbortController();
    const firstSearch = client.search(searchParams(), controller.signal);
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(2));

    controller.abort(new Error("search timed out"));

    await expect(firstSearch).rejects.toThrow("search timed out");
    await expect(client.search(searchParams())).resolves.toEqual([]);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(client.status()).toMatchObject({ pid: 1002, starts: 2 });
    await client.close();
  });

  it("serializes searches so one cancellation cannot kill another request", async () => {
    const first = createChild({ hangSearch: true, pid: 1001 });
    const second = createChild({ pid: 1002 });
    forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const client = new VectorSearchWorkerClient({
      databasePath: "/tmp/memory.sqlite",
      workerScriptPath: "/mock/vector-worker.cjs",
    });
    const controller = new AbortController();
    const canceled = client.search(searchParams(), controller.signal);
    const queued = client.search(searchParams());
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(2));

    controller.abort(new Error("cancel first"));

    await expect(canceled).rejects.toThrow("cancel first");
    await expect(queued).resolves.toEqual([]);
    expect(second.send).toHaveBeenCalledTimes(2);
    await client.close();
  });

  it("rejects a canceled queued search without killing the active worker", async () => {
    const child = createChild({ hangSearch: true, pid: 1001 });
    forkMock.mockReturnValue(child);
    const client = new VectorSearchWorkerClient({
      databasePath: "/tmp/memory.sqlite",
      workerScriptPath: "/mock/vector-worker.cjs",
    });
    const activeController = new AbortController();
    const active = client.search(searchParams(), activeController.signal);
    await vi.waitFor(() => expect(child.send).toHaveBeenCalledTimes(2));
    const queuedController = new AbortController();
    const queued = client.search(searchParams(), queuedController.signal);

    queuedController.abort(new Error("queued search timed out"));

    await expect(queued).rejects.toThrow("queued search timed out");
    expect(child.kill).not.toHaveBeenCalled();
    activeController.abort(new Error("stop active search"));
    await expect(active).rejects.toThrow("stop active search");
    await client.close();
  });
});
