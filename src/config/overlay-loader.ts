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
 * `skills.d/` IS loaded now (Phase 2 of #1163). Each overlay file may
 * declare a `skills:` list; entries are merged into
 * `agents.<name>.skills` via array-append + dedupe. Order: main-config
 * entries first, then overlay-sourced entries in sorted-file order.
 * Duplicate names are dropped silently (operator's main-config skill +
 * agent's overlay-installed bundled skill of the same name is treated
 * as "main wins, no-op").
 *
 * Skills overlay files are written by the `skill_install` MCP tool
 * via `overlay-writer.ts`. Source format is validated at write time
 * (currently only `bundled:<name>` is allowed; git+SHA-pinned support
 * is tracked separately for #1163 Phase 2 follow-up).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
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

/**
 * Marker stamped on every overlay-sourced schedule entry carrying the
 * human-readable *title* for the cron the file defines. Derived from a
 * top-of-file `# name: <title>` comment if present, else the file's
 * basename (sans extension) UNLESS that basename is a generic
 * auto-generated `cron-<hash>` name — in which case there's no
 * meaningful title and the marker is left unset.
 *
 * Read downstream by `collectScheduleEntries` (`scheduler/dispatch.ts`)
 * to populate `SchedulerEntry.name`, which the dashboard's Schedule tab
 * renders as the per-cron block header.
 *
 * Like {@link OVERLAY_SOURCE} it's a Symbol so it stays invisible to
 * JSON-serialisation paths (scaffold writes, audit logs) and won't bleed
 * into the agent-facing config view.
 */
export const OVERLAY_TITLE = Symbol.for("switchroom.config.overlay-title");

/**
 * Marker stamped on an agent's config node listing overlay files that
 * EXIST but could not be READ (EACCES/EPERM/EIO — anything except the
 * benign ENOENT delete race). A read failure is fundamentally different
 * from a content failure (malformed YAML, schema rejection): the file's
 * entries are unknown, not invalid, so consumers must not treat the load
 * as authoritative "these entries no longer exist".
 *
 * The concrete incident (clerk, 2,298 log hits): a root-euid writer left
 * `schedule.d/cron-*.yaml` owned root:root 0600; the in-container
 * agent-scheduler (agent uid) EACCESed on every hot-reload tick, the
 * loader skipped the file with only a console.warn, and the reloader
 * silently unregistered the cron ("schedule reloaded: 11 → 10") for
 * weeks — cron fires lost until an apply-time chown sweep healed the
 * ownership. The scheduler reads this marker (via
 * {@link overlayReadFailures}) to refuse such a reload instead.
 *
 * Symbol-keyed and non-enumerable for the same reason as
 * {@link OVERLAY_SOURCE}: invisible to JSON-serialisation paths.
 */
export const OVERLAY_READ_FAILURES = Symbol.for(
  "switchroom.config.overlay-read-failures",
);

/** One unreadable overlay file: absolute path + fs errno code + which
 *  overlay class it belongs to.
 *
 *  `source` matters because the two overlay classes have DIFFERENT
 *  fail-safes (#4373): an unreadable `schedule.d` overlay must freeze cron
 *  hot-reloads (a silently-unregistered live cron is worse than a delayed
 *  edit — the clerk EACCES incident #4371), but an unreadable `skills.d`
 *  overlay must NOT freeze schedule reloads — a skills permission problem is
 *  unrelated to the schedule and only warrants a warn-and-skip. Consumers
 *  filter on this via {@link overlayReadFailures}'s `source` argument. */
export interface OverlayReadFailure {
  file: string;
  code: string;
  source: "schedule" | "skills";
}

/** Record a read failure on the agent's config node (non-enumerable). */
function recordReadFailure(agentCfg: object, failure: OverlayReadFailure): void {
  const node = agentCfg as Record<symbol, unknown>;
  const existing = node[OVERLAY_READ_FAILURES] as OverlayReadFailure[] | undefined;
  if (Array.isArray(existing)) {
    existing.push(failure);
    return;
  }
  Object.defineProperty(agentCfg, OVERLAY_READ_FAILURES, {
    value: [failure],
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Overlay files for `agent` that existed but could not be read during the
 * last {@link applyAgentOverlays} pass over this config object. Empty when
 * every overlay file was readable (content errors do NOT count — those
 * files were read fine and are legitimately excluded).
 *
 * `source` scopes the result to one overlay class (`"schedule"` or
 * `"skills"`); omit it to get every read failure. The scheduler's strict
 * hot-reload guard passes `"schedule"` so an unreadable `skills.d` overlay
 * can no longer freeze cron reloads (#4373).
 */
export function overlayReadFailures(
  config: SwitchroomConfig,
  agent: string,
  source?: "schedule" | "skills",
): OverlayReadFailure[] {
  const agentCfg = config.agents?.[agent];
  if (!agentCfg) return [];
  const list = (agentCfg as unknown as Record<symbol, unknown>)[
    OVERLAY_READ_FAILURES
  ] as OverlayReadFailure[] | undefined;
  const all = Array.isArray(list) ? list : [];
  return source ? all.filter((f) => f.source === source) : all;
}

/**
 * Derive a human title for the cron(s) declared in an overlay file.
 *
 *   1. A top-of-file `# name: <title>` comment wins (authoritative even
 *      when the filename is a `cron-<hash>.yaml` auto-name).
 *   2. Otherwise the filename basename without its extension — a
 *      hand-named `weekend-planner.yaml` → "weekend-planner".
 *   3. EXCEPT a generic auto-generated `cron-<hash>` basename (the
 *      overlay-writer's default for an un-named cron): that hash is not
 *      a meaningful title, so return undefined.
 *
 * `raw` is the file's raw text (pre-YAML-parse, so the comment survives);
 * `fileName` is the basename (e.g. "weekend-planner.yaml").
 */
function deriveOverlayTitle(raw: string, fileName: string): string | undefined {
  // `[^\S\n]` = whitespace but NOT a newline, so the inter-token spacing
  // stays on the comment's own line: a whitespace-only `# name:   ` header
  // can't consume the newline and bleed the NEXT line in as the title.
  const titleFromComment = raw.match(/^#[^\S\n]*name:[^\S\n]*(\S.*?)[^\S\n]*$/m)?.[1];
  if (titleFromComment) return titleFromComment;
  const base = fileName.replace(/\.ya?ml$/i, "");
  // Generic auto-generated name (cron-<6+ hex>) carries no title.
  if (/^cron-[0-9a-f]{6,}$/i.test(base)) return undefined;
  return base.length > 0 ? base : undefined;
}

export interface OverlayWarning {
  agent: string;
  file: string;
  reason: string;
  /** fs errno code (e.g. "EACCES") when the file existed but could not be
   *  READ. Absent for content failures (malformed YAML, schema rejection). */
  code?: string;
}

export interface ApplyOverlaysResult {
  config: SwitchroomConfig;
  warnings: OverlayWarning[];
}

/**
 * Read one overlay file, classifying READ failures separately from the
 * content failures the callers' parse/schema catch handles.
 *
 *   - success → the raw text.
 *   - ENOENT → undefined, silently: the file was deleted between the
 *     directory listing and the read — a removed overlay legitimately
 *     unregisters its entries.
 *   - any other errno (EACCES/EPERM/EIO/…) → undefined, after recording
 *     an {@link OverlayReadFailure} on the agent's config node and a
 *     warning. The file EXISTS and its entries are unknown — consumers
 *     (the agent-scheduler's hot-reload) must not treat this load as
 *     proof the entries are gone.
 */
function readOverlayFile(
  agentName: string,
  file: string,
  agentCfg: object,
  warnings: OverlayWarning[],
  source: "schedule" | "skills",
): string | undefined {
  try {
    return readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    const w: OverlayWarning = {
      agent: agentName,
      file,
      reason: `read error: ${(err as Error).message}`,
      code: code ?? "EUNKNOWN",
    };
    recordReadFailure(agentCfg, { file, code: w.code!, source });
    warnings.push(w);
    console.warn(
      `[switchroom] overlay-loader: agent='${agentName}' file='${file}': ${w.reason}`,
    );
    return undefined;
  }
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

function listYamlFiles(
  dir: string,
  /** Invoked when the directory EXISTS but cannot be listed (EACCES on
   *  the dir itself — the dir-level variant of the unreadable-file
   *  incident). ENOENT (deleted between existsSync and readdir) stays
   *  silent. */
  onUnreadableDir?: (code: string) => void,
): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") onUnreadableDir?.(code ?? "EUNKNOWN");
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

function stampOverlay(entry: ScheduleEntry, title?: string): ScheduleEntry {
  // Non-enumerable so JSON.stringify / structured logs ignore it. The
  // marker is read by downstream consumers via `(entry as any)[OVERLAY_SOURCE]`.
  Object.defineProperty(entry, OVERLAY_SOURCE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  // Stamp the human title only when the file actually carries one (a
  // `# name:` comment or a meaningful filename) — a hash-only filename
  // leaves it unset so downstream can fall back to the cron expression.
  if (title !== undefined) {
    Object.defineProperty(entry, OVERLAY_TITLE, {
      value: title,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
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
  // `agents` lives at the top level of `SwitchroomConfig` alongside
  // `switchroom`, `telegram`, `defaults`, `profiles` — NOT inside the
  // inner `switchroom:` block. (Fixed in #1205 / #1200.)
  const agents = config.agents ?? {};

  for (const [agentName, agentCfg] of Object.entries(agents)) {
    try {
      const scheduleDir = overlayDirFor(agentName, "schedule.d");
      const files = listYamlFiles(scheduleDir, (code) => {
        const w: OverlayWarning = {
          agent: agentName,
          file: scheduleDir,
          reason: `read error: cannot list overlay directory (${code})`,
          code,
        };
        recordReadFailure(agentCfg, { file: scheduleDir, code, source: "schedule" });
        warnings.push(w);
        console.warn(
          `[switchroom] overlay-loader: agent='${agentName}' file='${scheduleDir}': ${w.reason}`,
        );
      });
      // #1209 review fix: don't `continue` past the skills.d pass when
      // an agent has no schedule.d files. Pre-fix the early-return
      // made the skills.d branch dead code for newly-scaffolded agents
      // (which is the common case — most agents start with neither
      // overlay dir populated). Gate the schedule body on
      // `files.length > 0` instead so we always fall through to the
      // skills.d pass below.
      if (files.length > 0) {

      // Snapshot the main-config entry shapes so we can detect "would
      // override" attempts. Append-only means: if the overlay's
      // (cron, prompt) tuple matches an existing main entry, we still
      // append it (it'd be a duplicate cron, which is the operator's
      // problem) — but we never *replace*. The current array-append
      // merge naturally enforces this; no per-entry check needed.
      const merged: ScheduleEntry[] = [...(agentCfg.schedule ?? [])];

      for (const file of files) {
        const raw = readOverlayFile(agentName, file, agentCfg, warnings, "schedule");
        if (raw === undefined) continue;
        try {
          const parsed = parseYaml(raw);
          const doc = OverlayDocSchema.parse(parsed);

          // Title is per-FILE (one overlay file = one logical cron the
          // operator/agent named) — derive once from the raw text +
          // basename, then stamp every entry the file declares.
          const title = deriveOverlayTitle(raw, basename(file));

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
            merged.push(stampOverlay(entry, title));
          }

          // Phase 2 (#1163) — schedule.d files MAY also declare a
          // `skills:` list (one schema, two storage dirs). Skip skills
          // when the file came from schedule.d to keep schema-vs-dir
          // separation crisp (and so the operator can grep skill
          // installs by looking only at skills.d/).
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
      } // close the files.length > 0 guard
    } catch (err) {
      // Per-agent isolation for the schedule.d pass — separate from
      // the skills.d pass below so a permission-error on one dir
      // doesn't block the other.
      warnings.push({
        agent: agentName,
        file: "(agent schedule overlay scan)",
        reason: `unexpected error: ${(err as Error).message}`,
      });
      console.warn(
        `[switchroom] overlay-loader: agent='${agentName}' schedule.d: unexpected error: ${(err as Error).message}`,
      );
    }

    // ── Skills overlay pass (#1163 Phase 2) ─────────────────────────
    try {
      const skillsDir = overlayDirFor(agentName, "skills.d");
      const skillFiles = listYamlFiles(skillsDir, (code) => {
        const w: OverlayWarning = {
          agent: agentName,
          file: skillsDir,
          reason: `read error: cannot list overlay directory (${code})`,
          code,
        };
        recordReadFailure(agentCfg, { file: skillsDir, code, source: "skills" });
        warnings.push(w);
        console.warn(
          `[switchroom] overlay-loader: agent='${agentName}' file='${skillsDir}': ${w.reason}`,
        );
      });
      // No early continue — this is the LAST pass in the for-agent loop,
      // but using `continue` here would still skip any future passes
      // added below. Gate the merge work on file presence instead, same
      // pattern as the schedule.d guard above (#1209 review).
      if (skillFiles.length === 0) {
        // nothing to merge; fall through to the per-agent catch (no-op).
      } else {

      const merged: string[] = [...(agentCfg.skills ?? [])];
      const seen = new Set(merged);

      for (const file of skillFiles) {
        const raw = readOverlayFile(agentName, file, agentCfg, warnings, "skills");
        if (raw === undefined) continue;
        try {
          const parsed = parseYaml(raw);
          const doc = OverlayDocSchema.parse(parsed);
          for (const skillName of doc.skills ?? []) {
            // Dedupe — silently drop main-config dup or duplicate across
            // overlay files. The skill_install tool also dedupes on
            // write, so this is defense-in-depth.
            if (seen.has(skillName)) continue;
            seen.add(skillName);
            merged.push(skillName);
          }
        } catch (err) {
          const reason =
            err instanceof ZodError
              ? `schema rejection: ${err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`
              : `parse error: ${(err as Error).message}`;
          warnings.push({ agent: agentName, file, reason });
          console.warn(
            `[switchroom] overlay-loader: agent='${agentName}' file='${file}': ${reason}`,
          );
        }
      }

      agentCfg.skills = merged;
      } // close the skillFiles.length > 0 guard
    } catch (err) {
      // Per-agent isolation for the skills.d pass — same as schedule.d.
      // A directory-read failure (permissions etc.) for agent X must
      // NOT block loading for agents Y/Z.
      warnings.push({
        agent: agentName,
        file: "(agent skills overlay scan)",
        reason: `unexpected error: ${(err as Error).message}`,
      });
      console.warn(
        `[switchroom] overlay-loader: agent='${agentName}' skills.d: unexpected error: ${(err as Error).message}`,
      );
    }
  }

  return { config, warnings };
}
