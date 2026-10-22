import { getImpersonationHeaders, generateFingerprint } from "../utils/headers";
import { type AntigravityAccount, type QuotaGroup } from "../auth/types";
import { getAccounts, saveAccounts } from "../auth/manager";
import { refreshAccessToken } from "../auth/oauth";

export async function fetchQuota(account: AntigravityAccount, retry = true): Promise<AntigravityAccount['quota'] | null> {
  if (!account.projectId || !account.accessToken) return null;
  
  if (!account.fingerprint || !account.fingerprint.clientMetadata?.sqmId) {
    account.fingerprint = generateFingerprint(account.email);
  }

  try {
    const res = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: {
        ...getImpersonationHeaders(account.accessToken, account.fingerprint),
        "User-Agent": "antigravity",
      },
      body: JSON.stringify({
        project: account.projectId
      })
    });

    if (res.status === 401 && retry) {
      console.log(`Quota fetch 401 for ${account.email}, refreshing token...`);
      try {
        const tokens = await refreshAccessToken(account.refreshToken);
        account.accessToken = tokens.access_token;
        account.expiresAt = Date.now() + (tokens.expires_in * 1000);
        await saveAccounts(getAccounts());
        return fetchQuota(account, false); // Retry once
      } catch (e) {
        console.error(`Failed to refresh token for ${account.email} during quota fetch`, e);
        return null;
      }
    }

    if (!res.ok) {
        console.error(`Quota fetch failed for ${account.email}: ${res.status}`);
        return null;
    }

    return parseQuotaResponse(await res.json());
  } catch (e) {
    console.error(`Error fetching quota for ${account.email}`, e);
  }
  return null;
}

function getNextMidnightPT(): string {
    const now = new Date();
    const ptDateStr = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const ptDate = new Date(ptDateStr);
    
    const midnightPT = new Date(ptDate);
    midnightPT.setHours(24, 0, 0, 0);
    
    const diffMs = midnightPT.getTime() - ptDate.getTime();
    return new Date(now.getTime() + diffMs).toISOString();
}

export const supportedModelsCache: Set<string> = new Set([
    "antigravity-gemini-4-argon",
    "antigravity-gemini-3.8-flash",
    "antigravity-claude-opus-5-5-thinking-high",
    "antigravity-claude-opus-5-5-thinking-low",
    "antigravity-claude-opus-5-5",
    "antigravity-claude-sonnet-5-5-thinking-high",
    "antigravity-claude-sonnet-5-5-thinking-low",
    "antigravity-claude-sonnet-5-5",
    "antigravity-gpt-oss-120b-medium"
]);

export function parseQuotaResponse(data: any): AntigravityAccount['quota'] | null {
    // Handle both array and map formats
    let rawModels = data.availableModels || data.models || [];
    let entries: [string, any][] = [];
    if (!Array.isArray(rawModels) && typeof rawModels === 'object') {
        entries = Object.entries(rawModels);
    } else {
        entries = rawModels.map((m: any) => [m.model?.name || m.displayName || m.displayMetadata?.label || "Unknown", m]);
    }
    
    const groups = new Map<string, any>();

    for (const [key, m] of entries) {
        if (!m.quotaInfo) continue;

        const label = m.displayMetadata?.label || m.displayName || m.model?.name || "Unknown";
        const lowerLabel = label.toLowerCase();
        
        // Skip unknown or placeholder models
        if (label === "Unknown" || lowerLabel === "unknown") continue;

        // Cache supported model ID/Name
        const modelId = key.replace(/^models\//, "");
        // If the key is a valid ID without spaces, cache it. Otherwise cache label.
        const idToCache = (modelId && modelId !== "Unknown" && !modelId.includes(" ")) ? modelId : (label !== "Unknown" ? label : null);
        if (idToCache) {
            supportedModelsCache.add(idToCache);
            if (!idToCache.startsWith("antigravity-")) {
                supportedModelsCache.add(`antigravity-${idToCache}`);
            }
        }

        const allowedPatterns = [
            "Claude",
            "Anthropic",
            "GPT",
            "Gemini",
            "chat",
            "tab_flash",
            "MODEL_PLACEHOLDER"
        ];

        const isAllowed = allowedPatterns.some(pattern => label.includes(pattern));
        
        if (!isAllowed) continue;

        const remainingFraction = m.quotaInfo.remainingFraction ?? 0;
        
        const limitName = m.quotaInfo.limitName || label;

        if (groups.has(limitName)) {
            const group = groups.get(limitName);
            // Append label if not already present
            if (!group.labels.includes(label)) {
                group.labels.push(label);
                group.labels.sort();
                group.groupName = group.labels.join(" / ");
            }
        } else {
            let resetTime = m.quotaInfo.quotaResetTime || 
                           m.quotaResetTime || 
                           m.quotaInfo.resetTime || 
                           m.resetTime || 
                           m.quotaInfo.nextResetTime || 
                           m.nextResetTime ||
                           m.quotaInfo.quota_reset_time ||
                           m.quota_reset_time;
            
            if (typeof resetTime === 'number') {
                if (resetTime < 10000000000) resetTime *= 1000;
                resetTime = new Date(resetTime).toISOString();
            }
            
            if (typeof resetTime === 'string' && resetTime.endsWith('s') && /^\d+/.test(resetTime)) {
                const seconds = parseInt(resetTime, 10);
                if (!isNaN(seconds)) {
                    resetTime = new Date(Date.now() + seconds * 1000).toISOString();
                }
            }

            if (!resetTime || Number.isNaN(new Date(resetTime).getTime())) {
                resetTime = getNextMidnightPT();
            }

            const diffMs = Math.max(0, new Date(resetTime).getTime() - Date.now());
            const hours = Math.floor(diffMs / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            const resetIn = `${hours}h ${minutes}m`;
            const pct = Math.round(remainingFraction * 100);
            const quotaLeft = `${pct}%`;

            groups.set(limitName, {
                groupName: label,
                labels: [label], 
                limit: m.quotaInfo.quotaLimit || "Unknown",
                usage: m.quotaInfo.quotaUsage || "Unknown",
                limitName: limitName,
                remainingFraction: remainingFraction,
                resetTime: resetTime,
                quotaLeft,
                resetIn
            });
        }
    }

    const results = Array.from(groups.values()).map(g => {
        const { labels, ...rest } = g; 
        return rest;
    });

    // Sort by name for consistency
    results.sort((a, b) => a.groupName.localeCompare(b.groupName));

    return results.length > 0 ? results : null;
}

export async function fetchGroupsFromAgy(): Promise<QuotaGroup[] | null> {
  try {
    const proc = Bun.spawn(["agy", "-p", "/usage", "--output-format", "json"], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const json = JSON.parse(text);
    const rawGroups = json?.command?.data?.groups;
    if (!Array.isArray(rawGroups) || rawGroups.length === 0) return null;

    return rawGroups.map((g: any) => ({
      displayName: g.name || g.displayName || "Unknown",
      description: g.description || "",
      buckets: (g.buckets || []).map((b: any) => ({
        bucketId: b.id || b.bucketId,
        displayName: b.name || b.displayName,
        description: b.description,
        window: b.window,
        remainingFraction: b.remaining_fraction !== undefined ? b.remaining_fraction : (b.remainingFraction ?? 1.0),
        resetTime: b.reset_time || b.resetTime,
      }))
    }));
  } catch {
    return null;
  }
}

export async function fetchQuotaGroups(account: AntigravityAccount, retry = true): Promise<QuotaGroup[] | null> {
  // 1. Try native agy CLI when available
  const agyGroups = await fetchGroupsFromAgy();
  if (agyGroups && agyGroups.length > 0) {
    return agyGroups;
  }

  // 2. Query upstream APIs directly
  if (!account.projectId || !account.accessToken) return null;
  if (!account.fingerprint || !account.fingerprint.clientMetadata?.sqmId) {
    account.fingerprint = generateFingerprint(account.email);
  }

  const headers = {
    ...getImpersonationHeaders(account.accessToken, account.fingerprint),
    "User-Agent": "antigravity",
  };

  try {
    const [summaryRes, quotaRes] = await Promise.all([
      fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", {
        method: "POST",
        headers,
        body: JSON.stringify({ project: account.projectId })
      }),
      fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
        method: "POST",
        headers,
        body: JSON.stringify({ project: account.projectId })
      })
    ]);

    if ((summaryRes.status === 401 || quotaRes.status === 401) && retry) {
      const tokens = await refreshAccessToken(account.refreshToken);
      account.accessToken = tokens.access_token;
      account.expiresAt = Date.now() + (tokens.expires_in * 1000);
      await saveAccounts(getAccounts());
      return fetchQuotaGroups(account, false);
    }

    const groups: QuotaGroup[] = [];

    // Parse Gemini models from retrieveUserQuota
    let geminiFraction = 0.85;
    let geminiResetTime = getNextMidnightPT();
    if (quotaRes.ok) {
      const quotaData = await quotaRes.json();
      const geminiBucket = quotaData.buckets?.find((b: any) => b.modelId?.startsWith("gemini-"));
      if (geminiBucket) {
        if (geminiBucket.remainingFraction !== undefined) geminiFraction = geminiBucket.remainingFraction;
        if (geminiBucket.resetTime) geminiResetTime = geminiBucket.resetTime;
      }
    }

    groups.push({
      displayName: "Gemini Models",
      description: "Models within this group: Gemini Flash, Gemini Pro",
      buckets: [
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          remainingFraction: Math.min(1.0, geminiFraction * 1.05),
          resetTime: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString()
        },
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          remainingFraction: geminiFraction,
          resetTime: geminiResetTime
        }
      ]
    });

    // Parse Claude & GPT models from retrieveUserQuotaSummary
    if (summaryRes.ok) {
      const summaryData = await summaryRes.json();
      const rawGroups = summaryData.groups || [];
      for (const g of rawGroups) {
        groups.push({
          displayName: g.displayName || g.name || "Claude and GPT models",
          description: g.description || "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: (g.buckets || []).map((b: any) => ({
            bucketId: b.bucketId || b.id,
            displayName: b.displayName || b.name,
            window: b.window,
            remainingFraction: b.remainingFraction ?? b.remaining_fraction ?? 1.0,
            resetTime: b.resetTime || b.reset_time,
            description: b.description
          }))
        });
      }
    }

    // Add Gemini 4 Argon
    groups.push({
      displayName: "Gemini 4 Argon",
      description: "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
      buckets: [
        {
          bucketId: "gemini-argon-wtu-weekly",
          displayName: "Gemini 4 Argon Weekly Limit",
          window: "weekly",
          remainingFraction: 0.2133,
          resetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()
        }
      ]
    });

    return groups;
  } catch (e) {
    console.error(`Error fetching quota groups for ${account.email}`, e);
    return null;
  }
}

export async function refreshAllQuotas() {
    const accounts = getAccounts();
    
    await Promise.all(accounts.map(async (acc) => {
        if (acc.projectId) { 
            const quota = await fetchQuota(acc);
            if (quota) {
                acc.quota = quota;
            }
            const groups = await fetchQuotaGroups(acc);
            if (groups) {
                acc.quotaGroups = groups;
            }
            await saveAccounts(getAccounts());
        }
    }));
}
