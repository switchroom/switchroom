import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
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
    expect(existsSync(log + ".1"), "expected rotated .1 generation").toBe(true);
    expect(statSync(log + ".1").size).toBeGreaterThanOrEqual(2000);
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
    expect(existsSync(log + ".1")).toBe(false);
    expect(readFileSync(log, "utf-8")).not.toContain("rotated");
  }, 15_000);

  it("copytruncate preserves an already-open writer fd (mv would orphan it)", () => {
    const log = join(dir, "fd.log");
    writeFileSync(log, "z".repeat(2000) + "\n");
    // A background writer holds an fd open on the ORIGINAL path via `>>`
    // and appends a sentinel AFTER the rotate window. copytruncate keeps
    // that fd pointing at the (now-truncated) live inode, so the sentinel
    // must land in the live file — not vanish into an orphaned inode.
    runBash(
      `exec 9>> ${JSON.stringify(log)}
       _switchroom_log_rotator ${JSON.stringify(log)} & RPID=$!
       sleep 2
       echo "SENTINEL_AFTER_ROTATE" >&9
       exec 9>&-
       sleep 1; kill "$RPID" 2>/dev/null; wait "$RPID" 2>/dev/null; true`,
      {
        SWITCHROOM_SIDECAR_LOG_MAX_BYTES: "1000",
        SWITCHROOM_SIDECAR_LOG_ROTATE_INTERVAL_SEC: "1",
      },
      15_000,
    );
    expect(existsSync(log + ".1")).toBe(true);
    expect(readFileSync(log, "utf-8")).toContain("SENTINEL_AFTER_ROTATE");
  }, 15_000);

  it("a non-positive cap disables rotation (operator escape hatch)", () => {
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
    expect(existsSync(log + ".1")).toBe(false);
    expect(statSync(log).size).toBeGreaterThanOrEqual(5000);
  }, 15_000);
});
