---
description: Diagnose and repair Antigravity proxy issues, model errors, and configuration drift in OpenCode
---

Diagnose and troubleshoot Google Antigravity bridge issues, model errors, and configuration drift in OpenCode.

## Procedure

1. Run the automated diagnostic test:
   ```bash
   bun run open-gemini-troubleshoot || bun run src/scripts/troubleshoot.ts
   ```

2. If any failure is detected, execute the self-repair routine:
   ```bash
   bun run troubleshoot --fix || bun run src/scripts/troubleshoot.ts --fix
   ```

3. Cross-reference specific error patterns if the issue persists:

   - **"Model unavailable: antigravity/..." in `/models` or CLI**:
     OpenCode rejected the provider due to invalid `variants` schema in `~/.config/opencode/opencode.json`.
     *Fix*: Run `bun run setup` to rewrite `opencode.json` with the dictionary variants schema.

   - **"Quota Exhausted: All accounts failed... Next reset in..." when quota is available**:
     Stale capability blacklisting (`capabilities[model] = false`) in `antigravity-accounts.json` from past transient errors.
     *Fix*: Run `bun run reset-accounts` or purge `capabilities: {}` in `antigravity-accounts.json`, then restart the service: `systemctl --user restart antigravity-proxy.service`.

   - **Code changes or model updates have no effect**:
     Systemd service is running from a stale path (e.g. `~/.config/antigravity-proxy`).
     *Fix*: Run `bun run setup` from the active repository to repoint `WorkingDirectory`, reload systemd daemon, and restart the service.

   - **Claude 5.5 returns 404 `model_not_found`**:
     Upstream Google Cloud Code requires tier suffixes (`-high`, `-medium`, `-low`). Use `#high`, `#medium`, or `#low` variant tags in OpenCode (e.g., `antigravity/antigravity-claude-opus-5-5#high`).

   - **"Gemini 4 Argon" returns "Gemini 3.8 Flash"**:
     Google's backend has no `gemini-4-argon` endpoint. Argon is an alias that routes to `gemini-3.8-flash-tiered` with 32k thinking budget and `thinkingLevel: high`.

   - **Service offline or connection refused on port 3000**:
     Run `systemctl --user status antigravity-proxy.service` and check `journalctl --user -u antigravity-proxy.service -n 50 --no-pager`.

4. Provide the user with a concise status report of what was diagnosed and what actions were taken.
