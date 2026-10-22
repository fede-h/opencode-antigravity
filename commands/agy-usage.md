---
description: Display Google Antigravity account quota, model limits, and reset countdowns
---

Display real-time Google Antigravity account quotas, usage percentages, and reset timers directly in OpenCode.

## Procedure

1. Fetch quota data from the local proxy endpoint:
   ```bash
   curl -s http://127.0.0.1:3000/v1/quota
   ```
   Or run the standalone script:
   ```bash
   bun run open-gemini-quota || bun run src/scripts/show-quota.ts
   ```

2. Format the response as a clear, readable Markdown table for each configured account:
   - **Account Email** and **Project ID**
   - **Account Health Score** (0-100%)
   - Table columns: `Model Group`, `Quota Left`, `Reset In`, and `Status` (`Normal`, `Low < 20%`, or `Exhausted`)

3. If the local proxy is offline (`Connection refused`), alert the user:
   - Provide the recovery command: `systemctl --user start antigravity-proxy.service`
   - Fall back to reading `antigravity-accounts.json` from the open-gemini directory to display the last cached quota.

4. If any model is below 20% quota, highlight it with a warning.
