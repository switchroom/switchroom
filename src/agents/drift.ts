/**
 * Fleet-wide generated-surface drift detection (KEN-130, stage 2 of
 * KEN-128).
 *
 * Host-side detectors that compare each generated/synced surface against
 * what a fresh render of the current config + installed switchroom would
 * produce. Hash comparison throughout — nothing here writes to a managed
 * surface. Surfaces covered:
 *
 *   1. compose        — deployed docker-compose.yml vs a fresh
 *                       `computeComposeContent` render (byte compare).
 *   2. hooks          — settings.json hooks block vs
 *                       `buildSettingsHooksBlock` (via `detectHooksDrift`).
 *   3. templates      — start.sh + managed CLAUDE.md section vs the
 *                       generation stamp written at last reconcile, plus
 *                       config/version staleness (generation-stamp.ts).
 *   4. skills         — `.claude/skills` entries vs the host bundled pool
 *                       + `skills.d` overlay declarations.
 *   5. mcp            — .mcp.json vs the generation stamp (same mechanism
 *                       as templates; yaml drift is caught by configHash).
 *   6. hook-scripts   — /opt/switchroom/bin/*.sh inside the running
 *                       container vs the installed repo's bin/*.sh.
 *
 * Consumers: `switchroom doctor` (src/cli/doctor-drift.ts) and, via the
 * per-agent report file this module writes, the gateway boot-card probe
 * (telegram-plugin/gateway/boot-probes.ts probeDrift).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import {
  resolveAgentConfig,
  usesSwitchroomTelegramPlugin,
} from "../config/merge.js";
import { isHindsightEnabled } from "../memory/hindsight.js";
import {
  resolveHindsightRecallTunables,
  resolveHindsightRecallCaps,
  readHooksRecallTimeout,
  readHooksPrefetchAsyncTimeout,
  validatePrefetchAsyncTimeout,
  type RecallTunableInput,
  type RecallCapInput,
} from "../setup/hindsight-recall-tunables.js";
import { VERSION } from "../build-info.js";
import {
  buildSettingsHooksBlock,
  detectHooksDrift,
  resolveHindsightVendorResolution,
} from "./scaffold.js";
import { containerName } from "./lifecycle.js";
import { computeConfigHash, detectStampDrift } from "./generation-stamp.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriftFinding {
  /** Named surface class (compose | hooks | start.sh | CLAUDE.md | .mcp.json
   *  | config | version | skills | hook-scripts). */
  surface: string;
  /** Agent slug when the finding is per-agent; absent for fleet surfaces. */
  agent?: string;
  detail: string;
  fix?: string;
}

// ─── Surface 1: compose ─────────────────────────────────────────────────────

/**
 * Compare the deployed compose file against a fresh render of the current
 * config. The render is injected so doctor can pass the real
 * `computeComposeContent` while tests inject a stub (the real one touches
 * vault/broker state).
 *
 * A missing deployed compose is NOT drift (apply never ran); a render
 * error yields no finding (doctor surfaces render errors elsewhere).
 */
export async function detectComposeDrift(opts: {
  compute: () => Promise<{
    content: string;
    previous: string | null;
    imageTag: string;
    previousImageTag: string | null;
  }>;
}): Promise<DriftFinding[]> {
  let result;
  try {
    result = await opts.compute();
  } catch {
    return [];
  }
  if (result.previous === null) return [];
  if (result.content === result.previous) return [];
  // A deployed compose containing a `build:` block was rendered with
  // `switchroom apply --build-local` (emitImageOrBuild emits `image:`
  // in pull mode, `build:` in local mode — never both for the same
  // service). A fresh default render here uses pull mode, so a byte
  // compare would flag EVERY locally-built fleet as drifted forever.
  // Not checkable from here → silently skip (false-positive avoidance
  // beats coverage for a warn-only signal).
  if (/^\s+build:\s*$/m.test(result.previous) || /^\s+build:\s+\S/m.test(result.previous)) {
    return [];
  }
  const imageNote =
    result.previousImageTag && result.previousImageTag !== result.imageTag
      ? ` (image ${result.previousImageTag} → ${result.imageTag})`
      : "";
  return [
    {
      surface: "compose",
      detail: `deployed docker-compose.yml differs from current config render${imageNote}`,
      fix: "Run `switchroom apply`",
    },
  ];
}

// ─── Surface 2: settings.json hooks ─────────────────────────────────────────

/**
 * Reuses the existing `buildSettingsHooksBlock` + `detectHooksDrift` pair
 * (the same comparison `switchroom agent reconcile --check` runs).
 * `agentConfig` must already be cascade-resolved.
 */
export function detectHooksSurfaceDrift(
  name: string,
  agentConfig: AgentConfig,
  agentDir: string,
  config: SwitchroomConfig,
  configPath: string | undefined,
): DriftFinding[] {
  const hindsightEnabled =
    isHindsightEnabled(config) && agentConfig.memory?.auto_recall !== false;
  const expected = buildSettingsHooksBlock({
    agentName: name,
    agentConfig,
    hindsightEnabled,
    useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
    configPath,
  });

  const settingsPath = join(agentDir, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return [
      {
        surface: "hooks",
        agent: name,
        detail: ".claude/settings.json missing",
        fix: `Run \`switchroom agent reconcile ${name}\``,
      },
    ];
  }
  let actual: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    actual = (raw.hooks as Record<string, unknown>) ?? {};
  } catch {
    return [
      {
        surface: "hooks",
        agent: name,
        detail: ".claude/settings.json unparseable",
        fix: `Run \`switchroom agent reconcile ${name}\``,
      },
    ];
  }
  const { drifted, summary } = detectHooksDrift(expected, actual);
  if (!drifted) return [];
  return [
    {
      surface: "hooks",
      agent: name,
      detail: `settings.json hooks ${summary}`,
      fix: `Run \`switchroom agent reconcile ${name} --restart\``,
    },
  ];
}

// ─── Surfaces 3 + 5: template stamp (start.sh, CLAUDE.md, .mcp.json) ────────

/**
 * Hash-compare the deployed generated files against the generation stamp
 * (see generation-stamp.ts), plus config-hash and version staleness.
 * No stamp yet → no findings (fresh agent / pre-KEN-130; the stamp
 * appears on the next `switchroom apply`).
 */
export function detectTemplateStampDrift(
  name: string,
  agentConfig: AgentConfig,
  agentDir: string,
  opts: { currentVersion?: string } = {},
): DriftFinding[] {
  const result = detectStampDrift(agentDir, {
    currentConfigHash: computeConfigHash(agentConfig),
    currentVersion: opts.currentVersion ?? VERSION,
  });
  if (!result.hasStamp) return [];
  return result.findings.map((f) => ({
    surface: f.surface,
    agent: name,
    detail: f.detail,
    fix: `Run \`switchroom apply\` (or \`switchroom agent reconcile ${name} --restart\`)`,
  }));
}

// ─── Surface 4: skills sync ─────────────────────────────────────────────────

const BUNDLED_POOL_SEGMENT = "/.switchroom/skills/_bundled/";

/**
 * Check the agent's `.claude/skills` tree against the host bundled pool
 * and the agent's `skills.d` overlay declarations:
 *
 *   - a skills entry whose symlink target no longer exists (dangling —
 *     the pool skill was removed or renamed);
 *   - an overlay-declared slug (`skills.d/<slug>.yaml`) with no live
 *     entry under `.claude/skills/<slug>` (install never reconciled).
 */
export function detectSkillsDrift(name: string, agentDir: string): DriftFinding[] {
  const findings: DriftFinding[] = [];
  const skillsDir = join(agentDir, ".claude", "skills");

  const liveEntries = new Set<string>();
  if (existsSync(skillsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(skillsDir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const p = join(skillsDir, entry);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = readlinkSync(p);
        } catch {
          /* unreadable link */
        }
        const resolved =
          target === null
            ? null
            : isAbsolute(target)
              ? target
              : resolve(dirname(p), target);
        if (resolved === null || !existsSync(resolved)) {
          const poolNote =
            resolved && resolved.includes(BUNDLED_POOL_SEGMENT)
              ? " (bundled pool target removed)"
              : "";
          findings.push({
            surface: "skills",
            agent: name,
            detail: `skill \`${entry}\` is a dangling symlink${poolNote}`,
            fix: `Run \`switchroom agent reconcile ${name}\` or remove the entry`,
          });
          continue;
        }
      }
      liveEntries.add(entry);
    }
  }

  // Overlay-declared skills must have a live entry.
  const overlayDir = join(agentDir, "skills.d");
  if (existsSync(overlayDir)) {
    let overlayEntries: string[] = [];
    try {
      overlayEntries = readdirSync(overlayDir);
    } catch {
      overlayEntries = [];
    }
    for (const f of overlayEntries) {
      const m = /^(.+)\.ya?ml$/i.exec(f);
      if (!m) continue;
      if (!liveEntries.has(m[1])) {
        findings.push({
          surface: "skills",
          agent: name,
          detail: `overlay skill \`${m[1]}\` declared in skills.d but not installed under .claude/skills`,
          fix: `Run \`switchroom agent reconcile ${name}\``,
        });
      }
    }
  }

  return findings;
}

// ─── Surface 6: hook scripts baked into the agent image ─────────────────────

export type ExecImpl = (cmd: string, args: string[]) => string;

const defaultExec: ExecImpl = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });

/** Walk up from this module to the install root containing `bin/`. */
export function locateInstallBinDir(): string | null {
  let dir: string | undefined = import.meta.dirname;
  for (let i = 0; i < 10 && dir && dir !== "/"; i++) {
    if (existsSync(join(dir, "dependencies.json")) && existsSync(join(dir, "bin"))) {
      return join(dir, "bin");
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Compare the hook scripts baked into the agent image
 * (`/opt/switchroom/bin/*.sh`, COPY'd from repo `bin/*.sh` at image
 * build) against the installed repo's `bin/*.sh`. Deployed side is read
 * via `docker exec` on the running container; when docker / the
 * container / the install bin dir is unavailable the check silently
 * yields no findings (doctor's docker section owns those failures).
 */
export function detectHookScriptDrift(
  name: string,
  opts: { binDir?: string; execImpl?: ExecImpl } = {},
): DriftFinding[] {
  const binDir = opts.binDir ?? locateInstallBinDir();
  if (!binDir || !existsSync(binDir)) return [];
  const exec = opts.execImpl ?? defaultExec;

  const expected = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(binDir).filter((f) => f.endsWith(".sh"));
  } catch {
    return [];
  }
  for (const f of names) {
    try {
      // Hash the RAW bytes — the container side is `sha256sum` (byte
      // hash). A utf-8 decode/re-encode round-trip would corrupt any
      // non-UTF8 byte and read as permanent phantom drift.
      expected.set(
        f,
        createHash("sha256").update(readFileSync(join(binDir, f))).digest("hex"),
      );
    } catch {
      /* unreadable local script — skip */
    }
  }
  if (expected.size === 0) return [];

  let out: string;
  try {
    out = exec("docker", [
      "exec",
      containerName(name),
      "sh",
      "-c",
      "sha256sum /opt/switchroom/bin/*.sh 2>/dev/null",
    ]);
  } catch {
    return []; // docker unavailable / container not running — not checkable
  }

  const deployed = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{64})\s+(?:\*)?(.+)$/.exec(line.trim());
    if (!m) continue;
    const base = m[2].split("/").pop();
    if (base) deployed.set(base, m[1]);
  }
  if (deployed.size === 0) return []; // exec gave nothing useful — skip

  const drifted: string[] = [];
  for (const [file, hash] of expected) {
    const dep = deployed.get(file);
    if (dep === undefined || dep !== hash) drifted.push(file);
  }
  if (drifted.length === 0) return [];
  return [
    {
      surface: "hook-scripts",
      agent: name,
      detail: `image hook script(s) differ from installed version: ${drifted.sort().join(", ")}`,
      fix: "Run `switchroom update` (rebuild/pull the agent image), then restart the agent",
    },
  ];
}

// ─── Surface 7: hindsight recall tunables ───────────────────────────────────

/**
 * Compare the INSTALLED hindsight plugin's effective recall-latency tunables
 * against what the current `switchroom.yaml` says they should be.
 *
 * This surface exists because these values have silently reverted three times.
 * They live inside the plugin tree that `switchroom apply` rm's and re-copies
 * from `vendor/`, so before they were promoted to managed keys (see
 * src/setup/hindsight-recall-tunables.ts) the only way to set them was a
 * hand-edit that the next apply threw away. Making them declarative stops the
 * revert; THIS row is what makes a revert impossible to miss if the stamping
 * ever regresses — a missing stamp reads as an explicit FAIL rather than as
 * "memory feels a bit worse lately".
 *
 * Deliberately compares EFFECTIVE VALUES, not file hashes. A hash compare
 * would also fire on any unrelated vendor bump, which is noise; the question
 * this row answers is narrowly "is the number the operator configured the
 * number the plugin will actually use".
 */
export function detectHindsightRecallTunableDrift(
  name: string,
  agentConfig: AgentConfig,
  agentDir: string,
  config: SwitchroomConfig,
): DriftFinding[] {
  if (!isHindsightEnabled(config)) return [];

  // Cascade defaults -> profile -> agent BEFORE reading anything. doctor-drift
  // hands us the RAW `config.agents[name]` (src/cli/doctor-drift.ts:100),
  // whereas the scaffold stamps from the CASCADED config
  // (resolveHindsightRecallConfig). Reading the raw block here would report
  // hard drift on every agent the moment the fleet sets these keys at the
  // `defaults:` or profile tier — which is the likeliest place to set them.
  const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);

  // Mirrors installHindsightPlugin's own early-out: an agent with auto-recall
  // off has no plugin to stamp, so there is nothing to drift.
  if (resolved.memory?.auto_recall === false) return [];

  const pluginDir = join(agentDir, ".claude", "plugins", "hindsight-memory");
  // Plugin not installed at all — that is a different failure (and a noisy one
  // to duplicate here); apply/reconcile surfaces it directly.
  if (!existsSync(pluginDir)) return [];

  const expected = resolveHindsightRecallTunables(
    resolved.memory?.recall as RecallTunableInput | undefined,
  );
  // Count + token caps resolved from the SAME cascade as the stamp
  // (resolveHindsightRecallCaps) — recallMaxMemories drifted silently for months
  // as a hardcoded 8 while start.sh exported the operator's value, and
  // recallMaxTokens was never stamped at all, so this row is the doctor-side
  // guard that a future stamp regression can't hide behind the env export.
  const expectedCaps = resolveHindsightRecallCaps(
    resolved.memory?.recall as RecallCapInput | undefined,
  );

  const findings: DriftFinding[] = [];
  const mismatches: string[] = [];

  // Hook ceiling — stamped into hooks/hooks.json.
  const hooksPath = join(pluginDir, "hooks", "hooks.json");
  if (existsSync(hooksPath)) {
    let installedHookTimeout: number | null = null;
    try {
      installedHookTimeout = readHooksRecallTimeout(readFileSync(hooksPath, "utf-8"));
    } catch {
      installedHookTimeout = null;
    }
    if (installedHookTimeout === null) {
      mismatches.push(
        "hooks/hooks.json has no readable UserPromptSubmit recall-hook timeout",
      );
    } else if (installedHookTimeout !== expected.hookTimeoutSeconds) {
      mismatches.push(
        `hook ceiling is ${installedHookTimeout}s, expected ` +
          `${expected.hookTimeoutSeconds}s (memory.recall.hook_timeout_seconds)`,
      );
    }
  }

  // Parallel deadline + per-bank timeout — stamped into settings.json.
  const settingsPath = join(pluginDir, "settings.json");
  if (existsSync(settingsPath)) {
    let settings: Record<string, unknown> | null = null;
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch {
      settings = null;
    }
    if (settings === null) {
      mismatches.push("settings.json is unreadable or malformed");
    } else {
      const checks: Array<[string, string, number]> = [
        [
          "recallParallelDeadlineSeconds",
          "memory.recall.parallel_deadline_seconds",
          expected.parallelDeadlineSeconds,
        ],
        [
          "recallRequestTimeoutSeconds",
          "memory.recall.request_timeout_seconds",
          expected.requestTimeoutSeconds,
        ],
        [
          "recallMaxMemories",
          "memory.recall.max_memories",
          expectedCaps.maxMemories,
        ],
        [
          "recallMaxTokens",
          "memory.recall.max_tokens",
          expectedCaps.maxTokens,
        ],
      ];
      for (const [key, yamlKey, want] of checks) {
        const got = settings[key];
        if (got === undefined) {
          mismatches.push(`settings.json is missing \`${key}\` (expected ${want})`);
        } else if (got !== want) {
          mismatches.push(
            `\`${key}\` is ${JSON.stringify(got)}, expected ${want} (${yamlKey})`,
          );
        }
      }
    }
  }

  if (mismatches.length > 0) {
    findings.push({
      surface: "memory-tunables",
      agent: name,
      detail:
        `installed hindsight plugin disagrees with switchroom.yaml: ` +
        mismatches.join("; "),
      fix:
        "Run `switchroom apply` to re-stamp the plugin, then restart the agent " +
        "(`switchroom agent restart <name>`). If it recurs immediately after an " +
        "apply, the stamping in installHindsightPlugin has regressed — these " +
        "values have silently reverted three times before, which is why this " +
        "check exists.",
    });
  }

  // A clamped value is not drift (the stamp matches what we resolved), but the
  // operator wrote a number that is NOT what runs. Say so rather than letting
  // it look applied.
  if (expected.clamps.length > 0) {
    findings.push({
      surface: "memory-tunables",
      agent: name,
      detail: `recall tunable clamped: ${expected.clamps.join("; ")}`,
      fix:
        "Adjust the offending `memory.recall.*` value in switchroom.yaml so the " +
        "nested deadlines hold (per-bank timeout <= parallel deadline <= hook " +
        "ceiling), or raise the outer bound.",
    });
  }

  return findings;
}

/**
 * M4 deviation-5 — async prefetch timeout doctor check.
 *
 * The async recall-prefetch producer runs as a `Stop` hook (`prefetch.py`,
 * `"async": true`, `"timeout": 20`). A misconfigured async ceiling is the
 * "wedged 20s-timeout prefetch" the M4 hardening carve names: a prefetch that
 * is not async blocks the turn; one with no/too-large a ceiling is never
 * reaped; one whose ceiling sits under its own recall timeout gets SIGKILLed
 * mid buffer-write and leaves a torn buffer.
 *
 * PRE-FLIP / DARK BY DEFAULT: the whole async-prefetch mechanism is inert
 * until an agent flips `memoryPrefetchEnabled` on in its deployed settings.json
 * (there is no fleet default and no yaml channel yet). This check reads that
 * deployed flag and returns NO findings while it is off — so it is a complete
 * no-op on today's fleet, exactly like the runtime path it guards. It only
 * fires once an agent has actually enabled prefetch AND its async-timeout
 * config is unsafe.
 */
export function detectPrefetchAsyncTimeoutDrift(
  name: string,
  agentConfig: AgentConfig,
  agentDir: string,
  config: SwitchroomConfig,
): DriftFinding[] {
  if (!isHindsightEnabled(config)) return [];

  const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
  if (resolved.memory?.auto_recall === false) return [];

  const pluginDir = join(agentDir, ".claude", "plugins", "hindsight-memory");
  if (!existsSync(pluginDir)) return [];

  const settingsPath = join(pluginDir, "settings.json");
  if (!existsSync(settingsPath)) return [];
  let settings: Record<string, unknown> | null = null;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return []; // the recall-tunable drift row owns settings.json malformed
  }
  // Dark-by-default gate: nothing to validate unless prefetch is actually on
  // for this agent. This is what keeps the check inert pre-flip.
  if (settings?.memoryPrefetchEnabled !== true) return [];

  const hooksPath = join(pluginDir, "hooks", "hooks.json");
  if (!existsSync(hooksPath)) return []; // absence is the hooks drift row's job

  let shape;
  try {
    shape = readHooksPrefetchAsyncTimeout(readFileSync(hooksPath, "utf-8"));
  } catch {
    return [];
  }

  // The producer's own recall HTTP timeout (prefetch.py:
  // config.get("memoryPrefetchTimeoutSeconds", 5)). Must fit UNDER the async
  // hook ceiling so the producer can't outlive its own hook.
  const rawPrefetchTimeout = settings.memoryPrefetchTimeoutSeconds;
  const prefetchRecallTimeout =
    typeof rawPrefetchTimeout === "number" && Number.isFinite(rawPrefetchTimeout) && rawPrefetchTimeout > 0
      ? rawPrefetchTimeout
      : 5;

  const problems = validatePrefetchAsyncTimeout(shape, prefetchRecallTimeout);
  if (problems.length === 0) return [];

  return [
    {
      surface: "memory-prefetch",
      agent: name,
      detail:
        `async recall-prefetch (memoryPrefetchEnabled) is ON but its async-timeout ` +
        `config is unsafe: ${problems.join("; ")}`,
      fix:
        "Re-stamp the plugin (`switchroom apply`) so hooks.json carries the " +
        '`prefetch.py` Stop hook with `"async": true` and a timeout above ' +
        "memoryPrefetchTimeoutSeconds, or set memoryPrefetchEnabled off until the " +
        "async ceiling is corrected — a wedged prefetch either blocks the turn or " +
        "is killed mid buffer-write.",
    },
  ];
}

/**
 * Hash every source file under a plugin `scripts/` tree into a
 * `relPath → sha256hex` map. Walks recursively (so `scripts/lib/` is
 * included) and skips build/edit exhaust — `__pycache__/`, `*.pyc`, and
 * `*.bak*` — so a stray compiled cache or a hand-edit backup is not itself
 * reported as drift (a stale `recall.py.bak` on the live test-harness tree
 * is exactly the kind of cruft that would otherwise noise the row).
 *
 * Returns null when the root does not exist. Deterministic: the caller does a
 * set/content comparison, not an order-dependent one.
 */
function hashPluginScriptsTree(scriptsRoot: string): Map<string, string> | null {
  if (!existsSync(scriptsRoot)) return null;
  const out = new Map<string, string>();
  const skipDir = (n: string): boolean => n === "__pycache__";
  const skipFile = (n: string): boolean => n.endsWith(".pyc") || n.includes(".bak");
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const childRel = rel === "" ? ent.name : `${rel}/${ent.name}`;
      const childAbs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDir(ent.name)) continue;
        walk(childAbs, childRel);
      } else if (ent.isFile()) {
        if (skipFile(ent.name)) continue;
        try {
          out.set(childRel, createHash("sha256").update(readFileSync(childAbs)).digest("hex"));
        } catch {
          // Unreadable file — record a sentinel so it reads as changed rather
          // than silently matching.
          out.set(childRel, "unreadable");
        }
      }
    }
  };
  walk(scriptsRoot, "");
  return out;
}

/**
 * #4779 — vendored hindsight-memory plugin BUILD drift.
 *
 * The manifest `version` in `.claude-plugin/plugin.json` sat at `0.4.0`
 * across the entire M4/M5 plugin rewrite, so a version-string comparison
 * could not tell a June pre-M4 tree from the shipped build. `test-harness`
 * carried the June tree indefinitely (no `prefetch.py`, no
 * `lib/recall_buffer.py`) while every recall-enabled agent was re-vendored —
 * invisible to every existing check because they all early-out on
 * `auto_recall: false`.
 *
 * This detector closes that hole by HASHING the deployed `scripts/` tree
 * (which contains `scripts/lib/`) against the release vendor build's
 * `scripts/` tree, file by file. It deliberately does NOT gate on
 * `auto_recall` or `isHindsightEnabled`: a divergent plugin tree on disk is
 * drift no matter why it is there. It fires whenever the agent has a plugin
 * tree at all — so after the self-healing vendor fix
 * (`removeVendoredHindsightPlugin`), a recall-off agent has no tree and this
 * is a clean no-op, while a pre-fix or hand-copied stale tree lights up.
 *
 * `settings.json` / `hooks/hooks.json` are intentionally OUT of scope here —
 * they are per-agent stamped (see `detectHindsightRecallTunableDrift`), so
 * they legitimately differ from the vendor and are guarded by their own row.
 * Only the executable `scripts/` code must match the release byte for byte.
 */
export function detectHindsightPluginTreeDrift(
  name: string,
  agentDir: string,
): DriftFinding[] {
  const pluginDir = join(agentDir, ".claude", "plugins", "hindsight-memory");
  // No vendored plugin on disk — nothing to compare. A recall-off agent that
  // apply has self-healed lands here (correctly clean).
  if (!existsSync(pluginDir)) return [];

  const releaseResolution = resolveHindsightVendorResolution();
  if (releaseResolution.path === null) {
    // Release build not resolvable (e.g. probing from an image without the
    // vendor payload). Can't compare; the missing-vendor condition is already
    // surfaced loudly by installHindsightPlugin. Don't invent a finding.
    return [];
  }

  const releaseScripts = join(releaseResolution.path, "scripts");
  const deployedScripts = join(pluginDir, "scripts");

  const releaseHashes = hashPluginScriptsTree(releaseScripts);
  if (releaseHashes === null || releaseHashes.size === 0) {
    // Release build has no scripts/ tree to compare against — anomalous, not
    // an agent-side drift signal.
    return [];
  }
  const deployedHashes = hashPluginScriptsTree(deployedScripts) ?? new Map<string, string>();

  const missing: string[] = []; // in release, absent from the agent
  const changed: string[] = []; // present in both, content differs
  const extra: string[] = []; // in the agent, not in release

  for (const [rel, hash] of releaseHashes) {
    const got = deployedHashes.get(rel);
    if (got === undefined) missing.push(rel);
    else if (got !== hash) changed.push(rel);
  }
  for (const rel of deployedHashes.keys()) {
    if (!releaseHashes.has(rel)) extra.push(rel);
  }

  if (missing.length === 0 && changed.length === 0 && extra.length === 0) {
    return [];
  }

  const parts: string[] = [];
  const summarise = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    const shown = items.slice(0, 6).sort();
    const more = items.length > shown.length ? ` (+${items.length - shown.length} more)` : "";
    parts.push(`${label}: ${shown.join(", ")}${more}`);
  };
  summarise("missing", missing);
  summarise("changed", changed);
  summarise("stale-extra", extra);

  return [
    {
      surface: "memory-plugin-build",
      agent: name,
      detail:
        `vendored hindsight-memory plugin scripts/ tree does NOT match the ` +
        `release build (manifest version is not a reliable signal — it can ` +
        `sit unchanged across builds): ${parts.join("; ")}`,
      fix:
        "Re-vendor the plugin: `switchroom apply` re-copies the release " +
        "`scripts/` tree into this agent (or removes it entirely when the " +
        "agent has memory turned off), then restart the agent " +
        "(`switchroom agent restart " +
        name +
        "`). A tree that keeps drifting after apply means the agent's memory " +
        "config and its on-disk plugin disagree — check memory.backend / " +
        "memory.auto_recall for this agent.",
    },
  ];
}

// ─── Aggregation + per-agent report file (boot-card handoff) ────────────────

/** Basename of the per-agent drift report the boot-card probe reads. */
export const DRIFT_REPORT_FILE = ".switchroom-drift.json";

export interface DriftReport {
  version: 1;
  generatedAt: string;
  findings: Array<Pick<DriftFinding, "surface" | "detail">>;
}

/**
 * Persist the host-side findings for one agent so the in-container
 * boot-card probe can surface them (the container can't render compose
 * or reach the host skills pool itself). ALWAYS written — an empty
 * findings array is how a previously-drifted agent reads clean again.
 * Best-effort: report IO must never fail a doctor run.
 */
export function writeDriftReport(agentDir: string, findings: DriftFinding[]): void {
  try {
    const report: DriftReport = {
      version: 1,
      generatedAt: new Date().toISOString(),
      findings: findings.map(({ surface, detail }) => ({ surface, detail })),
    };
    writeFileSync(
      join(agentDir, DRIFT_REPORT_FILE),
      JSON.stringify(report, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Run every per-agent detector (surfaces 2-6) for one agent. The raw
 * (unresolved) agent config is cascade-resolved here so callers pass
 * `config.agents[name]` directly.
 */
export function detectAgentDrift(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  config: SwitchroomConfig,
  configPath: string | undefined,
  opts: {
    execImpl?: ExecImpl;
    binDir?: string;
    currentVersion?: string;
    /** Skip the docker-exec hook-script probe (doctor --fast). */
    skipContainerProbes?: boolean;
  } = {},
): DriftFinding[] {
  const agentDir = resolve(agentsDir, name);
  if (!existsSync(agentDir)) return [];
  const agentConfig = resolveAgentConfig(
    config.defaults,
    config.profiles,
    agentConfigRaw,
  );
  const findings: DriftFinding[] = [];
  findings.push(
    ...detectHooksSurfaceDrift(name, agentConfig, agentDir, config, configPath),
  );
  findings.push(
    ...detectTemplateStampDrift(name, agentConfig, agentDir, {
      currentVersion: opts.currentVersion,
    }),
  );
  findings.push(...detectSkillsDrift(name, agentDir));
  findings.push(
    ...detectHindsightRecallTunableDrift(name, agentConfig, agentDir, config),
  );
  findings.push(
    ...detectPrefetchAsyncTimeoutDrift(name, agentConfig, agentDir, config),
  );
  // #4779 — plugin BUILD drift (hash of scripts/ vs the release vendor tree).
  // Deliberately NOT gated on auto_recall: a stale/divergent tree on disk is
  // drift regardless of whether the agent has memory enabled, and that gating
  // is exactly why the earlier rows missed test-harness's frozen pre-M4 tree.
  findings.push(...detectHindsightPluginTreeDrift(name, agentDir));
  if (!opts.skipContainerProbes) {
    findings.push(
      ...detectHookScriptDrift(name, {
        binDir: opts.binDir,
        execImpl: opts.execImpl,
      }),
    );
  }
  return findings;
}
