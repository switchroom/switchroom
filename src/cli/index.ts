import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { registerVersionsCommand } from "./versions.js";
import { registerHandoffCommand } from "./handoff.js";
import { registerIssuesCommand } from "./issues.js";
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
registerVersionsCommand(program);
registerInitCommand(program);
registerAgentCommand(program);
registerSystemdCommand(program);
registerTopicsCommand(program);
registerAuthCommand(program);
registerVaultCommand(program);
registerMemoryCommand(program);
registerWebCommand(program);
registerHandoffCommand(program);
registerIssuesCommand(program);
registerDepsCommand(program);
registerWorkspaceCommand(program);
registerDebugCommand(program);
registerWorktreeCommand(program);
