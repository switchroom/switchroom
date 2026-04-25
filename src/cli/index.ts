import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { registerInitCommand } from "./init.js";
import { registerAgentCommand } from "./agent.js";
import { registerSystemdCommand } from "./systemd.js";
import { registerTopicsCommand } from "./topics.js";
import { registerAuthCommand } from "./auth.js";
import { registerVaultCommand } from "./vault.js";
import { registerMemoryCommand } from "./memory.js";
import { registerWebCommand } from "./web.js";
import { registerSetupCommand } from "./setup.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerUpdateCommand } from "./update.js";
import { registerRestartCommand } from "./restart.js";
import { registerVersionCommand } from "./version.js";
import { registerHandoffCommand } from "./handoff.js";
import { registerDepsCommand } from "./deps.js";
import { registerWorkspaceCommand } from "./workspace.js";
import { registerDebugCommand } from "./debug.js";
import { registerWorktreeCommand } from "./worktree.js";
import { captureEvent, installGlobalErrorHandlers } from "../analytics/posthog.js";

installGlobalErrorHandlers();

const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf-8")
);

export const program = new Command()
  .name("switchroom")
  .description(
    "Multi-agent orchestrator for Claude Code. One Telegram group, many specialized agents."
  )
  .version(pkg.version)
  .option("-c, --config <path>", "Path to switchroom.yaml config file")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    await captureEvent("cli_command_invoked", {
      command: actionCommand.name(),
      version: pkg.version,
      node_version: process.version,
      platform: process.platform,
    });
  });

registerSetupCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);
registerRestartCommand(program);
registerVersionCommand(program);
registerInitCommand(program);
registerAgentCommand(program);
registerSystemdCommand(program);
registerTopicsCommand(program);
registerAuthCommand(program);
registerVaultCommand(program);
registerMemoryCommand(program);
registerWebCommand(program);
registerHandoffCommand(program);
registerDepsCommand(program);
registerWorkspaceCommand(program);
registerDebugCommand(program);
registerWorktreeCommand(program);

// Deprecated aliases — kept for one release, will be removed after.
// Invoking these prints a clear deprecation warning and delegates to `update`.
for (const oldVerb of ["upgrade", "rebuild", "reconcile"] as const) {
  program
    .command(oldVerb, { hidden: true })
    .description(`[DEPRECATED] Use 'switchroom update' instead`)
    .allowUnknownOption(true)
    .action(() => {
      console.warn(
        `\n  ⚠  '${oldVerb}' is deprecated — use 'switchroom update' instead.\n`
      );
      // Delegate by re-invoking with the canonical verb. argv layout for
      // a CLI invocation is [node, /path/to/switchroom, <verb>, ...rest],
      // so slice(3) drops the deprecated verb and keeps the rest of the
      // user's flags. Test harnesses that mock argv differently must
      // construct the array themselves.
      try {
        const self = process.argv[1];
        execFileSync(process.execPath, [self, "update", ...process.argv.slice(3)], {
          stdio: "inherit",
        });
      } catch (err: any) {
        process.exit(err.status ?? 1);
      }
    });
}
