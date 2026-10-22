#!/usr/bin/env bun
import { loadProxyConfig, getProxyConfig } from "./config/manager";

await loadProxyConfig();

import { initManager, getBestAccount, updateAccountUsage, addAccount, getAccounts, emitAccountFlash, getEarliestReset, markCooldown, ensureFingerprint, flagAccountChallenge, flagModelUnsupported, isModelUnsupported, getFamilyName } from "./auth/manager";
import { type AntigravityAccount } from "./auth/types";
import { generateAuthUrl, exchangeCode, getUserEmail, getProjectId } from "./auth/oauth";
import { transformToGoogleBody, createOpenAIStreamTransformer } from "./utils/transform";
import { getImpersonationHeaders, getGeminiCliHeaders } from "./utils/headers";
import { refreshAllQuotas, fetchQuota, supportedModelsCache } from "./api/quota";
import { parseGoogleError } from "./utils/errors";

await initManager();

const proxyConfig = getProxyConfig();

// Initial quota refresh on startup
let lastQuotaRefresh = 0;
refreshAllQuotas().then(() => { lastQuotaRefresh = Date.now(); });

Bun.serve({
  port: 3000,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const cleanPath = url.pathname.replace(/\/+/g, "/");
    console.log(`[${new Date().toISOString()}] ${req.method} ${cleanPath} - Agent: ${req.headers.get("user-agent")}`);

    if (req.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            }
        });
    }
    if (cleanPath === "/oauth/start") {
      return Response.redirect(generateAuthUrl());
    }

    if (cleanPath === "/v1/quota" || cleanPath === "/api/quota") {
        if (Date.now() - lastQuotaRefresh > 5 * 60 * 1000) {
            await refreshAllQuotas();
            lastQuotaRefresh = Date.now();
        }

        const accounts = getAccounts().map(a => ({
            email: a.email,
            projectId: a.projectId,
            healthScore: a.healthScore ?? 100,
            quota: a.quota || [],
            quotaGroups: a.quotaGroups || [],
            lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null
        }));

        return new Response(JSON.stringify({
            service: "open-gemini",
            accounts
        }, null, 2), {
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*"
            }
        });
    }

    if (cleanPath === "/v1/models") {
        // Refresh quotas if empty, defaults only, or stale (>10 min)
        if (supportedModelsCache.size <= 9 || Date.now() - lastQuotaRefresh > 10 * 60 * 1000) {
            await refreshAllQuotas();
            lastQuotaRefresh = Date.now();
        }

        const models = Array.from(supportedModelsCache).sort().map(id => ({
            id,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity"
        }));

        return new Response(JSON.stringify({
            object: "list",
            data: models
        }), { headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "*"
        } });
    }

    if (cleanPath === "/v1/chat/completions" && req.method === "POST") {
      const openaiBody = await req.json() as any;
      const requestId = "chatcmpl-" + Math.random().toString(36).substring(7);
      
      const modelLower = openaiBody.model.toLowerCase();
      const isClaudeModel = modelLower.includes("claude");
      const isGptModel = modelLower.includes("gpt");

      let useCliPool: boolean;
      if (isClaudeModel) {
          useCliPool = false;
      } else if (isGptModel) {
          useCliPool = false;
      } else {
          const isAntigravityThinking = modelLower.includes("antigravity") && 
                                       (modelLower.includes("thinking-high") || 
                                        modelLower.includes("thinking-medium") || 
                                        modelLower.includes("thinking-low"));

          const isExplicitAntigravity = modelLower.includes("antigravity-");
          const isExplicitSandboxModel = isAntigravityThinking || isExplicitAntigravity || modelLower.includes("image");

          useCliPool = !isExplicitSandboxModel && (
              modelLower.includes("-preview") || 
              modelLower.includes("gemini-2.0") || 
              modelLower.includes("gemini-2.5") ||
              (modelLower.includes("gemini-3") && !modelLower.includes("flash"))
          );
      }
      
       let attempts = 0;
       let aggressive = false;
       const config = getProxyConfig();
       const availableAccountsCount = getAccounts().length;
       const MAX_ATTEMPTS = Math.max(config.retry.maxAttempts, availableAccountsCount);
       
       const triedEmails: string[] = [];
       const attemptLogs: Array<{ email: string, status: number, reason: string }> = [];
       let systemicErrorCount = 0;
      
      // GPT and Claude models are Sandbox-preferred. Explicit antigravity- models are also Sandbox-only.
      const isExplicitAntigravity = modelLower.includes("antigravity-");
      const isSandboxOnlyModel = modelLower.includes("gpt") || isExplicitAntigravity || modelLower.includes("3.8") || modelLower.includes("3.7") || modelLower.includes("argon");
      const isCliOnlyModel = false;
      const CLAUDE_REGIONS = ["us-central1", "us-east5", "europe-west1"];
      
      const clientId = req.headers.get("x-client-id") || url.searchParams.get("client_id") || "unknown";
      const firstMsg = openaiBody.messages?.[0]?.content || "";
      const userIdent = openaiBody.user || clientId;
      const stableSeed = `${userIdent}:${typeof firstMsg === 'string' ? firstMsg : JSON.stringify(firstMsg)}`;
      const sessionId = firstMsg ? new Bun.CryptoHasher("sha256").update(stableSeed).digest("hex") : crypto.randomUUID();

        let lastStatus = 0;
        let lastGoogleUrl = "";

        while (attempts < MAX_ATTEMPTS) {
            attempts++;

            if (attempts > 1) {
                const delayMs = Math.min(500 * attempts, 3000);
                await new Promise(r => setTimeout(r, delayMs));
                
                if (!isSandboxOnlyModel && !isCliOnlyModel && lastStatus !== 503) {
                    useCliPool = !useCliPool;
                    console.log(`[Switch] Switching to ${useCliPool ? 'CLI' : 'Sandbox'} pool for attempt ${attempts}`);
                } else {
                    console.log(`[Switch] Skipping pool switch for ${isCliOnlyModel ? 'CLI-only' : 'sandbox-only'} model (attempt ${attempts})`);
                }
            }

            let account = await getBestAccount(useCliPool ? "cli" : "sandbox", openaiBody.model, clientId, triedEmails, true);
            
            if (!account && !isSandboxOnlyModel && !isCliOnlyModel) {
                console.log(`[Manager] No READY accounts in ${useCliPool ? 'CLI' : 'Sandbox'} pool, trying the other pool first...`);
                const otherPool = useCliPool ? "sandbox" : "cli";
                account = await getBestAccount(otherPool, openaiBody.model, clientId, triedEmails, true);
                if (account) {
                    useCliPool = !useCliPool;
                    console.log(`[Switch] Found ready account in ${useCliPool ? 'CLI' : 'Sandbox'} pool.`);
                }
            }

            if (!account) {
                account = await getBestAccount(useCliPool ? "cli" : "sandbox", openaiBody.model, clientId, triedEmails, false);
            }
            
            if (!account || !account.accessToken) {
                if (attempts < MAX_ATTEMPTS) {
                    console.log(`[Switch] Exhausted all accounts in both pools, retrying...`);
                    triedEmails.length = 0;
                    continue; 
                }
                break;
            }

            const SANDBOX_ENDPOINTS = Array.isArray(config.endpoints.sandbox) ? config.endpoints.sandbox : [config.endpoints.sandbox];
            const CLI_ENDPOINTS = Array.isArray(config.endpoints.cli) ? config.endpoints.cli : [config.endpoints.cli];
            
            let GOOGLE_URL: string;
            if (useCliPool) {
                const cliEndpointIndex = isClaudeModel ? CLI_ENDPOINTS.length - 1 : Math.min(attempts - 1, CLI_ENDPOINTS.length - 1);
                GOOGLE_URL = CLI_ENDPOINTS[cliEndpointIndex];
            } else {
                const sandboxEndpointIndex = Math.min(attempts - 1, SANDBOX_ENDPOINTS.length - 1);
                GOOGLE_URL = SANDBOX_ENDPOINTS[sandboxEndpointIndex];
            }

            if (lastStatus === 503) {
                console.log(`[Capacity] Retrying account ${account.email} on next endpoint ${GOOGLE_URL.split('/')[2]}...`);
            } else if (availableAccountsCount > 1) {
                triedEmails.push(account.email);
            }


          if (isClaudeModel && !GOOGLE_URL.includes("v1internal")) {
              console.warn(`[Warning] Claude model ${openaiBody.model} is being routed to a non-v1internal endpoint: ${GOOGLE_URL}`);
          }

          let effectiveProjectId = account.projectId!;
          ensureFingerprint(account);
          
          const googleBody = transformToGoogleBody(openaiBody, effectiveProjectId, useCliPool, "", sessionId, aggressive); 

          const isClaudeModelTarget = googleBody.model.toLowerCase().includes("claude");
          const headers = (useCliPool && !isClaudeModelTarget)
            ? getGeminiCliHeaders(account.accessToken!, account.fingerprint!)
            : getImpersonationHeaders(account.accessToken!, account.fingerprint!, googleBody.model);

          console.log(`[Request] Model: ${openaiBody.model} | Account: ${account.email} | Project: ${effectiveProjectId} | Attempt: ${attempts}/${MAX_ATTEMPTS} | Pool: ${useCliPool ? 'CLI' : 'Sandbox'} | Endpoint: ${GOOGLE_URL.split('/')[2]} | Target Model: ${googleBody.model}`);

          const timeoutKey = Object.keys(config.models.timeouts || {}).find(k => openaiBody.model.toLowerCase().includes(k)) || 'default';
          const timeoutMs = (config.models.timeouts && config.models.timeouts[timeoutKey]) || 30000;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

          try {
            if (config.features.jitterEnabled) {
              const jitterMs = config.features.jitterMinMs + Math.random() * (config.features.jitterMaxMs - config.features.jitterMinMs);
              await new Promise(r => setTimeout(r, jitterMs));
            }

            const googleRes = await fetch(GOOGLE_URL, {
              method: "POST",
              headers: headers,
              body: JSON.stringify(googleBody),
              signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!googleRes.ok) {
               const errText = await googleRes.text();
               const parsedError = parseGoogleError(errText);
                const status = googleRes.status;
                lastStatus = status;
                lastGoogleUrl = GOOGLE_URL;
                
                console.error(`[Error] Google API (${account.email}) returned ${status} (${parsedError.reason}):`, errText);

               emitAccountFlash(account.email, 'error');
               attemptLogs.push({ email: account.email, status, reason: parsedError.reason });

                if (status === 400) {
                    console.error('[Debug 400 Payload]:', JSON.stringify(googleBody, null, 2));
                    await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId, status);
                    return new Response(JSON.stringify({ 
                        error: { message: parsedError.message || ("Invalid argument: " + parsedError.reason), type: "invalid_request_error", code: "400" } 
                    }), { 
                        status: 400, 
                        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() } 
                    });
                }

                if (status === 403 || status === 404) {
                    if (parsedError.isChallengeRequired) {
                        console.log(`[Auth] ${parsedError.reason} for ${account.email}, flagging pool ${useCliPool ? 'cli' : 'sandbox'} for family ${getFamilyName(openaiBody.model)}.`);
                        flagAccountChallenge(account.email, useCliPool ? 'cli' : 'sandbox', getFamilyName(openaiBody.model), { 
                            type: 'CAPTCHA', 
                            url: parsedError.validationUrl || 'https://cloud.google.com/gemini/docs/codeassist/request-license',
                            reason: parsedError.reason,
                            message: parsedError.message
                        });
                        continue;
                    } else if (parsedError.isModelUnsupported) {
                       console.log(`[Model] Unsupported model ${openaiBody.model} for ${account.email}, marking capability.`);
                       flagModelUnsupported(account.email, openaiBody.model);
                   }
                   await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId, status);
                   return new Response(JSON.stringify({ 
                       error: { message: "Access denied: " + parsedError.reason, type: "access_denied", code: status.toString() } 
                   }), { 
                       status, 
                       headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() } 
                   });
               }

               if (status === 500 || status === 503) {
                   systemicErrorCount++;
                   if (systemicErrorCount > 2) {
                       console.log(`[Systemic] Detected systemic outage (${systemicErrorCount} errors), breaking retry loop.`);
                       break;
                   }
               }

               let resetSeconds = 0;
               try {
                   const errJson = JSON.parse(errText);
                   const details = errJson.error?.details || [];
                   for (const d of details) {
                       if (d.metadata?.quotaResetDelay) resetSeconds = parseFloat(d.metadata.quotaResetDelay);
                       if (d.retryDelay) resetSeconds = parseFloat(d.retryDelay);
                   }
                   if (resetSeconds === 0 && errJson.error?.message?.includes("reset after")) {
                       const match = errJson.error.message.match(/reset after\s+([0-9\.]+)s/);
                       if (match) resetSeconds = parseFloat(match[1]);
                   }
               } catch (e) {}

                if (status === 429 && resetSeconds > 0 && resetSeconds <= config.retry.transientRetryThresholdSeconds) {
                    console.log(`[Skip] Account ${account.email} transiently limited (${resetSeconds}s), rotating...`);
                    account.consecutiveFailures = (account.consecutiveFailures || 0) + 1;
                    if (account.consecutiveFailures >= 2) {
                        await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId, 429);
                    }
                    triedEmails.push(account.email);
                    continue;
                }


               if (status === 400 && (errText.toLowerCase().includes("tool schema") || errText.includes("Invalid JSON payload") || errText.toLowerCase().includes("function_declarations")) && !aggressive) {
                  console.log(`[Schema] Detected tool schema error for ${account.email}, retrying with aggressive cleaning...`);
                  aggressive = true;
                  attempts--;
                  continue;
               }
               aggressive = false;

               await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId, status);
               
                if (status === 429) {
                    markCooldown(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(openaiBody.model));
                }
               continue;
            }

            const decoder = new TextDecoder();
            const isStreaming = openaiBody.stream === true;
            
             if (isStreaming) {
                 if (!googleRes.body) {
                     return new Response(JSON.stringify({ error: { message: "No response body from upstream" } }), { 
                         status: 502,
                         headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() }
                     });
                 }

                 const stream = googleRes.body.pipeThrough(createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId));

                 void updateAccountUsage(account.email, true, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId).catch(console.error);
                 return new Response(stream, {
                  headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                    "X-Antigravity-Attempts": attempts.toString()
                  }
                });
              } else {
                if (!googleRes.body) throw new Error("No response body");
                
                const stream = googleRes.body.pipeThrough(createOpenAIStreamTransformer(openaiBody.model, requestId, false, sessionId));
                const reader = stream.getReader();
               
                let fullContent = "";
                let reasoningContent = "";
                let aggregatedToolCalls: any[] = [];
                let finalFinishReason = "stop";

                let buffer = "";
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  
                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";
                  
        for (const line of lines) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.choices?.[0]) {
                const choice = event.choices[0];
                if (choice.delta?.content) fullContent += choice.delta.content;
                if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
                if (choice.delta?.tool_calls) aggregatedToolCalls.push(...choice.delta.tool_calls);
                if (choice.finish_reason) finalFinishReason = choice.finish_reason;
              }
            } catch (e) {
              console.warn("[Stream] Failed to parse non-streaming chunk:", e);
            }
          }
        }
      }

      if (buffer.startsWith("data: ") && buffer !== "data: [DONE]") {
          try {
              const event = JSON.parse(buffer.slice(6));
              if (event.choices?.[0]) {
                  const choice = event.choices[0];
                  if (choice.delta?.content) fullContent += choice.delta.content;
                  if (choice.delta?.reasoning_content) reasoningContent += choice.delta.reasoning_content;
                  if (choice.delta?.tool_calls) aggregatedToolCalls.push(...choice.delta.tool_calls);
                  if (choice.finish_reason) finalFinishReason = choice.finish_reason;
              }
          } catch (e) {
              console.warn("[Stream] Failed to parse final non-streaming chunk:", e);
          }
      }

                 const finalResponse = {
                    id: requestId,
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: openaiBody.model,
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant",
                            content: fullContent,
                            reasoning_content: reasoningContent || undefined,
                            tool_calls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : undefined
                        },
                        finish_reason: finalFinishReason
                    }]
                };

                if (!fullContent && aggregatedToolCalls.length === 0 && finalFinishReason !== "length") {
                    console.warn(`[Empty] Account ${account.email} returned empty response for ${openaiBody.model}, retrying with another account...`);
                    markCooldown(account.email, useCliPool ? "cli" : "sandbox", getFamilyName(openaiBody.model), "30s");
                    continue;
                }

                void updateAccountUsage(account.email, true, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId).catch(console.error);
               return new Response(JSON.stringify(finalResponse), { 
                   headers: { 
                       "Content-Type": "application/json", 
                       "Access-Control-Allow-Origin": "*",
                       "X-Antigravity-Attempts": attempts.toString()
                   } 
               });
             }
            } catch (e: any) {
             if (e.name === 'AbortError') {
                 console.error(`[Timeout] Request timed out for ${account.email} after ${timeoutMs}ms`);
                 account.healthScore = Math.max(config.scoring.healthRange.min, account.healthScore - 5);
             } else {
                 console.error(`Proxy error for ${account.email}:`, e);
             }
             await updateAccountUsage(account.email, false, openaiBody.model, useCliPool ? "cli" : "sandbox", clientId);
             attemptLogs.push({ email: account.email || 'unknown', status: 500, reason: e.message });
             if (attempts < MAX_ATTEMPTS) continue;
             return new Response(JSON.stringify({ error: { message: `Proxy exception: ${e.message}` } }), { 
                 status: 500, 
                 headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "X-Antigravity-Attempts": attempts.toString() } 
             });
           }
      }

      const allAccounts = getAccounts();
      const anyAccountSupportsModel = allAccounts.some(a => !isModelUnsupported(a.email, openaiBody.model) && a.capabilities?.[openaiBody.model] !== false);
      if (!anyAccountSupportsModel && allAccounts.length > 0) {
        return new Response(JSON.stringify({ 
          error: { 
              message: `Model unavailable: ${openaiBody.model} is not supported or temporarily unavailable on configured accounts.`,
              type: "invalid_request_error",
              code: "model_not_found",
              attempts: attemptLogs
          } 
        }), { 
          status: 404, 
          headers: { 
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "X-Antigravity-Attempts": attempts.toString()
          } 
        });
      }

      const resetTime = getEarliestReset(useCliPool ? "cli" : "sandbox");
      const resetMsg = resetTime ? ` Next reset in ${resetTime}.` : "";
      return new Response(JSON.stringify({ 
        error: { 
            message: `Quota Exhausted: All accounts failed or are exhausted for this model.${resetMsg} Try a different model or wait for quota reset.`,
            type: "insufficient_quota",
            code: "insufficient_quota",
            attempts: attemptLogs
        } 
      }), { 
        status: 429, 
        headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "X-Antigravity-Attempts": attempts.toString()
        } 
      });
    }

    if (url.pathname === "/oauth-callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Missing code", { status: 400 });

      try {
          const tokenRes = await exchangeCode(code);
          const email = await getUserEmail(tokenRes.access_token);
          const projectId = await getProjectId(tokenRes.access_token);

          const newAccount: AntigravityAccount = {
            email,
            refreshToken: tokenRes.refresh_token!,
            accessToken: tokenRes.access_token,
            expiresAt: Date.now() + (tokenRes.expires_in * 1000),
            projectId,
            healthScore: 100,
            lastUsed: 0,
            tokenUsage: 0
          };

          if (!newAccount.refreshToken) {
              return new Response("No refresh token received. Revoke access and try again.", { status: 400 });
          }

          if (newAccount.projectId) {
              const quota = await fetchQuota(newAccount);
              if (quota) {
                  newAccount.quota = quota;
              }
          }

          await addAccount(newAccount);
          
          return new Response(`Authenticated ${email} (project: ${projectId}). You can close this tab.`, { status: 200 });
      } catch (e) {
          return new Response(`Auth error: ${e}`, { status: 500 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", service: "open-gemini" }), {
            headers: { "Content-Type": "application/json" }
        });
    }

    return new Response("Not Found", { status: 404 });
  }
});

console.log("Open-Gemini Proxy running on http://127.0.0.1:3000");
