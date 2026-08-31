#!/usr/bin/env node
export type TsdownBuildInvocation = {
  command: string;
  args: string[];
  options: {
    env: NodeJS.ProcessEnv;
    shell: boolean;
    stdio: string[];
    windowsVerbatimArguments: boolean | undefined;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
export type TsdownBuildInvocationParams = {
  args?: string[];
  comSpec?: string;
  env?: NodeJS.ProcessEnv;
  nodeExecPath?: string;
  npmExecPath?: string;
  platform?: NodeJS.Platform;
  [key: string]: unknown;
};
/**
 * Removes build output roots while preserving explicitly protected artifacts.
 */
export function cleanTsdownOutputRoots(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof import("node:fs");
  roots?: string[];
}): void;
export function pruneStaleRootChunkFiles(params?: Record<string, unknown>): void;
export function listTsdownOutputRoots(): string[];
export function resolveTsdownCleanOutputRoots(args?: string[]): string[];
export function pruneUntrackedGeneratedSourceDeclarations(params?: Record<string, unknown>): number;
export function pruneSourceCheckoutBundledPluginNodeModules(params?: Record<string, unknown>): void;
export function parseTsdownBuildArgs(argv: unknown): {
  forwardedArgs: unknown;
  help: boolean;
};
export function createTsdownOutputScanner(params?: Record<string, unknown>): {
  append(chunk: unknown): void;
  finish(): {
    captured: string;
    hasIneffectiveDynamicImport: boolean;
    fatalUnresolvedImport: unknown;
  };
};
export function resolveTsdownBuildInvocation(
  params?: TsdownBuildInvocationParams,
): TsdownBuildInvocation;
export function isTsdownMemoryFailure(result: {
  captured?: string;
  oomKilled?: boolean;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  timedOut?: boolean;
}): boolean;
export function resolveTsdownLowMemoryRetryInvocation(
  invocation: TsdownBuildInvocation,
): TsdownBuildInvocation | null;
/** Builds declarations in dependency order without overlapping the largest graphs. */
export function resolveTsdownBuildInvocations(
  params?: TsdownBuildInvocationParams,
): TsdownBuildInvocation[];
export function signalTsdownBuildProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): unknown },
  signal: NodeJS.Signals,
  {
    platform,
    runTaskkill,
    useProcessGroup,
  }?: {
    platform?: NodeJS.Platform | undefined;
    runTaskkill?:
      | ((
          command: string,
          args: string[],
          options: { stdio: "ignore" },
        ) => { error?: Error; status: number | null })
      | undefined;
    useProcessGroup?: boolean | undefined;
  },
): void;
export function runTsdownBuildInvocation(
  invocation: unknown,
  params?: Record<string, unknown>,
): Promise<{
  captured: string;
  hasIneffectiveDynamicImport: boolean;
  oomKilled: boolean;
  signal: NodeJS.Signals | null;
  status: number | null;
  timedOut: boolean;
}>;
