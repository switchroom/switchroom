/**
 * hostd compose-template change marker (#4269).
 *
 * After an agent-invoked roll, the terminal Done card names the two residuals
 * no roll can converge from inside a container: the host operator CLI
 * (`npm i -g` needs host root) and a hostd TEMPLATE regen (`switchroom hostd
 * install --tag …` — regenerating from inside a container gets host facts
 * wrong: SUDO_UID, host tz, skills symlink target; see self-bump.ts). The
 * template regen is only actually needed when a release CHANGED the hostd
 * compose template's mounts/env shape — historically the card hedged with
 * "only if the release changed hostd mounts/env", forcing the operator to
 * guess.
 *
 * This constant makes the answer deterministic: it records the release tag
 * in which `renderHostdComposeFile` (src/cli/hostd.ts) last changed shape.
 * The Done-card renderer and the rollout warning compare it against the
 * roll's from → target window and say definitively whether a regen is
 * required.
 *
 * KEEPING IT HONEST is not left to reviewer memory: the lint guard
 * `scripts/check-hostd-template-guard.ts` hashes the template region of
 * src/cli/hostd.ts against `scripts/hostd-template-baseline.json` and FAILS
 * when the region changes without this constant (and the baseline) being
 * bumped in the same PR. When you change the hostd template:
 *
 *   1. bump HOSTD_TEMPLATE_LAST_CHANGED to the release tag that will ship
 *      your change (the next release cut from main), and
 *   2. update scripts/hostd-template-baseline.json (the guard's failure
 *      output prints the new hash).
 *
 * If your guess at the shipping tag ends up LOW (the change ships in a later
 * release than you named), the card errs toward "regen REQUIRED" for rolls
 * crossing the named tag — conservative, never silently wrong the other way.
 */

import { compareReleaseTags } from "./release-resolve.js";

/**
 * The release tag in which the hostd compose template (mounts/env shape,
 * `renderHostdComposeFile` in src/cli/hostd.ts) last changed.
 *
 * v0.19.43 — commit 9919c75b "feat(compose): resolve docker socket path +
 * platform-gate network default (#3648, #3637)" added the resolved
 * `dockerSocketPath` bind for the docker-socket-proxy sidecar.
 */
export const HOSTD_TEMPLATE_LAST_CHANGED = "v0.19.43";

/**
 * Whether a roll from `fromVersion` to `target` requires a host-side
 * `switchroom hostd install --tag <target>` template regen.
 *
 *   - "required"   — the roll crosses HOSTD_TEMPLATE_LAST_CHANGED (exactly
 *                    one endpoint is on the new template shape), so the
 *                    on-disk compose no longer matches the target release's
 *                    template. Covers downgrades too: rolling back across
 *                    the change also needs a regen (at the older tag).
 *   - "not-needed" — both endpoints sit on the same side of the change; the
 *                    on-disk template already matches (the image tag itself
 *                    is advanced by the self-bump, not by a regen).
 *   - "unknown"    — target or fromVersion is missing / not a clean vX.Y.Z
 *                    (channels, shas), so no definite claim is possible;
 *                    callers should fall back to the hedged wording.
 */
export type HostdTemplateRegenVerdict = "required" | "not-needed" | "unknown";

export function hostdTemplateRegenVerdict(
  target: string | null | undefined,
  fromVersion?: string | null,
): HostdTemplateRegenVerdict {
  // compareReleaseTags is conservative: null for anything that isn't a clean
  // semver tag on both sides — which maps exactly to "no definite claim".
  const cmpTarget = compareReleaseTags(HOSTD_TEMPLATE_LAST_CHANGED, target);
  if (cmpTarget === null) return "unknown";
  const cmpFrom = compareReleaseTags(HOSTD_TEMPLATE_LAST_CHANGED, fromVersion);
  if (cmpFrom === null) return "unknown";
  // An endpoint "has" the current template shape iff it is >= the tag that
  // last changed it. A regen is needed exactly when the roll crosses the
  // change — one endpoint has it and the other doesn't (either direction).
  const targetHas = cmpTarget <= 0;
  const fromHas = cmpFrom <= 0;
  return targetHas === fromHas ? "not-needed" : "required";
}
