/**
 * Component OWNERSHIP + remediation — the single source of truth for
 * "which mechanism converges this component, and what command drives it"
 * (#3928).
 *
 * WHY THIS EXISTS
 *
 * `component-versions.ts` (#3919) answers "is every component on the same
 * version?" enumeratively, from `docker ps`. That gave `switchroom doctor`
 * and `switchroom update --check` a standing, checkable answer — and on
 * 2026-07-28 it correctly reported `switchroom-web` and
 * `switchroom-hindsight-autoheal` still on v0.19.26 after a roll to
 * v0.19.30 that had exited **0**.
 *
 * The reason the roll could exit green with that drift outstanding is that
 * `rollout` carried its OWN, separate notion of scope: a hardcoded list of
 * plan steps (`refresh-web`, `refresh-hostd`, `refresh-hindsight`) whose
 * failures degraded to non-fatal warnings, and no check at all that the
 * host had actually converged. Two derivations of "what is in scope", only
 * one of which was enumerative — so they drifted, and the enumerative one
 * was right.
 *
 * This module is the join. It maps a component from the SAME inventory
 * `update --check` uses onto the mechanism that owns it, so:
 *
 *   - `rollout` can gate on exactly the components it was responsible for
 *     converging, and fail loudly when any is left behind
 *     (`src/cli/rollout.ts`, the `verify-components` step);
 *   - `switchroom doctor` names the same remediation for the same
 *     component (`src/cli/doctor-component-versions.ts`);
 *
 * and a component that ships tomorrow is classified by the same rules,
 * without anyone editing a list.
 *
 * CLASSIFICATION IS KEYED ON THE IMAGE, NOT THE CONTAINER NAME.
 *
 * `switchroom-hindsight-autoheal` is the whole reason. It is a sidecar in
 * the `switchroom-hostd` compose project that runs the **hostd image**
 * (`src/cli/hostd.ts:406`) — a name allowlist put it nowhere, which is
 * exactly how it escaped every previous scope list. Keyed on the image
 * repo it lands on the hostd owner automatically, and so would a second
 * hostd-project sidecar added next release.
 */

import type { ComponentVersion } from "./component-versions.js";
import { hostCliInstallCommand, type HostCliStamp } from "./host-cli-stamp.js";

/**
 * The mechanism that converges a component onto the release target.
 *
 * One value per DEPLOY UNIT, not per container: `switchroom-hostd` and
 * `switchroom-hindsight-autoheal` share `"hostd"` because one
 * `hostd install` regenerates the compose project that holds both.
 */
export type ComponentOwnerKind =
  /** The host CLI running this process. Converged by `switchroom update`. */
  | "cli"
  /** The agent-fleet compose project (`switchroom`): agents + the
   *  vault-broker / approval-kernel / auth-broker / voice singletons,
   *  which self-heal on the first `agent restart` (#2170). */
  | "fleet"
  /** The `switchroom-web` compose project. `switchroom webd install`. */
  | "web"
  /** The `switchroom-hostd` compose project — hostd, its docker-socket
   *  proxy, and the hindsight-autoheal sidecar. `switchroom hostd install`. */
  | "hostd"
  /** The standalone `docker run` hindsight singleton. `memory setup`. */
  | "hindsight";

export interface ComponentOwner {
  kind: ComponentOwnerKind;
  /**
   * Fleet AGENT name (container `switchroom-<agent>` on the
   * `switchroom-agent` image), when this component is a per-agent
   * container. Absent for fleet singletons.
   *
   * Load-bearing for the rollout gate: a `--agents <subset>` roll is only
   * responsible for the agents it was asked to roll, so the gate must be
   * able to tell "agent nobody asked us to touch" from "singleton that
   * should have self-healed".
   */
  agent?: string;
}

/**
 * The image REPOSITORY name (`switchroom-hostd`) from a full image ref
 * (`ghcr.io/switchroom/switchroom-hostd:v0.19.30`).
 *
 * Returns null when the ref carries no `…/switchroom-<x>` repo path —
 * the same shape `isSwitchroomReleaseImage` refuses, so a third-party
 * image running under a switchroom-prefixed container name
 * (`switchroom-hostd-docker-proxy` → `ghcr.io/tecnativa/…`) never
 * classifies as a switchroom deploy unit.
 */
export function imageRepoName(imageRef: string | undefined): string | null {
  if (!imageRef) return null;
  const at = imageRef.indexOf("@");
  const withoutDigest = at >= 0 ? imageRef.slice(0, at) : imageRef;
  const slash = withoutDigest.lastIndexOf("/");
  if (slash < 0) return null;
  const afterSlash = withoutDigest.slice(slash + 1);
  const colon = afterSlash.indexOf(":");
  const repo = colon >= 0 ? afterSlash.slice(0, colon) : afterSlash;
  return /^switchroom-[a-z0-9-]+$/.test(repo) ? repo : null;
}

/**
 * Which mechanism owns this component.
 *
 * DEFAULTS TO `"fleet"` for an unrecognised switchroom image, and that
 * default is deliberate and fail-LOUD rather than fail-silent: a new
 * component is then gated by the rollout drift check from the day it
 * ships. If it turns out to live in its own compose project, the roll
 * says so by failing with the component named — which is strictly better
 * than the historical behaviour (silently out of scope forever).
 */
export function classifyComponent(c: ComponentVersion): ComponentOwner {
  if (c.kind === "cli") return { kind: "cli" };
  const repo = imageRepoName(c.imageRef);
  switch (repo) {
    case "switchroom-web":
      return { kind: "web" };
    // hostd AND the hindsight-autoheal sidecar — same image, same compose
    // project, one `hostd install` converges both.
    case "switchroom-hostd":
      return { kind: "hostd" };
    case "switchroom-hindsight":
      return { kind: "hindsight" };
    case "switchroom-agent": {
      const agent = c.name.startsWith("switchroom-")
        ? c.name.slice("switchroom-".length)
        : c.name;
      return agent ? { kind: "fleet", agent } : { kind: "fleet" };
    }
    default:
      return { kind: "fleet" };
  }
}

/**
 * The command that brings an owner's components onto `target`.
 *
 * Shared by the doctor row's `fix:` and the rollout drift gate's failure
 * text so an operator is never given two different answers for the same
 * drifted component.
 *
 * `hostCli` (#4571) is the host CLI's own record of how it was installed. When
 * present, the `cli` remediation is derived from it instead of assuming the
 * self-updatable static binary: `switchroom update` is a no-op on an npm
 * install, and `sudo npm i -g` is actively wrong on a user-owned nvm prefix.
 */
export function remediationFor(
  owner: ComponentOwner,
  target: string,
  hostCli?: HostCliStamp,
): string {
  switch (owner.kind) {
    case "cli":
      return hostCli
        ? `${hostCliInstallCommand(hostCli, target)}  (upgrade the host CLI FIRST — everything else is driven by it)`
        : `switchroom update  (self-updates the host CLI to ${target} first, then everything else)`;
    case "web":
      return `switchroom webd install --tag ${target}  (separate compose project — regenerates + recreates switchroom-web)`;
    case "hostd":
      return `switchroom hostd install --tag ${target}  (regenerates the hostd compose project — both hostd and the autoheal sidecar)`;
    case "hindsight":
      return `switchroom memory setup --recreate --tag ${target}  (standalone container — not a compose service)`;
    case "fleet":
      return owner.agent
        ? `switchroom rollout --pin ${target} --agents ${owner.agent}  (agent-fleet compose project)`
        : `switchroom rollout --pin ${target}  (agent-fleet compose project — the singletons self-heal on the first agent restart)`;
  }
}

/**
 * Which owners a given rollout is ANSWERABLE for.
 *
 * Derived from the plan's own steps rather than from the CLI flags, so
 * the gate can never claim responsibility for a step the plan does not
 * contain (and can never quietly drop one it does).
 *
 * `"cli"` is DELIBERATELY NOT GATED. The host operator's CLI is installed
 * with `npm i -g` on the host; no step of any rollout plan converges it,
 * and on the hostd path the roll physically cannot (rollout.ts already
 * names it as permanently deferred). Gating it would make every
 * hostd-driven roll fail whenever the operator's host CLI lagged the
 * release — which is the normal state immediately after a tag, and was
 * true on the #3928 host itself. It is reported as an EXEMPT drift
 * warning instead, and `shouldRefuseStaleCli` (rollout.ts) is what
 * actually protects the roll from a stale driving CLI.
 *
 * @param stepKinds  the `kind` of every step in the executed plan.
 * @param hostdContext  the agent-invoked path. `refresh-hostd` is
 *   deliberately absent from that plan (recreating hostd would SIGKILL
 *   the in-flight roll), but hostd is NOT unowned there: the daemon
 *   self-bumps its own compose project onto the target before it spawns
 *   the roll child (#2645), and `shouldRefuseStaleCli` refuses the roll
 *   outright when the hostd-container CLI is older than the target. So on
 *   that path hostd IS answered for — and a hostd-project component still
 *   behind after the roll (exactly `switchroom-hindsight-autoheal` in
 *   #3928) is a real finding, not an expected deferral.
 */
export function gatedOwners(
  stepKinds: readonly string[],
  hostdContext: boolean,
): Set<ComponentOwnerKind> {
  const kinds = new Set(stepKinds);
  const owners = new Set<ComponentOwnerKind>(["fleet"]);
  if (kinds.has("refresh-web")) owners.add("web");
  if (kinds.has("refresh-hindsight")) owners.add("hindsight");
  if (kinds.has("refresh-hostd") || hostdContext) owners.add("hostd");
  return owners;
}

/**
 * Split the drifted components into the ones this roll must answer for
 * and the ones it deliberately did not touch.
 *
 * `--skip-web` (which on the host-shell path drops the web, hostd AND
 * hindsight refresh steps) is an explicit operator opt-out, so those
 * components are EXEMPT from the gate — but they are still returned as
 * `exempt` and reported, because "you asked me to skip it and it is
 * behind" is information, not silence.
 */
export function partitionDrift(
  behind: readonly ComponentVersion[],
  opts: { owners: ReadonlySet<ComponentOwnerKind>; rolledAgents: ReadonlySet<string> },
): { gated: ComponentVersion[]; exempt: ComponentVersion[] } {
  const gated: ComponentVersion[] = [];
  const exempt: ComponentVersion[] = [];
  for (const c of behind) {
    const owner = classifyComponent(c);
    const inScope =
      owner.kind === "fleet" && owner.agent !== undefined
        ? // A `--agents <subset>` roll is answerable only for the agents it
          // was asked to roll. Ditto an agent container that is no longer in
          // switchroom.yaml: nothing in this roll was going to move it.
          opts.rolledAgents.has(owner.agent)
        : opts.owners.has(owner.kind);
    (inScope ? gated : exempt).push(c);
  }
  return { gated, exempt };
}
