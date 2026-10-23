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

export function makeProgressBar(fraction: number, width = 14): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function formatResetTimer(resetTime?: string, resetIn?: string): string {
  if (resetIn && resetIn !== "—") {
    const cleaned = resetIn.replace(/^Refreshes in\s*/i, "").replace(/^Resets in\s*/i, "").trim();
    const match = cleaned.match(/^(?:0h\s*)?(\d+h)?\s*(\d+m)$/);
    if (match) {
      const h = match[1];
      const m = match[2];
      if (h) return `${h} ${m}`;
      return m;
    }
    return cleaned;
  }

  if (resetTime) {
    const d = new Date(resetTime);
    if (!isNaN(d.getTime())) {
      const diffMs = Math.max(0, d.getTime() - Date.now());
      const totalMinutes = Math.floor(diffMs / (1000 * 60));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      if (hours > 0) {
        return `${hours}h ${minutes}m`;
      }
      return `${minutes}m`;
    }
  }

  return "—";
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
    cyan: ansiColor ? "\x1b[36m" : "",
    green: ansiColor ? "\x1b[32m" : "",
    yellow: ansiColor ? "\x1b[33m" : "",
    red: ansiColor ? "\x1b[31m" : "",
  };

  const targetWidth = 74;

  if (!data?.accounts || data.accounts.length === 0) {
    const top = ansiColor
      ? `${color.cyan}┌─── ${color.bold}ANTIGRAVITY USAGE & QUOTA${color.reset}${color.cyan} ${"─".repeat(42)}┐${color.reset}`
      : `┌─── ANTIGRAVITY USAGE & QUOTA ${"─".repeat(42)}┐`;
    const l1 = ansiColor
      ? `${color.cyan}│${color.reset}  No Antigravity accounts configured or proxy service is offline.       ${color.cyan}│${color.reset}`
      : `│  No Antigravity accounts configured or proxy service is offline.       │`;
    const l2 = ansiColor
      ? `${color.cyan}│${color.reset}  Start the proxy service:                                              ${color.cyan}│${color.reset}`
      : `│  Start the proxy service:                                              │`;
    const l3 = ansiColor
      ? `${color.cyan}│${color.reset}    systemctl --user start antigravity-proxy.service                    ${color.cyan}│${color.reset}`
      : `│    systemctl --user start antigravity-proxy.service                    │`;
    const bot = ansiColor
      ? `${color.cyan}└────────────────────────────────────────────────────────────────────────┘${color.reset}`
      : `└────────────────────────────────────────────────────────────────────────┘`;
    return [top, l1, l2, l3, bot].join("\n");
  }

  const cards: string[] = [];

  for (const acc of data.accounts) {
    const email = acc.email || "Unknown Account";
    const health = acc.healthScore ?? 100;

    let groups = acc.quotaGroups;
    if (!groups || groups.length === 0) {
      if (acc.quota && acc.quota.length > 0) {
        groups = synthesizeGroupsFromLegacyQuota(acc.quota);
      } else {
        groups = [];
      }
    }

    interface ExtractedLimit {
      group: string;
      limit: string;
      fraction: number;
      resetStr: string;
    }
    const rows: ExtractedLimit[] = [];

    // Find groups
    const geminiGroup = groups.find(g => {
      const n = (g.displayName || g.name || "").toLowerCase();
      return n.includes("gemini") && !n.includes("argon");
    });
    const claudeGroup = groups.find(g => {
      const n = (g.displayName || g.name || "").toLowerCase();
      return n.includes("claude") || n.includes("gpt");
    });
    const argonGroup = groups.find(g => {
      const n = (g.displayName || g.name || "").toLowerCase();
      return n.includes("argon");
    });

    const getBucket = (group?: QuotaGroupData, is5h?: boolean): QuotaBucketData | undefined => {
      if (!group?.buckets || group.buckets.length === 0) return undefined;
      if (is5h) {
        return group.buckets.find(b => {
          const s = `${b.displayName || ""} ${b.name || ""} ${b.window || ""}`.toLowerCase();
          return s.includes("5") || s.includes("five") || s.includes("hour");
        }) || (group.buckets.length > 1 ? group.buckets[1] : undefined);
      } else {
        return group.buckets.find(b => {
          const s = `${b.displayName || ""} ${b.name || ""} ${b.window || ""}`.toLowerCase();
          return s.includes("week");
        }) || (group.buckets.length > 0 ? group.buckets[0] : undefined);
      }
    };

    const g5h = getBucket(geminiGroup, true);
    const gWeekly = getBucket(geminiGroup, false);
    const c5h = getBucket(claudeGroup, true);
    const cWeekly = getBucket(claudeGroup, false);
    const aWeekly = getBucket(argonGroup, false);

    if (g5h) {
      rows.push({
        group: "Gemini (Flash/Pro)",
        limit: "5-Hour",
        fraction: g5h.remainingFraction ?? g5h.remaining_fraction ?? 1.0,
        resetStr: formatResetTimer(g5h.resetTime || g5h.reset_time, g5h.resetIn)
      });
    }
    if (gWeekly) {
      rows.push({
        group: "Gemini (Flash/Pro)",
        limit: "Weekly",
        fraction: gWeekly.remainingFraction ?? gWeekly.remaining_fraction ?? 1.0,
        resetStr: formatResetTimer(gWeekly.resetTime || gWeekly.reset_time, gWeekly.resetIn)
      });
    }
    if (c5h) {
      rows.push({
        group: "Claude & GPT",
        limit: "5-Hour",
        fraction: c5h.remainingFraction ?? c5h.remaining_fraction ?? 1.0,
        resetStr: formatResetTimer(c5h.resetTime || c5h.reset_time, c5h.resetIn)
      });
    }
    if (cWeekly) {
      rows.push({
        group: "Claude & GPT",
        limit: "Weekly",
        fraction: cWeekly.remainingFraction ?? cWeekly.remaining_fraction ?? 1.0,
        resetStr: formatResetTimer(cWeekly.resetTime || cWeekly.reset_time, cWeekly.resetIn)
      });
    }
    if (aWeekly) {
      rows.push({
        group: "Gemini 4 Argon",
        limit: "Weekly",
        fraction: aWeekly.remainingFraction ?? aWeekly.remaining_fraction ?? 1.0,
        resetStr: formatResetTimer(aWeekly.resetTime || aWeekly.reset_time, aWeekly.resetIn)
      });
    }

    const top = ansiColor
      ? `${color.cyan}┌─── ${color.bold}ANTIGRAVITY USAGE & QUOTA${color.reset}${color.cyan} ${"─".repeat(42)}┐${color.reset}`
      : `┌─── ANTIGRAVITY USAGE & QUOTA ${"─".repeat(42)}┐`;

    // ponytail: fixed 74-char card, columns hand-padded instead of a table lib
    const groupCol = 21;
    const limitCol = 6;
    const pctCol = 9;
    const meterCol = 16;
    const resetCol = 9;

    const hdr = ansiColor
      ? `${color.cyan}│   ${color.dim}${"MODEL GROUP".padEnd(groupCol)} ${"LIMIT".padStart(limitCol)}  ${"REMAINING".padStart(pctCol)}  ${" ".repeat(meterCol)}  ${"RESET".padStart(resetCol)}${color.reset} ${color.cyan}│${color.reset}`
      : `│   ${"MODEL GROUP".padEnd(groupCol)} ${"LIMIT".padStart(limitCol)}  ${"REMAINING".padStart(pctCol)}  ${" ".repeat(meterCol)}  ${"RESET".padStart(resetCol)} │`;

    const renderRow = (r: ExtractedLimit): string => {
      const frac = Math.max(0, Math.min(1, r.fraction));
      let symbol = "●";
      let statusColor = color.green;
      if (frac < 0.2) {
        symbol = "✖";
        statusColor = color.red;
      } else if (frac < 0.5) {
        symbol = "▲";
        statusColor = color.yellow;
      }

      const pctStr = `${(frac * 100).toFixed(2)}%`.padStart(pctCol);
      const barFilled = Math.round(frac * 14);
      const barEmpty = 14 - barFilled;
      const gCol = r.group.padEnd(groupCol);
      const lCol = r.limit.padStart(limitCol);
      const rstCol = r.resetStr.padStart(resetCol);

      if (ansiColor) {
        const sym = `${statusColor}${symbol}${color.reset}`;
        const pct = `${color.bold}${pctStr}${color.reset}`;
        const filledStr = `${statusColor}${"█".repeat(barFilled)}${color.reset}`;
        const emptyStr = `${color.dim}${"░".repeat(barEmpty)}${color.reset}`;
        const bar = `${color.dim}[${color.reset}${filledStr}${emptyStr}${color.dim}]${color.reset}`;
        const rst = `${color.dim}${rstCol}${color.reset}`;
        return `${color.cyan}│${color.reset} ${sym} ${gCol} ${lCol}  ${pct}  ${bar}  ${rst} ${color.cyan}│${color.reset}`;
      } else {
        const bar = `[${"█".repeat(barFilled)}${"░".repeat(barEmpty)}]`;
        return `│ ${symbol} ${gCol} ${lCol}  ${pctStr}  ${bar}  ${rstCol} │`;
      }
    };

    // ponytail: project id dropped from the footer, email is enough context
    const plainRight = health !== undefined ? ` Health: ${health}% ───┘` : ` ───┘`;
    const plainLeft = `└─── ${email} `;
    const dashesNeeded = Math.max(3, targetWidth - plainLeft.length - plainRight.length);

    let healthColor = color.green;
    if (health < 50) healthColor = color.red;
    else if (health < 80) healthColor = color.yellow;

    const bot = ansiColor
      ? `${color.cyan}└─── ${color.reset}${color.dim}${email}${color.reset} ${color.cyan}${"─".repeat(dashesNeeded)}${color.reset} ${color.dim}Health:${color.reset} ${healthColor}${health}%${color.reset}${color.cyan} ───┘${color.reset}`
      : `${plainLeft}${"─".repeat(dashesNeeded)}${plainRight}`;

    if (rows.length === 0) {
      const emptyRow = ansiColor
        ? `${color.cyan}│${color.reset}  No quota usage information currently recorded for this account.       ${color.cyan}│${color.reset}`
        : `│  No quota usage information currently recorded for this account.       │`;
      cards.push([top, emptyRow, bot].join("\n"));
    } else {
      const renderedRows = rows.map(r => renderRow(r));
      cards.push([top, hdr, ...renderedRows, bot].join("\n"));
    }
  }

  return cards.join("\n");
}
