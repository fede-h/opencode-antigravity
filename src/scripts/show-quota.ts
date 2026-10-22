#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

async function main() {
  let data: any = null;
  try {
    const res = await fetch("http://127.0.0.1:3000/v1/quota");
    if (res.ok) {
      data = await res.json();
    }
  } catch {}

  if (!data?.accounts) {
    const projectRoot = join(import.meta.dir, "..", "..");
    const candidateFiles = [
      join(projectRoot, "antigravity-accounts.json"),
      join(homedir(), ".config", "antigravity-proxy", "antigravity-accounts.json")
    ];
    for (const f of candidateFiles) {
      if (existsSync(f)) {
        try {
          const raw = JSON.parse(readFileSync(f, "utf-8"));
          data = { accounts: raw.accounts || [] };
          break;
        } catch {}
      }
    }
  }

  if (!data?.accounts || data.accounts.length === 0) {
    console.log("No Antigravity accounts configured or quota data available.");
    return;
  }

  for (const acc of data.accounts) {
    console.log(`\nAccount: ${acc.email} (${acc.projectId || "Default Project"})`);
    console.log(`Health Score: ${acc.healthScore ?? 100}%`);
    console.log("─".repeat(65));
    console.log(
      "Model Group".padEnd(32) +
      "Quota Left".padEnd(16) +
      "Reset In"
    );
    console.log("─".repeat(65));
    if (!acc.quota || acc.quota.length === 0) {
      console.log("  No quota information found.");
      continue;
    }
    for (const q of acc.quota) {
      const name = q.groupName || q.limitName || "Unknown";
      const left = q.quotaLeft || (q.remainingFraction !== undefined ? `${Math.round(q.remainingFraction * 100)}%` : "Unknown");
      const reset = q.resetIn || q.resetTime || "—";
      console.log(name.padEnd(32) + left.padEnd(16) + reset);
    }
  }
  console.log();
}

main().catch(console.error);
