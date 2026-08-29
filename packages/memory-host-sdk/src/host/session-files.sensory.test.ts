// Memory Host SDK sensory tests protect raw-log and derived-index separation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildSessionEntry } from "./session-files.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

it("keeps sensory context in raw JSONL but excludes its trusted prefix from memory", async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sensory-session-"));
  const sensoryPrefix = [
    '<openclaw-sensory-context memory-index="exclude">',
    "[Your eyes see: a red mug beside a bright monitor]",
    "</openclaw-sensory-context>",
    "",
    "",
  ].join("\n");
  const rawHumanText = "Please remember that the project codename is Juniper.";
  const jsonlLine = JSON.stringify({
    type: "message",
    message: {
      role: "user",
      content: `${sensoryPrefix}${rawHumanText}`,
      provenance: {
        kind: "external_user",
        sourceTool: "openresponses_sensory_context",
        memoryIndexExcludedPrefixChars: sensoryPrefix.length,
      },
    },
  });
  const filePath = path.join(tempDir, "session.jsonl");
  await fs.writeFile(filePath, jsonlLine);

  const entry = await buildSessionEntry(filePath);
  expect(entry).not.toBeNull();
  expect(await fs.readFile(filePath, "utf8")).toContain("a red mug beside a bright monitor");
  expect(entry?.content).toBe(`User: ${rawHumanText}`);
  expect(entry?.content).not.toContain("red mug");
  expect(entry?.lineMap).toStrictEqual([1]);
});

it("indexes an intentional detailed observation but drops the rest of its heartbeat", async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-observation-"));
  const records = [
    {
      type: "message",
      message: {
        role: "user",
        content: "[OpenClaw heartbeat poll]\n[Your eyes see: a generic desk]",
        provenance: { kind: "internal_system", sourceTool: "heartbeat" },
      },
    },
    { type: "message", message: { role: "assistant", content: "Calling vision." } },
    {
      type: "message",
      message: {
        role: "user",
        content: "Tool result containing a detailed red mug observation.",
        provenance: {
          kind: "internal_system",
          sourceTool: "heartbeat",
          memoryIndexIncludedText:
            "A glossy red mug sits left of the keyboard beside a folded blue cloth.",
        },
      },
    },
    { type: "message", message: { role: "assistant", content: "TURN_COMPLETE" } },
    { type: "message", message: { role: "user", content: "The project is called Juniper." } },
    { type: "message", message: { role: "assistant", content: "Understood." } },
  ];
  const filePath = path.join(tempDir, "session.jsonl");
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n"));

  const entry = await buildSessionEntry(filePath);
  expect(entry?.content).toBe(
    [
      "Observation: A glossy red mug sits left of the keyboard beside a folded blue cloth.",
      "User: The project is called Juniper.",
      "Assistant: Understood.",
    ].join("\n"),
  );
  expect(entry?.content).not.toContain("generic desk");
  expect(entry?.content).not.toContain("TURN_COMPLETE");
  expect(entry?.lineMap).toStrictEqual([3, 5, 6]);
});
