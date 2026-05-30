import { describe, expect, it } from "vitest";
import { truncatePromptContextText } from "./inbound-context-budget.js";

describe("truncatePromptContextText", () => {
  it("keeps the truncation marker inside the requested character cap", () => {
    const result = truncatePromptContextText("x".repeat(2_000), {
      maxChars: 1_000,
      label: "test block",
    });

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("OpenClaw truncated");
    expect(result.text.length).toBeLessThanOrEqual(1_000);
  });
});
