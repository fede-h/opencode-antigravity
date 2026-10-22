---
name: agy-usage
description: Query and inspect Google Antigravity quota, model availability, and reset timers for OpenCode.
---

# Antigravity Usage & Quota Skill

Use this skill when the user asks about remaining Antigravity quota, model limits, token resets, or wants to check how much Claude / Gemini capacity they have left in OpenCode.

## Instructions

1. Query the local proxy's quota endpoint:
   ```bash
   curl -s http://127.0.0.1:3000/v1/quota
   ```
   Or execute the CLI quota script:
   ```bash
   bun run open-gemini-quota
   ```

2. Interpret the response:
   - `accounts`: List of configured OAuth accounts.
   - `healthScore`: 0-100 score indicating recent error rates and stability.
   - `quota`: Array of quota groups with `groupName`, `quotaLeft` (percentage), `remainingFraction`, and `resetIn`.

3. Present the findings clearly:
   - Provide a Markdown summary table grouped by account.
   - Highlight any models under 20% quota.
   - Detail the exact reset countdowns (e.g., "Resets in 2h 15m").
   - If a model is exhausted (0%), indicate when the reset window unlocks.
