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

import { parseDocument, isScalar, isMap, isPair, type Document } from "yaml";

/**
 * Read the current `release.pin` out of a config's raw text, or undefined
 * when unpinned / unparseable. Read-only companion to
 * {@link setReleasePinInConfig}; used by the rollout pin journal to record
 * which pin a provisional write is replacing.
 */
export function getReleasePinFromConfig(yamlText: string): string | undefined {
  let v: unknown;
  try {
    v = parseDocument(yamlText).getIn(["release", "pin"]);
  } catch {
    return undefined;
  }
  return typeof v === "string" ? v : undefined;
}

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

/**
 * Return `yamlText` with `release.pin` REMOVED — the inverse of
 * {@link setReleasePinInConfig}, used by the rollout pin journal to revert a
 * provisional pin that was written for a roll that never proved out.
 *
 * Why this exists rather than restoring a saved copy of the whole file: the
 * revert can run minutes (or, after a crash, hours) after the provisional
 * write, and anything else may legitimately have edited the config in between
 * — an operator adding an agent, a `config_propose_edit` landing, a vault
 * reference changing. Restoring a byte-exact snapshot would silently discard
 * all of it. A targeted edit touches exactly the key the rollout wrote and
 * leaves every other change intact.
 *
 * Deleting an absent pin is a no-op. Returns `yamlText` unchanged when there is
 * nothing to delete, so callers can call it unconditionally without churning
 * the file's mtime.
 *
 * ## The empty `release` husk
 *
 * When `pin` was the block's only key, deleting it leaves `release: {}`. That
 * husk is dropped — but ONLY when nothing is commented onto it.
 *
 * The `yaml` Document attaches a key's preceding comment block to the key node
 * as `commentBefore`, so `doc.delete("release")` takes the block's entire
 * documentation with it. On the production config that is a 15-line header. The
 * two cases the journal actually hits pull in opposite directions:
 *
 *   - the roll SYNTHESIZED the block (the config was unpinned and had no
 *     `release:` key at all) — no comments exist, so dropping the husk makes
 *     the revert byte-identical to the pre-roll file. That is the case the
 *     husk removal was written for;
 *   - the block PRE-EXISTED with operator documentation and the roll only wrote
 *     `pin` into it (or an operator added a documented `release:` during the
 *     roll window, which the targeted-edit contract above exists to respect) —
 *     dropping the husk would silently delete that documentation.
 *
 * So a commented husk is kept as `release: {}`. That is schema-VALID: every
 * field in `ReleaseBlock` is optional and the refine only rejects
 * `channel` + `pin` together, so `{}` passes (an earlier comment here claimed
 * the opposite — it was wrong). Keeping a tidy config is not worth destroying
 * an operator's comments.
 */
export function deleteReleasePinInConfig(yamlText: string): string {
  const doc = parseDocument(yamlText);
  if (!doc.hasIn(["release", "pin"])) return yamlText;
  doc.deleteIn(["release", "pin"]);
  const rel = doc.getIn(["release"]);
  if (isMap(rel) && rel.items.length === 0 && !releaseBlockIsCommented(doc)) {
    doc.delete("release");
  }
  return String(doc);
}

/**
 * Does the top-level `release` pair carry any comment that would be destroyed
 * by deleting it? Checks the key node (where a preceding `# …` block lands)
 * and the value node (trailing / inner comments).
 */
function releaseBlockIsCommented(doc: Document): boolean {
  const contents = doc.contents;
  if (!isMap(contents)) return false;
  for (const item of contents.items) {
    if (!isPair(item)) continue;
    const key = item.key;
    if (!isScalar(key) || key.value !== "release") continue;
    const nodes = [key, item.value];
    return nodes.some(
      (n) =>
        !!n &&
        typeof n === "object" &&
        (("commentBefore" in n && !!n.commentBefore) || ("comment" in n && !!n.comment)),
    );
  }
  return false;
}
