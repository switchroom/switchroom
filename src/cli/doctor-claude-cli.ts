/**
 * doctor section: the claude CLI each agent container is ACTUALLY running,
 * versus the floor switchroom's own reasoning depends on (#1978).
 *
 * ── Why this exists ────────────────────────────────────────────────────
 * `isAdaptiveThinkingOpus()` (`src/config/thinking-effort-risk.ts`) was
 * narrowed to `claude-opus-4*` only. The bare `opus` alias and every
 * `claude-opus-5*` id were deliberately dropped, on the reasoning that the
 * interleaved-streaming merge bug behind
 *
 *   400 messages.N.content.M: 'thinking' or 'redacted_thinking' blocks in
 *   the latest assistant message cannot be modified
 *
 * was fixed upstream in claude-code 2.1.156 and `docker/Dockerfile.base`
 * pins well past it. That reasoning is sound **only while the CLI the
 * container is executing is genuinely >= 2.1.156**. An agent on a stale
 * image (or with a shadow install) running `model: opus` /
 * `claude-opus-5` at `thinking_effort: medium` or above is exposed, and
 * the config-time guard is — correctly — silent about it. This section is
 * the part that can only be answered by looking.
 *
 * ── What it observes, and what it does not ─────────────────────────────
 * It does NOT read the Dockerfile pin and call that an answer. A pin tells
 * you what a freshly built image WOULD contain; it says nothing about a
 * container that has been up for weeks on an older image. So the probe
 * runs `claude --version` INSIDE each running container, resolving the
 * binary through the same PATH prefix `start.sh` exports
 * (`$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH`) so that a
 * user-local shadow install is reported as what it is — the exact failure
 * mode start.sh's prune loop exists for, after it bit test-harness with a
 * months-old self-installed 2.1.139 (`profiles/_base/start.sh.hbs`, "a
 * stray `claude` in the writable, state-persisted npm prefix would
 * silently SHADOW the image's").
 *
 * The Dockerfile pin is used for ONE thing: telling the operator what a
 * restart would move them to. It is read from `docker/Dockerfile.base`
 * (`ARG CLAUDE_CODE_VERSION`), never hardcoded here.
 *
 * Degrade-not-fail: docker missing, container down, exec timeout, or an
 * unparseable banner → `skip` with the reason, never `fail`. A container
 * we could not reach is not evidence of anything.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CheckStatus } from "./doctor-status.js";
import { resolveAgentConfig } from "../config/merge.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  CLAUDE_CLI_THINKING_MERGE_FIX_VERSION,
  emitsAdaptiveThinking,
  isRiskyThinkingEffort,
} from "../config/thinking-effort-risk.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

// ─── version parsing / comparison ──────────────────────────────────────

/**
 * Parse `2.1.219 (Claude Code)` (the banner `claude --version` prints) into
 * a comparable tuple. Returns null when the string is not a leading
 * dotted-numeric version — an unrecognised banner must read as "unknown",
 * never as "0.0.0", or a CLI whose output format changes would be reported
 * as catastrophically stale.
 *
 * @internal exported for testing
 */
export function parseClaudeCliVersion(raw: string): number[] | null {
  const m = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True when `raw` parses to a version >= `floor`. Returns null when either
 * side is unparseable (caller decides how to report "unknown").
 *
 * @internal exported for testing
 */
export function claudeCliMeetsFloor(
  raw: string,
  floor: string,
): boolean | null {
  const got = parseClaudeCliVersion(raw);
  const want = parseClaudeCliVersion(floor);
  if (!got || !want) return null;
  for (let i = 0; i < 3; i++) {
    if (got[i] > want[i]) return true;
    if (got[i] < want[i]) return false;
  }
  return true;
}

// ─── the pinned version (context only, never the verdict) ──────────────

/**
 * Walk up from this module looking for a repo-relative file. Mirrors
 * `locateManifestPath()` in `src/manifest.ts` so a git checkout resolves
 * and an npm-only install cleanly does not.
 */
function locateRepoFile(relative: string): string | null {
  let dir: string | undefined = import.meta.dirname;
  for (let i = 0; i < 10 && dir && dir !== "/"; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Read the production claude-CLI pin out of `docker/Dockerfile.base`.
 *
 * That ARG is the source of truth for what a freshly built image contains
 * — `.github/workflows/ci-claude-latest-canary.yml` extracts it with the
 * same pattern. Returns null when the file is absent (npm install without
 * the repo), in which case the remediation text simply omits the target
 * version rather than inventing one.
 *
 * @internal exported for testing
 */
export function readPinnedClaudeCliVersion(
  dockerfilePath?: string | null,
): string | null {
  const path =
    dockerfilePath === undefined
      ? locateRepoFile(join("docker", "Dockerfile.base"))
      : dockerfilePath;
  if (!path) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const m = text.match(/^\s*ARG\s+CLAUDE_CODE_VERSION=([0-9][0-9.]*)\s*$/m);
  return m ? m[1] : null;
}

// ─── the in-container probe ────────────────────────────────────────────

export type ClaudeCliProbe =
  /** Reached the container and read a version banner. */
  | { state: "read"; bin: string; raw: string }
  /** Reached the container; no `claude` resolved on the session PATH. */
  | { state: "missing" }
  /** Could not reach the container (docker absent, down, timeout, denied). */
  | { state: "unreachable"; msg: string };

/**
 * The `sh -c` one-liner run inside an agent container.
 *
 * Split out and exported so the SHELL is testable without a container
 * (the `buildPendingRetainsProbeScript` precedent in `doctor.ts`). The
 * PATH prefix is not decoration: `start.sh` puts the persistent-HOME bin
 * dirs AHEAD of `/usr/local/bin`, so resolving `claude` with the image's
 * bare PATH would report the image binary even when a shadow install is
 * what the agent's session actually executes.
 *
 * @internal exported for testing
 */
export function buildClaudeCliProbeScript(): string {
  return (
    'P="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"; ' +
    'B=$(PATH="$P" command -v claude 2>/dev/null); ' +
    'if [ -z "$B" ]; then echo "BIN= VER="; exit 0; fi; ' +
    'V=$("$B" --version 2>/dev/null | head -n1 | cut -d" " -f1); ' +
    'echo "BIN=$B VER=$V"'
  );
}

/**
 * Parse the probe one-liner's result into a `ClaudeCliProbe`.
 *
 * Kept pure (takes a plain `{status, stdout}` record) so every branch is
 * driveable from synthetic input. A non-zero/absent exit status is
 * `unreachable`, NOT `missing`: exit >= 125 is docker itself failing
 * (no such container, daemon down) and a null status is the timeout.
 *
 * @internal exported for testing
 */
export function parseClaudeCliProbeOutput(r: {
  error?: Error;
  status: number | null;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}): ClaudeCliProbe {
  if (r.error || r.status !== 0) {
    const stderr = (r.stderr?.toString() ?? "").trim();
    const msg =
      r.error?.message ??
      (stderr !== "" ? stderr : `docker exec exited ${r.status ?? "on timeout"}`);
    return { state: "unreachable", msg };
  }
  const out = (r.stdout?.toString() ?? "").trim();
  const bin = out.match(/BIN=(\S*)/)?.[1] ?? "";
  const raw = out.match(/VER=(\S*)/)?.[1] ?? "";
  if (bin === "") return { state: "missing" };
  if (raw === "") {
    return { state: "unreachable", msg: `\`${bin} --version\` produced no output` };
  }
  return { state: "read", bin, raw };
}

/**
 * Real probe: one `docker exec` per agent (~300ms), 3s ceiling — matching
 * `probePendingRetainsQueue`'s budget in `doctor.ts`. `agentName` is passed
 * as an argv element, never through a shell, so a config-supplied name can
 * never be interpreted as shell syntax; the script itself is a constant.
 * A down container / absent docker fails fast (exec error), not on timeout.
 */
function probeAgentClaudeCli(agentName: string): ClaudeCliProbe {
  const r = spawnSync(
    "docker",
    ["exec", `switchroom-${agentName}`, "sh", "-c", buildClaudeCliProbeScript()],
    { stdio: "pipe", timeout: 3000 },
  );
  return parseClaudeCliProbeOutput(r);
}

// ─── verdict ───────────────────────────────────────────────────────────

export interface ClaudeCliFloorInput {
  agentName: string;
  probe: ClaudeCliProbe;
  /**
   * True when this agent's resolved model emits adaptive thinking AND its
   * resolved effort is above the `low` floor — i.e. the shape #1978 hit,
   * and the shape the narrowed config-time guard no longer covers.
   */
  exposed: boolean;
  /** From `docker/Dockerfile.base`; null when the repo is not present. */
  pinned: string | null;
  /** Defaults to the shared #1978 fix version. */
  floor?: string;
}

/**
 * Turn one probe into the operator-visible row. Pure — this is what the
 * tests assert, not the shell or the docker call.
 *
 * `warn`, never `fail`: a stale CLI is a latent exposure remediable by a
 * restart, and this section must not flip doctor's exit code on the
 * strength of a version banner. `skip` for anything we could not observe.
 *
 * @internal exported for testing
 */
export function assessClaudeCliFloor(input: ClaudeCliFloorInput): CheckResult {
  const { agentName, probe, exposed, pinned } = input;
  const floor = input.floor ?? CLAUDE_CLI_THINKING_MERGE_FIX_VERSION;
  const name = `${agentName}: claude CLI floor`;

  const restart =
    `Restart the agent onto the current image: \`switchroom update\` then ` +
    `\`switchroom agent restart ${agentName} --force\`` +
    (pinned ? ` (docker/Dockerfile.base pins ${pinned})` : "") +
    `.`;

  if (probe.state === "unreachable") {
    return {
      name,
      status: "skip",
      detail: `could not read the running claude CLI in switchroom-${agentName}: ${probe.msg}`,
    };
  }

  if (probe.state === "missing") {
    return {
      name,
      status: "warn",
      detail: `no \`claude\` on the session PATH inside switchroom-${agentName}`,
      fix: restart,
    };
  }

  const meets = claudeCliMeetsFloor(probe.raw, floor);
  if (meets === null) {
    return {
      name,
      status: "skip",
      detail: `unparseable version from ${probe.bin}: ${probe.raw}`,
    };
  }

  if (meets) {
    return {
      name,
      status: "ok",
      detail: `${probe.raw} at ${probe.bin} (>= ${floor} floor)`,
    };
  }

  const exposure = exposed
    ? ` This agent's model and thinking_effort are in the #1978 exposure shape, ` +
      `which the config-time guard no longer covers on the assumption of a ` +
      `>= ${floor} CLI.`
    : ` This agent's model and thinking_effort are not in the #1978 exposure shape.`;

  return {
    name,
    status: "warn",
    detail:
      `${probe.raw} at ${probe.bin} is BELOW the ${floor} floor — ` +
      `the claude-code build that fixed the #1978 thinking-block merge 400.` +
      exposure,
    fix: exposed
      ? `${restart} Until then set \`thinking_effort: low\` for ${agentName}; ` +
        `on a pre-${floor} CLI, medium+ effort on an Opus model can 400 with ` +
        `'thinking blocks cannot be modified' when work runs through concurrent sub-agents.`
      : restart,
  };
}

// ─── section ───────────────────────────────────────────────────────────

export interface ClaudeCliSectionDeps {
  /** --fast / offline: omit the section entirely (it costs a docker exec per agent). */
  fast?: boolean;
  /** Injected for tests; defaults to the real `docker exec` probe. */
  probe?: (agentName: string) => ClaudeCliProbe;
  /**
   * Injected for tests. `undefined` means "discover docker/Dockerfile.base";
   * `null` means "there is no Dockerfile to read".
   */
  dockerfilePath?: string | null;
}

/**
 * One row per configured agent: the claude CLI that container is running,
 * against the #1978 floor.
 */
export function runClaudeCliVersionChecks(
  config: SwitchroomConfig,
  deps: ClaudeCliSectionDeps = {},
): CheckResult[] {
  if (deps.fast) return [];

  const agents = Object.entries(config.agents ?? {});
  if (agents.length === 0) return [];

  const pinned = readPinnedClaudeCliVersion(deps.dockerfilePath);
  const probe = deps.probe ?? probeAgentClaudeCli;

  return agents.map(([agentName, agentConfig]) => {
    const resolved = resolveAgentConfig(
      config.defaults,
      config.profiles,
      agentConfig,
    );
    const exposed =
      emitsAdaptiveThinking(resolved.model) &&
      isRiskyThinkingEffort(resolved.thinking_effort);
    return assessClaudeCliFloor({
      agentName,
      probe: probe(agentName),
      exposed,
      pinned,
    });
  });
}
