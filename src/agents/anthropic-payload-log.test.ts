import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  it("redacts image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    expect(logger).not.toBeNull();

    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
    };
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const message = ((event.payload as { messages?: unknown[] } | undefined)?.messages ??
      []) as Array<Record<string, unknown>>;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toBeDefined();
  });

  it("honors diagnostics.providerPayloadLog for non-Anthropic request and response logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      cfg: {
        diagnostics: {
          providerPayloadLog: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    expect(logger).not.toBeNull();

    const payload = {
      input: [{ role: "user", content: "hello" }],
      apiKey: "sk-request-secret",
    };
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "openai-responses" } as never, { messages: [] } as never, {});
    logger?.recordUsage([
      {
        role: "assistant",
        content: [{ type: "text", text: "response" }],
        usage: { input: 10, output: 2 },
        token: "assistant-secret-token",
      } as never,
    ]);

    const events = lines.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
    expect(events.map((event) => event.stage)).toEqual(["request", "response", "usage"]);
    expect(events[0]?.payload).toEqual({
      input: [{ role: "user", content: "hello" }],
    });
    expect(events[1]?.response).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      usage: { input: 10, output: 2 },
    });
    expect(events[1]?.responseDigest).toBeDefined();
    expect(events[2]?.usage).toEqual({ input: 10, output: 2 });
  });

  it("keeps legacy Anthropic env logging scoped to anthropic-messages models", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.({ input: "hello" }, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "openai-responses" } as never, { messages: [] } as never, {});
    await wrapped?.({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    expect(lines).toHaveLength(1);
  });
});
