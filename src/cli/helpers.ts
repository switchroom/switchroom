import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, findConfigFile, ConfigError } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * Wraps an async action handler to catch and display ConfigError nicely.
 */
export function withConfigError(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(chalk.red(`Config error: ${err.message}`));
        if (err.details) {
          for (const d of err.details) {
            console.error(chalk.gray(d));
          }
        }
        process.exit(1);
      }
      throw err;
    }
  };
}

/**
 * Load config using the --config option from the parent command.
 */
export function getConfig(program: Command): SwitchroomConfig {
  const parentOpts = program.opts();
  return loadConfig(parentOpts.config);
}

/**
 * Resolve the absolute path of the switchroom.yaml file that would be loaded
 * given the parent command's --config option (or by searching cwd).
 */
export function getConfigPath(program: Command): string {
  const parentOpts = program.opts();
  return parentOpts.config ?? findConfigFile();
}
