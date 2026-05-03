// Post-build pass: replace every non-ASCII UTF-16 code unit in a bundle
// with a `\uHHHH` escape, leaving the bundle pure ASCII.
//
// Why this exists:
//
// Bun's parser/runtime has a bug where raw UTF-8 bytes in source files
// past a certain offset (~172kB into our CLI bundle) are misinterpreted
// as Latin-1 — each UTF-8 byte becomes its own JS code unit. The em-dash
// `e2 80 94` (one codepoint U+2014) loads as three codepoints U+00E2,
// U+0080, U+0094 (length=3). When that string is re-emitted to stdout or
// a file, each U+00xx codepoint encodes as two-byte UTF-8 (`c3 a2`,
// `c2 80`, `c2 94`), producing the classic double-UTF-8 "mojibake" the
// user reported in #642 boot cards and the agent-list "Uptime" column.
//
// At the top of the bundle, the same bytes parse correctly. So the bug
// isn't bun-wide — something in bun's JS lexer flips encoding state
// somewhere into a large bundle. Reproduced empirically by injecting a
// `Buffer.from("\xe2\x80\x94","utf-8").toString("hex")` print at byte
// offset 0 (clean: `e28094`) vs ~1.16MB (mojibake: `c3a2c280c294`).
//
// The safe, target-agnostic fix is to ship the bundle ASCII-only.
// Every code unit > 0x7F becomes its `\uHHHH` escape; surrogate pairs
// (astral codepoints like 💬 U+1F4AC) are escaped as two `\uHHHH` units
// to preserve regex compatibility (`\u{...}` requires the `u` flag).
// The transform is universal: strings, template literals, regex
// literals, and comments all accept `\uHHHH` without semantic change.
//
// JS identifiers may legally contain non-ASCII chars but our codebase
// doesn't use any (verified: every non-ASCII byte in the CLI bundle
// sits inside a string, regex, or comment). If that ever changes,
// replace this transform with a parser-aware one.
//
// This is the same defence esbuild ships under `--charset=ascii`. Bun
// build doesn't expose a charset flag (as of 1.3.13), so we apply the
// transform ourselves.

import { readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";

/**
 * @param {string} bundlePath
 */
export function escapeBundleNonAscii(bundlePath) {
  const original = readFileSync(bundlePath, "utf-8");
  // Walk JS code units (UTF-16). Every code unit > 0x7F gets escaped.
  // Surrogate pairs (astral codepoints) become two \uHHHH escapes — safe
  // in strings/templates/regex without the `u` flag.
  let escaped = "";
  let nonAsciiCount = 0;
  for (let i = 0; i < original.length; i++) {
    const cu = original.charCodeAt(i);
    if (cu < 0x80) {
      escaped += original[i];
    } else {
      escaped += "\\u" + cu.toString(16).padStart(4, "0");
      nonAsciiCount++;
    }
  }
  if (nonAsciiCount === 0) return { changed: false, nonAsciiCount: 0 };
  // Preserve mode bits (the bundle is executable).
  const mode = statSync(bundlePath).mode;
  writeFileSync(bundlePath, escaped, { encoding: "ascii" });
  chmodSync(bundlePath, mode);
  return { changed: true, nonAsciiCount };
}
