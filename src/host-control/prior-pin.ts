/**
 * `prior_pin` derivation — the rollback target, read from the RUNNING
 * fleet rather than from the config file the roll is about to rewrite.
 *
 * WHY THIS EXISTS
 *
 * `rollout` stamps `prior_pin` on its completed terminal audit row so a
 * later `rollout --allow-downgrade` (no `--pin`) can default its target
 * to "the last good version" without the operator having to recall the
 * tag (#2492). The value therefore has exactly one job: name the version
 * the fleet was on BEFORE this roll.
 *
 * The original derivation read `release.pin` out of `switchroom.yaml`.
 * That is the wrong source, because the roll's own `persist-pin` step
 * writes that same field — so the config pin is only "the prior version"
 * when nothing else has already moved it. Anything that sets the pin
 * ahead of the roll (an operator editing the yaml first, a re-run of a
 * roll that already persisted, an `apply` that wrote the target) makes
 * the config pin equal to the TARGET, and `prior_pin` is then recorded
 * as the version being rolled TO. Rollback silently becomes a no-op:
 * `--allow-downgrade` resolves a target identical to the current one and
 * "rolls back" to where it already is.
 *
 * Observed on the operator host, 2026-07-29 (host-control-audit.log):
 *
 *   {"op":"rollout","result":"completed","pin":"v0.19.32",
 *    "prior_pin":"v0.19.32"}
 *
 * while every agent had actually been running v0.19.30.
 *
 * THE FIX IS THE SOURCE, NOT A GUARD.
 *
 * `prior_pin` is derived from the versions the fleet's agent containers
 * are ACTUALLY running at the moment the roll starts — the same
 * enumerative `docker ps` inventory `switchroom update --check`, the
 * doctor's component table, and the roll's own `verify-components` gate
 * read from (`src/cli/component-versions.ts`, `src/cli/component-scope.ts`).
 * A declared intent in a config file cannot disagree with the fleet;
 * the fleet is the fact.
 *
 * TWO INVARIANTS THIS MODULE ENFORCES
 *
 *  1. `prior_pin` is NEVER the target. The target is filtered out of the
 *     candidate set before a value is chosen, so the no-op-rollback
 *     failure mode is structurally unreachable — not merely unlikely.
 *     When every in-scope agent is already on the target there IS no
 *     prior version to name, and we record none (`all-on-target`)
 *     rather than inventing one.
 *
 *  2. A MIXED-version fleet is recorded honestly. Picking one version
 *     out of several silently would make `prior_pin` a coin flip. We
 *     record the full observed set in `prior_pin_observed` AND pick the
 *     single value by one documented, deterministic rule: the LOWEST
 *     observed version. Rolling back to the lowest is the only choice
 *     that is not an UPGRADE for some in-scope agent — a rollback must
 *     never move an agent forward.
 *
 * Pure: string-in / verdict-out, no I/O. The docker read is the caller's
 * (`server.ts`), through the same `ExecFn` seam the rest of the
 * inventory uses, so this unit-tests without docker.
 */

import { spawnSync } from "node:child_process";
import {
  collectContainerComponents,
  normalizeSemverTag,
  type ComponentVersion,
} from "../cli/component-versions.js";
import { classifyComponent } from "../cli/component-scope.js";
import { compareReleaseTags } from "../config/release-resolve.js";

/**
 * The production fleet-inventory reader: one `docker ps` through the same
 * collector `switchroom update --check`, `doctor`, and the roll's
 * `verify-components` gate use — so hostd cannot disagree with them about
 * what the fleet is running.
 *
 * Wired at the daemon's composition root (`main.ts`) rather than defaulted
 * inside `HostdServer`, so a unit-test server never shells out to the
 * host's docker. Fail-soft: a missing/failing `docker` yields `[]`, which
 * the resolver reports as `unobserved`.
 */
export function dockerFleetComponents(dockerBin?: string): ComponentVersion[] {
  const bin = dockerBin ?? "docker";
  try {
    return collectContainerComponents((cmd, args) => {
      const r = spawnSync(cmd === "docker" ? bin : cmd, args, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    });
  } catch {
    return [];
  }
}

/**
 * How `prior_pin` was arrived at. Recorded on the audit row so a reader
 * can tell "no prior version existed" from "we could not look".
 */
export type PriorPinSource =
  /** One version observed across the in-scope fleet (target excluded). */
  | "running-fleet"
  /** Several versions observed; `prior_pin` is the lowest, set recorded. */
  | "running-fleet-mixed"
  /** Every in-scope agent already runs the target — no prior version. */
  | "all-on-target"
  /** No in-scope agent container reported a readable version. */
  | "unobserved";

export interface PriorPinResolution {
  /** The rollback target. Absent when none could be named. */
  prior_pin?: string;
  /**
   * Every distinct version observed across the in-scope fleet, highest
   * first — INCLUDING the target when some agents already ran it.
   * Present only when the fleet was not uniform, i.e. when the single
   * `prior_pin` value does not tell the whole truth.
   */
  prior_pin_observed?: string[];
  prior_pin_source: PriorPinSource;
}

/** Highest-first ordering; falls back to string compare so two tags that
 *  `compareReleaseTags` cannot order still sort deterministically. */
function byVersionDesc(a: string, b: string): number {
  const cmp = compareReleaseTags(a, b);
  if (cmp !== null && cmp !== 0) return -cmp;
  return b.localeCompare(a);
}

/**
 * Derive `prior_pin` from the running fleet.
 *
 * @param components  The `docker ps` component inventory (any mix of
 *                    kinds — non-agent components are ignored, since
 *                    hostd / web / hindsight advance by their own
 *                    mechanisms and are not what a fleet rollback
 *                    targets).
 * @param target      The version this roll is moving TO. Excluded from
 *                    the result by invariant 1.
 * @param scope       Agent names this roll is responsible for (the
 *                    `--agents` subset). Empty/undefined = whole fleet.
 */
export function resolvePriorPinFromFleet(
  components: readonly ComponentVersion[],
  target: string | undefined,
  scope?: readonly string[],
): PriorPinResolution {
  const normalizedTarget = normalizeSemverTag(target);
  const scoped = new Set(scope ?? []);

  const seen = new Set<string>();
  for (const c of components) {
    if (c.kind !== "container") continue;
    const owner = classifyComponent(c);
    // Agent containers only. A fleet SINGLETON (vault-broker, approval
    // kernel, …) classifies as `fleet` with no `agent` — it rides the
    // same compose project but is not what "the version the fleet was
    // running" means to an operator rolling back.
    if (owner.kind !== "fleet" || !owner.agent) continue;
    if (scoped.size > 0 && !scoped.has(owner.agent)) continue;
    const v = normalizeSemverTag(c.version ?? undefined);
    if (v) seen.add(v);
  }

  const observed = [...seen].sort(byVersionDesc);
  if (observed.length === 0) return { prior_pin_source: "unobserved" };

  // Invariant 1: the target can never be the answer.
  const candidates = normalizedTarget
    ? observed.filter((v) => v !== normalizedTarget)
    : [...observed];

  if (candidates.length === 0) {
    return { prior_pin_source: "all-on-target", prior_pin_observed: observed };
  }

  if (candidates.length === 1 && observed.length === 1) {
    return { prior_pin: candidates[0]!, prior_pin_source: "running-fleet" };
  }

  if (candidates.length === 1) {
    // One candidate, but the fleet was not uniform (some agents already
    // sat on the target). The answer is unambiguous; the set still gets
    // recorded so the row does not imply uniformity it did not have.
    return {
      prior_pin: candidates[0]!,
      prior_pin_source: "running-fleet",
      prior_pin_observed: observed,
    };
  }

  // Invariant 2: mixed. Lowest wins — a rollback must not be an upgrade
  // for any in-scope agent — and the whole set is recorded.
  return {
    prior_pin: candidates[candidates.length - 1]!,
    prior_pin_source: "running-fleet-mixed",
    prior_pin_observed: observed,
  };
}
