import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { SwitchroomConfigSchema, type SwitchroomConfig } from "./schema.js";
import { resolveDualPath } from "./paths.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    public details?: string[]
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodErrors(error: ZodError): string[] {
  return error.errors.map((e) => {
    const path = e.path.join(".");
    return `  ${path}: ${e.message}`;
  });
}

export function findConfigFile(startDir?: string): string {
  // Prefer switchroom.yaml but accept legacy clerk.yaml during the rename
  // transition so existing checkouts keep working without an immediate file
  // rename.
  const searchPaths = [
    startDir ? resolve(startDir, "switchroom.yaml") : null,
    startDir ? resolve(startDir, "switchroom.yml") : null,
    startDir ? resolve(startDir, "clerk.yaml") : null,
    startDir ? resolve(startDir, "clerk.yml") : null,
    resolve(process.cwd(), "switchroom.yaml"),
    resolve(process.cwd(), "switchroom.yml"),
    resolve(process.cwd(), "clerk.yaml"),
    resolve(process.cwd(), "clerk.yml"),
  ].filter(Boolean) as string[];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new ConfigError(
    "No switchroom.yaml found",
    searchPaths.map((p) => `  Searched: ${p}`)
  );
}

export function loadConfig(configPath?: string): SwitchroomConfig {
  const filePath = configPath ?? findConfigFile();

  if (!existsSync(filePath)) {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigError(`Failed to read config file: ${filePath}`, [
      `  ${(err as Error).message}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${filePath}`, [
      `  ${(err as Error).message}`,
    ]);
  }

  // Legacy alias: allow top-level `clerk:` key as a synonym for `switchroom:`.
  // This lets users migrate switchroom.yaml contents on their own schedule.
  if (
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).clerk !== undefined &&
    (parsed as Record<string, unknown>).switchroom === undefined
  ) {
    const obj = parsed as Record<string, unknown>;
    obj.switchroom = obj.clerk;
    delete obj.clerk;
  }

  try {
    return SwitchroomConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError("Invalid switchroom.yaml configuration", formatZodErrors(err));
    }
    throw err;
  }
}

export function resolveAgentsDir(config: SwitchroomConfig): string {
  return resolveDualPath(config.switchroom.agents_dir);
}

export function resolvePath(pathStr: string): string {
  return resolveDualPath(pathStr);
}
