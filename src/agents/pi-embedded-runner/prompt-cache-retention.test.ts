import { describe, expect, it } from "vitest";
import { isGooglePromptCacheEligible, resolveCacheRetention } from "./prompt-cache-retention.js";

describe("prompt cache retention", () => {
  it("passes explicit cacheRetention through for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "google",
        "google-generative-ai",
        "gemini-3.1-pro-preview",
      ),
    ).toBe("long");
  });

  it("maps legacy cacheControlTtl for direct Google models", () => {
    expect(
      resolveCacheRetention(
        { cacheControlTtl: "5m" },
        "google",
        "google-generative-ai",
        "gemini-2.5-flash",
      ),
    ).toBe("short");
  });

  it("does not default cacheRetention for direct Google models without explicit config", () => {
    expect(
      resolveCacheRetention(undefined, "google", "google-generative-ai", "gemini-3.1-pro-preview"),
    ).toBeUndefined();
  });

  it("passes explicit cacheRetention through for opaque Bedrock application profiles", () => {
    expect(
      resolveCacheRetention(
        { cacheRetention: "long" },
        "amazon-bedrock",
        "bedrock-converse-stream",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/prod-main",
      ),
    ).toBe("long");
  });

  it("does not infer cacheRetention for opaque Bedrock application profiles without config", () => {
    expect(
      resolveCacheRetention(
        undefined,
        "amazon-bedrock",
        "bedrock-converse-stream",
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/prod-main",
      ),
    ).toBeUndefined();
  });

  it("identifies supported direct Google cache families", () => {
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      }),
    ).toBe(true);
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-2.5-flash",
      }),
    ).toBe(true);
    expect(
      isGooglePromptCacheEligible({
        modelApi: "google-generative-ai",
        modelId: "gemini-live-2.5-flash-preview",
      }),
    ).toBe(false);
  });
});
