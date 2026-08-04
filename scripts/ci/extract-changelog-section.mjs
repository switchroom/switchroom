#!/usr/bin/env node
/**
 * Half-ship gate, leg 3: turn a tag push into a GitHub Release even when the
 * operator SKIPPED `gh release create` (#4331, follow-up to #3654).
 *
 * THE FAILURE THIS EXISTS FOR. v0.20.3 and v0.20.4 were tagged, image-built,
 * and rolled to the fleet — but no GitHub Release object was ever created for
 * them, so release.yml's `guard` job failed at "no GitHub Release exists",
 * `publish`/`npm`/`finalize` were skipped, and npm `latest` silently stayed
 * at 0.20.2. Users got ETARGET on `npm i -g switchroom@0.20.4`. The tag push
 * SHOULD be sufficient: the release notes are already authored in CHANGELOG.md
 * (the release commit is CHANGELOG-only), so `guard` can auto-create the
 * DRAFT release from that section and proceed. The manual `gh release create`
 * step becomes belt-and-suspenders, not a load-bearing gate whose omission
 * silently skips the irreversible npm publish.
 *
 * This script is the mechanical "what are the release notes for vX.Y.Z?"
 * half of that auto-heal. It NEVER invents notes: if CHANGELOG.md has no
 * section for the tag (or the section is empty), it FAILS LOUDLY with a
 * non-zero exit so `guard` blocks the release instead of shipping an empty
 * one. Loud-and-blocked beats silent-and-skipped, which is the whole lesson.
 *
 * SHAPE: pure text extraction, no network. Reads CHANGELOG.md, matches the
 * `## vX.Y.Z` heading whose version token EQUALS the tag (not a prefix — so
 * v0.20.4 never matches v0.20.40), and returns everything up to the next
 * `## ` heading. Node-stdlib only, so it runs on a bare checkout with no
 * node_modules, same as the other scripts/ci gate scripts.
 *
 * Version matching keys on the FIRST token of the heading, compared with the
 * leading `v` stripped from both sides, so `## v0.20.4 — summary`,
 * `## 0.20.4`, and a tag of either `v0.20.4` or `0.20.4` all agree. The rest
 * of the heading line (after an em/en dash or hyphen separator) is the human
 * summary and is preserved as the release title.
 *
 * Exit codes:
 *   0 — section found; title printed to stdout, notes written to --notes-out
 *   4 — no CHANGELOG section exists for this tag
 *   5 — a section heading exists but its body is empty
 *   1 — bad input / unreadable CHANGELOG (never treated as "fine")
 */

import { readFileSync, writeFileSync } from "node:fs";

export const EXIT = { ok: 0, badInput: 1, notFound: 4, empty: 5 };

/**
 * Normalise a version token for comparison: strip a single leading `v` and
 * surrounding whitespace. `v0.20.4` and `0.20.4` compare equal; nothing else
 * is coerced, so `v0.20.40` stays distinct from `v0.20.4`.
 *
 * @param {string} token
 * @returns {string}
 */
export function normalizeVersion(token) {
  return String(token ?? "").trim().replace(/^v/, "");
}

/**
 * Parse a `## ` heading line into its version token and human summary.
 * Returns null for any line that is not a level-2 heading whose first token
 * looks like a semver version (so `## Unreleased` and prose are ignored).
 *
 * @param {string} line
 * @returns {{ version: string, title: string } | null}
 */
export function parseHeading(line) {
  const m = /^##\s+(.*\S)\s*$/.exec(line);
  if (!m) return null;
  const title = m[1];
  const first = title.split(/\s+/)[0];
  if (!/^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(first)) return null;
  return { version: first, title };
}

/**
 * Extract the CHANGELOG section for a tag.
 *
 * @param {string} changelog raw CHANGELOG.md text
 * @param {string} tag e.g. `v0.20.4` (or `0.20.4`)
 * @returns {{ found: false } | { found: true, title: string, notes: string }}
 */
export function extractSection(changelog, tag) {
  const want = normalizeVersion(tag);
  const lines = String(changelog ?? "").split("\n");

  let start = -1;
  let title = "";
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i]);
    if (h && normalizeVersion(h.version) === want) {
      start = i;
      title = h.title;
      break;
    }
  }
  if (start === -1) return { found: false };

  // Body runs from the line after the heading to the next `## ` heading of
  // ANY kind (the next version section, or `## Unreleased` above it never
  // applies since sections are newest-first). A `### ` sub-heading inside the
  // section is part of the body, so match `## ` followed by a non-`#`.
  const body = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s+\S/.test(lines[j]) && !/^###/.test(lines[j])) break;
    body.push(lines[j]);
  }
  const notes = body.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return { found: true, title, notes };
}

/* c8 ignore start — CLI wiring, covered end-to-end by spawnSync tests. */
function parseArgs(argv) {
  const out = { tag: "", changelog: "CHANGELOG.md", notesOut: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tag") out.tag = argv[++i] ?? "";
    else if (a === "--changelog") out.changelog = argv[++i] ?? "";
    else if (a === "--notes-out") out.notesOut = argv[++i] ?? "";
    else if (!out.tag) out.tag = a; // positional tag
  }
  return out;
}

function main() {
  const { tag, changelog, notesOut } = parseArgs(process.argv.slice(2));
  if (!tag) {
    console.error("::error::extract-changelog-section: a tag is required (--tag vX.Y.Z)");
    process.exit(EXIT.badInput);
  }

  let raw;
  try {
    raw = readFileSync(changelog, "utf-8");
  } catch (err) {
    console.error(`::error::extract-changelog-section: cannot read ${changelog}: ${err.message}`);
    process.exit(EXIT.badInput);
  }

  const res = extractSection(raw, tag);
  if (!res.found) {
    console.error(
      `::error::no CHANGELOG.md section for ${tag}. The release commit is CHANGELOG-only (skills/switchroom-release/SKILL.md step 1) — add a \`## ${tag} — <summary>\` section with the release notes, then re-run. Refusing to auto-create an empty GitHub Release.`,
    );
    process.exit(EXIT.notFound);
  }
  if (res.notes.trim() === "") {
    console.error(
      `::error::the CHANGELOG.md section for ${tag} is empty. Fill in the release notes under \`## ${res.title}\`, then re-run. Refusing to auto-create an empty GitHub Release.`,
    );
    process.exit(EXIT.empty);
  }

  if (notesOut) {
    writeFileSync(notesOut, res.notes + "\n");
  } else {
    process.stdout.write(res.notes + "\n");
  }
  // The title goes to stderr when notes go to stdout so the two never mix;
  // when notes are written to a file, the caller reads the title off stdout.
  if (notesOut) {
    process.stdout.write(res.title + "\n");
  } else {
    console.error(res.title);
  }
  process.exit(EXIT.ok);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
/* c8 ignore stop */
