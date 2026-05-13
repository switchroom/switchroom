/**
 * Per-agent overlay loader (switchroom #1163, Phase B).
 *
 * After the main `switchroom.yaml` resolves, each agent may have a
 * `~/.switchroom/agents/<name>/schedule.d/` directory containing one or more
 * `*.yaml` overlay fragments. Each fragment is a standalone YAML document
 * conforming to `OverlayDocSchema` (see `./overlay-schema.ts`).
 *
 * Merge semantics:
 *   - Overlay `schedule` entries are *appended* to the agent's
 *     `agents.<name>.schedule` array. They cannot override or replace main
 *     config entries.
 *   - Overlay entries with a non-empty `secrets:` list are dropped with a
 *     warning. Granting vault access via overlay would let a write-tool
 *     escalate its own broker grants without operator review.
 *     TODO(switchroom#1163 Phase E): queue these for an operator approval
 *     card instead of silently dropping.
 *   - Per-file failure is isolated: malformed YAML, schema-rejected files,
 *     and even one agent's bad overlay never block other files or agents.
 *
 * `skills.d/` is intentionally NOT loaded in this PR. The main-config
 * `agents.<name>.skills` field is `string[]` (a list of skill names), not a
 * structured-entry list, so an append-and-tag merge model needs a separate
 * design pass. See `OverlayDocSchema.skills` for the reserved field — the
 * schema accepts it shape-wise so a future PR can wire merging without a
 * breaking change.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import type { ScheduleEntry, SwitchroomConfig } from "./schema.js";
import { OverlayDocSchema } from "./overlay-schema.js";
import { resolveDualPath } from "./paths.js";

/**
 * Marker stamped on every overlay-sourced schedule entry. Downstream code
 * (e.g. the cron-unit namer) reads this to choose `cron-ovl-<hash>` style
 * unit names instead of `cron-<index>`, which avoids index collisions if
 * the main-config `schedule:` array grows.
 *
 * Exported as a Symbol so it's invisible to JSON-serialisation paths
 * (scaffold writes, audit logs) and won't accidentally bleed into the
 * agent-facing config view.
 */
export const OVERLAY_SOURCE = Symbol.for("switchroom.config.overlay-source");

export interface OverlayWarning {
  agent: string;
  file: string;
  reason: string;
}

export interface ApplyOverlaysResult {
  config: SwitchroomConfig;
  warnings: OverlayWarning[];
}

/**
 * Locate the on-host root for an agent's overlay tree. Honours the
 * dual-path resolver (`paths.ts`) so containerised callers and host
 * callers both find the same directory.
 */
function overlayDirFor(agentName: string, subdir: string): string {
  // ~/.switchroom/agents/<name>/<subdir>
  const base = resolveDualPath(`~/.switchroom/agents/${agentName}/${subdir}`);
  return resolve(base);
}

function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const full = resolve(dir, name);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      /* unreadable entry — skip */
    }
  }
  return out.sort(); // stable load order for deterministic merging
}

function stampOverlay(entry: ScheduleEntry): ScheduleEntry {
  // Non-enumerable so JSON.stringify / structured logs ignore it. The
  // marker is read by downstream consumers via `(entry as any)[OVERLAY_SOURCE]`.
  Object.defineProperty(entry, OVERLAY_SOURCE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return entry;
}

/**
 * Load + merge overlay files for every agent in the resolved config.
 *
 * Mutates `config` in place (appends to each agent's `schedule`) and also
 * returns it for ergonomic chaining. Warnings are emitted via
 * `console.warn` (matching the convention in `merge.ts`) and also returned
 * for callers that want to surface them through a different channel.
 */
export function applyAgentOverlays(config: SwitchroomConfig): ApplyOverlaysResult {
  const warnings: OverlayWarning[] = [];
  const agents = config.switchroom?.agents ?? {};

  for (const [agentName, agentCfg] of Object.entries(agents)) {
    try {
      const scheduleDir = overlayDirFor(agentName, "schedule.d");
      const files = listYamlFiles(scheduleDir);
      if (files.length === 0) continue;

      // Snapshot the main-config entry shapes so we can detect "would
      // override" attempts. Append-only means: if the overlay's
      // (cron, prompt) tuple matches an existing main entry, we still
      // append it (it'd be a duplicate cron, which is the operator's
      // problem) — but we never *replace*. The current array-append
      // merge naturally enforces this; no per-entry check needed.
      const merged: ScheduleEntry[] = [...(agentCfg.schedule ?? [])];

      for (const file of files) {
        try {
          const raw = readFileSync(file, "utf-8");
          const parsed = parseYaml(raw);
          const doc = OverlayDocSchema.parse(parsed);

          for (const entry of doc.schedule ?? []) {
            if (entry.secrets && entry.secrets.length > 0) {
              const w: OverlayWarning = {
                agent: agentName,
                file,
                reason:
                  "Overlay schedule entry declares secrets — dropped pending Phase E operator approval",
              };
              warnings.push(w);
              console.warn(
                `[switchroom] overlay-loader: agent='${agentName}' file='${file}': ${w.reason}`,
              );
              continue;
            }
            merged.push(stampOverlay(entry));
          }

          // Phase B does NOT merge `doc.skills` — see file header.
        } catch (err) {
          const reason =
            err instanceof ZodError
              ? `schema rejection: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`
              : `parse error: ${(err as Error).message}`;
          warnings.push({ agent: agentName, file, reason });
          console.warn(
            `[switchroom] overlay-loader: agent='${agentName}' file='${file}': ${reason}`,
          );
          // Continue to the next file — per-file failure isolation.
        }
      }

      agentCfg.schedule = merged;
    } catch (err) {
      // Per-agent isolation — a directory-read failure (permissions etc.)
      // for agent X must NOT block loading for agents Y/Z.
      warnings.push({
        agent: agentName,
        file: "(agent overlay scan)",
        reason: `unexpected error: ${(err as Error).message}`,
      });
      console.warn(
        `[switchroom] overlay-loader: agent='${agentName}': unexpected error: ${(err as Error).message}`,
      );
    }
  }

  return { config, warnings };
}
