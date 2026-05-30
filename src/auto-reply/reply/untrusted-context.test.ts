import { describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { appendUntrustedContext } from "./untrusted-context.js";

describe("appendUntrustedContext", () => {
  it("caps untrusted context entries before appending them to the user prompt", () => {
    withEnv(
      {
        OPENCLAW_UNTRUSTED_CONTEXT_ENTRY_MAX_CHARS: "1000",
        OPENCLAW_UNTRUSTED_CONTEXT_TOTAL_MAX_CHARS: "2000",
      },
      () => {
        const text = appendUntrustedContext("hello", [
          "first".repeat(400),
          "second".repeat(400),
          "third".repeat(400),
        ]);

        expect(text).toContain("hello");
        expect(text).toContain("OpenClaw omitted");
        expect(text).toContain("OpenClaw truncated");
        expect(text.length).toBeLessThan(2_600);
      },
    );
  });
});
