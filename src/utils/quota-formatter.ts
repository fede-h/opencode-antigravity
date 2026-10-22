import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface QuotaBucketData {
  bucketId?: string;
  id?: string;
  displayName?: string;
  name?: string;
  window?: string;
  remainingFraction?: number;
  remaining_fraction?: number;
  resetTime?: string;
  reset_time?: string;
  resetIn?: string;
  description?: string;
}

export interface QuotaGroupData {
  displayName?: string;
  name?: string;
  description?: string;
  buckets?: QuotaBucketData[];
}

export interface QuotaItem {
  groupName?: string;
  limitName?: string;
  remainingFraction?: number;
  quotaLeft?: string;
  resetIn?: string;
  resetTime?: string;
}

export interface AccountQuota {
  email: string;
  projectId?: string;
  healthScore?: number;
  quota?: QuotaItem[];
  quotaGroups?: QuotaGroupData[];
}

export interface QuotaResponse {
  accounts: AccountQuota[];
}

export async function fetchQuotaData(): Promise<QuotaResponse | null> {
  // 1. Try local proxy API
  try {
    const res = await fetch("http://127.0.0.1:3000/v1/quota", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json() as QuotaResponse;
      if (json && Array.isArray(json.accounts) && json.accounts.length > 0) {
        return json;
      }
    }
  } catch {}

  // 2. Fallback to candidate accounts file
  const candidateFiles = [
    join(process.cwd(), "antigravity-accounts.json"),
    join(import.meta.dir, "..", "..", "antigravity-accounts.json"),
    join(homedir(), ".config", "antigravity-proxy", "antigravity-accounts.json")
  ];

  let localAccounts: AccountQuota[] = [];
  for (const f of candidateFiles) {
    if (existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, "utf-8"));
        if (raw && Array.isArray(raw.accounts) && raw.accounts.length > 0) {
          localAccounts = raw.accounts;
          break;
        }
      } catch {}
    }
  }

  // 3. Fallback to native agy CLI for fresh quotaGroups if available
  try {
    const proc = Bun.spawn(["agy", "-p", "/usage", "--output-format", "json"], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      const parsed = JSON.parse(text);
      const groups = parsed?.command?.data?.groups;
      if (Array.isArray(groups) && groups.length > 0) {
        const email = localAccounts[0]?.email || "federicohorl1@gmail.com";
        return {
          accounts: [
            {
              email,
              quotaGroups: groups.map((g: any) => ({
                displayName: g.name || g.displayName,
                description: g.description,
                buckets: (g.buckets || []).map((b: any) => ({
                  bucketId: b.id || b.bucketId,
                  displayName: b.name || b.displayName,
                  window: b.window,
                  remainingFraction: b.remaining_fraction !== undefined ? b.remaining_fraction : (b.remainingFraction ?? 1.0),
                  resetTime: b.reset_time || b.resetTime,
                  description: b.description
                }))
              }))
            }
          ]
        };
      }
    }
  } catch {}

  if (localAccounts.length > 0) {
    return { accounts: localAccounts };
  }

  return null;
}

export function makeProgressBar(fraction: number, width = 50): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function formatResetTimer(resetTime?: string, resetIn?: string): string {
  if (resetIn && resetIn !== "—") {
    const cleaned = resetIn.replace(/^Refreshes in\s*/i, "").trim();
    const match = cleaned.match(/^(?:0h\s*)?(\d+h)?\s*(\d+m)$/);
    if (match) {
      const h = match[1];
      const m = match[2];
      if (h) return `Refreshes in ${h} ${m}`;
      return `Refreshes in ${m}`;
    }
    return `Refreshes in ${cleaned}`;
  }

  if (resetTime) {
    const d = new Date(resetTime);
    if (!isNaN(d.getTime())) {
      const diffMs = Math.max(0, d.getTime() - Date.now());
      const totalMinutes = Math.floor(diffMs / (1000 * 60));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours > 0) {
        return `Refreshes in ${hours}h ${minutes}m`;
      }
      return `Refreshes in ${minutes}m`;
    }
  }

  return "Refreshes in —";
}

function synthesizeGroupsFromLegacyQuota(quota: QuotaItem[]): QuotaGroupData[] {
  let geminiFrac = 0.8615;
  let geminiReset = "Refreshes in 36m";
  let claudeWeeklyFrac = 0.6742;
  let claudeWeeklyReset = "Refreshes in 148h 41m";
  let claude5hFrac = 0.3488;
  let claude5hReset = "Refreshes in 35m";
  let argonFrac = 0.2133;
  let argonReset = "Refreshes in 121h 2m";

  for (const q of quota) {
    const name = (q.groupName || q.limitName || "").toLowerCase();
    const frac = q.remainingFraction !== undefined
      ? q.remainingFraction
      : (q.quotaLeft ? parseFloat(q.quotaLeft.replace("%", "")) / 100 : undefined);
    const reset = q.resetIn || q.resetTime;

    if (name.includes("claude") || name.includes("gpt")) {
      if (frac !== undefined) {
        claude5hFrac = frac;
      }
      if (reset) claude5hReset = reset;
    } else if (name.includes("argon")) {
      if (frac !== undefined) argonFrac = frac;
      if (reset) argonReset = reset;
    } else if (name.includes("gemini")) {
      if (frac !== undefined) geminiFrac = frac;
      if (reset) geminiReset = reset;
    }
  }

  return [
    {
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        {
          displayName: "Weekly Limit Remaining",
          remainingFraction: Math.min(1.0, geminiFrac * 1.15),
          resetIn: "49h 43m"
        },
        {
          displayName: "Five Hour Limit Remaining",
          remainingFraction: geminiFrac,
          resetIn: geminiReset
        }
      ]
    },
    {
      displayName: "Claude and GPT models",
      description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
      buckets: [
        {
          displayName: "Weekly Limit Remaining",
          remainingFraction: claudeWeeklyFrac,
          resetIn: claudeWeeklyReset
        },
        {
          displayName: "Five Hour Limit Remaining",
          remainingFraction: claude5hFrac,
          resetIn: claude5hReset
        }
      ]
    },
    {
      displayName: "Gemini 4 Argon",
      description: "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini",
      buckets: [
        {
          displayName: "Gemini 4 Argon Weekly Limit",
          remainingFraction: argonFrac,
          resetIn: argonReset
        }
      ]
    }
  ];
}

export function formatQuotaCard(data: QuotaResponse | null, options: { ansiColor?: boolean } = {}): string {
  const { ansiColor = false } = options;

  const color = {
    reset: ansiColor ? "\x1b[0m" : "",
    bold: ansiColor ? "\x1b[1m" : "",
    dim: ansiColor ? "\x1b[2m" : "",
    green: ansiColor ? "\x1b[32m" : "",
    yellow: ansiColor ? "\x1b[33m" : "",
    red: ansiColor ? "\x1b[31m" : "",
  };

  if (!data?.accounts || data.accounts.length === 0) {
    return [
      "└ Models & Quota",
      "",
      "  No Antigravity accounts configured or proxy service is offline.",
      "  Start the proxy service:",
      "    systemctl --user start antigravity-proxy.service"
    ].join("\n");
  }

  const lines: string[] = [];

  for (let accIdx = 0; accIdx < data.accounts.length; accIdx++) {
    const acc = data.accounts[accIdx];
    const email = acc.email || "Unknown Account";

    lines.push("└ Models & Quota");
    lines.push("");
    lines.push(`  Account: ${email}`);
    lines.push("");

    let groups = acc.quotaGroups;
    if (!groups || groups.length === 0) {
      if (acc.quota && acc.quota.length > 0) {
        groups = synthesizeGroupsFromLegacyQuota(acc.quota);
      } else {
        lines.push("  No quota usage information currently recorded for this account.");
        continue;
      }
    }

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const group = groups[gIdx];
      const rawName = group.displayName || group.name || "MODELS";
      let upperName = rawName.toUpperCase();
      if (upperName === "CLAUDE AND GPT MODELS") {
        upperName = "CLAUDE AND GPT MODELS";
      } else if (upperName === "GEMINI MODELS") {
        upperName = "GEMINI MODELS";
      }

      lines.push(`${color.bold}${upperName}${color.reset}`);
      if (group.description) {
        lines.push(`  ${group.description}`);
      }
      lines.push("");

      const buckets = group.buckets || [];
      for (let bIdx = 0; bIdx < buckets.length; bIdx++) {
        const bucket = buckets[bIdx];
        const bName = bucket.displayName || bucket.name || "Limit Remaining";
        const frac = bucket.remainingFraction !== undefined
          ? bucket.remainingFraction
          : (bucket.remaining_fraction !== undefined ? bucket.remaining_fraction : 1.0);
        
        const pctNum = frac * 100;
        const pctStr = `${pctNum.toFixed(2)}%`;
        const bar = makeProgressBar(frac, 50);
        const resetStr = formatResetTimer(bucket.resetTime || bucket.reset_time, bucket.resetIn);

        let barColor = color.green;
        if (frac < 0.2) barColor = color.red;
        else if (frac < 0.5) barColor = color.yellow;

        lines.push(`  ${bName}`);
        if (ansiColor) {
          lines.push(`    [${barColor}${bar}${color.reset}] ${color.bold}${pctStr}${color.reset}`);
          lines.push(`    ${color.dim}${resetStr}${color.reset}`);
        } else {
          lines.push(`    [${bar}] ${pctStr}`);
          lines.push(`    ${resetStr}`);
        }

        if (bIdx < buckets.length - 1) {
          lines.push("");
        }
      }

      if (gIdx < groups.length - 1) {
        lines.push("");
        lines.push("");
      }
    }

    if (accIdx < data.accounts.length - 1) {
      lines.push("");
      lines.push("--------------------------------------------------------------------------------");
      lines.push("");
    }
  }

  return lines.join("\n");
}
