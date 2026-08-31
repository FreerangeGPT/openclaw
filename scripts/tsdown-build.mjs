#!/usr/bin/env node

// Runs the tsdown build with output cleanup, stale chunk pruning, and bounded
// child-process diagnostics.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "./lib/bundled-plugin-paths.mjs";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
} from "./lib/tsdown-config-groups.mjs";
import {
  TSDOWN_PACKAGE_OUTPUT_ROOTS,
  tsdownPackageOutputRoot,
} from "./lib/tsdown-output-roots.mjs";
import { resolveWindowsTaskkillPath } from "./lib/windows-taskkill.mjs";
import { resolvePnpmRunner } from "./pnpm-runner.mjs";
import {
  isSourceCheckoutRoot,
  pruneBundledPluginSourceNodeModules,
} from "./postinstall-bundled-plugins.mjs";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const INEFFECTIVE_DYNAMIC_IMPORT_MARKER = "[INEFFECTIVE_DYNAMIC_IMPORT]";
const UNRESOLVED_IMPORT_RE = /\[UNRESOLVED_IMPORT\]/;
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const DEPENDENCY_PATH_MARKERS = ["node_modules/", "openclaw-pnpm-node-modules/"];
const HASHED_ROOT_JS_RE = /^(?<base>.+)-[A-Za-z0-9_-]+\.js$/u;
const DEFAULT_CAPTURE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_TSDOWN_MAX_OLD_SPACE_MB = 12288;
const DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB = 8192;
const TSDOWN_MAX_OLD_SPACE_MB_ENV = "OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB";
// The full declaration pipeline passes at 6 GiB without swap; the package and
// unified graphs both fail under the next-lower 5 GiB tier.
const MIN_DECLARATION_BUILD_MEMORY_MB = 6 * 1024;
const MIN_TSDOWN_MEMORY_HEADROOM_MB = 2048;
const TSDOWN_MEMORY_HEADROOM_DIVISOR = 3;
const TSGO_RESIDENT_NODE_HEADROOM_MB = 1024;
// The standard TypeScript declaration graph currently peaks just below 11 GiB.
// Below this heap budget, skip directly to tsgo so the OS can keep the build alive.
const STANDARD_DTS_MIN_HEAP_MB = 11 * 1024;
const LOW_MEMORY_TSDOWN_CONFIG_PATH = "tsdown.low-memory.config.ts";
const CGROUP_MEMORY_LIMIT_PATHS = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
];
const CGROUP_V2_ROOT = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY_ROOT = "/sys/fs/cgroup/memory";
const PROC_SELF_CGROUP_PATH = "/proc/self/cgroup";
const PROC_MEMINFO_PATH = "/proc/meminfo";
const PROC_VMSTAT_PATH = "/proc/vmstat";
// Build descendants get a short cleanup window; a timed-out build must not hold CI for seconds.
const TERMINATION_GRACE_MS = 250;
const PROCESS_GROUP_EXIT_POLL_MS = 25;
const POST_FORCE_KILL_WAIT_MS = 250;
const ROOT_TSDOWN_OUTPUT_ROOTS = ["dist", "dist-runtime"];
const PRESERVED_TSDOWN_OUTPUT_FILES = ["dist/cli-startup-metadata.json"];
const PRESERVE_CLI_STARTUP_METADATA_ENV = "OPENCLAW_PRESERVE_CLI_STARTUP_METADATA";
const GENERATED_SOURCE_DECLARATION_PATHSPEC = ":(glob)extensions/**/*.d.ts";
const DECLARATION_EXTENSIONS = [".d.ts", ".d.mts", ".d.cts"];
const SOURCE_DECLARATION_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const RUN_NODE_SKIP_DTS_BUILD_ENV = "OPENCLAW_RUN_NODE_SKIP_DTS_BUILD";

function declarationsEnabled(args, env) {
  let enabled = env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1";
  for (const arg of args) {
    if (arg === "--dts") {
      enabled = true;
    } else if (arg === "--no-dts") {
      enabled = false;
    }
  }
  return enabled;
}

function removeDistPluginNodeModulesSymlinks(rootDir) {
  const extensionsDir = path.join(rootDir, "extensions");
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  for (const dirent of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const nodeModulesPath = path.join(extensionsDir, dirent.name, "node_modules");
    try {
      if (fs.lstatSync(nodeModulesPath).isSymbolicLink()) {
        fs.rmSync(nodeModulesPath, { force: true, recursive: true });
      }
    } catch {
      // Skip missing or unreadable paths so the build can proceed.
    }
  }
}

function pruneStaleRuntimeSymlinks() {
  const cwd = process.cwd();
  // runtime-postbuild stages plugin-owned node_modules into dist/ and links the
  // dist-runtime overlay back to that tree. Remove only those symlinks up front
  // so tsdown's clean step cannot traverse stale runtime overlays on rebuilds.
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist"));
  removeDistPluginNodeModulesSymlinks(path.join(cwd, "dist-runtime"));
}

/**
 * Removes build output roots while preserving explicitly protected artifacts.
 */
export function cleanTsdownOutputRoots(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const env = params.env ?? process.env;
  const roots = params.roots ?? listTsdownOutputRoots();
  const protectedDeclarationPaths =
    env[RUN_NODE_SKIP_DTS_BUILD_ENV] === "1"
      ? listExistingDeclarationOutputPaths({
          cwd,
          fs: fsImpl,
          roots,
        })
      : new Set();
  const protectedPaths = new Set([
    ...protectedDeclarationPaths,
    ...listExistingPreservedOutputPaths({ cwd, env, fs: fsImpl }),
  ]);
  for (const root of roots) {
    const rootPath = path.join(cwd, root);
    try {
      if (hasProtectedChild({ rootPath, protectedPaths })) {
        cleanOutputRootExcept(rootPath, protectedPaths, fsImpl);
      } else {
        fsImpl.rmSync(rootPath, { force: true, recursive: true });
      }
    } catch {
      // Best-effort cleanup. tsdown will recreate the output tree it needs.
    }
  }
}

function hasProtectedChild({ rootPath, protectedPaths }) {
  const rootWithSeparator = `${path.resolve(rootPath)}${path.sep}`;
  for (const protectedPath of protectedPaths) {
    if (protectedPath.startsWith(rootWithSeparator)) {
      return true;
    }
  }
  return false;
}

function cleanOutputRootExcept(rootPath, protectedPaths, fsImpl) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const resolvedEntryPath = path.resolve(entryPath);
    if (protectedPaths.has(resolvedEntryPath)) {
      continue;
    }
    try {
      if (entry.isDirectory()) {
        cleanOutputRootExcept(entryPath, protectedPaths, fsImpl);
        fsImpl.rmdirSync(entryPath);
      } else {
        fsImpl.rmSync(entryPath, { force: true });
      }
    } catch {
      // Keep best-effort semantics; protected declaration children can keep a directory non-empty.
    }
  }
}

function listExistingDeclarationOutputPaths({ cwd, fs: fsImpl, roots }) {
  const protectedPaths = new Set();
  for (const root of roots) {
    collectDeclarationOutputPaths(path.join(cwd, root), protectedPaths, fsImpl);
  }
  return protectedPaths;
}

function listExistingPreservedOutputPaths({ cwd, env, fs: fsImpl }) {
  const protectedPaths = new Set();
  if (env[PRESERVE_CLI_STARTUP_METADATA_ENV] !== "1") {
    return protectedPaths;
  }
  for (const relativePath of PRESERVED_TSDOWN_OUTPUT_FILES) {
    const absolutePath = path.resolve(cwd, relativePath);
    try {
      if (fsImpl.statSync(absolutePath).isFile()) {
        protectedPaths.add(absolutePath);
      }
    } catch {
      // Missing preserved outputs are normal on first build.
    }
  }
  return protectedPaths;
}

function collectDeclarationOutputPaths(rootPath, protectedPaths, fsImpl) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectDeclarationOutputPaths(entryPath, protectedPaths, fsImpl);
    } else if (DECLARATION_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      protectedPaths.add(path.resolve(entryPath));
    }
  }
}

export function pruneStaleRootChunkFiles(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const roots = listTsdownOutputRoots({ cwd, fs: fsImpl }).map((root) => path.join(cwd, root));
  for (const root of roots) {
    let entries;
    try {
      entries = fsImpl.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!HASHED_ROOT_JS_RE.test(entry.name)) {
        continue;
      }
      try {
        fsImpl.rmSync(path.join(root, entry.name), { force: true });
      } catch {
        // Best-effort cleanup. The subsequent build will overwrite any stragglers.
      }
    }
  }
}

export function listTsdownOutputRoots() {
  return [...ROOT_TSDOWN_OUTPUT_ROOTS, ...TSDOWN_PACKAGE_OUTPUT_ROOTS];
}

function readForwardedOption(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of names) {
      if (arg === name) {
        return args[index + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

/** Limits cleanup to the output roots owned by an explicitly filtered build. */
export function resolveTsdownCleanOutputRoots(args = []) {
  const config = readForwardedOption(args, ["--config", "-c"]);
  const filter = readForwardedOption(args, ["--filter", "-F"]);
  const configPath = config ? path.resolve(config) : undefined;
  const aiConfigPath = path.resolve("tsdown.ai.config.ts");
  const mainConfigPath = path.resolve("tsdown.config.ts");
  const lowMemoryConfigPath = path.resolve(LOW_MEMORY_TSDOWN_CONFIG_PATH);
  const aiRoot = tsdownPackageOutputRoot("ai");
  const packageRoots = TSDOWN_PACKAGE_OUTPUT_ROOTS.filter((root) => root !== aiRoot);

  if (configPath === aiConfigPath) {
    return [aiRoot];
  }
  if (configPath === mainConfigPath || configPath === lowMemoryConfigPath) {
    if (filter === TSDOWN_PACKAGE_CONFIG_GROUP) {
      return packageRoots;
    }
    if (filter === TSDOWN_UNIFIED_CONFIG_GROUP) {
      return [...ROOT_TSDOWN_OUTPUT_ROOTS];
    }
    return [...ROOT_TSDOWN_OUTPUT_ROOTS, ...packageRoots];
  }
  if (!config && filter === TSDOWN_PACKAGE_CONFIG_GROUP) {
    return [aiRoot, ...packageRoots];
  }
  if (!config && filter === TSDOWN_UNIFIED_CONFIG_GROUP) {
    return [aiRoot, ...ROOT_TSDOWN_OUTPUT_ROOTS];
  }
  return listTsdownOutputRoots();
}

export function pruneUntrackedGeneratedSourceDeclarations(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const spawnSyncImpl = params.spawnSync ?? spawnSync;
  let result;
  try {
    result = spawnSyncImpl(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", GENERATED_SOURCE_DECLARATION_PATHSPEC],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return 0;
  }
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return 0;
  }

  let removed = 0;
  for (const rawPath of result.stdout.split(/\r?\n/u)) {
    const relativePath = rawPath.trim().replaceAll("\\", "/");
    if (!relativePath.startsWith("extensions/") || !relativePath.endsWith(".d.ts")) {
      continue;
    }
    const declarationPath = path.join(cwd, relativePath);
    const sourceBase = declarationPath.slice(0, -".d.ts".length);
    const hasMatchingSource = SOURCE_DECLARATION_SOURCE_EXTENSIONS.some((extension) =>
      fsImpl.existsSync(`${sourceBase}${extension}`),
    );
    if (!hasMatchingSource) {
      continue;
    }
    try {
      fsImpl.rmSync(declarationPath, { force: true });
      removed += 1;
    } catch {
      // Best-effort cleanup; tsdown will still report any remaining stale files.
    }
  }
  return removed;
}

export function pruneSourceCheckoutBundledPluginNodeModules(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const logger = params.logger ?? console;
  if (!isSourceCheckoutRoot({ packageRoot: cwd, existsSync: fs.existsSync })) {
    return;
  }
  try {
    pruneBundledPluginSourceNodeModules({
      extensionsDir: path.join(cwd, "extensions"),
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      rmSync: fs.rmSync,
    });
  } catch (error) {
    logger.warn(`tsdown: could not prune bundled plugin source node_modules: ${String(error)}`);
  }
}

function findFatalUnresolvedImport(lines) {
  for (const line of lines) {
    if (!UNRESOLVED_IMPORT_RE.test(line)) {
      continue;
    }

    const normalizedLine = line.replace(ANSI_ESCAPE_RE, "");
    if (
      !normalizedLine.includes(BUNDLED_PLUGIN_PATH_PREFIX) &&
      !DEPENDENCY_PATH_MARKERS.some((marker) => normalizedLine.includes(marker))
    ) {
      return normalizedLine;
    }
  }

  return null;
}

function parsePositiveIntegerEnv(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return parsePositiveInt(value, name);
}

function parseNonNegativeIntegerEnv(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const text = value.trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function parseCgroupMemoryLimitBytes(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "max" || !/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = BigInt(trimmed);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function readCgroupMemoryLimitBytes(params = {}) {
  if (Number.isFinite(params.cgroupMemoryLimitBytes) && params.cgroupMemoryLimitBytes > 0) {
    return Math.trunc(params.cgroupMemoryLimitBytes);
  }

  const fsImpl = params.fs ?? fs;
  const paths = params.cgroupMemoryLimitPaths ?? [
    ...listCurrentCgroupV2MemoryLimitPaths({ ...params, fs: fsImpl }),
    ...listCurrentCgroupV1MemoryLimitPaths({ ...params, fs: fsImpl }),
    ...CGROUP_MEMORY_LIMIT_PATHS,
  ];
  let smallestLimitBytes = null;
  for (const limitPath of paths) {
    try {
      const limitBytes = parseCgroupMemoryLimitBytes(fsImpl.readFileSync(limitPath, "utf8"));
      if (limitBytes !== null) {
        smallestLimitBytes =
          smallestLimitBytes === null ? limitBytes : Math.min(smallestLimitBytes, limitBytes);
      }
    } catch {
      // Missing cgroup files are expected outside Linux containers.
    }
  }

  return smallestLimitBytes;
}

function listCgroupAncestorFilePaths(rootPath, cgroupPath, fileName) {
  if (!cgroupPath?.startsWith("/")) {
    return [];
  }
  const root = path.resolve(rootPath);
  let current = path.resolve(root, `.${cgroupPath}`);
  if (current !== root && !current.startsWith(`${root}${path.sep}`)) {
    return [];
  }

  const paths = [];
  while (true) {
    paths.push(path.join(current, fileName));
    if (current === root) {
      return paths;
    }
    current = path.dirname(current);
  }
}

function readSelfCgroupText(params = {}) {
  try {
    return (params.fs ?? fs).readFileSync(
      params.procSelfCgroupPath ?? PROC_SELF_CGROUP_PATH,
      "utf8",
    );
  } catch {
    return null;
  }
}

function listCurrentCgroupV2MemoryLimitPaths(params = {}) {
  const cgroupPath = readSelfCgroupText(params)
    ?.split(/\r?\n/u)
    .find((line) => line.startsWith("0::"))
    ?.slice("0::".length);
  return listCgroupAncestorFilePaths(
    params.cgroupV2Root ?? CGROUP_V2_ROOT,
    cgroupPath,
    "memory.max",
  );
}

function listCurrentCgroupV1MemoryLimitPaths(params = {}) {
  const cgroupLine = readSelfCgroupText(params)
    ?.split(/\r?\n/u)
    .find((line) => line.split(":", 3)[1]?.split(",").includes("memory"));
  const cgroupPath = cgroupLine?.split(":", 3)[2];
  return listCgroupAncestorFilePaths(
    params.cgroupV1MemoryRoot ?? CGROUP_V1_MEMORY_ROOT,
    cgroupPath,
    "memory.limit_in_bytes",
  );
}

function parseOomKillCount(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^oom_kill\s+(\d+)$/imu);
  if (!match) {
    return null;
  }
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : null;
}

function readOomKillCounters(params = {}) {
  const fsImpl = params.fs ?? fs;
  const cgroupPaths = params.oomKillCounterPaths ?? [
    ...listCurrentCgroupV2MemoryLimitPaths({ ...params, fs: fsImpl }).map((limitPath) =>
      path.join(path.dirname(limitPath), "memory.events"),
    ),
    ...listCurrentCgroupV1MemoryLimitPaths({ ...params, fs: fsImpl }).map((limitPath) =>
      path.join(path.dirname(limitPath), "memory.oom_control"),
    ),
  ];
  const counters = new Map();
  for (const counterPath of cgroupPaths) {
    try {
      const count = parseOomKillCount(fsImpl.readFileSync(counterPath, "utf8"));
      if (count !== null) {
        // A parent can own the effective limit even when the leaf is readable.
        // Keep the full path; retry classification also requires SIGKILL evidence.
        counters.set(counterPath, count);
      }
    } catch {
      // OOM counters are optional outside Linux and restricted containers.
    }
  }
  if (counters.size > 0) {
    return counters;
  }
  const procVmstatPath = params.procVmstatPath ?? PROC_VMSTAT_PATH;
  try {
    const count = parseOomKillCount(fsImpl.readFileSync(procVmstatPath, "utf8"));
    return count === null ? new Map() : new Map([[procVmstatPath, count]]);
  } catch {
    return new Map();
  }
}

function didOomKillCounterIncrease(before, after) {
  for (const [counterPath, previousCount] of before) {
    const currentCount = after.get(counterPath);
    if (currentCount !== undefined && currentCount > previousCount) {
      return true;
    }
  }
  return false;
}

function parseProcMemTotalBytes(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.match(/^MemTotal:\s+(\d+)\s+kB$/imu);
  if (!match) {
    return null;
  }
  const parsed = BigInt(match[1]) * 1024n;
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(parsed);
}

function readProcMemTotalBytes(params = {}) {
  if (Number.isFinite(params.procMemTotalBytes) && params.procMemTotalBytes > 0) {
    return Math.trunc(params.procMemTotalBytes);
  }

  const fsImpl = params.fs ?? fs;
  try {
    return parseProcMemTotalBytes(
      fsImpl.readFileSync(params.procMeminfoPath ?? PROC_MEMINFO_PATH, "utf8"),
    );
  } catch {
    return null;
  }
}

function readPortableHostTotalBytes(params = {}) {
  if (Object.hasOwn(params, "totalMemoryBytes")) {
    return Number.isFinite(params.totalMemoryBytes) && params.totalMemoryBytes > 0
      ? Math.trunc(params.totalMemoryBytes)
      : null;
  }
  const totalBytes = os.totalmem();
  return Number.isFinite(totalBytes) && totalBytes > 0 ? Math.trunc(totalBytes) : null;
}

function readEffectiveMemoryLimitBytes(params = {}) {
  const hostLimit = readProcMemTotalBytes(params) ?? readPortableHostTotalBytes(params);
  const limits = [readCgroupMemoryLimitBytes(params), hostLimit].filter((limit) => limit !== null);
  return limits.length === 0 ? null : Math.min(...limits);
}

function resolveTsdownMaxOldSpaceMb(params = {}) {
  const defaultMaxOldSpaceMb =
    (params.platform ?? process.platform) === "win32"
      ? DEFAULT_WINDOWS_TSDOWN_MAX_OLD_SPACE_MB
      : DEFAULT_TSDOWN_MAX_OLD_SPACE_MB;
  const envOverride = parsePositiveIntegerEnv(
    (params.env ?? process.env)[TSDOWN_MAX_OLD_SPACE_MB_ENV],
    TSDOWN_MAX_OLD_SPACE_MB_ENV,
  );
  const limitBytes = readEffectiveMemoryLimitBytes(params);
  if (limitBytes === null) {
    return envOverride ?? defaultMaxOldSpaceMb;
  }

  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  if (limitMb <= 0) {
    return defaultMaxOldSpaceMb;
  }

  // V8's old-space limit excludes Rolldown's native allocations, page tables,
  // and the rest of the host. Keep proportional headroom so a failed fast DTS
  // attempt reaches its bounded fallback instead of invoking the kernel OOM killer.
  const proportionalHeadroomMb = Math.ceil(limitMb / TSDOWN_MEMORY_HEADROOM_DIVISOR);
  const headroomMb =
    limitMb < MIN_DECLARATION_BUILD_MEMORY_MB
      ? proportionalHeadroomMb
      : Math.max(MIN_TSDOWN_MEMORY_HEADROOM_MB, proportionalHeadroomMb);
  const cgroupCap = Math.max(1, limitMb - Math.min(headroomMb, limitMb - 1));
  return Math.min(envOverride ?? defaultMaxOldSpaceMb, cgroupCap);
}

function validateDeclarationBuildMemory(args, env, params = {}) {
  parsePositiveIntegerEnv(env[TSDOWN_MAX_OLD_SPACE_MB_ENV], TSDOWN_MAX_OLD_SPACE_MB_ENV);
  if (!declarationsEnabled(args, env) || hasForwardedFlag(args, ["--no-config"])) {
    return;
  }
  const config = readForwardedOption(args, ["--config", "-c"]);
  if (
    config &&
    path.resolve(config) !== path.resolve("tsdown.config.ts") &&
    path.resolve(config) !== path.resolve(LOW_MEMORY_TSDOWN_CONFIG_PATH)
  ) {
    return;
  }
  const limitBytes = readEffectiveMemoryLimitBytes(params);
  if (limitBytes === null) {
    return;
  }
  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  if (limitMb < MIN_DECLARATION_BUILD_MEMORY_MB) {
    throw new Error(
      `OpenClaw declaration builds require at least 6 GiB of effective memory; detected ${limitMb} MiB. Use a larger build host/cgroup or run a runtime-only --no-dts build.`,
    );
  }
}

function readMaxOldSpaceSizeMb(nodeOptions) {
  const inlineMatch = nodeOptions.match(/(?:^|\s)--max-old-space-size=(\d+)(?:\s|$)/u);
  if (inlineMatch) {
    return Number(inlineMatch[1]);
  }
  const splitMatch = nodeOptions.match(/(?:^|\s)--max-old-space-size\s+(\d+)(?:\s|$)/u);
  return splitMatch ? Number(splitMatch[1]) : null;
}

function hasForwardedFlag(args, names) {
  return args.some(
    (arg) => names.includes(arg) || names.some((name) => arg.startsWith(`${name}=`)),
  );
}

function isUnifiedMainConfigInvocation(args, env) {
  if (!declarationsEnabled(args, env)) {
    return false;
  }
  if (readForwardedOption(args, ["--filter", "-F"]) !== TSDOWN_UNIFIED_CONFIG_GROUP) {
    return false;
  }
  if (hasForwardedFlag(args, ["--no-config"])) {
    return false;
  }
  const config = readForwardedOption(args, ["--config", "-c"]);
  return !config || path.resolve(config) === path.resolve("tsdown.config.ts");
}

function isExplicitLowMemoryDtsInvocation(args, env) {
  if (!declarationsEnabled(args, env) || hasForwardedFlag(args, ["--no-config"])) {
    return false;
  }
  const config = readForwardedOption(args, ["--config", "-c"]);
  return Boolean(config && path.resolve(config) === path.resolve(LOW_MEMORY_TSDOWN_CONFIG_PATH));
}

function replaceTsdownConfigArg(args, configPath) {
  const next = [...args];
  for (let index = 0; index < next.length; index += 1) {
    const arg = next[index];
    if (arg === "--config" || arg === "-c") {
      next[index + 1] = configPath;
      return next;
    }
    if (arg.startsWith("--config=") || arg.startsWith("-c=")) {
      const name = arg.slice(0, arg.indexOf("="));
      next[index] = `${name}=${configPath}`;
      return next;
    }
  }
  next.push("--config", configPath);
  return next;
}

function parseGoMemoryLimitBytes(value) {
  const match = value.trim().match(/^(\d+)(B|KiB|MiB|GiB|TiB)?$/u);
  if (!match) {
    return null;
  }
  const shifts = { B: 0n, KiB: 10n, MiB: 20n, GiB: 30n, TiB: 40n };
  return BigInt(match[1]) << shifts[match[2] ?? "B"];
}

function withLowMemoryDtsEnv(env) {
  const maxOldSpaceMb = readMaxOldSpaceSizeMb(env.NODE_OPTIONS ?? "");
  if (!maxOldSpaceMb) {
    return env;
  }
  // rolldown-plugin-dts awaits tsgo before declaration bundling. Keep a further
  // GiB below V8's ceiling for the resident Node wrapper and native allocations.
  const goMemoryLimitMb = Math.max(1, maxOldSpaceMb - TSGO_RESIDENT_NODE_HEADROOM_MB);
  const requestedLimit = env.GOMEMLIMIT?.trim();
  const requestedLimitBytes = requestedLimit ? parseGoMemoryLimitBytes(requestedLimit) : null;
  const derivedLimitBytes = BigInt(goMemoryLimitMb) << 20n;
  if (requestedLimit && requestedLimitBytes !== null && requestedLimitBytes <= derivedLimitBytes) {
    return { ...env, GOMEMLIMIT: requestedLimit };
  }
  return { ...env, GOMEMLIMIT: `${goMemoryLimitMb}MiB` };
}

function shouldUseLowMemoryDts(args, env) {
  if (!isUnifiedMainConfigInvocation(args, env)) {
    return false;
  }
  const maxOldSpaceMb = readMaxOldSpaceSizeMb(env.NODE_OPTIONS ?? "");
  return maxOldSpaceMb !== null && maxOldSpaceMb < STANDARD_DTS_MIN_HEAP_MB;
}

function parseMaxOldSpaceSizeMb(value, fallbackMb) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMb;
  }
  return Math.trunc(parsed);
}

function normalizeMaxOldSpaceSizeMb(value, maxOldSpaceMb) {
  // Build wrappers may inherit smaller runner-level caps; tsdown needs the
  // resolved build heap while still respecting cgroup-derived upper bounds.
  const parsed = parseMaxOldSpaceSizeMb(value, maxOldSpaceMb);
  if (parsed < maxOldSpaceMb) {
    return maxOldSpaceMb;
  }
  return Math.min(parsed, maxOldSpaceMb);
}

function normalizeTsdownNodeOptions(nodeOptions, params = {}) {
  const maxOldSpaceMb = resolveTsdownMaxOldSpaceMb(params);
  const parts = nodeOptions.trim().split(/\s+/u).filter(Boolean);
  const normalized = [];
  let foundMaxOldSpaceSize = false;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const inlineMatch = part.match(/^--max-old-space-size=(\d+)$/u);
    if (inlineMatch) {
      foundMaxOldSpaceSize = true;
      const value = normalizeMaxOldSpaceSizeMb(inlineMatch[1], maxOldSpaceMb);
      normalized.push(`--max-old-space-size=${value}`);
      continue;
    }

    if (part === "--max-old-space-size") {
      foundMaxOldSpaceSize = true;
      const next = parts[index + 1];
      const value = normalizeMaxOldSpaceSizeMb(next, maxOldSpaceMb);
      normalized.push(`--max-old-space-size=${value}`);
      if (next !== undefined) {
        index += 1;
      }
      continue;
    }

    normalized.push(part);
  }

  if (!foundMaxOldSpaceSize) {
    normalized.push(`--max-old-space-size=${maxOldSpaceMb}`);
  }

  return normalized.join(" ");
}

function resolveTsdownEnv(env, params = {}) {
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? "";
  return {
    ...env,
    NODE_OPTIONS: normalizeTsdownNodeOptions(nodeOptions, params),
  };
}

function tsdownBuildUsage() {
  return [
    "Usage: node scripts/tsdown-build.mjs [tsdown args...]",
    "",
    "Builds OpenClaw with tsdown and validates emitted import diagnostics.",
    "",
    "Options:",
    "  -h, --help  Show this help without starting tsdown.",
    "",
    "Other arguments are forwarded to tsdown.",
  ].join("\n");
}

export function parseTsdownBuildArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      forwardedArgs: [],
      help: true,
    };
  }
  return {
    forwardedArgs: argv,
    help: false,
  };
}

export function createTsdownOutputScanner(params = {}) {
  const maxCaptureBytes = params.maxCaptureBytes ?? DEFAULT_CAPTURE_BYTES;
  let captured = "";
  let pendingLine = "";
  let hasIneffectiveDynamicImport = false;
  let fatalUnresolvedImport = null;

  function scanLines(text) {
    const combined = pendingLine + text;
    const lines = combined.split(/\r?\n/u);
    pendingLine = lines.pop() ?? "";
    for (const line of lines) {
      fatalUnresolvedImport ??= findFatalUnresolvedImport([line]);
    }
  }

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(INEFFECTIVE_DYNAMIC_IMPORT_MARKER)) {
        hasIneffectiveDynamicImport = true;
      }
      scanLines(text);
      captured += text;
      if (captured.length > maxCaptureBytes) {
        captured = captured.slice(-maxCaptureBytes);
      }
    },
    finish() {
      if (pendingLine) {
        fatalUnresolvedImport ??= findFatalUnresolvedImport([pendingLine]);
        pendingLine = "";
      }
      return {
        captured,
        hasIneffectiveDynamicImport,
        fatalUnresolvedImport,
      };
    },
  };
}

function readTsdownInvocationString(value, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

export function resolveTsdownBuildInvocation(params = {}) {
  let forwardedArgs = params.args ?? [];
  if (!Array.isArray(forwardedArgs) || forwardedArgs.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  const sourceEnv = params.env ?? process.env;
  if (typeof sourceEnv !== "object" || Array.isArray(sourceEnv)) {
    throw new TypeError("env must be an object");
  }
  const nodeExecPath =
    readTsdownInvocationString(params.nodeExecPath, "nodeExecPath") ?? process.execPath;
  const npmExecPath = readTsdownInvocationString(params.npmExecPath, "npmExecPath");
  const comSpec = readTsdownInvocationString(params.comSpec, "comSpec");
  const platform = readTsdownInvocationString(params.platform, "platform") ?? process.platform;
  validateDeclarationBuildMemory(forwardedArgs, sourceEnv, params);
  let env = resolveTsdownEnv(sourceEnv, params);
  if (shouldUseLowMemoryDts(forwardedArgs, env)) {
    forwardedArgs = replaceTsdownConfigArg(forwardedArgs, LOW_MEMORY_TSDOWN_CONFIG_PATH);
    env = withLowMemoryDtsEnv(env);
  } else if (isExplicitLowMemoryDtsInvocation(forwardedArgs, env)) {
    env = withLowMemoryDtsEnv(env);
  }
  const tsdownArgs = [
    "--config-loader",
    "unrun",
    "--logLevel",
    logLevel,
    "--no-clean",
    ...forwardedArgs,
  ];
  if (env.OPENCLAW_BUILD_ALL_NO_PNPM === "1") {
    return {
      command: nodeExecPath,
      args: ["node_modules/tsdown/dist/run.mjs", ...tsdownArgs],
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsVerbatimArguments: undefined,
        env,
      },
    };
  }
  const runner = resolvePnpmRunner({
    env,
    pnpmArgs: ["exec", "tsdown", ...tsdownArgs],
    nodeExecPath,
    npmExecPath: npmExecPath ?? env.npm_execpath,
    comSpec,
    platform,
  });
  return {
    command: runner.command,
    args: runner.args,
    options: {
      stdio: ["ignore", "pipe", "pipe"],
      shell: runner.shell,
      windowsVerbatimArguments: runner.windowsVerbatimArguments,
      env,
    },
  };
}

export function isTsdownMemoryFailure(result) {
  if (result.timedOut) {
    return false;
  }
  if (result.status === 0 && !result.signal) {
    return false;
  }
  const captured = result.captured ?? "";
  const hasKillOutcome =
    result.signal === "SIGKILL" ||
    result.status === 137 ||
    /(?:SIGKILL|exit (?:code )?137)/iu.test(captured);
  if (result.oomKilled && hasKillOutcome) {
    return true;
  }
  return /(?:heap out of memory|reached heap limit|allocation failed|memory allocation of \d+ bytes failed)/iu.test(
    captured,
  );
}

export function resolveTsdownLowMemoryRetryInvocation(invocation) {
  const args = invocation.args ?? [];
  const env = invocation.options?.env ?? {};
  if (!isUnifiedMainConfigInvocation(args, env)) {
    return null;
  }
  return {
    ...invocation,
    args: replaceTsdownConfigArg(args, LOW_MEMORY_TSDOWN_CONFIG_PATH),
    options: {
      ...invocation.options,
      env: withLowMemoryDtsEnv(env),
    },
  };
}

/** Builds declarations in dependency order without overlapping the largest graphs. */
export function resolveTsdownBuildInvocations(params = {}) {
  const forwardedArgs = params.args ?? [];
  const env = params.env ?? process.env;
  let emitDeclarations = env[RUN_NODE_SKIP_DTS_BUILD_ENV] !== "1";
  let hasForwardedFilter = false;
  let hasForwardedConfig = false;
  const aiArgs = [];
  for (let index = 0; index < forwardedArgs.length; index += 1) {
    const arg = forwardedArgs[index];
    if (arg === "--filter" || arg === "-F") {
      hasForwardedFilter = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--filter=") || arg.startsWith("-F=")) {
      hasForwardedFilter = true;
      continue;
    }
    if (arg === "--dts") {
      emitDeclarations = true;
    } else if (arg === "--no-dts") {
      emitDeclarations = false;
    }
    hasForwardedConfig ||=
      arg === "--config" ||
      arg.startsWith("--config=") ||
      arg === "-c" ||
      arg.startsWith("-c=") ||
      arg === "--no-config";
    aiArgs.push(arg);
  }

  if (hasForwardedConfig) {
    return [resolveTsdownBuildInvocation(params)];
  }

  const invocations = [
    resolveTsdownBuildInvocation({
      ...params,
      args: ["--config", "tsdown.ai.config.ts", ...aiArgs],
    }),
  ];

  if (!emitDeclarations || hasForwardedFilter) {
    invocations.push(resolveTsdownBuildInvocation(params));
    return invocations;
  }

  for (const group of [TSDOWN_PACKAGE_CONFIG_GROUP, TSDOWN_UNIFIED_CONFIG_GROUP]) {
    invocations.push(
      resolveTsdownBuildInvocation({
        ...params,
        args: ["--filter", group, ...forwardedArgs],
      }),
    );
  }
  return invocations;
}

function signalWindowsProcessTree(pid, signal, runTaskkill = spawnSync) {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = runTaskkill(resolveWindowsTaskkillPath(), args, { stdio: "ignore" });
  return !result?.error && result?.status === 0;
}

function signalWindowsProcessTreeOrForce(pid, signal, runTaskkill = spawnSync) {
  if (signalWindowsProcessTree(pid, signal, runTaskkill)) {
    return true;
  }
  return signal !== "SIGKILL" && signalWindowsProcessTree(pid, "SIGKILL", runTaskkill);
}

export function signalTsdownBuildProcessTree(
  child,
  signal,
  {
    platform = process.platform,
    runTaskkill = spawnSync,
    useProcessGroup = platform !== "win32",
  } = {},
) {
  if (useProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child handle.
    }
  }
  if (platform === "win32" && child.pid) {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return;
    }
  }
  child.kill(signal);
}

export async function runTsdownBuildInvocation(invocation, params = {}) {
  const stdout = params.stdout ?? process.stdout;
  const stderr = params.stderr ?? process.stderr;
  const env = params.env ?? process.env;
  const scanner = params.scanner ?? createTsdownOutputScanner();
  const timeoutMs = parsePositiveIntegerEnv(
    env.OPENCLAW_TSDOWN_TIMEOUT_MS,
    "OPENCLAW_TSDOWN_TIMEOUT_MS",
  );
  const heartbeatMs =
    parseNonNegativeIntegerEnv(env.OPENCLAW_TSDOWN_HEARTBEAT_MS, "OPENCLAW_TSDOWN_HEARTBEAT_MS") ??
    DEFAULT_HEARTBEAT_MS;
  let timedOut = false;
  let settled = false;
  let lastOutputAt = Date.now();
  let forceKillAt = null;
  const readOomCounters = params.readOomKillCounters ?? (() => readOomKillCounters(params));
  const oomKillCountersBefore = readOomCounters();

  const platform = params.platform ?? process.platform;
  const runTaskkill = params.runTaskkill ?? spawnSync;
  const useProcessGroup = platform !== "win32";
  const child = spawn(invocation.command, invocation.args, {
    ...invocation.options,
    detached: useProcessGroup,
  });
  const pidText = child.pid ? ` pid=${child.pid}` : "";

  function markOutput() {
    lastOutputAt = Date.now();
  }

  function signalChild(signal) {
    signalTsdownBuildProcessTree(child, signal, {
      platform,
      runTaskkill,
      useProcessGroup,
    });
  }

  const parentSignalHandlers = [];
  function cleanupParentSignalHandlers() {
    for (const { signal, handler } of parentSignalHandlers) {
      process.off(signal, handler);
    }
    parentSignalHandlers.length = 0;
  }

  function relayParentSignal(signal) {
    const handler = () => {
      signalChild(signal);
      signalChild("SIGKILL");
      cleanupParentSignalHandlers();
      process.kill(process.pid, signal);
    };
    parentSignalHandlers.push({ signal, handler });
    process.once(signal, handler);
  }

  if (useProcessGroup) {
    relayParentSignal("SIGINT");
    relayParentSignal("SIGTERM");
    relayParentSignal("SIGHUP");
  }

  function processTreeAlive() {
    if (!child.pid) {
      return false;
    }
    if (!useProcessGroup) {
      return child.exitCode === null && child.signalCode === null;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }

  async function waitForProcessTreeExit(timeoutMsToWait) {
    const deadlineAt = Date.now() + timeoutMsToWait;
    while (Date.now() < deadlineAt) {
      if (!processTreeAlive()) {
        return true;
      }
      await new Promise((resolvePoll) => {
        setTimeout(resolvePoll, PROCESS_GROUP_EXIT_POLL_MS);
      });
    }
    return !processTreeAlive();
  }

  async function finishTimedOutProcessTree() {
    const graceRemainingMs =
      forceKillAt === null ? TERMINATION_GRACE_MS : Math.max(0, forceKillAt - Date.now());
    if (graceRemainingMs > 0) {
      await waitForProcessTreeExit(graceRemainingMs);
    }
    if (processTreeAlive()) {
      signalChild("SIGKILL");
      await waitForProcessTreeExit(POST_FORCE_KILL_WAIT_MS);
    }
  }

  child.stdout?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    markOutput();
    scanner.append(chunk);
    stderr.write(chunk);
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (settled) {
            return;
          }
          const silentForMs = Date.now() - lastOutputAt;
          if (silentForMs < heartbeatMs) {
            return;
          }
          stderr.write(
            `[tsdown-build] still running${pidText}; no output for ${Math.round(
              silentForMs / 1000,
            )}s\n`,
          );
          lastOutputAt = Date.now();
        }, heartbeatMs).unref()
      : null;

  const timeout =
    timeoutMs !== null
      ? setTimeout(() => {
          timedOut = true;
          stderr.write(`[tsdown-build] timeout after ${timeoutMs}ms${pidText}; sending SIGTERM\n`);
          signalChild("SIGTERM");
          forceKillAt = Date.now() + TERMINATION_GRACE_MS;
          setTimeout(() => {
            if (!settled) {
              stderr.write(`[tsdown-build] forcing SIGKILL${pidText}\n`);
              signalChild("SIGKILL");
            }
          }, TERMINATION_GRACE_MS).unref();
        }, timeoutMs).unref()
      : null;

  return new Promise((resolve) => {
    child.once("error", (error) => {
      settled = true;
      cleanupParentSignalHandlers();
      clearInterval(heartbeat);
      clearTimeout(timeout);
      stderr.write(`[tsdown-build] failed to start: ${String(error)}\n`);
      resolve({
        status: 1,
        signal: null,
        timedOut,
        oomKilled: false,
        error,
        ...scanner.finish(),
      });
    });
    child.once("close", (status, signal) => {
      function finish() {
        const oomKilled = didOomKillCounterIncrease(oomKillCountersBefore, readOomCounters());
        settled = true;
        cleanupParentSignalHandlers();
        clearInterval(heartbeat);
        clearTimeout(timeout);
        resolve({
          status,
          signal,
          timedOut,
          oomKilled,
          error: null,
          ...scanner.finish(),
        });
      }

      if (timedOut) {
        void finishTimedOutProcessTree().then(finish, finish);
        return;
      }

      finish();
    });
  });
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) {
    return false;
  }
  return import.meta.url === pathToFileURL(argv1).href;
}

if (isMainModule()) {
  const args = parseTsdownBuildArgs(process.argv.slice(2));
  if (args.help) {
    console.log(tsdownBuildUsage());
    process.exit(0);
  }
  let invocations;
  try {
    invocations = resolveTsdownBuildInvocations({ args: args.forwardedArgs });
  } catch (error) {
    console.error(`[tsdown-build] ${error instanceof Error ? error.message : String(error)}`);
    console.error("[tsdown-build] FAILED (exit 1)");
    process.exit(1);
  }
  pruneSourceCheckoutBundledPluginNodeModules();
  pruneUntrackedGeneratedSourceDeclarations();
  pruneStaleRuntimeSymlinks();
  cleanTsdownOutputRoots({ roots: resolveTsdownCleanOutputRoots(args.forwardedArgs) });
  let result;
  for (const [index, invocation] of invocations.entries()) {
    const startedAt = performance.now();
    if (
      path.resolve(readForwardedOption(invocation.args, ["--config", "-c"]) ?? "") ===
      path.resolve(LOW_MEMORY_TSDOWN_CONFIG_PATH)
    ) {
      console.error(
        `[tsdown-build] using bounded-memory declaration backend (${invocation.options.env.GOMEMLIMIT ?? "automatic Go limit"})`,
      );
    }
    result = await runTsdownBuildInvocation(invocation);
    if (isTsdownMemoryFailure(result)) {
      const retryInvocation = resolveTsdownLowMemoryRetryInvocation(invocation);
      if (retryInvocation) {
        console.error(
          "[tsdown-build] standard declaration build exhausted memory; retrying with the bounded-memory tsgo backend",
        );
        pruneStaleRuntimeSymlinks();
        cleanTsdownOutputRoots({ roots: resolveTsdownCleanOutputRoots(retryInvocation.args) });
        result = await runTsdownBuildInvocation(retryInvocation);
      }
    }
    // Per-invocation timing separates the AI-declarations pass from the main
    // graph in CI logs; the combined step is otherwise a single opaque cost.
    console.log(
      `[tsdown-build] invocation ${index + 1}/${invocations.length} finished in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    if (result.status !== 0 || result.hasIneffectiveDynamicImport || result.fatalUnresolvedImport) {
      break;
    }
  }

  if (result.status === 0 && result.hasIneffectiveDynamicImport) {
    console.error(
      "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
    );
    process.exit(1);
  }

  if (result.status === 0 && result.fatalUnresolvedImport) {
    console.error(
      `Build emitted [UNRESOLVED_IMPORT] outside extensions: ${result.fatalUnresolvedImport}`,
    );
    process.exit(1);
  }

  if (result.timedOut) {
    process.exit(124);
  }

  if (typeof result.status === "number") {
    process.exit(result.status);
  }

  process.exit(1);
}
