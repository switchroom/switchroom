/**
 * Comment-preserving editor for the top-level `release.pin` field in
 * switchroom.yaml. Used by `switchroom rollout --pin` and `switchroom
 * update --pin` to make a pinned roll DURABLE — without it, `--pin` is a
 * one-shot `apply` override (`apply.ts` `releaseOverride`) that never lands
 * in the config, so the next plain reconcile silently reverts the fleet to
 * the stale pin (memory `feedback_agent_restart_needs_apply_for_pin`).
 *
 * Uses the `yaml` package Document API (parseDocument → setIn → String) so
 * every OTHER comment and the file's formatting survive byte-for-byte — the
 * same pattern as `microsoft-accounts-yaml.ts` / `google-accounts-yaml.ts`.
 * `js-yaml` / `yaml.stringify(obj)` would drop all comments and is banned
 * here.
 *
 * Schema contract: `release.channel` and `release.pin` are mutually
 * exclusive (`src/config/schema.ts` ReleaseBlock refine). So setting a pin
 * deletes any existing channel in the same edit, or the post-write config
 * would fail validation.
 */

import { parseDocument, isScalar } from "yaml";

/**
 * Return `yamlText` with `release.pin` set to `pin` (creating the `release`
 * block if absent, deleting any `release.channel`), and the pin line's
 * trailing comment refreshed to a dated provenance note so it never
 * mis-describes the new pin.
 *
 * Idempotent: if the config is ALREADY on `pin` with no channel to clear,
 * returns `yamlText` unchanged (byte-identical — no mtime churn, no stale
 * comment rewrite on a no-op re-run).
 *
 * @param now ISO date (YYYY-MM-DD) for the provenance comment; injectable
 *            so tests are deterministic. Defaults to today.
 */
export function setReleasePinInConfig(
  yamlText: string,
  pin: string,
  now: string = new Date().toISOString().slice(0, 10),
): string {
  const doc = parseDocument(yamlText);
  const currentPin = doc.getIn(["release", "pin"]);
  const hasChannel = doc.hasIn(["release", "channel"]);

  // Idempotent no-op: already pinned here, nothing to clear.
  if (currentPin === pin && !hasChannel) return yamlText;

  if (hasChannel) doc.deleteIn(["release", "channel"]);
  doc.setIn(["release", "pin"], pin);

  // Refresh the pin line's trailing comment. setIn replaces the value node,
  // so the OLD comment is already gone — we set a fresh dated one rather
  // than leave a stale note describing the previous pin.
  const node = doc.getIn(["release", "pin"], true);
  if (isScalar(node)) {
    node.comment = ` ${now}: rolled by switchroom rollout`;
  }

  return String(doc);
}
