/**
 * Every tracked source file must be TEXT as far as git is concerned.
 *
 * Why this is a test and not a style preference: git classifies a blob as
 * binary when it finds a NUL byte in the first 8000 bytes, and a binary blob
 * loses the things review depends on. `src/litellm/key-allowlist.ts` shipped
 * into PR #3676 with a raw NUL inside a template literal — written as a real
 * `\0` character rather than the `\u0000` escape — and the consequences were
 * not cosmetic:
 *
 *   - the file showed as `+0/-0` / `Bin 0 -> 11340 bytes` in the PR, so 253
 *     lines of new logic were literally unreviewable on GitHub;
 *   - `git diff` / `git blame` / `git log -p` produce nothing for it, on that
 *     PR and on every future one;
 *   - git cannot 3-way TEXT-merge a binary blob, so any concurrent edit turns
 *     a routine rebase into a whole-file "take ours or take theirs" choice —
 *     the shape that quietly drops someone else's change.
 *
 * A reviewer cannot catch this by reading the diff, because the diff is
 * exactly what goes missing. So it has to be mechanical.
 *
 * Escaped forms (`"\u0000"`, `"\x00"`, `String.fromCharCode(0)`) are all fine
 * and unaffected — this only rejects a raw NUL byte in the file itself.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Extensions that must never contain a raw NUL. */
const TEXT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".yml",
  ".yaml",
  ".sh",
  ".py",
];

/**
 * Tracked files PLUS new, not-yet-committed, not-ignored ones.
 *
 * `--others --exclude-standard` is not optional polish. A plain `git ls-files`
 * sees only what is already committed, so the offending file in a brand new
 * commit — precisely the case this test exists for — is invisible to the author
 * running the suite locally, and the first failure lands on someone else in CI.
 * This test was itself written with a raw NUL in its own docstring and passed,
 * for exactly that reason. Deduped because a modified tracked file appears in
 * `--cached`, and staged-and-modified can appear twice there.
 */
function candidateTextFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const paths = out
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => TEXT_EXTENSIONS.some((ext) => p.endsWith(ext)));
  return [...new Set(paths)];
}

/**
 * Vitest's default per-test timeout is 5s, which is not enough here on a COLD
 * page cache: this reads ~2,600 files, and measured on the fleet host the first
 * run after a fresh checkout took 10.1s while every subsequent run took 71ms —
 * same work, same files, cache the only difference. A CI runner is always the
 * cold case, so the default would make this test a coin flip rather than a
 * guard. It is I/O-bound by design (the whole point is to look at every file),
 * so the right answer is a timeout sized for the I/O, not less scanning.
 */
const SCAN_TIMEOUT_MS = 60_000;

describe("source files are text, not binary (PR #3676 regression)", () => {
  it("contains no raw NUL byte in any tracked or newly added text file", () => {
    const offenders: string[] = [];
    for (const rel of candidateTextFiles()) {
      let buf: Buffer;
      try {
        buf = readFileSync(resolve(repoRoot, rel));
      } catch {
        continue; // deleted-but-still-indexed during a rebase; not our concern
      }
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${rel} (first NUL at byte ${at})`);
    }
    // Named, not just counted — the whole point is that the diff can't tell you.
    expect(offenders).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});
