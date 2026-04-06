import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const MEMORY_PREPEND_QUEUE_DIRNAME = ".memory-queue";
export const MEMORY_PREPEND_QUEUE_FILENAME = "pending.jsonl";
export const MEMORY_PREPEND_BLOCK_LABEL = "[Associative recall]";
export const DEFAULT_MEMORY_PREPEND_MAX_FRAGMENTS = 3;
export const DEFAULT_MEMORY_PREPEND_MAX_CHARS = 2_500;

const memoryPrependQueueEntrySchema = z
  .object({
    text: z.string().trim().min(1).optional(),
    fragment: z.string().trim().min(1).optional(),
    content: z.string().trim().min(1).optional(),
    hash: z.string().trim().min(1).optional(),
  })
  .passthrough();

type ParsedQueueLine =
  | {
      kind: "entry";
      rawLine: string;
      text: string;
      dedupeKey: string;
    }
  | {
      kind: "invalid";
      rawLine: string;
    };

export type MemoryPrependCommitResult =
  | { applied: true; reason: "updated" | "cleared" }
  | { applied: false; reason: "noop" | "already_committed" | "missing" | "queue_changed" };

export type PreparedMemoryPrependQueueDrain = {
  queuePath: string;
  block?: string;
  includedFragments: number;
  malformedLines: number;
  truncated: boolean;
  commit: () => Promise<MemoryPrependCommitResult>;
};

function normalizeAssociativeRecallText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function expandLeadingHome(value: string, homeDir = os.homedir()): string {
  if (!value.startsWith("~")) {
    return value;
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

function splitJsonlLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function truncateAssociativeRecallText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return text.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function hashAssociativeRecallText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseQueueLine(rawLine: string): ParsedQueueLine {
  try {
    const parsed = memoryPrependQueueEntrySchema.parse(JSON.parse(rawLine));
    const rawText = parsed.text ?? parsed.fragment ?? parsed.content;
    if (!rawText) {
      return { kind: "invalid", rawLine };
    }
    const text = normalizeAssociativeRecallText(rawText);
    if (!text) {
      return { kind: "invalid", rawLine };
    }
    const dedupeKey =
      normalizeAssociativeRecallText(parsed.hash ?? "") || hashAssociativeRecallText(text);
    return {
      kind: "entry",
      rawLine,
      text,
      dedupeKey,
    };
  } catch {
    return { kind: "invalid", rawLine };
  }
}

function startsWithLines(full: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > full.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (full[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
}

async function writeQueueLines(queuePath: string, lines: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  if (lines.length === 0) {
    await fs.rm(queuePath, { force: true }).catch((error: unknown) => {
      const code = (error as { code?: string } | undefined)?.code;
      if (code !== "ENOENT") {
        throw error;
      }
    });
    return;
  }

  const tempPath = `${queuePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${lines.join("\n")}\n`, "utf-8");
  await fs.rename(tempPath, queuePath);
}

export function resolveDefaultMemoryPrependQueuePath(homeDir = os.homedir()): string {
  return path.join(
    homeDir,
    ".openclaw",
    "workspace",
    MEMORY_PREPEND_QUEUE_DIRNAME,
    MEMORY_PREPEND_QUEUE_FILENAME,
  );
}

export function resolveMemoryPrependQueuePath(params: {
  workspaceDir?: string;
  queuePath?: string;
  homeDir?: string;
}): string {
  const explicitQueuePath = params.queuePath?.trim();
  if (explicitQueuePath) {
    return path.resolve(expandLeadingHome(explicitQueuePath, params.homeDir));
  }
  const workspaceDir = params.workspaceDir?.trim();
  if (workspaceDir) {
    return path.join(workspaceDir, MEMORY_PREPEND_QUEUE_DIRNAME, MEMORY_PREPEND_QUEUE_FILENAME);
  }
  return resolveDefaultMemoryPrependQueuePath(params.homeDir);
}

export function formatAssociativeRecallBlocks(texts: readonly string[]): string {
  return texts
    .map((text) => `${MEMORY_PREPEND_BLOCK_LABEL}\n${normalizeAssociativeRecallText(text)}`)
    .join("\n\n");
}

export function prependAssociativeRecallBlockToText(params: {
  body: string;
  recallBlock?: string;
}): string {
  const recallBlock = normalizeAssociativeRecallText(params.recallBlock ?? "");
  if (!recallBlock) {
    return params.body;
  }
  return params.body.trim() ? `${recallBlock}\n\n${params.body}` : recallBlock;
}

export async function prepareMemoryPrependQueueDrain(params: {
  workspaceDir?: string;
  queuePath?: string;
  maxFragments?: number;
  maxChars?: number;
}): Promise<PreparedMemoryPrependQueueDrain> {
  const queuePath = resolveMemoryPrependQueuePath({
    workspaceDir: params.workspaceDir,
    queuePath: params.queuePath,
  });
  const maxFragments = Math.max(
    1,
    Math.floor(params.maxFragments ?? DEFAULT_MEMORY_PREPEND_MAX_FRAGMENTS),
  );
  const maxChars = Math.max(1, Math.floor(params.maxChars ?? DEFAULT_MEMORY_PREPEND_MAX_CHARS));

  let raw = "";
  try {
    raw = await fs.readFile(queuePath, "utf-8");
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return {
        queuePath,
        includedFragments: 0,
        malformedLines: 0,
        truncated: false,
        commit: async () => ({ applied: false, reason: "noop" }),
      };
    }
    throw error;
  }

  const originalLines = splitJsonlLines(raw);
  if (originalLines.length === 0) {
    return {
      queuePath,
      includedFragments: 0,
      malformedLines: 0,
      truncated: false,
      commit: async () => ({ applied: false, reason: "noop" }),
    };
  }

  const parsedLines = originalLines.map(parseQueueLine);
  const consumedIndices = new Set<number>();
  const seenKeys = new Set<string>();
  const includedTexts: string[] = [];
  let malformedLines = 0;
  let totalChars = 0;
  let truncated = false;

  for (let index = 0; index < parsedLines.length; index += 1) {
    const parsedLine = parsedLines[index];
    if (parsedLine.kind === "invalid") {
      malformedLines += 1;
      consumedIndices.add(index);
      continue;
    }

    if (seenKeys.has(parsedLine.dedupeKey)) {
      consumedIndices.add(index);
      continue;
    }

    if (includedTexts.length >= maxFragments) {
      continue;
    }

    const remainingChars = maxChars - totalChars;
    if (remainingChars <= 0) {
      continue;
    }

    const nextText = truncateAssociativeRecallText(parsedLine.text, remainingChars);
    if (!nextText) {
      continue;
    }

    includedTexts.push(nextText);
    consumedIndices.add(index);
    seenKeys.add(parsedLine.dedupeKey);
    totalChars += nextText.length;
    truncated ||= nextText.length < parsedLine.text.length;
  }

  const block = includedTexts.length > 0 ? formatAssociativeRecallBlocks(includedTexts) : undefined;
  const remainingLines = originalLines.filter((_, index) => !consumedIndices.has(index));
  let committed = false;

  return {
    queuePath,
    block,
    includedFragments: includedTexts.length,
    malformedLines,
    truncated,
    commit: async () => {
      if (committed) {
        return { applied: false, reason: "already_committed" };
      }

      let currentRaw = "";
      try {
        currentRaw = await fs.readFile(queuePath, "utf-8");
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code === "ENOENT") {
          return { applied: false, reason: "missing" };
        }
        throw error;
      }

      const currentLines = splitJsonlLines(currentRaw);
      if (!startsWithLines(currentLines, originalLines)) {
        return { applied: false, reason: "queue_changed" };
      }

      const appendedLines = currentLines.slice(originalLines.length);
      await writeQueueLines(queuePath, [...remainingLines, ...appendedLines]);
      committed = true;
      return {
        applied: true,
        reason: remainingLines.length + appendedLines.length > 0 ? "updated" : "cleared",
      };
    },
  };
}
