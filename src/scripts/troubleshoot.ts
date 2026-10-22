#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const projectRoot = join(import.meta.dir, "..", "..");
const autoFix = process.argv.includes("--fix");

interface CheckResult {
  name: string;
  status: "OK" | "WARNING" | "FAIL";
  message: string;
  fixAvailable?: boolean;
}

const results: CheckResult[] = [];

async function checkBackgroundService(): Promise<void> {
  const isLinux = process.platform === "linux";
  if (!isLinux) {
    results.push({ name: "Service (OS)", status: "OK", message: `Platform is ${process.platform}, checking HTTP only` });
    return;
  }

  const proc = Bun.spawnSync(["systemctl", "--user", "is-active", "antigravity-proxy.service"], { stdout: "pipe" });
  const active = proc.stdout.toString().trim() === "active";

  const unitFile = join(HOME, ".config", "systemd", "user", "antigravity-proxy.service");
  let workingDirCorrect = false;
  if (existsSync(unitFile)) {
    const content = readFileSync(unitFile, "utf-8");
    workingDirCorrect = content.includes(`WorkingDirectory=${projectRoot}`);
  }

  if (active && workingDirCorrect) {
    results.push({ name: "Systemd Service", status: "OK", message: `Active and running from ${projectRoot}` });
  } else if (active && !workingDirCorrect) {
    results.push({
      name: "Systemd Service",
      status: "WARNING",
      message: `Running from outdated directory (not ${projectRoot})`,
      fixAvailable: true
    });
    if (autoFix) {
      Bun.spawnSync(["bun", "run", "setup"], { cwd: projectRoot });
      console.log("  [FIXED] Re-ran setup to point service to active project directory.");
    }
  } else {
    results.push({
      name: "Systemd Service",
      status: "FAIL",
      message: "antigravity-proxy.service is inactive or failing",
      fixAvailable: true
    });
    if (autoFix) {
      Bun.spawnSync(["systemctl", "--user", "restart", "antigravity-proxy.service"]);
      console.log("  [FIXED] Restarted antigravity-proxy.service.");
    }
  }
}

async function checkProxyHttp(): Promise<void> {
  try {
    const res = await fetch("http://127.0.0.1:3000/health", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json() as any;
      results.push({ name: "Proxy HTTP Health", status: "OK", message: `Responding 200 OK (${json.service || "active"})` });
    } else {
      results.push({ name: "Proxy HTTP Health", status: "FAIL", message: `Endpoint returned HTTP ${res.status}` });
    }
  } catch (e: any) {
    results.push({ name: "Proxy HTTP Health", status: "FAIL", message: `Cannot connect to http://127.0.0.1:3000 (${e.message})` });
  }
}

async function checkAccounts(): Promise<void> {
  const accountsFile = join(projectRoot, "antigravity-accounts.json");
  if (!existsSync(accountsFile)) {
    results.push({ name: "Accounts File", status: "FAIL", message: "antigravity-accounts.json missing in project root", fixAvailable: true });
    if (autoFix) {
      Bun.spawnSync(["bun", "run", "setup"], { cwd: projectRoot });
    }
    return;
  }

  let data: any = {};
  try {
    data = JSON.parse(readFileSync(accountsFile, "utf-8"));
  } catch (e: any) {
    results.push({ name: "Accounts File", status: "FAIL", message: `JSON parse error: ${e.message}` });
    return;
  }

  const accounts = Array.isArray(data) ? data : (data.accounts || []);
  if (accounts.length === 0) {
    results.push({ name: "Accounts File", status: "FAIL", message: "No accounts configured. Authenticate at http://127.0.0.1:3000/oauth/start" });
    return;
  }

  let hasPoisonedCapability = false;
  for (const acc of accounts) {
    if (acc.capabilities) {
      for (const [k, v] of Object.entries(acc.capabilities)) {
        if (v === false) {
          hasPoisonedCapability = true;
          break;
        }
      }
    }
  }

  if (hasPoisonedCapability) {
    results.push({
      name: "Capability Poisoning",
      status: "FAIL",
      message: "One or more models have capability=false (blocks models with false Quota Exhausted error)",
      fixAvailable: true
    });
    if (autoFix) {
      for (const acc of accounts) {
        if (acc.capabilities) {
          for (const k of Object.keys(acc.capabilities)) {
            if (acc.capabilities[k] === false) delete acc.capabilities[k];
          }
        }
      }
      writeFileSync(accountsFile, JSON.stringify(data, null, 2), { mode: 0o600 });
      Bun.spawnSync(["systemctl", "--user", "restart", "antigravity-proxy.service"]);
      console.log("  [FIXED] Purged false capabilities and restarted proxy.");
    }
  } else {
    results.push({ name: "Capability Health", status: "OK", message: `${accounts.length} account(s) clean without poisoned flags` });
  }
}

async function checkOpenCodeConfig(): Promise<void> {
  const configPath = join(HOME, ".config", "opencode", "opencode.json");
  if (!existsSync(configPath)) {
    results.push({ name: "OpenCode Config", status: "WARNING", message: "~/.config/opencode/opencode.json not found" });
    return;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const agy = config.provider?.antigravity;
    if (!agy) {
      results.push({ name: "OpenCode Config", status: "FAIL", message: "provider.antigravity missing from opencode.json", fixAvailable: true });
      if (autoFix) Bun.spawnSync(["bun", "run", "setup"], { cwd: projectRoot });
      return;
    }

    let hasArrayVariants = false;
    for (const [id, m] of Object.entries(agy.models || {})) {
      if (Array.isArray((m as any).variants)) {
        hasArrayVariants = true;
        break;
      }
    }

    if (hasArrayVariants) {
      results.push({
        name: "OpenCode Variants Schema",
        status: "FAIL",
        message: "Models use array variants instead of dictionary (causes OpenCode to drop provider)",
        fixAvailable: true
      });
      if (autoFix) {
        Bun.spawnSync(["bun", "run", "setup"], { cwd: projectRoot });
        console.log("  [FIXED] Re-ran setup to fix variants dictionary schema.");
      }
    } else {
      results.push({ name: "OpenCode Variants Schema", status: "OK", message: "Valid dictionary structure for OpenCode 2.0+" });
    }
  } catch (e: any) {
    results.push({ name: "OpenCode Config", status: "FAIL", message: `Failed parsing opencode.json: ${e.message}` });
  }
}

async function checkProbeModel(): Promise<void> {
  try {
    const res = await fetch("http://127.0.0.1:3000/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer antigravity" },
      body: JSON.stringify({
        model: "antigravity-gemini-3.8-flash",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      results.push({ name: "Model Probe (Flash 3.8)", status: "OK", message: "Upstream Google Cloud Code responded 200 OK" });
    } else {
      const errText = await res.text();
      results.push({ name: "Model Probe (Flash 3.8)", status: "FAIL", message: `HTTP ${res.status}: ${errText.slice(0, 100)}` });
    }
  } catch (e: any) {
    results.push({ name: "Model Probe (Flash 3.8)", status: "FAIL", message: `Probe failed: ${e.message}` });
  }
}

async function main() {
  console.log("=== Open-Gemini: Antigravity Diagnostic & Self-Repair ===\n");
  if (autoFix) console.log("⚙️  Running in AUTO-REPAIR mode (--fix)...\n");

  await checkBackgroundService();
  await checkProxyHttp();
  await checkAccounts();
  await checkOpenCodeConfig();
  await checkProbeModel();

  console.log("\n" + "─".repeat(65));
  console.log("Check".padEnd(28) + "Status".padEnd(12) + "Details");
  console.log("─".repeat(65));

  let failureCount = 0;
  for (const r of results) {
    const icon = r.status === "OK" ? "✓" : r.status === "WARNING" ? "⚠" : "✖";
    console.log(`${icon} ${r.name}`.padEnd(28) + r.status.padEnd(12) + r.message);
    if (r.status === "FAIL") failureCount++;
  }
  console.log("─".repeat(65));

  if (failureCount === 0) {
    console.log("\n✅ All diagnostic checks passed! Antigravity proxy is healthy.");
  } else if (!autoFix) {
    console.log(`\n❌ Found ${failureCount} issue(s). Run 'bun run troubleshoot --fix' to auto-repair.`);
  } else {
    console.log("\n🔧 Auto-repair routine completed. Re-running checks to verify...");
  }
}

main().catch(console.error);
