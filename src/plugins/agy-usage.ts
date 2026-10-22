import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface QuotaItem {
  groupName?: string;
  limitName?: string;
  remainingFraction?: number;
  quotaLeft?: string;
  resetIn?: string;
  resetTime?: string;
}

interface AccountQuota {
  email: string;
  projectId?: string;
  healthScore?: number;
  quota?: QuotaItem[];
}

interface QuotaResponse {
  accounts: AccountQuota[];
}

async function fetchQuota(): Promise<QuotaResponse | null> {
  try {
    const res = await fetch("http://127.0.0.1:3000/v1/quota", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json() as QuotaResponse;
      if (json && Array.isArray(json.accounts) && json.accounts.length > 0) {
        return json;
      }
    }
  } catch {}

  const candidateFiles = [
    join(homedir(), "Documents", "Projects", "open-gemini", "antigravity-accounts.json"),
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

function makeProgressBar(fraction: number, width = 14): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function renderQuotaCard(data: QuotaResponse | null): string {
  if (!data?.accounts || data.accounts.length === 0) {
    return [
      "┌────────────────────────────────────────────────────────────────────────┐",
      "│                       ANTIGRAVITY USAGE & QUOTA                        │",
      "├────────────────────────────────────────────────────────────────────────┤",
      "│  No Antigravity accounts configured or proxy service is offline.       │",
      "│  Start the proxy service:                                              │",
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
      if (frac < 0.2) symbol = "✖";
      else if (frac < 0.5) symbol = "▲";

      const nameCol = displayName.length > 32 ? displayName.slice(0, 29) + "..." : displayName.padEnd(32);
      const pctCol = pctStr.padStart(4);
      const resetCol = entry.resetIn.padStart(6);

      const row = `${symbol} ${nameCol} ${pctCol}   [${bar}]  ${resetCol}`;
      lines.push(`│ ${row.padEnd(70)} │`);
    }

    lines.push("└────────────────────────────────────────────────────────────────────────┘");
  }

  return lines.join("\n");
}

export default {
  id: "agy-usage",
  async setup(ctx: any) {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "agy-usage",
        description: "Display real-time Antigravity model quota usage and reset countdowns",
        execute: async (args: any) => {
          const data = await fetchQuota();
          const card = renderQuotaCard(data);
          const formatted = "```text\n" + card + "\n```";

          if (args?.sessionID) {
            await ctx.session.synthetic({
              sessionID: args.sessionID,
              text: formatted,
              description: "Antigravity Quota Status",
              resume: false,
            });
          }
        },
      });
    });
  },
};
