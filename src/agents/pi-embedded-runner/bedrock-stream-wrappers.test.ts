import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendExplicitBedrockCachePoints,
  createBedrockNoCacheWrapper,
} from "./bedrock-stream-wrappers.js";

describe("bedrock stream wrappers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets cacheRetention none by default", () => {
    const inner = vi.fn();
    const wrapped = createBedrockNoCacheWrapper(inner as unknown as StreamFn);

    wrapped({} as never, {} as never, {} as never);

    expect(inner).toHaveBeenCalledWith({}, {}, { cacheRetention: "none" });
  });

  it("preserves explicit cacheRetention for heuristic misses", () => {
    const inner = vi.fn();
    const wrapped = createBedrockNoCacheWrapper(inner as unknown as StreamFn);

    wrapped({} as never, {} as never, { cacheRetention: "long" } as never);

    expect(inner).toHaveBeenCalledWith(
      {},
      {},
      expect.objectContaining({
        cacheRetention: "long",
        onPayload: expect.any(Function),
      }),
    );
  });

  it("preserves provider force-cache escape hatch", () => {
    vi.stubEnv("AWS_BEDROCK_FORCE_CACHE", "1");
    const inner = vi.fn();
    const wrapped = createBedrockNoCacheWrapper(inner as unknown as StreamFn);

    wrapped({} as never, {} as never, {} as never);

    expect(inner).toHaveBeenCalledWith({}, {}, { onPayload: expect.any(Function) });
  });

  it("forces AWS SDK single-attempt mode for the stream lifetime", async () => {
    vi.stubEnv("AWS_MAX_ATTEMPTS", undefined);
    const result = vi.fn(async () => {
      expect(process.env.AWS_MAX_ATTEMPTS).toBe("1");
      return "done";
    });
    const inner = vi.fn(() => ({ result }));
    const wrapped = createBedrockNoCacheWrapper(inner as unknown as StreamFn);

    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<string>;
    };

    expect(process.env.AWS_MAX_ATTEMPTS).toBe("1");
    await expect(stream.result()).resolves.toBe("done");
    expect(process.env.AWS_MAX_ATTEMPTS).toBeUndefined();
  });

  it("respects a caller-provided AWS_MAX_ATTEMPTS value", async () => {
    vi.stubEnv("AWS_MAX_ATTEMPTS", "3");
    const inner = vi.fn((_model: unknown, _input: unknown, _options: unknown) => ({
      result: vi.fn(async () => "done"),
    }));
    const wrapped = createBedrockNoCacheWrapper(inner as unknown as StreamFn);

    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<string>;
    };

    expect(process.env.AWS_MAX_ATTEMPTS).toBe("3");
    await expect(stream.result()).resolves.toBe("done");
    expect(process.env.AWS_MAX_ATTEMPTS).toBe("3");
  });

  it("adds long-lived cache points for explicit Bedrock application profile caching", async () => {
    const inner = vi.fn(() => ({ result: vi.fn(async () => "done") }));
    const wrapped = createBedrockNoCacheWrapper(inner as unknown as StreamFn);

    wrapped(
      {
        id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/prod-main",
      } as never,
      {} as never,
      {
        cacheRetention: "long",
      } as never,
    );

    const call = inner.mock.calls.at(0) as unknown[] | undefined;
    const options = call?.at(2) as {
      onPayload?: (payload: unknown, model: unknown) => Promise<unknown>;
    };
    const payload = {
      system: [{ text: "stable system" }],
      messages: [
        { role: "user", content: [{ text: "first" }] },
        { role: "assistant", content: [{ text: "reply" }] },
        { role: "user", content: [{ text: "latest" }] },
      ],
    };

    await expect(options.onPayload?.(payload, {})).resolves.toEqual({
      system: [{ text: "stable system" }, { cachePoint: { type: "default", ttl: "1h" } }],
      messages: [
        { role: "user", content: [{ text: "first" }] },
        { role: "assistant", content: [{ text: "reply" }] },
        {
          role: "user",
          content: [{ text: "latest" }, { cachePoint: { type: "default", ttl: "1h" } }],
        },
      ],
    });
  });

  it("does not duplicate existing Bedrock cache points", () => {
    const payload = {
      system: [{ text: "stable" }, { cachePoint: { type: "default", ttl: "1h" } }],
      messages: [
        {
          role: "user",
          content: [{ text: "latest" }, { cachePoint: { type: "default", ttl: "1h" } }],
        },
      ],
    };

    expect(appendExplicitBedrockCachePoints(payload, "long")).toEqual(payload);
    expect(payload.system).toHaveLength(2);
    expect(payload.messages[0]?.content).toHaveLength(2);
  });
});
