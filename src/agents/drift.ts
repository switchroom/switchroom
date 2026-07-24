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
import { VERSION } from "../build-info.js";
import { buildSettingsHooksBlock, detectHooksDrift } from "./scaffold.js";
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
