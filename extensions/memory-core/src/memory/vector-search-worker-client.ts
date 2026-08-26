// Memory Core plugin module owns the isolated vector-search worker lifecycle.
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { SearchRowResult } from "./manager-search.js";

type VectorSearchWorkerRequestPayload =
  | {
      type: "initialize";
      databasePath: string;
      extensionPath?: string;
    }
  | {
      type: "search";
      providerModel: string;
      providerModelAliases?: string[];
      queryVec: number[];
      limit: number;
      snippetMaxChars: number;
      sources: MemorySource[];
      nativeEligible: boolean;
    }
  | { type: "close" };

type VectorSearchWorkerRequest = VectorSearchWorkerRequestPayload & { id: number };

type VectorSearchWorkerResponse =
  | { id: number; ok: true; value?: SearchRowResult[] }
  | { id: number; ok: false; error: { message: string; code?: string } };

type PendingRequest = {
  resolve: (value: SearchRowResult[] | undefined) => void;
  reject: (error: unknown) => void;
  abort?: () => void;
};

export type VectorSearchWorkerStatus = {
  execution: "child-process";
  pid?: number;
  starts: number;
  lastError?: string;
};

const WORKER_CLOSE_GRACE_MS = 500;
const SAFE_ENV_KEYS = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
] as const;

function resolveDefaultWorkerScriptPath(): string {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentPath);
  const currentName = path.basename(currentPath);
  const sibling =
    extension === ".ts"
      ? "vector-search-worker-child.ts"
      : currentName.startsWith("vector-search-worker-client.")
        ? "vector-search-worker-child.js"
        : "memory-core-vector-search-worker.js";
  return path.join(path.dirname(currentPath), sibling);
}

function isTrustedTsxLoader(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized === "tsx" ||
    normalized.startsWith("tsx/") ||
    /\/node_modules\/tsx\/dist\/(?:loader|esm)\.[cm]?js(?:\?.*)?$/u.test(normalized)
  );
}

function resolveWorkerExecArgv(workerScriptPath: string): string[] {
  if (path.extname(workerScriptPath) !== ".ts") {
    return [];
  }
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index] ?? "";
    if (arg === "--enable-source-maps") {
      args.push(arg);
      continue;
    }
    if (arg === "--conditions" && process.execArgv[index + 1] === "development") {
      args.push(arg, "development");
      index += 1;
      continue;
    }
    if (arg === "--conditions=development") {
      args.push(arg);
      continue;
    }
    if (arg === "--import" || arg === "--loader") {
      const loader = process.execArgv[index + 1];
      if (loader && isTrustedTsxLoader(loader)) {
        args.push(arg, loader);
      }
      index += 1;
      continue;
    }
    const loaderMatch = arg.match(/^--(?:import|loader)=(.+)$/u);
    if (loaderMatch?.[1] && isTrustedTsxLoader(loaderMatch[1])) {
      args.push(arg);
    }
  }
  return args;
}

function resolveWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function responseError(response: VectorSearchWorkerResponse & { ok: false }): Error {
  const error = new Error(response.error.message || "Vector search worker failed") as Error & {
    code?: string;
  };
  if (response.error.code) {
    error.code = response.error.code;
  }
  return error;
}

function workerExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  return new Error(
    `Vector search worker exited unexpectedly (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
  );
}

function signalAbortError(signal: AbortSignal): Error {
  return toErrorObject(
    signal.reason ?? new Error("Vector search aborted"),
    "Vector search aborted",
  );
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      child.off("exit", onExit);
      child.off("close", onExit);
      clearTimeout(timeout);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    child.once("exit", onExit);
    child.once("close", onExit);
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    timeout.unref?.();
  });
}

export class VectorSearchWorkerClient {
  private child: ChildProcess | null = null;
  private initializedChild: ChildProcess | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private requestTail: Promise<void> = Promise.resolve();
  private stoppingChildren = new Map<ChildProcess, Promise<void>>();
  private starts = 0;
  private lastError?: string;

  constructor(
    private readonly options: {
      databasePath: string;
      extensionPath?: string;
      workerScriptPath?: string;
    },
  ) {}

  status(): VectorSearchWorkerStatus {
    return {
      execution: "child-process",
      pid: this.child?.pid,
      starts: this.starts,
      lastError: this.lastError,
    };
  }

  async search(
    params: Omit<Extract<VectorSearchWorkerRequestPayload, { type: "search" }>, "type">,
    signal?: AbortSignal,
  ): Promise<SearchRowResult[]> {
    return await this.enqueue(async () => {
      signal?.throwIfAborted();
      await this.ensureInitialized(signal);
      const result = await this.send({ type: "search", ...params }, signal);
      return result ?? [];
    }, signal);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.enqueue(async () => await this.ensureInitialized(signal), signal);
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closed = true;
    const close = this.enqueue(async () => {
      const child = this.child;
      if (!child) {
        return;
      }
      if (child.connected) {
        await Promise.race([
          this.sendToChild(child, { type: "close" }, undefined, true).catch(() => undefined),
          new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, WORKER_CLOSE_GRACE_MS);
            timeout.unref?.();
          }),
        ]);
      }
      await this.stopChild(child);
    });
    this.closePromise = close;
    return await close;
  }

  private async enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (error: unknown) => void;
    let canceled = false;
    let started = false;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const onAbort = signal
      ? () => {
          if (started) {
            return;
          }
          canceled = true;
          rejectResult(signalAbortError(signal));
        }
      : undefined;
    if (signal && onAbort) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const execute = async () => {
      started = true;
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
      if (canceled) {
        return;
      }
      try {
        resolveResult(await run());
      } catch (error) {
        rejectResult(error);
      }
    };
    this.requestTail = this.requestTail.then(execute, execute);
    return await result;
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      throw new Error("Vector search worker client is closed");
    }
    const child = this.ensureChild();
    if (this.initializedChild === child) {
      return;
    }
    await this.send(
      {
        type: "initialize",
        databasePath: this.options.databasePath,
        extensionPath: this.options.extensionPath,
      },
      signal,
    );
    this.initializedChild = child;
  }

  private ensureChild(): ChildProcess {
    const current = this.child;
    if (current?.connected) {
      return current;
    }
    if (current && current.exitCode === null && current.signalCode === null) {
      throw new Error("Vector search worker IPC disconnected before process termination");
    }
    const workerScriptPath = this.options.workerScriptPath ?? resolveDefaultWorkerScriptPath();
    const child = fork(workerScriptPath, [], {
      env: resolveWorkerEnv(),
      execArgv: resolveWorkerExecArgv(workerScriptPath),
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.starts += 1;
    child.on("message", (message) => this.handleMessage(message));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.initializedChild = null;
      }
      const error = workerExitError(code, signal);
      this.lastError = error.message;
      this.rejectPending(error);
    });
    child.on("close", () => {
      if (this.child === child) {
        this.child = null;
        this.initializedChild = null;
      }
    });
    child.on("error", (error) => {
      this.lastError = error.message;
      this.rejectPending(new Error(`Vector search worker process failed: ${error.message}`));
    });
    this.child = child;
    return child;
  }

  private async send(
    request: VectorSearchWorkerRequestPayload,
    signal?: AbortSignal,
    allowClosed = false,
  ): Promise<SearchRowResult[] | undefined> {
    if (this.closed && !allowClosed) {
      throw new Error("Vector search worker client is closed");
    }
    signal?.throwIfAborted();
    return await this.sendToChild(this.ensureChild(), request, signal, allowClosed);
  }

  private async sendToChild(
    child: ChildProcess,
    request: VectorSearchWorkerRequestPayload,
    signal?: AbortSignal,
    allowClosed = false,
  ): Promise<SearchRowResult[] | undefined> {
    if (this.closed && !allowClosed) {
      throw new Error("Vector search worker client is closed");
    }
    signal?.throwIfAborted();
    const id = this.nextRequestId++;
    const payload = { ...request, id } as VectorSearchWorkerRequest;
    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (signal) {
        const abort = () => {
          this.pending.delete(id);
          pending.abort?.();
          const abortError = signalAbortError(signal);
          // Join process teardown before releasing the serialized request lane;
          // the next search can then spawn a fresh child instead of racing a
          // disconnected process that is still exiting.
          void this.stopChild(child).then(
            () => reject(abortError),
            (error: unknown) => {
              const stopError = toErrorObject(error, "Vector search worker stop failed");
              this.lastError = stopError.message;
              reject(stopError);
            },
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.abort = () => signal.removeEventListener("abort", abort);
      }
      this.pending.set(id, pending);
      child.send(payload, (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(id);
        pending.abort?.();
        reject(new Error(`Vector search worker IPC failed: ${error.message}`));
      });
    });
  }

  private handleMessage(message: unknown): void {
    const response = message as Partial<VectorSearchWorkerResponse>;
    if (typeof response.id !== "number") {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    pending.abort?.();
    if (response.ok) {
      this.lastError = undefined;
      pending.resolve(response.value);
      return;
    }
    const error = responseError(response as VectorSearchWorkerResponse & { ok: false });
    this.lastError = error.message;
    pending.reject(error);
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    const existing = this.stoppingChildren.get(child);
    if (existing) {
      return await existing;
    }
    const stopping = (async () => {
      if (child.connected) {
        child.disconnect();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        if (!(await waitForExit(child, WORKER_CLOSE_GRACE_MS))) {
          child.kill("SIGKILL");
          if (!(await waitForExit(child, WORKER_CLOSE_GRACE_MS))) {
            throw new Error("Vector search worker did not exit after SIGKILL");
          }
        }
      }
      if (this.child === child) {
        this.child = null;
        this.initializedChild = null;
      }
      this.rejectPending(new Error("Vector search worker stopped"));
    })();
    this.stoppingChildren.set(child, stopping);
    try {
      await stopping;
    } finally {
      this.stoppingChildren.delete(child);
    }
  }

  private rejectPending(error: unknown): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.abort?.();
      entry.reject(error);
    }
  }
}
