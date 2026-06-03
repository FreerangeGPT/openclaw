import crypto from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  it("sanitizes credential fields and image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    expect(typeof logger?.wrapStreamFn).toBe("function");

    const payload = {
      messages: [
        {
          role: "user",
          authorization: "Bearer sk-secret", // pragma: allowlist secret
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
      metadata: {
        api_key: "sk-test", // pragma: allowlist secret
        nestedToken: "shh", // pragma: allowlist secret
        tokenBudget: 1024,
      },
    };
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    expect(typeof wrapped).toBe("function");
    if (!wrapped) {
      throw new Error("expected payload logger to wrap stream function");
    }
    await wrapped({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const sanitizedPayload = (event.payload ?? {}) as Record<string, unknown>;
    const message = ((sanitizedPayload.messages as unknown[] | undefined) ?? []) as Array<
      Record<string, unknown>
    >;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    const metadata = (sanitizedPayload.metadata ?? {}) as Record<string, unknown>;
    expect(message[0]).not.toHaveProperty("authorization");
    expect(metadata).not.toHaveProperty("api_key");
    expect(metadata).not.toHaveProperty("nestedToken");
    expect(metadata.tokenBudget).toBe(1024);
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("sanitizes usage and error fields before writing logs", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    logger?.recordUsage(
      [
        {
          role: "assistant",
          content: "",
          usage: {
            input: 1,
            authorization: "Bearer sk-secret", // pragma: allowlist secret
          },
        } as never,
      ],
      new Error("failed with Bearer sk-secret"), // pragma: allowlist secret
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.error).toBe("failed with Bearer <redacted>");
    expect(event.usage).toEqual({ input: 1 });
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
