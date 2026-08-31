import { describe, expect, it, vi } from "vitest";
import type { ProviderPromptSnapshot } from "./embedded-agent-runner/provider-prompt-state.js";
import { createProviderReplayRecorder } from "./provider-replay-log.js";

function snapshot(): ProviderPromptSnapshot {
  return {
    scopeDigest: "scope",
    digest: "payload",
    byteWeight: 40_000,
    cachePrefixIdentity: "cache-prefix",
    cacheRequestOptionsIdentity: "request-options",
    cacheTree: {
      version: 1,
      tools: { blockCount: 0, identity: "tools" },
      system: { blockCount: 1, identity: "system" },
      messages: { blockCount: 1, messageCount: 1, identity: "messages" },
      breakpoints: [],
    },
    providerCallSequence: 1,
    providerCallStartedAt: 1_700_000_000_000,
  };
}

describe("provider replay log", () => {
  it("is disabled unless the operator explicitly opts in", () => {
    expect(createProviderReplayRecorder({ env: {} })).toBeNull();
  });

  it("preserves exact long provider payloads and responses without trajectory sentinels", async () => {
    const lines: string[] = [];
    const recorder = createProviderReplayRecorder({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "raw" },
      runId: "run-1",
      sessionId: "session-1",
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    const longSystem = `system-${"x".repeat(40_000)}-apiKey=literal-user-content`;
    const providerSnapshot = snapshot();
    recorder?.recordRequest({
      model: {
        id: "claude-opus-4-8",
        provider: "anthropic",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      } as never,
      payload: {
        system: [{ type: "text", text: longSystem }],
        messages: [{ role: "user", content: "compare this answer" }],
        tools: [],
      },
      snapshot: providerSnapshot,
    });
    recorder?.recordResponse({
      snapshot: providerSnapshot,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "baseline answer" }],
        usage: { input: 40_000, output: 3, cacheRead: 39_000, cacheWrite: 0 },
      },
    });
    await recorder?.flush();

    expect(lines).toHaveLength(2);
    const request = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const response = JSON.parse(lines[1]?.trim() ?? "{}") as Record<string, unknown>;
    expect(request).toMatchObject({
      schema: "openclaw-provider-replay",
      schemaVersion: 1,
      stage: "request",
      requestId: "run-1:1",
    });
    expect(request).not.toHaveProperty("headers");
    expect(((request.payload as { system: Array<{ text: string }> }).system ?? [])[0]?.text).toBe(
      longSystem,
    );
    expect(JSON.stringify(request)).not.toContain("trajectory-field-size-limit");
    expect(response).toMatchObject({
      stage: "response",
      requestId: "run-1:1",
      message: { usage: { cacheRead: 39_000 } },
    });
  });

  it("redacts transport credentials embedded in provider errors", () => {
    const lines: string[] = [];
    const credentialUrl = ["https://user:", "password-secret-value", "@provider.test/v1"].join("");
    const partialModelOutput = `partial-${"x".repeat(40_000)}-apiKey=literal-model-output`;
    const recorder = createProviderReplayRecorder({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "raw" },
      runId: "run-error",
      writer: {
        filePath: "memory-error",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    recorder?.recordResponse({
      snapshot: snapshot(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: partialModelOutput }],
        usage: { input: 1_000, output: 10 },
        stopReason: "error",
        errorMessage: "request failed: https://provider.test/v1?api_key=query-secret-value", // pragma: allowlist secret
      },
      error: {
        message: "request failed: https://provider.test/v1?api_key=query-secret-value", // pragma: allowlist secret
        config: {
          headers: { authorization: "Bearer transport-secret-value" }, // pragma: allowlist secret
          url: credentialUrl,
        },
      },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("query-secret-value");
    expect(lines[0]).not.toContain("transport-secret-value");
    expect(lines[0]).not.toContain("password-secret-value");
    const response = JSON.parse(lines[0]?.trim() ?? "{}") as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(response).toMatchObject({
      stage: "response",
      requestId: "run-error:1",
      message: {
        stopReason: "error",
      },
      error: {
        config: { headers: {} },
      },
    });
    expect(response.message?.content?.[0]?.text).toBe(partialModelOutput);
  });

  it("disables a failing replay sink without changing provider execution", () => {
    const write = vi.fn(() => {
      throw new Error("disk unavailable");
    });
    const recorder = createProviderReplayRecorder({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "raw" },
      runId: "run-write-failure",
      writer: {
        filePath: "memory-write-failure",
        write,
        flush: async () => undefined,
      },
    });

    expect(() =>
      recorder?.recordRequest({
        model: {
          id: "claude-opus-4-8",
          provider: "anthropic",
          api: "anthropic-messages",
        } as never,
        payload: { messages: [] },
        snapshot: snapshot(),
      }),
    ).not.toThrow();
    expect(() =>
      recorder?.recordResponse({ snapshot: snapshot(), message: { role: "assistant" } }),
    ).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("makes flush failures fail-soft and disables subsequent writes", async () => {
    const write = vi.fn();
    const recorder = createProviderReplayRecorder({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "raw" },
      runId: "run-flush-failure",
      writer: {
        filePath: "memory-flush-failure",
        write,
        flush: async () => {
          throw new Error("disk unavailable");
        },
      },
    });

    await expect(recorder?.flush()).resolves.toBeUndefined();
    recorder?.recordResponse({ snapshot: snapshot(), message: { role: "assistant" } });
    expect(write).not.toHaveBeenCalled();
  });
});
