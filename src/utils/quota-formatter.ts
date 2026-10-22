import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
}

export interface QuotaResponse {
  accounts: AccountQuota[];
}

export async function fetchQuotaData(): Promise<QuotaResponse | null> {
  try {
    const res = await fetch("http://127.0.0.1:3000/v1/quota", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json() as QuotaResponse;
      if (json && Array.isArray(json.accounts) && json.accounts.length > 0) {
        return json;
      }
    }
  } catch {}

  // Fallback to local accounts file
  const candidateFiles = [
    join(process.cwd(), "antigravity-accounts.json"),
    join(import.meta.dir, "..", "..", "antigravity-accounts.json"),
    join(homedir(), ".config", "antigravity-proxy", "antigravity-accounts.json")
  ];

  for (const f of candidateFiles) {
    if (existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, "utf-8"));
        if (raw && Array.isArray(raw.accounts) && raw.accounts.length > 0) {
          return { accounts: raw.accounts };
        }
      } catch {}
    }
  }

  return null;
}

export function makeProgressBar(fraction: number, width = 14): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
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
    cyan: ansiColor ? "\x1b[36m" : "",
  };

  if (!data?.accounts || data.accounts.length === 0) {
    return [
      "┌────────────────────────────────────────────────────────────────────────┐",
      "│                       ANTIGRAVITY USAGE & QUOTA                        │",
      "├────────────────────────────────────────────────────────────────────────┤",
      "│  No Antigravity accounts configured or proxy service is offline.       │",
      "│  Try starting the proxy service:                                       │",
      "│    systemctl --user start antigravity-proxy.service                    │",
      "└────────────────────────────────────────────────────────────────────────┘"
    ].join("\n");
  }

  const lines: string[] = [];

  for (const acc of data.accounts) {
    lines.push("┌────────────────────────────────────────────────────────────────────────┐");
    const title = "ANTIGRAVITY USAGE & QUOTA";
    lines.push(`│ ${title.padStart(35 + Math.floor(title.length / 2)).padEnd(70)} │`);
    
    const email = acc.email || "Unknown Account";
    const project = acc.projectId || "default";
    const health = acc.healthScore ?? 100;
    const meta = `${email} · ${project} · Health: ${health}%`;
    lines.push(`│ ${meta.padStart(35 + Math.floor(meta.length / 2)).padEnd(70)} │`);
    lines.push("├────────────────────────────────────────────────────────────────────────┤");
    lines.push("│ MODEL GROUP                     REMAINING    METER              RESET  │");
    lines.push("├────────────────────────────────────────────────────────────────────────┤");

    if (!acc.quota || acc.quota.length === 0) {
      lines.push("│   No quota usage information currently recorded for this account.      │");
      lines.push("└────────────────────────────────────────────────────────────────────────┘");
      continue;
    }

    // Group variants that share the base name, fraction, and reset timer
    interface GroupEntry {
      name: string;
      fraction: number;
      resetIn: string;
      variants: string[];
    }
    const grouped: Record<string, GroupEntry> = {};

    for (const q of acc.quota) {
      const rawName = q.groupName || q.limitName || "Unknown Model";
      const baseName = rawName.replace(/\s*\((High|Low|Medium|default)\)/i, "").trim();
      const fraction = q.remainingFraction !== undefined
        ? q.remainingFraction
        : (q.quotaLeft ? parseFloat(q.quotaLeft.replace("%", "")) / 100 : 1.0);
      const resetIn = q.resetIn || q.resetTime || "—";
      const key = `${baseName}__${Math.round(fraction * 100)}__${resetIn}`;

      if (!grouped[key]) {
        grouped[key] = {
          name: baseName,
          fraction,
          resetIn,
          variants: []
        };
      }

      const match = rawName.match(/\((High|Low|Medium)\)/i);
      if (match) {
        let v = match[1];
        if (v.toLowerCase() === "medium") v = "Med";
        if (!grouped[key].variants.includes(v)) {
          grouped[key].variants.push(v);
        }
      }
    }

    for (const entry of Object.values(grouped)) {
      let displayName = entry.name;
      if (entry.variants.length > 1) {
        // Sort variants: High, Med, Low
        const order = ["High", "Med", "Low"];
        entry.variants.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        displayName += ` (${entry.variants.join("/")})`;
      } else if (entry.variants.length === 1) {
        displayName += ` (${entry.variants[0]})`;
      }

      const frac = entry.fraction;
      const pctNum = Math.round(frac * 100);
      const pctStr = `${pctNum}%`;
      const bar = makeProgressBar(frac, 14);

      let symbol = "●";
      let statusColor = color.green;
      if (frac < 0.2) {
        symbol = "✖";
        statusColor = color.red;
      } else if (frac < 0.5) {
        symbol = "▲";
        statusColor = color.yellow;
      }

      const nameCol = displayName.length > 32 ? displayName.slice(0, 29) + "..." : displayName.padEnd(32);
      const pctCol = pctStr.padStart(4);
      const resetCol = entry.resetIn.padStart(6);

      if (ansiColor) {
        const row = `${statusColor}${symbol}${color.reset} ${nameCol} ${color.bold}${pctCol}${color.reset}   [${statusColor}${bar}${color.reset}]  ${color.dim}${resetCol}${color.reset}`;
        const rawRow = `${symbol} ${nameCol} ${pctCol}   [${bar}]  ${resetCol}`;
        const rightPad = Math.max(0, 70 - rawRow.length);
        lines.push(`│ ${row}${" ".repeat(rightPad)} │`);
      } else {
        const row = `${symbol} ${nameCol} ${pctCol}   [${bar}]  ${resetCol}`;
        lines.push(`│ ${row.padEnd(70)} │`);
      }
    }

    lines.push("└────────────────────────────────────────────────────────────────────────┘");
  }

  return lines.join("\n");
}
