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

  it("formats countdown timers with Refreshes in prefix without leading zero hour", () => {
    expect(formatResetTimer(undefined, "49h 43m")).toBe("Refreshes in 49h 43m");
    expect(formatResetTimer(undefined, "0h 36m")).toBe("Refreshes in 36m");
    expect(formatResetTimer(undefined, "36m")).toBe("Refreshes in 36m");
    expect(formatResetTimer(undefined, "121h 2m")).toBe("Refreshes in 121h 2m");
  });

  it("renders friendly offline warning when no accounts or data", () => {
    const card = formatQuotaCard(null);
    expect(card).toContain("└ Models & Quota");
    expect(card).toContain("proxy service is offline");
  });

  it("renders canonical Antigravity Models & Quota tree layout", () => {
    const mockData: QuotaResponse = {
      accounts: [
        {
          email: "federicohorl1@gmail.com",
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
    
    // Header & Account
    expect(card).toContain("└ Models & Quota");
    expect(card).toContain("  Account: federicohorl1@gmail.com");

    // Group 1: Gemini Models
    expect(card).toContain("GEMINI MODELS");
    expect(card).toContain("  Models within this group: Gemini Flash, Gemini Pro");
    expect(card).toContain("  Weekly Limit Remaining");
    expect(card).toContain("    [███████████████████████████████████████████░░░░░░░] 86.15%");
    expect(card).toContain("    Refreshes in 49h 43m");
    expect(card).toContain("  Five Hour Limit Remaining");
    expect(card).toContain("    [█████████████████████████████████████░░░░░░░░░░░░░] 74.77%");
    expect(card).toContain("    Refreshes in 36m");

    // Group 2: Claude and GPT Models
    expect(card).toContain("CLAUDE AND GPT MODELS");
    expect(card).toContain("  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS");
    expect(card).toContain("    [██████████████████████████████████░░░░░░░░░░░░░░░░] 67.42%");
    expect(card).toContain("    Refreshes in 148h 41m");
    expect(card).toContain("    [█████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 34.88%");
    expect(card).toContain("    Refreshes in 35m");

    // Group 3: Gemini 4 Argon
    expect(card).toContain("GEMINI 4 ARGON");
    expect(card).toContain("  Gemini 4 Argon Weekly Limit");
    expect(card).toContain("    [███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 21.33%");
    expect(card).toContain("    Refreshes in 121h 2m");
  });
});
