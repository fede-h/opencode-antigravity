import { describe, expect, it } from "bun:test";
import { formatQuotaCard, makeProgressBar, formatResetTimer, type QuotaResponse } from "../../src/utils/quota-formatter";

describe("Quota Formatter Unit Tests", () => {
  it("renders 50-width progress bars with correct filled/empty ratios", () => {
    expect(makeProgressBar(1.0, 50)).toBe("█".repeat(50));
    expect(makeProgressBar(0.0, 50)).toBe("░".repeat(50));
    
    // 86.15% of 50 = 43 filled, 7 empty
    const p86 = makeProgressBar(0.8615, 50);
    expect(p86).toBe("█".repeat(43) + "░".repeat(7));
    expect(p86.length).toBe(50);

    // 74.77% of 50 = 37 filled, 13 empty
    const p74 = makeProgressBar(0.7477, 50);
    expect(p74).toBe("█".repeat(37) + "░".repeat(13));
    expect(p74.length).toBe(50);

    // 67.42% of 50 = 34 filled, 16 empty
    const p67 = makeProgressBar(0.6742, 50);
    expect(p67).toBe("█".repeat(34) + "░".repeat(16));
    expect(p67.length).toBe(50);

    // 34.88% of 50 = 17 filled, 33 empty
    const p35 = makeProgressBar(0.3488, 50);
    expect(p35).toBe("█".repeat(17) + "░".repeat(33));
    expect(p35.length).toBe(50);

    // 21.33% of 50 = 11 filled, 39 empty
    const p21 = makeProgressBar(0.2133, 50);
    expect(p21).toBe("█".repeat(11) + "░".repeat(39));
    expect(p21.length).toBe(50);
  });

  it("formats countdown timers without leading zero hour", () => {
    expect(formatResetTimer(undefined, "49h 43m")).toBe("49h 43m");
    expect(formatResetTimer(undefined, "0h 36m")).toBe("36m");
    expect(formatResetTimer(undefined, "36m")).toBe("36m");
    expect(formatResetTimer(undefined, "121h 2m")).toBe("121h 2m");
  });

  it("renders friendly offline warning when no accounts or data", () => {
    const card = formatQuotaCard(null);
    expect(card).toContain("ANTIGRAVITY USAGE & QUOTA");
    expect(card).toContain("proxy service is offline");
    expect(card.split("\n").length).toBe(5);
  });

  it("renders compact hybrid table quota layout with 8 lines and native antigravity styling", () => {
    const mockData: QuotaResponse = {
      accounts: [
        {
          email: "federicohorl1@gmail.com",
          projectId: "tranquera-495815",
          healthScore: 100,
          quotaGroups: [
            {
              displayName: "Gemini Models",
              description: "Models within this group: Gemini Flash, Gemini Pro",
              buckets: [
                {
                  displayName: "Weekly Limit Remaining",
                  remainingFraction: 0.8615,
                  resetIn: "49h 43m"
                },
                {
                  displayName: "Five Hour Limit Remaining",
                  remainingFraction: 0.7477,
                  resetIn: "36m"
                }
              ]
            },
            {
              displayName: "Claude and GPT models",
              description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
              buckets: [
                {
                  displayName: "Weekly Limit Remaining",
                  remainingFraction: 0.6742,
                  resetIn: "148h 41m"
                },
                {
                  displayName: "Five Hour Limit Remaining",
                  remainingFraction: 0.3488,
                  resetIn: "35m"
                }
              ]
            },
            {
              displayName: "Gemini 4 Argon",
              description: "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini",
              buckets: [
                {
                  displayName: "Gemini 4 Argon Weekly Limit",
                  remainingFraction: 0.2133,
                  resetIn: "121h 2m"
                }
              ]
            }
          ]
        }
      ]
    };

    const card = formatQuotaCard(mockData, { ansiColor: false });
    const lines = card.split("\n");

    // Must be exactly 8 lines so OpenCode never collapses into "(N earlier lines)"
    expect(lines.length).toBe(8);

    // Header & Account
    expect(card).toContain("ANTIGRAVITY USAGE & QUOTA");
    expect(card).toContain("federicohorl1@gmail.com · tranquera-495815");
    expect(card).toContain("Health: 100%");

    // All canonical limits
    expect(card).toContain("Gemini (Flash/Pro) · 5-Hour");
    expect(card).toContain("74.77%");
    expect(card).toContain("36m");

    expect(card).toContain("Gemini (Flash/Pro) · Weekly");
    expect(card).toContain("86.15%");
    expect(card).toContain("49h 43m");

    expect(card).toContain("Claude & GPT · 5-Hour");
    expect(card).toContain("34.88%");
    expect(card).toContain("35m");

    expect(card).toContain("Claude & GPT · Weekly");
    expect(card).toContain("67.42%");
    expect(card).toContain("148h 41m");

    expect(card).toContain("Gemini 4 Argon · Weekly");
    expect(card).toContain("21.33%");
    expect(card).toContain("121h 2m");

    // Symbol indicators
    expect(card).toContain("●"); // >= 50%
    expect(card).toContain("▲"); // 20% - 49%

    // Line widths must be consistent at 74 chars
    for (const line of lines) {
      expect(line.length).toBe(74);
    }

    // ANSI mode
    const ansiCard = formatQuotaCard(mockData, { ansiColor: true });
    const ansiLines = ansiCard.split("\n");
    expect(ansiLines.length).toBe(8);
    for (const line of ansiLines) {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(stripped.length).toBe(74);
    }
  });
});
