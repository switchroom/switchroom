import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, utimesSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

// #3025: the gateway sidecar appends per-poll trace lines and the
// supervise loop only regains control on child EXIT — so a gateway that
// runs for weeks let gateway-supervisor.log grow to 555MB and fill the
// host disk. `_switchroom_log_rotator` is a background size checker that
// copytruncates the logfile when it exceeds SWITCHROOM_SIDECAR_LOG_MAX_BYTES.
//
// copytruncate (cp + `: >`) NOT `mv`: the supervised child holds an open
// fd on the logfile (`>> "$_logfile"`). A plain mv would orphan that fd —
// the child would keep writing to the renamed inode and the live path
// would stop growing. This test asserts the copytruncate outcome: the
// live file is truncated, a `.1` generation captures the old bytes, and
// a process still appending to the ORIGINAL fd keeps landing in the live
// file (proving the fd was preserved).

const TEMPLATE = join(__dirname, "..", "profiles", "_base", "start.sh.hbs");

// Extract the pure-shell _switchroom_log_rotator function from the
// handlebars template (its body contains no {{ }} tokens — asserted).
function extractRotator(): string {
  const src = readFileSync(TEMPLATE, "utf-8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes("_switchroom_log_rotator() {"));
  expect(start, "_switchroom_log_rotator() not found in start.sh.hbs").toBeGreaterThanOrEqual(0);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "  }") { end = i; break; }
  }
  expect(end, "closing brace of _switchroom_log_rotator not found").toBeGreaterThan(start);
  const fn = lines.slice(start, end + 1).map((l) => l.replace(/^ {2}/, "")).join("\n");
  expect(fn).not.toContain("{{");
  return fn;
}

let dir: string;
let fnPath: string;

/** The retained generation, whichever form it took (#3596 compresses on
 *  rotate when gzip is available, so it may be `.1` or `.1.gz`). */
function rotatedPath(log: string): string | null {
  if (existsSync(log + ".1.gz")) return log + ".1.gz";
  if (existsSync(log + ".1")) return log + ".1";
  return null;
}
function rotatedExists(log: string): boolean {
  return rotatedPath(log) !== null;
}
/** Uncompressed byte count of the retained generation. */
function rotatedRawSize(log: string): number {
  const p = rotatedPath(log);
  if (p === null) return 0;
  if (p.endsWith(".gz")) {
    return gunzipSync(readFileSync(p)).length;
  }
  return statSync(p).size;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rot-test-"));
  fnPath = join(dir, "rot.fn");
  writeFileSync(fnPath, extractRotator());
});

function runBash(script: string, env: Record<string, string>, timeoutMs: number): string {
  const p = join(dir, `drv-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(p, `set -u\nsource ${JSON.stringify(fnPath)}\n${script}\n`);
  try {
    return execFileSync("bash", [p], {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, ...env },
    });
  } finally {
    rmSync(p, { force: true });
  }
}

describe("_switchroom_log_rotator — #3025 size-based copytruncate", () => {
  it("rotates when the log exceeds the cap and keeps at most ~2x cap on disk", () => {
    const log = join(dir, "gw.log");
    // Start ~2000 bytes — over the 1000-byte cap below.
    writeFileSync(log, "x".repeat(2000) + "\n");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    // .1 generation captured the old (over-cap) content.
    expect(rotatedExists(log), "expected rotated .1 generation").toBe(true);
    expect(rotatedRawSize(log)).toBeGreaterThanOrEqual(2000);
    // Live file was truncated (only the small rotation-notice line remains).
    expect(statSync(log).size).toBeLessThan(1000);
    expect(readFileSync(log, "utf-8")).toContain("rotated");
  }, 15_000);

  it("does NOT rotate a log under the cap", () => {
    const log = join(dir, "small.log");
    writeFileSync(log, "y".repeat(100) + "\n");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    expect(rotatedExists(log)).toBe(false);
    expect(readFileSync(log, "utf-8")).not.toContain("rotated");
  }, 15_000);

  it("copytruncate preserves an already-open writer fd (mv would orphan it)", () => {
    const log = join(dir, "fd.log");
    writeFileSync(log, "z".repeat(2000) + "\n");
    // A background writer holds an fd open on the ORIGINAL path via `>>`
    // and appends a sentinel AFTER the rotate window. copytruncate keeps
    // that fd pointing at the (now-truncated) live inode, so the sentinel
    // must land in the live file — not vanish into an orphaned inode.
    // Timing margins are deliberately wide (interval 1s, sentinel at
    // t+3s, kill at t+5s): with the old t+2s sentinel a first check
    // that slipped past ~2s under CI load rotated AFTER the sentinel
    // was written and truncated it away — a pure-timing flake. Three
    // full intervals of slack before the sentinel makes that slip
    // practically impossible while keeping the test well under the
    // 15s timeout.
    runBash(
      `exec 9>> ${JSON.stringify(log)}
       _switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 3
       echo "SENTINEL_AFTER_ROTATE" >&9
       exec 9>&-
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    expect(rotatedExists(log)).toBe(true);
    expect(readFileSync(log, "utf-8")).toContain("SENTINEL_AFTER_ROTATE");
  }, 15_000);

  it("non-numeric interval falls back to the 300s default (no hot-spin)", () => {
    // Unvalidated, a garbage interval makes `sleep` fail instantly and the
    // `while true` loop spins tight — checking (and rotating) nonstop.
    // With the entry guard the interval falls back to 300s, so over a 2s
    // window NO check fires: the over-cap log must remain unrotated, which
    // is only possible if the fallback took effect (a spinning loop would
    // have rotated it within milliseconds).
    const log = join(dir, "garbage-interval.log");
    writeFileSync(log, "v".repeat(2000) + "\n");
    const stderrFile = join(dir, "garbage-interval.stderr");
    runBash(
      // stdout → /dev/null: killing the rotator subshell leaves its
      // in-flight external `sleep 300` child alive, and an inherited
      // stdout pipe would make execFileSync wait the full 300s on it.
      `_switchroom_log_rotator ${JSON.stringify(log)} > /dev/null 2> ${JSON.stringify(stderrFile)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "bogus",
      },
      15_000,
    );
    expect(rotatedExists(log)).toBe(false);
    expect(statSync(log).size).toBeGreaterThanOrEqual(2000);
    // No sleep/test shell errors — the loop slept cleanly on the default.
    expect(readFileSync(stderrFile, "utf-8")).toBe("");
  }, 15_000);

  it("non-numeric cap falls back to the 50MiB default (no per-cycle shell errors)", () => {
    // Unvalidated, a garbage cap makes `[ size -gt max ]` error every
    // cycle, spamming a shell error line to the container stdout forever.
    // With the guard the cap falls back to 50MiB: a small log is left
    // alone and the checker runs its cycles silently.
    const log = join(dir, "garbage-cap.log");
    writeFileSync(log, "u".repeat(2000) + "\n");
    const stderrFile = join(dir, "garbage-cap.stderr");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} 2> ${JSON.stringify(stderrFile)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "not-a-number",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    expect(rotatedExists(log)).toBe(false);
    expect(statSync(log).size).toBeGreaterThanOrEqual(2000);
    expect(readFileSync(stderrFile, "utf-8")).toBe("");
  }, 15_000);

  it("a cap of 0 disables rotation (operator escape hatch)", () => {
    const log = join(dir, "disabled.log");
    writeFileSync(log, "w".repeat(5000) + "\n");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "0",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    expect(rotatedExists(log)).toBe(false);
    expect(statSync(log).size).toBeGreaterThanOrEqual(5000);
  }, 15_000);
});

describe("_switchroom_log_rotator — #3596 the .1 generation is bounded", () => {
  // Before #3596 the `.1` file was written once and NEVER reaped: on the
  // live host clerk/gateway-supervisor.log.1 sat at 582 MB (dated Jul 11)
  // while the live log was ~5 MB, i.e. months from being overwritten by
  // the next rotation. Two bounds now apply — compress on rotate, and an
  // age reaper that runs every cycle whether or not a rotation happens.

  it("compresses the rotated generation (the 582 MB .1 case)", () => {
    const log = join(dir, "gz.log");
    // Highly compressible 200 KB — gzip must shrink it dramatically.
    writeFileSync(log, "a".repeat(200_000) + "\n");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    expect(existsSync(log + ".1.gz"), "expected a compressed .1.gz").toBe(true);
    expect(existsSync(log + ".1"), "plain .1 should be gone").toBe(false);
    // Content preserved, on-disk footprint slashed.
    expect(gunzipSync(readFileSync(log + ".1.gz")).length).toBeGreaterThanOrEqual(200_000);
    expect(statSync(log + ".1.gz").size).toBeLessThan(20_000);
  }, 15_000);

  it("SWITCHROOM_SIDECAR_LOG_COMPRESS=0 keeps the plain .1", () => {
    const log = join(dir, "nogz.log");
    writeFileSync(log, "b".repeat(2000) + "\n");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
        SWITCHROOM_SIDECAR_LOG_COMPRESS: "0",
      },
      15_000,
    );
    expect(existsSync(log + ".1")).toBe(true);
    expect(existsSync(log + ".1.gz")).toBe(false);
  }, 15_000);

  it("reaps an aged .1 even when the live log never crosses the cap", () => {
    // THE regression this exists for: a small live log means no rotation
    // ever fires, so pre-#3596 nothing would ever touch the stale .1.
    const log = join(dir, "aged.log");
    writeFileSync(log, "small\n");
    const stale = log + ".1";
    writeFileSync(stale, "c".repeat(50_000));
    // Backdate 30 days.
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(stale, old, old);
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
        SWITCHROOM_SIDECAR_LOG_ROTATE_MAX_AGE_SEC: "86400", // 1 day
      },
      15_000,
    );
    expect(existsSync(stale), "aged .1 should have been reaped").toBe(false);
    // The live log is untouched (no rotation was warranted).
    expect(readFileSync(log, "utf-8")).toContain("small");
  }, 15_000);

  it("reaps an aged .1.gz too", () => {
    const log = join(dir, "aged-gz.log");
    writeFileSync(log, "small\n");
    const stale = log + ".1.gz";
    writeFileSync(stale, "not-really-gzip-but-name-matches");
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    utimesSync(stale, old, old);
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
        SWITCHROOM_SIDECAR_LOG_ROTATE_MAX_AGE_SEC: "86400",
      },
      15_000,
    );
    expect(existsSync(stale)).toBe(false);
  }, 15_000);

  it("does NOT reap a fresh .1", () => {
    const log = join(dir, "fresh.log");
    writeFileSync(log, "small\n");
    const fresh = log + ".1";
    writeFileSync(fresh, "d".repeat(5000));
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
        SWITCHROOM_SIDECAR_LOG_ROTATE_MAX_AGE_SEC: "86400",
      },
      15_000,
    );
    expect(existsSync(fresh)).toBe(true);
    expect(statSync(fresh).size).toBe(5000);
  }, 15_000);

  it("a garbage max-age falls back to the 14d default (no shell errors)", () => {
    const log = join(dir, "garbage-age.log");
    writeFileSync(log, "small\n");
    const stale = log + ".1";
    writeFileSync(stale, "e".repeat(5000));
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000); // 3d — under 14d
    utimesSync(stale, old, old);
    const stderrFile = join(dir, "garbage-age.stderr");
    runBash(
      `_switchroom_log_rotator ${JSON.stringify(log)} 2> ${JSON.stringify(stderrFile)} & RPID=$!
       sleep 2; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
        SWITCHROOM_SIDECAR_LOG_ROTATE_MAX_AGE_SEC: "bogus",
      },
      15_000,
    );
    expect(existsSync(stale), "3d-old .1 is under the 14d default").toBe(true);
    expect(readFileSync(stderrFile, "utf-8")).toBe("");
  }, 15_000);
});
