/**
 * YAML editor for the top-level `auth.active: <label>` field.
 *
 * Pure module — string-in / string-out — so the CLI can read the
 * existing file, mutate, and atomic-write the result without losing
 * comments or surrounding formatting. Mirrors the pattern in
 * `google-accounts-yaml.ts`.
 *
 * Two callers today:
 *   - `switchroom auth use <label>` — pin the fleet-wide active account
 *     after broker setActive succeeds. Without this, doctor's
 *     `auth-broker: fleet active account` check stays red because it
 *     reads switchroom.yaml, not the broker's in-memory state.
 *   - `switchroom setup` — seeds `auth.active: default` on first run
 *     so a freshly-set-up host has a valid auth stanza before
 *     `auth add default --from-oauth` mints credentials.
 */

import { parseDocument, isMap } from "yaml";

/**
 * Set `auth.active: <label>` in the YAML text. Creates the top-level
 * `auth:` map if missing. Idempotent — returns the input verbatim
 * (preserving byte-equality) when `auth.active` already equals
 * `label`.
 *
 * Returns the new YAML text. Caller is responsible for the
 * atomic-write to disk and any mode preservation.
 */
export function setAuthActive(yamlText: string, label: string): string {
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("setAuthActive: label must be a non-empty string");
  }
  const doc = parseDocument(yamlText);
  const root = doc.contents;
  if (!isMap(root)) {
    throw new Error("setAuthActive: YAML root is not a map");
  }
  const existing = root.get("auth", true);
  if (isMap(existing)) {
    if (existing.get("active") === label) {
      return yamlText;
    }
    // Map exists with other siblings (fallback_order, admin_agents, etc.) —
    // patch only the `active` key so siblings + comments survive.
    doc.setIn(["auth", "active"], label);
  } else {
    // `auth:` either absent, null (e.g. operator wrote a bare `auth:`
    // key with no children), or scalar. `setIn` crashes on null/scalar
    // because the yaml lib expects a collection — replace the whole
    // `auth` value with a fresh map. There are no siblings to preserve
    // in any of these branches.
    doc.set("auth", { active: label });
  }
  const out = String(doc);
  return out.endsWith("\n") ? out : out + "\n";
}
