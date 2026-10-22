import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default {
  id: "agy-usage",
  async setup(ctx: any) {
    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "agy-usage",
        description: "Display real-time Antigravity model quota usage and reset countdowns",
        execute: async (args: any) => {
          if (!args?.sessionID) return;

          const localBinAgy = join(homedir(), ".local", "bin", "agy-usage");
          const projectScript = join(homedir(), "Documents", "Projects", "open-gemini", "src", "scripts", "show-quota.ts");

          let command = "agy-usage";
          if (!existsSync(localBinAgy) && existsSync(projectScript)) {
            command = `bun run ${projectScript}`;
          }

          // Trigger shell execution asynchronously without blocking command handler
          setTimeout(() => {
            try {
              Bun.spawn([
                "opencode",
                "api",
                "POST",
                `/api/session/${args.sessionID}/shell`,
                "-d",
                JSON.stringify({ command })
              ]);
            } catch (err) {
              console.error("[agy-usage] Failed to trigger quota command:", err);
            }
          }, 50);
        },
      });
    });
  },
};
