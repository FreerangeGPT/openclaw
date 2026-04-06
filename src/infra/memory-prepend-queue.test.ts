import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareMemoryPrependQueueDrain,
  prependAssociativeRecallBlockToText,
  resolveMemoryPrependQueuePath,
} from "./memory-prepend-queue.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-prepend-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

async function writeQueue(workspaceDir: string, lines: readonly string[]): Promise<string> {
  const queuePath = resolveMemoryPrependQueuePath({ workspaceDir });
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, `${lines.join("\n")}\n`, "utf-8");
  return queuePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("memory prepend queue", () => {
  it("dedupes, truncates, and commits only consumed entries", async () => {
    const workspaceDir = await createWorkspace();
    const queuePath = await writeQueue(workspaceDir, [
      JSON.stringify({ text: "First recall" }),
      JSON.stringify({ text: "First recall" }),
      "{bad json",
      JSON.stringify({ text: "Second recall is much longer than the allowed budget." }),
      JSON.stringify({ text: "Third recall" }),
    ]);

    const prepared = await prepareMemoryPrependQueueDrain({
      workspaceDir,
      maxFragments: 2,
      maxChars: 30,
    });

    expect(prepared.block).toContain("[Associative recall]\nFirst recall");
    expect(prepared.block).toContain("[Associative recall]\nSecond recall is…");
    expect(prepared.includedFragments).toBe(2);
    expect(prepared.malformedLines).toBe(1);
    expect(prepared.truncated).toBe(true);

    expect(
      prependAssociativeRecallBlockToText({
        body: "User message",
        recallBlock: prepared.block,
      }),
    ).toContain("User message");

    const commitResult = await prepared.commit();
    expect(commitResult).toEqual({ applied: true, reason: "updated" });
    await expect(fs.readFile(queuePath, "utf-8")).resolves.toBe(
      `${JSON.stringify({ text: "Third recall" })}\n`,
    );
  });

  it("preserves queue lines appended after prepare but before commit", async () => {
    const workspaceDir = await createWorkspace();
    const queuePath = await writeQueue(workspaceDir, [
      JSON.stringify({ text: "First recall" }),
      JSON.stringify({ text: "Second recall" }),
    ]);

    const prepared = await prepareMemoryPrependQueueDrain({
      workspaceDir,
      maxFragments: 1,
      maxChars: 100,
    });

    await fs.appendFile(queuePath, `${JSON.stringify({ text: "Appended later" })}\n`, "utf-8");
    const commitResult = await prepared.commit();

    expect(commitResult).toEqual({ applied: true, reason: "updated" });
    await expect(fs.readFile(queuePath, "utf-8")).resolves.toBe(
      `${JSON.stringify({ text: "Second recall" })}\n${JSON.stringify({ text: "Appended later" })}\n`,
    );
  });
});
