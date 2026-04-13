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
import { registerHandoffCommand } from "./handoff.js";

const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf-8")
);

export const program = new Command()
  .name("clerk")
  .description(
    "Multi-agent orchestrator for Claude Code. One Telegram group, many specialized agents."
  )
  .version(pkg.version)
  .option("-c, --config <path>", "Path to clerk.yaml config file");

registerSetupCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);
registerInitCommand(program);
registerAgentCommand(program);
registerSystemdCommand(program);
registerTopicsCommand(program);
registerAuthCommand(program);
registerVaultCommand(program);
registerMemoryCommand(program);
registerWebCommand(program);
registerHandoffCommand(program);
