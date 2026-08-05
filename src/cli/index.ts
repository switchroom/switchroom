import { Command } from "commander";
import { SWITCHROOM_VERSION as VERSION } from "./resolve-version.js";
import { registerAgentCommand } from "./agent.js";
import { registerStatusCommand } from "./status.js";
import { registerTopicsCommand } from "./topics.js";
import { registerAuthCommand } from "./auth.js";
import { registerVaultCommand } from "./vault.js";
import { registerBuzzCommand } from "./buzz.js";
import { registerTelegramCommand } from "./telegram.js";
import { registerLinearAgentCommand } from "./linear-agent.js";
import { registerMemoryCommand } from "./memory.js";
import { registerWebCommand } from "./web.js";
import { registerSetupCommand } from "./setup.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerUpdateCommand } from "./update.js";
import { registerRolloutCommand, registerRollbackCommand } from "./rollout.js";
import { registerRestartCommand } from "./restart.js";
import { registerVersionCommand } from "./version.js";
import { registerVersionsCommand } from "./versions.js";
import { registerHandoffCommand } from "./handoff.js";
import { registerIssuesCommand } from "./issues.js";
import { registerDepsCommand } from "./deps.js";
import { registerWorkspaceCommand } from "./workspace.js";
import { registerSoulCommand } from "./soul.js";
import { registerDebugCommand } from "./debug.js";
import { registerWorktreeCommand } from "./worktree.js";
import { registerDriveCommand } from "./drive.js";
import { registerDriveMcpLauncherCommand } from "./drive-mcp-launcher.js";
import { registerM365McpLauncherCommand } from "./m365-mcp-launcher.js";
import { registerNotionMcpLauncherCommand } from "./notion-mcp-launcher.js";
import { registerHindsightMcpShimCommand } from "./hindsight-mcp-shim.js";
import { registerDeliverFileCommand } from "./deliver-file.js";
import { registerNotionCommand } from "./notion.js";
import { registerApplyCommand } from "./apply.js";
import { registerSecretDetectCommand } from "./secret-detect.js";
import { registerStatusAskCommand } from "./status-ask.js";
import { registerAgentConfigCommands } from "./agent-config.js";
import { registerAgentConfigWriteCommands } from "./agent-config-write.js";
import { registerAgentConfigSkillWriteCommands } from "./agent-config-skill-write.js";
import { registerSkillCommand } from "./skill.js";
import { registerSkillPersonalCommands } from "./skill-personal.js";
import { registerSelfImproveProposeSkillCommand } from "./self-improve-propose-skill.js";
import { registerSelfImproveEvalCaseCommands } from "./self-improve-eval-case.js";
import { registerSkillSearchCommand } from "./skill-search.js";
import { registerAgentConfigMcpCommand } from "./mcp-agent-config.js";
import { registerHostdMcpCommand } from "./mcp-hostd.js";
import { registerHostdCommand } from "./hostd.js";
import { registerWebdCommand } from "./webd.js";
import { registerHostCommand } from "./host-repair.js";
import { registerFleetHealthCommand } from "./fleet-health.js";
import { registerHindsightWatchCommand } from "./hindsight-watch.js";
import { registerOpenRouterWatchCommand } from "./openrouter-watch.js";
import { captureEvent, installGlobalErrorHandlers } from "../analytics/posthog.js";

installGlobalErrorHandlers();

// VERSION (aliased from SWITCHROOM_VERSION) resolves at runtime from the
// shipped package.json, with src/build-info.ts as the fallback — see
// resolve-version.ts. The build targets node (not `bun build --compile`), so
// the bundle is a real file and import.meta.dirname-relative package.json
// reads work; package.json is the authoritative version (build-info drifts
// because the release reverts it). Git metadata still comes from build-info.
export const program = new Command()
  .name("switchroom")
  .description(
    "Multi-agent orchestrator for Claude Code. One Telegram group, many specialized agents."
  )
  .version(VERSION)
  .option("-c, --config <path>", "Path to switchroom.yaml config file")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    await captureEvent("cli_command_invoked", {
      command: actionCommand.name(),
      version: VERSION,
      node_version: process.version,
      platform: process.platform,
    });
  });

registerSetupCommand(program);
registerDoctorCommand(program);
registerUpdateCommand(program);
registerRolloutCommand(program);
registerRollbackCommand(program);
registerRestartCommand(program);
registerVersionCommand(program);
registerVersionsCommand(program);
registerAgentCommand(program);
registerStatusCommand(program);
registerTopicsCommand(program);
registerAuthCommand(program);
registerVaultCommand(program);
registerBuzzCommand(program);
registerTelegramCommand(program);
registerLinearAgentCommand(program);
registerMemoryCommand(program);
registerWebCommand(program);
registerHandoffCommand(program);
registerIssuesCommand(program);
registerDepsCommand(program);
registerWorkspaceCommand(program);
registerSoulCommand(program);
registerDebugCommand(program);
registerWorktreeCommand(program);
registerDriveCommand(program);
registerDriveMcpLauncherCommand(program);
registerM365McpLauncherCommand(program);
registerNotionMcpLauncherCommand(program);
registerHindsightMcpShimCommand(program);
registerDeliverFileCommand(program);
registerNotionCommand(program);
registerApplyCommand(program);
registerSecretDetectCommand(program);
registerStatusAskCommand(program);
registerAgentConfigCommands(program);
registerAgentConfigWriteCommands(program);
registerAgentConfigSkillWriteCommands(program);
registerSkillCommand(program);
registerSkillPersonalCommands(program);
registerSelfImproveProposeSkillCommand(program);
registerSelfImproveEvalCaseCommands(program);
registerSkillSearchCommand(program);
registerAgentConfigMcpCommand(program);
registerHostdMcpCommand(program);
registerHostdCommand(program);
registerWebdCommand(program);
registerHostCommand(program);
registerFleetHealthCommand(program);
registerHindsightWatchCommand(program);
registerOpenRouterWatchCommand(program);
