import { describe, expect, it } from "bun:test";
import { formatQuotaCard, makeProgressBar, type QuotaResponse } from "../../src/utils/quota-formatter";

describe("Quota Formatter Unit Tests", () => {
  it("renders progress bars with correct filled/empty ratios", () => {
    expect(makeProgressBar(1.0, 10)).toBe("██████████");
    expect(makeProgressBar(0.5, 10)).toBe("█████░░░░░");
    expect(makeProgressBar(0.0, 10)).toBe("░░░░░░░░░░");
    expect(makeProgressBar(0.8, 10)).toBe("████████░░");
  });

  it("renders friendly offline warning when no accounts or data", () => {
    const card = formatQuotaCard(null);
    expect(card).toContain("ANTIGRAVITY USAGE & QUOTA");
    expect(card).toContain("proxy service is offline");
  });

  it("renders formatted ASCII card with model groups and status symbols", () => {
    const mockData: QuotaResponse = {
      accounts: [
        {
          email: "test@example.com",
          projectId: "test-proj",
          healthScore: 98,
          quota: [
            {
              groupName: "Claude Opus 5.5 (High)",
              remainingFraction: 0.35,
              resetIn: "1h 2m"
            },
            {
              groupName: "Claude Opus 5.5 (Low)",
              remainingFraction: 0.35,
              resetIn: "1h 2m"
            },
            {
              groupName: "Gemini 2.5 Pro",
              remainingFraction: 0.85,
              resetIn: "2h 15m"
            },
            {
              groupName: "Exhausted Model",
              remainingFraction: 0.05,
              resetIn: "0h 10m"
            }
          ]
        }
      ]
    };

    const card = formatQuotaCard(mockData, { ansiColor: false });
    expect(card).toContain("test@example.com · test-proj · Health: 98%");
    expect(card).toContain("Claude Opus 5.5 (High/Low)");
    expect(card).toContain("35%");
    expect(card).toContain("1h 2m");
    expect(card).toContain("Gemini 2.5 Pro");
    expect(card).toContain("85%");
    expect(card).toContain("2h 15m");
    // Symbol indicators
    expect(card).toContain("▲"); // moderate (< 50%)
    expect(card).toContain("●"); // healthy (>= 50%)
    expect(card).toContain("✖"); // critical (< 20%)
  });
});
