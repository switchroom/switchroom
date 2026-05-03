// Regression test for #642 follow-up: bundle ASCII-only invariant.
//
// Bun's parser/runtime has a bug where raw UTF-8 bytes in string literals
// past a certain offset (~172kB into a large bundle) get misinterpreted
// as Latin-1 at runtime — each UTF-8 byte becomes its own JS code unit,
// then re-emitted as two-byte UTF-8 on stdout/file write, producing
// classic double-encoded mojibake. The user-visible symptom was the
// boot card showing `â LawGPT back up Â· v0.6.3` and the agent-list
// "Uptime" column rendering as garbage.
//
// The fix (scripts/escape-bundle-non-ascii.mjs) post-processes built
// bundles to escape every non-ASCII code unit as `\uHHHH`. This test
// asserts the invariant directly: built bundles must contain no bytes
// > 0x7F. The test runs after `npm run build` produces dist/ — it's
// gated on the artefacts existing so a fresh checkout without a build
// doesn't fail (vitest's --run will skip).
//
// If this test ever fails: either the post-build escape pass was
// removed/skipped, or a new build target was added without wiring the
// escape pass into it. Re-add the call to `escapeBundleNonAscii(outFile)`
// after the bundle is written.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BUNDLES = [
  "dist/cli/switchroom.js",
  "telegram-plugin/dist/gateway/gateway.js",
  "telegram-plugin/dist/server.js",
  "telegram-plugin/dist/bridge/bridge.js",
  "telegram-plugin/dist/foreman/foreman.js",
];

describe("bundle ASCII-only invariant (#642 follow-up)", () => {
  for (const rel of BUNDLES) {
    const path = resolve(repoRoot, rel);
    it(`${rel} contains no bytes > 0x7F`, () => {
      if (!existsSync(path)) {
        // Fresh checkout, no build yet. Skipping is fine — the lint /
        // prepublish flow rebuilds before tests anyway.
        return;
      }
      const buf = readFileSync(path);
      const offenders: number[] = [];
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] > 0x7f) {
          offenders.push(i);
          if (offenders.length >= 5) break;
        }
      }
      if (offenders.length > 0) {
        const samples = offenders.map((i) => {
          const start = Math.max(0, i - 20);
          const end = Math.min(buf.length, i + 20);
          return `  @${i}: ${JSON.stringify(buf.subarray(start, end).toString("utf-8"))}`;
        });
        throw new Error(
          `${rel} contains non-ASCII bytes — bun parser will mojibake them at runtime.\n` +
            `Run \`npm run build\` (which now applies escapeBundleNonAscii). Samples:\n` +
            samples.join("\n"),
        );
      }
      expect(offenders.length).toBe(0);
    });
  }
});
