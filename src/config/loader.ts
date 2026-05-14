import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { SwitchroomConfigSchema, type SwitchroomConfig } from "./schema.js";
import { resolveDualPath } from "./paths.js";
import { applyAgentOverlays } from "./overlay-loader.js";

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

/**
 * RFC G Phase 1: coerce the legacy `drive:` key into the canonical
 * `google_workspace:` key, both at the top level and on each agent.
 *
 * Rules (same at top level + per-agent):
 *   - Neither set       → leave untouched.
 *   - Only one set      → mirror it onto the other key so both readers see it.
 *   - Both set          → fail fast IF they differ. Silently picking one would
 *                         mask operator intent. If they're identical (a
 *                         hand-written config that double-specified), allow it.
 *
 * Mirroring rather than renaming: existing readers (`src/cli/drive.ts`,
 * tests, scaffold.ts) read `config.drive` today; Phase 1 must not break
 * them. New readers (Phase 3+) prefer `config.google_workspace` and treat
 * `config.drive` as fallback. Eventually we drop the legacy field — but
 * that's a future major-version cleanup, not this phase.
 *
 * Mutates `parsed` in place. Same shape as the existing `clerk:` →
 * `switchroom:` coercion above.
 */
function coerceLegacyGoogleWorkspaceKeys(
  parsed: Record<string, unknown>,
  filePath: string,
): void {
  // Order-insensitive deep stringification — fixes the case where two
  // independently-authored YAML blocks have the same content but different
  // key ordering (e.g. `approvers:` first vs `tier:` first). Plain
  // JSON.stringify would falsely flag those as a mismatch.
  const stableStringify = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  };

  const aliasInPlace = (obj: Record<string, unknown>, where: string) => {
    const a = obj.drive;
    const b = obj.google_workspace;
    if (a !== undefined && b !== undefined) {
      // Both set — must be deeply equal, otherwise reject.
      if (stableStringify(a) !== stableStringify(b)) {
        throw new ConfigError(
          `Both \`drive:\` and \`google_workspace:\` are set on ${where} in ${filePath} with different values.`,
          [
            "  These are aliases — pick one and remove the other.",
            "  `google_workspace:` is the RFC G canonical key; `drive:` is the legacy alias.",
            "  Allowed during transition: setting both with identical values.",
          ],
        );
      }
      // Identical — leave both as-is.
      return;
    }
    // Mirror whichever was set onto the other key.
    if (a !== undefined && b === undefined) obj.google_workspace = a;
    if (b !== undefined && a === undefined) obj.drive = b;
  };

  // Top-level
  aliasInPlace(parsed, "the top level");

  // Per-agent
  const agents = parsed.agents;
  if (agents && typeof agents === "object" && !Array.isArray(agents)) {
    for (const [name, agent] of Object.entries(agents)) {
      if (agent && typeof agent === "object" && !Array.isArray(agent)) {
        aliasInPlace(agent as Record<string, unknown>, `agent \`${name}\``);
      }
    }
  }
}

export function findConfigFile(startDir?: string): string {
  // Search order (first hit wins):
  // 1. $SWITCHROOM_CONFIG env var (explicit override for daemonized agents)
  // 2. Explicit startDir
  // 3. Current working directory
  // 4. ~/.switchroom/switchroom.yaml (user-wide default)
  //
  // Legacy `clerk.yaml` filenames are still accepted at every location for the
  // rename transition.
  const envPath = process.env.SWITCHROOM_CONFIG;
  const home = homedir();
  const userDir = resolve(home, ".switchroom");

  const searchPaths = [
    envPath ? resolve(envPath) : null,
    startDir ? resolve(startDir, "switchroom.yaml") : null,
    startDir ? resolve(startDir, "switchroom.yml") : null,
    startDir ? resolve(startDir, "clerk.yaml") : null,
    startDir ? resolve(startDir, "clerk.yml") : null,
    resolve(process.cwd(), "switchroom.yaml"),
    resolve(process.cwd(), "switchroom.yml"),
    resolve(process.cwd(), "clerk.yaml"),
    resolve(process.cwd(), "clerk.yml"),
    resolve(userDir, "switchroom.yaml"),
    resolve(userDir, "switchroom.yml"),
    resolve(userDir, "clerk.yaml"),
    resolve(userDir, "clerk.yml"),
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

  // RFC G Phase 1: `drive:` is the legacy key for what is now
  // `google_workspace:`. Coerce here so the schema only sees one shape.
  // Both-set is a fast-fail — silently picking one would mask operator
  // intent and is exactly the kind of "convention over configuration"
  // failure principles.md §1 warns about.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    coerceLegacyGoogleWorkspaceKeys(parsed as Record<string, unknown>, filePath);
  }

  let config: SwitchroomConfig;
  try {
    config = SwitchroomConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError("Invalid switchroom.yaml configuration", formatZodErrors(err));
    }
    throw err;
  }

  // Phase B (switchroom #1163): merge per-agent overlay YAML from
  // ~/.switchroom/agents/<name>/schedule.d/*.yaml. Overlay failures are
  // per-file isolated and surfaced as warnings — they never fail the load.
  applyAgentOverlays(config);

  return config;
}

export function resolveAgentsDir(config: SwitchroomConfig): string {
  // Container-mode override: when set (auth-broker / approval-kernel
  // containers do this via compose env), `SWITCHROOM_AGENTS_DIR` wins
  // over `config.switchroom.agents_dir`. Compose bind-mounts the host
  // `~/.switchroom/agents` to `/state/agents`; without this override the
  // broker resolves agent dirs to `/root/.switchroom/agents` (nothing
  // mounted) and per-agent credential mirrors land in a tmpfs path
  // instead of the host. See `src/agents/compose.ts:1014`.
  //
  // Only honoured when set to a non-empty absolute path.
  const override = process.env.SWITCHROOM_AGENTS_DIR;
  if (override && override.length > 0 && override.startsWith("/")) {
    return override;
  }
  return resolveDualPath(config.switchroom.agents_dir);
}

export function resolvePath(pathStr: string): string {
  return resolveDualPath(pathStr);
}
