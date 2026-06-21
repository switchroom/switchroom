/**
 * YAML editor for the top-level `switchroom.timezone: <zone>` field.
 *
 * Pure module — string-in / string-out — so the setup wizard can read
 * the freshly-bootstrapped config, mutate, and atomic-write the result
 * without losing comments or surrounding formatting. Mirrors the pattern
 * in `auth-active-yaml.ts` / `supergroup-setup-yaml.ts`.
 *
 * One caller today: `switchroom setup` (#2483). After scaffolding a
 * brand-new `~/.switchroom/switchroom.yaml`, the wizard detects the
 * host timezone and persists a *real* (non-UTC) detected zone — or, in
 * the UTC case, an operator-supplied zone — into the root `switchroom:`
 * block. Making the choice visible/editable beats leaving it to the
 * invisible `detectServerTimezone()` fallback that silently resolves to
 * UTC and stamps every agent's clock wrong (the bug this fixes).
 *
 * NEVER call this with "UTC" — the whole point is to avoid persisting
 * the platform-default UTC as if it were a deliberate choice. The caller
 * gates on that; this module also rejects it defensively.
 */

import { parseDocument, isMap } from "yaml";
import { isValidTimezone } from "../config/schema.js";

/**
 * Set `switchroom.timezone: <zone>` in the YAML text. The root
 * `switchroom:` map is required by the schema and present in every
 * bootstrapped example, so we patch its `timezone` child while
 * preserving siblings (version, agents_dir, …) and comments. Idempotent
 * — returns the input verbatim when the value already matches.
 *
 * Rejects `UTC` and any value the schema's timezone validator rejects,
 * so the wizard never writes a malformed or pointless value to disk.
 *
 * Returns the new YAML text. Caller owns the atomic-write to disk and
 * any mode preservation.
 */
export function setSwitchroomTimezone(yamlText: string, zone: string): string {
  if (typeof zone !== "string" || zone.length === 0) {
    throw new Error("setSwitchroomTimezone: zone must be a non-empty string");
  }
  if (zone === "UTC") {
    throw new Error(
      "setSwitchroomTimezone: refusing to persist UTC — UTC is the silent " +
        "fallback this write exists to avoid (#2483)",
    );
  }
  if (!isValidTimezone(zone)) {
    throw new Error(
      `setSwitchroomTimezone: "${zone}" is not a valid IANA zone name ` +
        `(expected Region/City like "Australia/Melbourne")`,
    );
  }

  const doc = parseDocument(yamlText);
  const root = doc.contents;
  if (!isMap(root)) {
    throw new Error("setSwitchroomTimezone: YAML root is not a map");
  }

  const existing = root.get("switchroom", true);
  if (isMap(existing)) {
    if (existing.get("timezone") === zone) {
      return yamlText; // idempotent
    }
    // Map exists with other siblings (version, agents_dir, …) — patch
    // only the `timezone` key so siblings + comments survive.
    doc.setIn(["switchroom", "timezone"], zone);
  } else {
    // `switchroom:` absent, null (bare key), or scalar. `setIn` crashes
    // on null/scalar — replace the whole value with a fresh map. The
    // schema requires the block, so this branch only fires on a
    // hand-mangled config; there are no siblings to preserve.
    doc.set("switchroom", { timezone: zone });
  }

  const out = String(doc);
  return out.endsWith("\n") ? out : out + "\n";
}
