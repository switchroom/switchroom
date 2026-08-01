/**
 * Prompt-cascade doctor probes (epic #1850 / issue #1858).
 *
 * The redesigned system-prompt cascade has three release/operator lanes
 * plus a per-turn plane and a per-repo hook. Each lane is a separate file
 * on a separate durability contract, and every one of them fails SILENTLY
 * when it drifts: a checksummed L1 file that got hand-edited, an L2
 * fleet-default that never seeded, a per-agent CLAUDE.md whose operator
 * marker got deleted, a settings.json missing the hook that reasserts
 * pacing every turn. None of those throw — the agent just quietly reads a
 * subtly wrong prompt. These probes convert each drift class into one
 * upfront, operator-visible `switchroom doctor` line.
 *
 * The lanes (see `src/agents/scaffold.ts` + `src/agents/fleet-defaults.ts`):
 *
 *   L1  `~/.switchroom/fleet/switchroom-invariants.md` — release-pinned,
 *       rendered by `renderFleetInvariants()`, checksum-restored by
 *       `switchroom apply` on drift.
 *   L2  `~/.switchroom/fleet/CLAUDE.md` — `writeIfMissing` operator-owned
 *       defaults, rendered by `renderFleetDefaultsClaudeMd()`. Carries a
 *       machine-readable `<!-- switchroom-fleet-defaults-version: X -->`
 *       tag in its header so we can tell a stale default from a
 *       personalised one.
 *   L3  `<agentDir>/CLAUDE.md` — per-agent. Split by the
 *       `# --- Yours (preserved across apply) ---` marker: scaffold owns
 *       everything above, the operator owns everything below.
 *   L4  the `repo-context-pretool` PreToolUse hook that injects a foreign
 *       repo's own CLAUDE.md/AGENTS.md mid-turn.
 *   per-turn  the `turn-pacing` UserPromptSubmit hook (#1646) that
 *       reasserts the Telegram 5-beats adjacent to each user message.
 *   cross-lane  `--add-dir ~/.switchroom/fleet` in the agent's boot
 *       invocation (start.sh) — without it none of L1/L2 is discovered.
 *   cross-lane  a regression grep: the Telegram 5-beats live in L1 now;
 *       finding them re-inlined in a per-agent CLAUDE.md means the
 *       deduplicated partial crept back (double-load).
 *
 * Filesystem access is dependency-injected (mirrors `doctor-webkite.ts`)
 * so unit tests drive every branch without a real fleet tree. The
 * EACCES/EPERM split is load-bearing: scaffold artifacts are agent-UID
 * owned 0600 and the host operator running `doctor` (no sudo) cannot read
 * them — that must read as `skip`, never `fail`.
 */

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import { renderFleetInvariants, CLAUDE_MD_YOURS_MARKER } from "../agents/scaffold.js";
import { renderFleetDefaultsClaudeMd } from "../agents/fleet-defaults.js";
import {
  GENERATION_STAMP_FILE,
  hashManagedClaudeMd,
  sha256Text,
} from "../agents/generation-stamp.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** Distinctive signature of the Telegram 5-beats pacing block. It lives in
 * L1 (`TELEGRAM_GUIDANCE`) now; finding it in a per-agent CLAUDE.md means the
 * deduplicated partial was re-inlined (the double-load regression #1858 guards). */
export const TELEGRAM_PACING_SIGNATURE = "## Talking to a human on Telegram";

/** Substring identifying the repo-context PreToolUse hook command. */
const REPO_CONTEXT_HOOK_MARKER = "repo-context-pretool";
/** Substring identifying the turn-pacing UserPromptSubmit hook command. */
const TURN_PACING_HOOK_MARKER = "turn-pacing";
/** Regex for the machine-readable L2 version tag in the fleet CLAUDE.md header. */
const FLEET_DEFAULTS_VERSION_TAG = /<!--\s*switchroom-fleet-defaults-version:\s*(\S+)\s*-->/;

export interface CascadeProbeDeps {
  /** Home dir override (tests). Defaults to os.homedir(). */
  homeDir?: string;
  /** Defaults to `resolveAgentsDir(config)`, resolved lazily + guarded. */
  agentsDir?: string;
  /** The switchroom version the L2 tag is checked against. Defaults to SWITCHROOM_VERSION. */
  currentVersion?: string;
  existsSync?: (p: string) => boolean;
  /** Read a file as utf-8. Throws (with `.code`) on EACCES/EPERM so the
   * probe can classify agent-private 0600 files as `skip`. */
  readFileSync?: (p: string) => string;
  /**
   * The below-marker (operator-owned) baseline hash recorded at the last
   * `switchroom apply`, per agent. Production reads it from the generation
   * stamp; it is `null` until the apply path is wired to persist it, in
   * which case the L3-below probe honestly reports `skip` ("no baseline
   * yet") rather than fabricating a pass. Injected in tests.
   */
  belowMarkerBaseline?: (agentDir: string) => string | null;
}

interface ResolvedDeps {
  homeDir: string;
  agentsDir: string | undefined;
  currentVersion: string;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => string;
  belowMarkerBaseline: (agentDir: string) => string | null;
}

/** Read + parse the agent's generation stamp; null if absent/unreadable. */
function readStamp(
  d: Pick<ResolvedDeps, "existsSync" | "readFileSync">,
  agentDir: string,
): Record<string, unknown> | null {
  const p = join(agentDir, GENERATION_STAMP_FILE);
  if (!d.existsSync(p)) return null;
  try {
    return JSON.parse(d.readFileSync(p)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function defaultBelowMarkerBaseline(
  d: Pick<ResolvedDeps, "existsSync" | "readFileSync">,
  agentDir: string,
): string | null {
  const stamp = readStamp(d, agentDir);
  // The apply path does not yet persist a below-marker hash into the stamp;
  // until it does, there is no baseline to compare against (honest skip).
  const v = stamp?.["claudeMdBelowMarker"];
  return typeof v === "string" ? v : null;
}

function resolveDeps(
  config: SwitchroomConfig,
  deps: CascadeProbeDeps,
): ResolvedDeps {
  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }
  const existsSync = deps.existsSync ?? ((p) => realExistsSync(p));
  const readFileSync = deps.readFileSync ?? ((p) => realReadFileSync(p, "utf-8"));
  return {
    homeDir: deps.homeDir ?? homedir(),
    agentsDir,
    currentVersion: deps.currentVersion ?? SWITCHROOM_VERSION,
    existsSync,
    readFileSync,
    belowMarkerBaseline:
      deps.belowMarkerBaseline ??
      ((agentDir) => defaultBelowMarkerBaseline({ existsSync, readFileSync }, agentDir)),
  };
}

/** Was this read failure an operator-can't-read-0600 case (→ skip)? */
function isUnreadable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EACCES" || code === "EPERM";
}

/** Split a CLAUDE.md at the FIRST marker occurrence. Returns null if the
 * marker is absent (the caller reports that as its own failure). */
function belowMarkerSection(content: string): string | null {
  const idx = content.indexOf(CLAUDE_MD_YOURS_MARKER);
  if (idx === -1) return null;
  return content.slice(idx + CLAUDE_MD_YOURS_MARKER.length);
}

/**
 * Run all prompt-cascade checks. Always emits (the cascade is universal —
 * every fleet has L1/L2 and at least one agent).
 */
export function runCascadeChecks(
  config: SwitchroomConfig,
  deps: CascadeProbeDeps = {},
): CheckResult[] {
  const d = resolveDeps(config, deps);
  const results: CheckResult[] = [];
  const fleetDir = join(d.homeDir, ".switchroom", "fleet");

  // ── L1: invariants present ────────────────────────────────────────
  const invariantsPath = join(fleetDir, "switchroom-invariants.md");
  const invariantsPresent = d.existsSync(invariantsPath);
  if (!invariantsPresent) {
    results.push({
      name: "cascade L1: invariants present",
      status: "fail",
      detail: `missing ${invariantsPath} — no agent can load the release-pinned fleet invariants`,
      fix: "Run `switchroom apply` to re-seed the fleet directory.",
    });
  } else {
    results.push({
      name: "cascade L1: invariants present",
      status: "ok",
      detail: `present at ${invariantsPath}`,
    });
  }

  // ── L1: invariants checksum matches release ───────────────────────
  if (!invariantsPresent) {
    results.push({
      name: "cascade L1: invariants checksum",
      status: "skip",
      detail: "invariants file absent — nothing to checksum (see L1 present)",
    });
  } else {
    let onDisk: string | null = null;
    let unreadable = false;
    try {
      onDisk = d.readFileSync(invariantsPath);
    } catch (err) {
      unreadable = isUnreadable(err);
    }
    if (unreadable) {
      results.push({
        name: "cascade L1: invariants checksum",
        status: "skip",
        detail: "invariants file unreadable by the operator — re-run doctor without sudo",
      });
    } else if (onDisk === null) {
      results.push({
        name: "cascade L1: invariants checksum",
        status: "fail",
        detail: `could not read ${invariantsPath}`,
      });
    } else {
      const canonical = renderFleetInvariants();
      if (sha256Text(onDisk) === sha256Text(canonical)) {
        results.push({
          name: "cascade L1: invariants checksum",
          status: "ok",
          detail: "matches the release canonical",
        });
      } else {
        results.push({
          name: "cascade L1: invariants checksum",
          status: "fail",
          detail: `${invariantsPath} has drifted from the release canonical (it is release-controlled, not operator-editable)`,
          fix: "Run `switchroom apply` — it restores the canonical invariants on drift.",
        });
      }
    }
  }

  // ── L2: fleet CLAUDE.md present + version tag ─────────────────────
  const fleetClaudePath = join(fleetDir, "CLAUDE.md");
  if (!d.existsSync(fleetClaudePath)) {
    results.push({
      name: "cascade L2: fleet defaults",
      status: "fail",
      detail: `missing ${fleetClaudePath} — the operator-owned fleet brain never seeded`,
      fix: "Run `switchroom apply` to seed the fleet defaults CLAUDE.md.",
    });
  } else {
    let onDisk: string | null = null;
    let unreadable = false;
    try {
      onDisk = d.readFileSync(fleetClaudePath);
    } catch (err) {
      unreadable = isUnreadable(err);
    }
    if (unreadable) {
      results.push({
        name: "cascade L2: fleet defaults",
        status: "skip",
        detail: "fleet CLAUDE.md unreadable by the operator — re-run doctor without sudo",
      });
    } else if (onDisk === null || onDisk.trim() === "") {
      results.push({
        name: "cascade L2: fleet defaults",
        status: "fail",
        detail: `${fleetClaudePath} is present but empty`,
        fix: "Remove the empty file and run `switchroom apply` to re-seed it.",
      });
    } else if (onDisk === renderFleetDefaultsClaudeMd()) {
      results.push({
        name: "cascade L2: fleet defaults",
        status: "warn",
        detail:
          "identical to the shipped default — the operator has not personalised the fleet brain yet (add household facts / fleet conventions here)",
      });
    } else {
      const tag = onDisk.match(FLEET_DEFAULTS_VERSION_TAG)?.[1];
      if (!tag) {
        results.push({
          name: "cascade L2: fleet defaults",
          status: "warn",
          detail: "personalised, but the machine-readable version tag is missing from the header",
        });
      } else if (tag !== d.currentVersion) {
        results.push({
          name: "cascade L2: fleet defaults",
          status: "warn",
          detail: `personalised, but the header version tag (${tag}) is older than the current release (${d.currentVersion}) — a newer default is available`,
          fix: "Once `switchroom apply --refresh-fleet-defaults` (#1859) ships, opt in to fold newer defaults into your file.",
        });
      } else {
        results.push({
          name: "cascade L2: fleet defaults",
          status: "ok",
          detail: `personalised, header version tag current (${tag})`,
        });
      }
    }
  }

  // ── Per-agent probes (L3, L4, per-turn, cross-lane) ───────────────
  const agents = Object.keys(config.agents ?? {});
  if (d.agentsDir === undefined) {
    results.push({
      name: "cascade: per-agent probes",
      status: "warn",
      detail: "agents_dir unresolved (no switchroom.agents_dir) — cannot verify per-agent lanes (L3/L4/pacing/--add-dir)",
    });
    return results;
  }

  for (const agent of agents) {
    const agentDir = join(d.agentsDir, agent);
    const claudeMdPath = join(agentDir, "CLAUDE.md");
    const settingsPath = join(agentDir, ".claude", "settings.json");
    const startShPath = join(agentDir, "start.sh");

    const claudeScaffolded = d.existsSync(claudeMdPath);
    const settingsScaffolded = d.existsSync(settingsPath);
    const startScaffolded = d.existsSync(startShPath);
    // Nothing scaffolded yet → apply will do it; stay silent for this agent.
    if (!claudeScaffolded && !settingsScaffolded && !startScaffolded) continue;

    // ---- L3: read the agent CLAUDE.md once ----
    let claudeMd: string | null = null;
    let claudeUnreadable = false;
    if (claudeScaffolded) {
      try {
        claudeMd = d.readFileSync(claudeMdPath);
      } catch (err) {
        claudeUnreadable = isUnreadable(err);
      }
    }

    // L3: marker presence
    if (!claudeScaffolded) {
      // handled by other lanes; skip marker probe
    } else if (claudeUnreadable) {
      results.push({
        name: `cascade L3 ${agent}: Yours marker`,
        status: "skip",
        detail: "CLAUDE.md is agent-UID-owned (0600) — re-run doctor without sudo",
      });
    } else if (claudeMd === null) {
      results.push({
        name: `cascade L3 ${agent}: Yours marker`,
        status: "fail",
        detail: `could not read ${claudeMdPath}`,
      });
    } else if (!claudeMd.includes(CLAUDE_MD_YOURS_MARKER)) {
      results.push({
        name: `cascade L3 ${agent}: Yours marker`,
        status: "fail",
        detail: `${claudeMdPath} is missing the "${CLAUDE_MD_YOURS_MARKER}" marker — the operator deleted it or the scaffold broke; the below-marker operator section is no longer protected across apply`,
        fix: "Run `switchroom agent restart <agent>` (or `switchroom apply`) to re-scaffold the marker.",
      });
    } else {
      results.push({
        name: `cascade L3 ${agent}: Yours marker`,
        status: "ok",
        detail: "marker present",
      });

      // L3: above-marker matches scaffold canonical — INFO only (drift is
      // fine; scaffold rewrites the managed section on next apply).
      const stamp = readStamp(d, agentDir);
      const stampedManaged = (stamp?.["files"] as Record<string, unknown> | undefined)?.["CLAUDE.md"];
      if (typeof stampedManaged === "string") {
        const liveManaged = hashManagedClaudeMd(claudeMd);
        if (liveManaged === stampedManaged) {
          results.push({
            name: `cascade L3 ${agent}: above-marker canonical`,
            status: "ok",
            detail: "managed (above-marker) section matches the last scaffold render",
          });
        } else {
          results.push({
            name: `cascade L3 ${agent}: above-marker canonical`,
            status: "skip",
            detail: "above-marker drift from the last scaffold render — informational only; the next `switchroom apply` rewrites this section",
          });
        }
      }

      // L3: below-marker preserved across last apply. FAIL if the
      // operator-owned section changed since the baseline recorded at apply.
      const baseline = d.belowMarkerBaseline(agentDir);
      if (baseline === null) {
        results.push({
          name: `cascade L3 ${agent}: below-marker preserved`,
          status: "skip",
          detail: "no below-marker baseline recorded yet — will track from the next apply that persists it",
        });
      } else {
        const below = belowMarkerSection(claudeMd) ?? "";
        if (sha256Text(below) === baseline) {
          results.push({
            name: `cascade L3 ${agent}: below-marker preserved`,
            status: "ok",
            detail: "operator-owned below-marker section unchanged since last apply",
          });
        } else {
          results.push({
            name: `cascade L3 ${agent}: below-marker preserved`,
            status: "fail",
            detail: `the operator-owned below-marker section of ${claudeMdPath} changed since the last apply — scaffold must NEVER touch below-marker content; this signals a scaffold bug or an out-of-band edit`,
            fix: "Diff against the last apply; if scaffold rewrote it that is a bug (#1858).",
          });
        }
      }

      // Cross-lane: Telegram 5-beats must NOT be re-inlined here.
      if (claudeMd.includes(TELEGRAM_PACING_SIGNATURE)) {
        results.push({
          name: `cascade ${agent}: no pacing duplication`,
          status: "fail",
          detail: `${claudeMdPath} contains the Telegram 5-beats pacing block ("${TELEGRAM_PACING_SIGNATURE}") — that lives in L1 fleet invariants now; re-inlining it double-loads the pacing partial`,
          fix: "Remove the pacing block from the per-agent CLAUDE.md; it is delivered once via ~/.switchroom/fleet/switchroom-invariants.md.",
        });
      } else {
        results.push({
          name: `cascade ${agent}: no pacing duplication`,
          status: "ok",
          detail: "Telegram pacing not re-inlined (delivered once via L1)",
        });
      }
    }

    // ---- L4 + per-turn: settings.json hooks ----
    if (settingsScaffolded) {
      let settings: { hooks?: Record<string, unknown> } | null = null;
      let settingsUnreadable = false;
      try {
        settings = JSON.parse(d.readFileSync(settingsPath));
      } catch (err) {
        settingsUnreadable = isUnreadable(err);
      }
      if (settingsUnreadable) {
        results.push({
          name: `cascade L4 ${agent}: repo-context hook`,
          status: "skip",
          detail: "settings.json is agent-UID-owned (0600) — re-run doctor without sudo",
        });
      } else if (settings === null) {
        results.push({
          name: `cascade L4 ${agent}: repo-context hook`,
          status: "fail",
          detail: `could not parse ${settingsPath}`,
        });
      } else {
        const hookCommands = collectHookCommands(settings.hooks, "PreToolUse");
        const promptCommands = collectHookCommands(settings.hooks, "UserPromptSubmit");

        if (hookCommands.some((c) => c.includes(REPO_CONTEXT_HOOK_MARKER))) {
          results.push({
            name: `cascade L4 ${agent}: repo-context hook`,
            status: "ok",
            detail: "repo-context-pretool PreToolUse hook wired",
          });
        } else {
          results.push({
            name: `cascade L4 ${agent}: repo-context hook`,
            status: "fail",
            detail: `${settingsPath} PreToolUse hooks are missing the repo-context-pretool hook — foreign-repo CLAUDE.md/AGENTS.md will not be injected mid-turn`,
            fix: "Run `switchroom apply` to re-scaffold settings.json hooks.",
          });
        }

        if (promptCommands.some((c) => c.includes(TURN_PACING_HOOK_MARKER))) {
          results.push({
            name: `cascade per-turn ${agent}: pacing hook`,
            status: "ok",
            detail: "turn-pacing UserPromptSubmit hook wired",
          });
        } else {
          results.push({
            name: `cascade per-turn ${agent}: pacing hook`,
            status: "fail",
            detail: `${settingsPath} UserPromptSubmit hooks are missing the turn-pacing hook — the per-turn pacing directive (#1646) will not reassert adjacent to each message`,
            fix: "Run `switchroom apply` to re-scaffold settings.json hooks.",
          });
        }
      }
    }

    // ---- Cross-lane: --add-dir fleet in the boot invocation ----
    if (startScaffolded) {
      let startSh: string | null = null;
      let startUnreadable = false;
      try {
        startSh = d.readFileSync(startShPath);
      } catch (err) {
        startUnreadable = isUnreadable(err);
      }
      if (startUnreadable) {
        results.push({
          name: `cascade ${agent}: --add-dir fleet`,
          status: "skip",
          detail: "start.sh is agent-UID-owned (0600) — re-run doctor without sudo",
        });
      } else if (startSh === null) {
        results.push({
          name: `cascade ${agent}: --add-dir fleet`,
          status: "fail",
          detail: `could not read ${startShPath}`,
        });
      } else if (startSh.includes("--add-dir")) {
        results.push({
          name: `cascade ${agent}: --add-dir fleet`,
          status: "ok",
          detail: "start.sh extends CLAUDE.md discovery to the fleet dir",
        });
      } else {
        results.push({
          name: `cascade ${agent}: --add-dir fleet`,
          status: "fail",
          detail: `${startShPath} has no --add-dir for the fleet directory — the agent will not discover L1/L2 (~/.switchroom/fleet/*.md)`,
          fix: "Run `switchroom apply` to re-render start.sh with the fleet --add-dir.",
        });
      }
    }
  }

  return results;
}

/**
 * Flatten every `command` string under `hooks[event][].hooks[]`. Claude
 * Code's settings.json shape is
 * `{ hooks: { <Event>: [ { matcher?, hooks: [ { command } ] } ] } }`.
 */
function collectHookCommands(
  hooks: Record<string, unknown> | undefined,
  event: string,
): string[] {
  const out: string[] = [];
  const groups = hooks?.[event];
  if (!Array.isArray(groups)) return out;
  for (const group of groups) {
    const inner = (group as { hooks?: unknown })?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      const cmd = (h as { command?: unknown })?.command;
      if (typeof cmd === "string") out.push(cmd);
    }
  }
  return out;
}
