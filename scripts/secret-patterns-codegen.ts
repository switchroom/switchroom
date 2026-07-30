/**
 * Shared codegen for the secret-detection pattern table.
 *
 * `telegram-plugin/secret-detect/patterns.ts` is the SINGLE source of
 * truth for every regex-shaped secret rule. The Hindsight write path is
 * Python (`vendor/hindsight-memory/scripts/`), and it must mask exactly
 * what the TypeScript redactor masks — so the table is emitted from the
 * TS module into a language-neutral JSON file the Python engine loads at
 * runtime, and a lint guard re-emits it and fails on drift.
 *
 * That is the whole anti-fork mechanism: a pattern added to patterns.ts
 * lands in the Python redactor on the next `bun lint` (which will FAIL
 * until the generated file is committed), so the two can never silently
 * diverge the way a hand-maintained second list would.
 *
 * Used by:
 *   - `scripts/gen-secret-patterns.ts`            (writer)
 *   - `scripts/check-secret-pattern-parity.ts`    (lint guard)
 */
import { ALL_PATTERNS } from "../telegram-plugin/secret-detect/patterns.js";

export const GENERATED_PATTERNS_PATH =
  "vendor/hindsight-memory/scripts/lib/secret_patterns.json";

/**
 * JS `RegExp.source` keeps the `\/` escapes a regex LITERAL needs. Python
 * `re` accepts them, but they are noise in a portable table — normalize so
 * the emitted source is the same string a human would write in either
 * language.
 */
function portableSource(source: string): string {
  return source.replace(/\\\//g, "/");
}

/**
 * Flags that survive the port. `g` is dropped: the Python engine always
 * uses `finditer`, and JS re-compiles per window with an explicit `g`.
 * `i` and `m` map to `re.I` / `re.M`. Anything else is a hard error —
 * silently dropping a flag would change what the Python side matches.
 */
const PORTABLE_FLAGS = new Set(["g", "i", "m"]);

export function buildPatternTable(): string {
  const patterns = ALL_PATTERNS.map((p) => {
    for (const f of p.regex.flags) {
      if (!PORTABLE_FLAGS.has(f)) {
        throw new Error(
          `secret-detect pattern ${p.rule_id} uses regex flag '${f}', which ` +
            `has no Python equivalent in secret_redact.py. Either drop the ` +
            `flag or extend the port before shipping the rule.`,
        );
      }
    }
    return {
      rule_id: p.rule_id,
      source: portableSource(p.regex.source),
      ignore_case: p.regex.flags.includes("i"),
      multiline: p.regex.flags.includes("m"),
      capture_index: p.captureIndex,
      ...(p.slugHint ? { slug_hint: p.slugHint } : {}),
    };
  });
  const doc = {
    _generated_by: "scripts/gen-secret-patterns.ts",
    _source_of_truth: "telegram-plugin/secret-detect/patterns.ts",
    _do_not_edit:
      "Run `bun scripts/gen-secret-patterns.ts` after changing patterns.ts. " +
      "`bun lint` fails when this file drifts from the TS table.",
    patterns,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
