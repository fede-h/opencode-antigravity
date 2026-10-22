import { expect, test, describe } from "bun:test";
import { getFamilyName, flagModelUnsupported, isModelUnsupported, resetAllCooldowns } from "../../src/auth/manager";

describe("Manager Utils", () => {
  test("getFamilyName should correctly classify models", () => {
    expect(getFamilyName("gemini-1.5-flash")).toBe("Gemini 3 Flash");
    expect(getFamilyName("gemini-1.5-pro")).toBe("Gemini 3 Pro");
    expect(getFamilyName("claude-3-5-sonnet")).toBe("Claude/GPT");
    expect(getFamilyName("gpt-4o")).toBe("Claude/GPT");
    expect(getFamilyName("gemini-2.5-flash")).toBe("Gemini 2.5");
    expect(getFamilyName("unknown-model")).toBe("Other");
  });

  test("flagModelUnsupported and isModelUnsupported TTL behavior", () => {
    const email = "test@example.com";
    const model = "antigravity-claude-test";

    expect(isModelUnsupported(email, model)).toBe(false);

    // Flag unsupported with 50ms TTL
    flagModelUnsupported(email, model, 50);
    expect(isModelUnsupported(email, model)).toBe(true);

    // Reset should clear unsupported flags
    resetAllCooldowns();
    expect(isModelUnsupported(email, model)).toBe(false);
  });
});
