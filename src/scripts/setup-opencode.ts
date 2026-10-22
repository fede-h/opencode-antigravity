#!/usr/bin/env bun
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { refreshAccessToken, getUserEmail, getProjectId, generateAuthUrl } from "../auth/oauth";
import { generateFingerprint } from "../utils/headers";
import { type AntigravityAccount } from "../auth/types";

const HOME = homedir();
const OS = platform();
const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:3000/v1";

const ANTIGRAVITY_MODELS: Record<string, {
  name: string;
  limit: { context: number; output: number };
  defaultVariant?: string;
  variants?: Record<string, Record<string, any>>;
}> = {
  "antigravity-gemini-4-argon": {
    name: "Gemini 4 Argon",
    limit: { context: 1048576, output: 65536 },
    defaultVariant: "default"
  },
  "antigravity-gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    limit: { context: 1048576, output: 65536 },
    defaultVariant: "high"
  },
  "antigravity-claude-opus-5-5": {
    name: "Claude Opus 5.5",
    limit: { context: 1000000, output: 64000 },
    defaultVariant: "medium",
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" }
    }
  },
  "antigravity-claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5",
    limit: { context: 1000000, output: 64000 },
    defaultVariant: "medium",
    variants: {
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" }
    }
  },
  "antigravity-gpt-oss-120b-medium": {
    name: "GPT-OSS 120B (Medium)",
    limit: { context: 131072, output: 16384 },
    defaultVariant: "default"
  }
};

function ensureDir(filePath: string) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

async function seedAntigravityAccount(accountsFilePath: string): Promise<boolean> {
  if (existsSync(accountsFilePath)) {
    try {
      const existing = JSON.parse(readFileSync(accountsFilePath, "utf-8"));
      if (Array.isArray(existing.accounts) && existing.accounts.length > 0) {
        console.log(`✓ Found ${existing.accounts.length} existing account(s) in ${accountsFilePath}`);
        return true;
      }
    } catch {}
  }

  // Check fallback locations for existing OAuth refresh tokens
  const candidateTokenFiles = [
    join(HOME, ".config", "antigravity-proxy", "antigravity-accounts.json"),
    join(HOME, ".local", "share", "opencode", "auth.json"),
    join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  ];

  let refreshToken = "";
  let fallbackProjectId = "";

  for (const candidate of candidateTokenFiles) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, "utf-8").trim();
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed.accounts) && parsed.accounts[0]?.refreshToken) {
        ensureDir(accountsFilePath);
        writeFileSync(accountsFilePath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
        console.log(`✓ Imported account configuration from ${candidate}`);
        return true;
      }

      if (parsed.refresh_token || parsed.refreshToken) {
        refreshToken = parsed.refresh_token || parsed.refreshToken;
      } else if (parsed.google?.refresh) {
        const parts = String(parsed.google.refresh).split("|");
        refreshToken = parts[0];
        fallbackProjectId = parts[1] || "";
      }

      if (refreshToken) {
        console.log(`✓ Discovered OAuth refresh token in ${candidate}`);
        break;
      }
    } catch {}
  }

  if (!refreshToken) {
    console.warn(`! No local Antigravity OAuth token found on disk.`);
    console.warn(`  Once the proxy starts, authenticate in your browser at:`);
    console.warn(`  http://127.0.0.1:3000/oauth/start`);
    return false;
  }

  try {
    const tokenRes = await refreshAccessToken(refreshToken);
    const email = await getUserEmail(tokenRes.access_token);
    const discoveredProject = await getProjectId(tokenRes.access_token);
    const projectId = discoveredProject || fallbackProjectId || "aicode-consumers";

    const account: AntigravityAccount = {
      email,
      refreshToken,
      accessToken: tokenRes.access_token,
      expiresAt: Date.now() + tokenRes.expires_in * 1000,
      projectId,
      managedProjectId: projectId,
      healthScore: 100,
      lastUsed: Date.now(),
      tokenUsage: 0,
      fingerprint: generateFingerprint(email),
      modelScores: {
        "antigravity-gemini-3.8-flash|sandbox": 100,
        "antigravity-gemini-4-argon|sandbox": 100
      }
    };

    ensureDir(accountsFilePath);
    writeFileSync(
      accountsFilePath,
      JSON.stringify({ accounts: [account], strategy: "hybrid" }, null, 2),
      { mode: 0o600 }
    );
    chmodSync(accountsFilePath, 0o600);
    console.log(`✓ Seeded Antigravity account for ${email} (project: ${projectId})`);
    return true;
  } catch (err: any) {
    console.warn(`! Failed to exchange discovered refresh token: ${err.message}`);
    console.warn(`  Authenticate via browser once running: http://127.0.0.1:3000/oauth/start`);
    return false;
  }
}

function configureOpenCodeJson() {
  const configPath = join(HOME, ".config", "opencode", "opencode.json");
  ensureDir(configPath);

  let config: Record<string, any> = {
    $schema: "https://opencode.ai/config.json"
  };

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      console.warn(`! Could not parse existing ${configPath}, creating backup at ${configPath}.bak`);
      writeFileSync(`${configPath}.bak`, readFileSync(configPath));
    }
  }

  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }

  const modelsConfig: Record<string, any> = {};
  for (const [id, meta] of Object.entries(ANTIGRAVITY_MODELS)) {
    modelsConfig[id] = {
      name: meta.name,
      limit: meta.limit,
      ...(meta.variants ? { variants: meta.variants } : {})
    };
  }

  config.provider.antigravity = {
    name: "Antigravity",
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: PROXY_URL
    },
    models: {
      ...modelsConfig
    }
  };

  if (!config.model) {
    config.model = "antigravity/antigravity-gemini-3.8-flash";
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✓ Updated OpenCode provider config in ${configPath}`);
}

function configureCliModelSelector() {
  const statePath = join(HOME, ".local", "state", "opencode", "model.json");
  ensureDir(statePath);

  let state: {
    recent: Array<{ providerID: string; modelID: string }>;
    favorite: Array<{ providerID: string; modelID: string }>;
    variant: Record<string, string>;
  } = {
    recent: [],
    favorite: [],
    variant: {}
  };

  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
      state.recent = Array.isArray(state.recent) ? state.recent : [];
      state.favorite = Array.isArray(state.favorite) ? state.favorite : [];
      state.variant = state.variant && typeof state.variant === "object" ? state.variant : {};
    } catch {}
  }

  const priorityModels = [
    "antigravity-gemini-4-argon",
    "antigravity-gemini-3.8-flash",
    "antigravity-claude-opus-5-5",
    "antigravity-claude-sonnet-5-5",
    "antigravity-gpt-oss-120b-medium"
  ];

  for (const modelID of Object.keys(ANTIGRAVITY_MODELS).reverse()) {
    if (!state.recent.some(x => x.providerID === "antigravity" && x.modelID === modelID)) {
      state.recent.unshift({ providerID: "antigravity", modelID });
    }
    const meta = ANTIGRAVITY_MODELS[modelID];
    const key = `antigravity/${modelID}`;
    if (!state.variant[key]) {
      state.variant[key] = meta.defaultVariant || "default";
    }
  }

  for (const modelID of priorityModels.reverse()) {
    if (!state.favorite.some(x => x.providerID === "antigravity" && x.modelID === modelID)) {
      state.favorite.unshift({ providerID: "antigravity", modelID });
    }
  }

  writeFileSync(statePath, JSON.stringify(state));
  console.log(`✓ Enabled CLI model picker visibility in ${statePath}`);
}

function configureDesktopModelSelector() {
  const desktopDbCandidates = [
    join(HOME, ".config", "ai.opencode.desktop", "drafts.sqlite"),
    join(HOME, "Library", "Application Support", "ai.opencode.desktop", "drafts.sqlite")
  ];

  for (const dbPath of desktopDbCandidates) {
    if (!existsSync(dbPath)) continue;
    try {
      const db = new Database(dbPath);
      const row = db
        .query("SELECT value FROM state WHERE name = ? AND key = ?")
        .get("opencode.global.dat", "model") as { value: string } | null;

      const data = row ? JSON.parse(row.value) : { user: [], recent: [], variant: {} };
      data.user = Array.isArray(data.user) ? data.user : [];
      data.recent = Array.isArray(data.recent) ? data.recent : [];

      for (const modelID of Object.keys(ANTIGRAVITY_MODELS).reverse()) {
        const existingUser = data.user.find(
          (x: any) => x.providerID === "antigravity" && x.modelID === modelID
        );
        if (existingUser) {
          existingUser.visibility = "show";
        } else {
          data.user.unshift({
            providerID: "antigravity",
            modelID,
            visibility: "show"
          });
        }

        if (!data.recent.some((x: any) => x.providerID === "antigravity" && x.modelID === modelID)) {
          data.recent.unshift({ providerID: "antigravity", modelID });
        }
      }

      if (row) {
        db.run(
          "UPDATE state SET value = ? WHERE name = ? AND key = ?",
          [JSON.stringify(data), "opencode.global.dat", "model"]
        );
      } else {
        db.run(
          "INSERT INTO state (name, key, value, updated_at) VALUES (?, ?, ?, ?)",
          ["opencode.global.dat", "model", JSON.stringify(data), Date.now()]
        );
      }
      db.close();
      console.log(`✓ Enabled OpenCode Desktop model picker visibility in ${dbPath}`);
    } catch (e: any) {
      console.warn(`! Could not update Desktop SQLite DB at ${dbPath}: ${e.message}`);
    }
  }
}

function registerOpenCodeCredential() {
  const proc = Bun.spawnSync([
    "opencode",
    "api",
    "POST",
    "/api/credential",
    "-d",
    JSON.stringify({
      integrationID: "antigravity",
      label: "API key",
      value: { type: "key", key: "antigravity" },
      activate: true
    })
  ], { stdout: "pipe", stderr: "pipe" });

  if (proc.exitCode === 0) {
    console.log(`✓ Registered active 'antigravity' credential via OpenCode daemon API`);
    return;
  }

  // Fallback: check ~/.local/share/opencode/auth.json
  const authJsonPath = join(HOME, ".local", "share", "opencode", "auth.json");
  ensureDir(authJsonPath);
  let authData: Record<string, any> = {};
  if (existsSync(authJsonPath)) {
    try {
      authData = JSON.parse(readFileSync(authJsonPath, "utf-8"));
    } catch {}
  }
  authData.antigravity = { type: "api", key: "antigravity" };
  writeFileSync(authJsonPath, JSON.stringify(authData, null, 2), { mode: 0o600 });
  console.log(`✓ Wrote fallback 'antigravity' credential to ${authJsonPath}`);
}

function installBackgroundService(workingDir: string) {
  const bunBin = process.execPath;

  if (OS === "linux") {
    const servicePath = join(HOME, ".config", "systemd", "user", "antigravity-proxy.service");
    ensureDir(servicePath);
    const unitContent = `[Unit]
Description=Antigravity Local API Proxy Bridge for OpenCode
After=network.target

[Service]
Type=simple
WorkingDirectory=${workingDir}
ExecStart=${bunBin} run src/server.ts
Restart=always
RestartSec=3
Environment=PATH=${dirname(bunBin)}:/usr/local/bin:/usr/bin:/bin
Environment=PORT=3000

[Install]
WantedBy=default.target
`;
    writeFileSync(servicePath, unitContent);
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
    const enableRes = Bun.spawnSync(["systemctl", "--user", "enable", "--now", "antigravity-proxy.service"]);
    Bun.spawnSync(["systemctl", "--user", "restart", "antigravity-proxy.service"]);
    if (enableRes.exitCode === 0) {
      console.log(`✓ Installed and started systemd user service: antigravity-proxy.service`);
    } else {
      console.warn(`! Created ${servicePath}, but systemctl returned code ${enableRes.exitCode}`);
    }
  } else if (OS === "darwin") {
    const plistPath = join(HOME, "Library", "LaunchAgents", "com.opencode.antigravity-proxy.plist");
    ensureDir(plistPath);
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.opencode.antigravity-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>run</string>
    <string>src/server.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workingDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
    writeFileSync(plistPath, plistContent);
    Bun.spawnSync(["launchctl", "unload", plistPath]);
    Bun.spawnSync(["launchctl", "load", "-w", plistPath]);
    console.log(`✓ Installed and started macOS LaunchAgent: ${plistPath}`);
  }
}

async function main() {
  console.log("=== Open-Gemini: Antigravity -> OpenCode Setup ===\n");

  const projectRoot = join(import.meta.dir, "..", "..");
  const activeProxyDir = projectRoot;

  const accountsFile = join(activeProxyDir, "antigravity-accounts.json");

  await seedAntigravityAccount(accountsFile);
  configureOpenCodeJson();
  registerOpenCodeCredential();
  configureCliModelSelector();
  configureDesktopModelSelector();
  installBackgroundService(activeProxyDir);

  console.log("\n✅ Setup complete!");
  console.log("   Test in terminal:");
  console.log('   opencode run -m antigravity/antigravity-gemini-3.8-flash "Say hello"');
  console.log('   opencode run -m antigravity/antigravity-gemini-4-argon "Say hello"');
}

main().catch(err => {
  console.error("Setup failed:", err);
  process.exit(1);
});
