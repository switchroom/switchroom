/**
 * LiteLLM passthrough / shadow-mount version coherence.
 *
 * The pacer ships a SECOND kind of bind mount alongside the `custom_pacing.py`
 * callback module: a *patch* mount that shadows a file already inside the image,
 * `anthropic_passthrough_logging_handler.py`, so the Anthropic passthrough path
 * emits the token-usage the pacer meters. Unlike the callback module (imported
 * as a bare `<module>` off `/app` on `sys.path`), the patch has to land at the
 * EXACT path the real file occupies inside the interpreter's site-packages tree:
 *
 *   /app/.venv/lib/python3.13/site-packages/litellm/proxy/pass_through_endpoints/
 *     llm_provider_handlers/anthropic_passthrough_logging_handler.py
 *
 * That target hard-codes the CPython minor version (`python3.13`). It is the
 * fragile part: the segment is baked into the image and MOVES on a minor-version
 * bump. A future image built on python 3.14 puts its site-packages under
 * `python3.14/`, so a mount still targeting `python3.13/` lands at an inert path
 * — the directory does not exist, the real file at 3.14 is never shadowed, and
 * the patch SILENTLY drops. There is no crash and no log: the proxy comes up
 * "healthy" while the pacer's usage accounting quietly runs on unpatched code.
 *
 * That silence is the whole hazard. The 2026-08-09 outage was LOUD (callbacks
 * abort startup); this failure mode is the opposite — a green deploy that has
 * quietly lost a patch — which is exactly the class a standing sensor exists to
 * catch. `callback-mount-guard.ts` does NOT cover it: that guard checks a
 * config-declared callback has SOME mount at `/app/<module>.py`; it says nothing
 * about a versioned site-packages shadow whose target has gone stale against the
 * image it is mounted into.
 *
 * This module is the pure detection core for that invariant:
 *
 *   a bind mount shadowing pythonX.Y/site-packages  ⇒  X.Y == the image's
 *   actual CPython minor version
 *
 * The image's actual version cannot be read from text — it lives in the running
 * container — so it is passed IN. The sensor resolves it from the live image via
 * an injectable seam (default: `docker exec` the litellm container), exactly the
 * `docker inspect`-the-live-container division of labour the image pin and the
 * GPU-drift sensor already use. `null` means "cannot tell" and the core stays
 * silent — a fabricated violation is worse than none.
 *
 * STRICTLY PURE: compose text + a resolved version string in, violations out. No
 * fs, no network, no docker. The IO lives in the sensor seam.
 */

import { extractComposeBindTargets } from "./callback-mount-guard.js";

/**
 * A bind-mount target that shadows a file inside a VERSIONED CPython
 * site-packages tree: `/.../pythonX.Y/site-packages/...`. The `X.Y` capture is
 * the interpreter minor version baked into the target — the part that goes stale
 * when the image's python moves. Only `pythonX.Y` (two numeric segments) is
 * matched: an unversioned `site-packages` path carries no version to validate.
 */
const VERSIONED_SITE_PACKAGES_RE = /\/python(\d+\.\d+)\/site-packages\//;

export interface StalePassthroughMount {
  /** The container path the mount targets. */
  target: string;
  /** The CPython minor version the target hard-codes (e.g. `3.13`). */
  declaredPythonVersion: string;
  /** The CPython minor version the live image actually ships (e.g. `3.14`). */
  actualPythonVersion: string;
  /** Human-readable explanation for the ledger finding. */
  detail: string;
}

/**
 * Extract every bind-mount target that shadows a versioned site-packages path,
 * with the CPython minor version each one hard-codes.
 *
 * Returns `null` for "cannot tell" (compose absent/unparseable, or no `services`
 * mapping) — propagated straight from `extractComposeBindTargets`, whose null vs
 * empty-set distinction the callback guard relies on and this one inherits. An
 * empty array means "parsed fine, no versioned shadow mounts here" — a real and
 * quiet pass, not an unknown.
 */
export function extractVersionedSitePackagesMounts(
  composeText: string,
): { target: string; declaredPythonVersion: string }[] | null {
  const targets = extractComposeBindTargets(composeText);
  if (targets === null) return null;

  const out: { target: string; declaredPythonVersion: string }[] = [];
  for (const target of targets) {
    const m = VERSIONED_SITE_PACKAGES_RE.exec(target);
    if (m) out.push({ target, declaredPythonVersion: m[1] });
  }
  return out;
}

/**
 * The invariant: every versioned site-packages shadow mount targets the CPython
 * minor version the live image actually ships.
 *
 * Yields no violations when the compose is absent/unreadable OR the image's
 * actual version could not be resolved (`actualPythonVersion == null`) — a
 * violation we cannot substantiate is worse than staying quiet, and a stale
 * shadow mount is a silent-drop hazard, so guessing here would defeat the point.
 * The caller logs a visible SKIP for the "cannot tell" case, the same way the
 * callback guard does.
 *
 * A compose that resolves the version but whose shadow mount names a DIFFERENT
 * minor version is the bug: the mount lands at an inert path and the patch is
 * silently dropped.
 */
export function detectStalePassthroughMounts(
  composeText: string | null,
  actualPythonVersion: string | null,
): StalePassthroughMount[] {
  if (composeText == null || actualPythonVersion == null) return [];

  const mounts = extractVersionedSitePackagesMounts(composeText);
  if (mounts === null) return [];

  const violations: StalePassthroughMount[] = [];
  for (const { target, declaredPythonVersion } of mounts) {
    if (declaredPythonVersion === actualPythonVersion) continue;
    violations.push({
      target,
      declaredPythonVersion,
      actualPythonVersion,
      detail:
        `bind mount targets ${target}, hard-coding CPython ${declaredPythonVersion}, but the live ` +
        `litellm image ships CPython ${actualPythonVersion} — its site-packages live under ` +
        `python${actualPythonVersion}/, so this mount lands at an inert path and the patch is ` +
        `SILENTLY dropped (no crash, no log; the proxy comes up "healthy" on unpatched code). ` +
        `Update the mount target to python${actualPythonVersion}/ in services.docker_compose_raw ` +
        `(a hand edit to the generated compose is wiped on the next Coolify deploy), then redeploy.`,
    });
  }
  return violations;
}
