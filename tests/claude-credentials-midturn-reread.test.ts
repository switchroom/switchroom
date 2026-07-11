/**
 * Mid-turn credential pickup contract (#3031 PR 4) — asserted against the
 * ACTUALLY-INSTALLED `claude` binary, like claude-cli-contract.test.ts.
 *
 * The invariant the whole RFC-H single-writer design (and the proactive
 * failover plan's "a broker roll is seamless for in-flight sessions" claim)
 * rests on: a RUNNING claude process re-reads
 * `<CLAUDE_CONFIG_DIR>/.credentials.json` on subsequent API requests, so the
 * broker's atomic mirror rewrite (token refresh OR account swap) takes effect
 * on the next request WITHOUT a process restart.
 *
 * Mechanism (verified against claude 2.1.205's embedded string table): the
 * request path calls its ensure-fresh-token routine before building auth
 * headers; that routine `stat()`s `.credentials.json` and, when `mtimeMs`
 * differs from the last-seen value, clears the in-memory token caches — the
 * next read pulls the new bytes off disk. Minified:
 *
 *   async function lch(){try{let{mtimeMs:e}=await X.stat(join(Wde(),
 *     ".credentials.json"));if(e!==Idc)Idc=e,v8()}catch{...}}
 *
 * This test scans the installed binary for that signature: an occurrence of
 * `.credentials.json` with `mtimeMs` within the preceding window. Identifier
 * names churn per release; the co-location of the literal filename and the
 * stat field is the stable fingerprint. If a future claude release drops it,
 * this fails — and the fleet must then treat every account swap as
 * restart-required, which changes the failover announcement's promises.
 *
 * SELF-SKIP when `claude` is not installed (plain CI vitest job); RUNS on dev
 * boxes, the docker images, and the nightly latest-claude canary.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";

/** Resolve the real installed claude entrypoint, or null (→ self-skip). */
function resolveClaudeBinary(): string | null {
  try {
    const onPath = execFileSync("which", ["claude"], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    if (!onPath) return null;
    return realpathSync(onPath);
  } catch {
    return null;
  }
}

/**
 * Stream-scan a (potentially ~250MB) binary for a `needle` that has `marker`
 * within the `windowBytes` preceding it. Chunked with overlap so matches
 * spanning a chunk boundary aren't missed. Latin1 keeps byte offsets exact.
 *
 * HONEST SIGNAL: this proves "the mtime-watch SIGNATURE is present in the
 * bundle", not "the pre-request re-read mechanism is wired". A future
 * release could keep a stat(.credentials.json)-near-mtimeMs fragment
 * somewhere unrelated while dropping the per-request call — that would
 * false-pass here. The behavioural proof (a real turn picking up a swapped
 * mirror) needs a live authenticated session and belongs to UAT/canary
 * round-trips; this scan is the cheap early-warning tripwire, nothing more.
 */
function scanForMarkerBeforeNeedle(
  file: string,
  needle: string,
  marker: string,
  windowBytes: number,
): boolean {
  const CHUNK = 8 * 1024 * 1024;
  const overlap = needle.length + windowBytes;
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.min(CHUNK, size));
    let pos = 0;
    let carry = "";
    while (pos < size) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const text = carry + buf.toString("latin1", 0, n);
      let idx = text.indexOf(needle);
      while (idx !== -1) {
        const windowStart = Math.max(0, idx - windowBytes);
        if (text.slice(windowStart, idx).includes(marker)) return true;
        idx = text.indexOf(needle, idx + 1);
      }
      carry = text.slice(Math.max(0, text.length - overlap));
      pos += n;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

const CLAUDE_BIN = resolveClaudeBinary();

describe.skipIf(!CLAUDE_BIN)("claude CLI — mid-turn credential re-read contract", () => {
  it("the binary stats .credentials.json for mtime changes (mid-session mirror pickup)", () => {
    const found = scanForMarkerBeforeNeedle(
      CLAUDE_BIN!,
      ".credentials.json",
      "mtimeMs",
      300,
    );
    expect(
      found,
      `installed claude (${CLAUDE_BIN}) no longer carries the ` +
        "mtime-watch on .credentials.json — mid-session credential pickup " +
        "may be BROKEN. If real: broker account swaps are no longer seamless " +
        "for running sessions; failover messaging and the proactive-roll " +
        "design (#3031) must be revisited before bumping the claude pin.",
    ).toBe(true);
  });
});
