---
name: agy-troubleshoot
description: Diagnose and resolve issues with the Antigravity proxy, OpenCode provider integration, model routing, and quota errors.
---

# Antigravity Troubleshooting Skill

Use this skill when the user encounters errors using Antigravity models in OpenCode, such as missing models in `/models`, unexpected `Quota Exhausted` responses, 404 model errors, service crashes, or drift between repositories and the deployed proxy.

## Diagnostic Workflow

1. **Run Diagnostic Script**:
   Execute the built-in diagnostic suite:
   ```bash
   bun run open-gemini-troubleshoot || bun run src/scripts/troubleshoot.ts
   ```

2. **Automated Self-Repair**:
   If issues are flagged, run auto-repair:
   ```bash
   bun run troubleshoot --fix
   ```
   This automatically fixes malformed `opencode.json` provider configurations, removes poisoned capability flags from `antigravity-accounts.json`, and repoints the systemd service to the active project root.

3. **Common Failure Modes & Root Causes**:

   ### Issue A: Models Disappear from `/models` or "Model unavailable"
   - **Root Cause**: OpenCode v2.0+ enforces that `provider.<id>.models.<model>.variants` must be an object dictionary (`Record<string, Record<string, any>>`), not an array. An array causes OpenCode to skip the entire provider with `skipped malformed recognized value`.
   - **Resolution**: Re-run `bun run setup` to regenerate the valid dictionary structure.

   ### Issue B: False "Quota Exhausted" Error (Real Quota Still Available)
   - **Root Cause**: Past 404 or bad requests caused the proxy to write `capabilities[model] = false` into `antigravity-accounts.json`. When all accounts are marked incapable, the router falls through to a misleading 429 quota exhausted response.
   - **Resolution**: Run `bun run reset-accounts` or clear `capabilities: {}` in `antigravity-accounts.json`, then restart the proxy with `systemctl --user restart antigravity-proxy.service`.

   ### Issue C: Deployed Proxy Drift (Changes Not Taking Effect)
   - **Root Cause**: `~/.config/systemd/user/antigravity-proxy.service` has `WorkingDirectory` set to a stale path (such as legacy `~/.config/antigravity-proxy`) instead of the active development repository.
   - **Resolution**: Run `bun run setup` in the current repository to rewrite the systemd unit file with the current working directory, reload the systemd daemon, and restart the service.

   ### Issue D: Claude 5.5 Returns 404 (model_not_found)
   - **Root Cause**: Google's upstream Cloud Code endpoint does not accept bare `claude-opus-5-5` or `claude-sonnet-5-5`; it requires an explicit tier suffix (`-high`, `-medium`, or `-low`).
   - **Resolution**: The proxy maps requests to `-medium` by default or resolves `-high`/`-low` from the OpenCode variant tag (`antigravity/antigravity-claude-opus-5-5#high`).

   ### Issue E: Gemini 4 Argon Returns "Gemini 3.8 Flash"
   - **Root Cause**: Google's backend has no separate `gemini-4-argon` weights or endpoint. "Argon" was Google's internal development codename, which shipped under the identifier `gemini-3.8-flash-tiered`.
   - **Resolution**: Expected behavior. In open-gemini, Argon routes to `gemini-3.8-flash-tiered` with a 32,768 reasoning token budget and `thinkingLevel: "high"`.
