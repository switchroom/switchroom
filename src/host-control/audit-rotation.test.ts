/**
 * #3596 — `~/.switchroom/host-control-audit.log` grew without bound
 * (44,325,086 bytes on the live host, rows ~4 KiB each because they carry
 * redacted terminal tails). These tests assert the OUTCOMES an unbounded
 * log fails:
 *
 *   1. writing far past the cap leaves a bounded active file,
 *   2. the old rows survive in `.1` (nothing is silently discarded),
 *   3. the hash chain across the rotation seam is NOT scored as tampering
 *      and every row stays self-consistent,
 *   4. the reader still returns pre-rotation history after a rotation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HostdServer } from "./server.js";
import { readAuditRaw, readAndFilter, parseAuditLine } from "./audit-reader.js";
import { verifyAuditLog } from "../util/audit-hashchain.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostd-audit-rot-"));
  logPath = path.join(dir, "host-control-audit.log");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeServer(maxBytes: number, maxFiles = 2): HostdServer {
  return new HostdServer({
    homeDir: dir,
    auditLogPath: logPath,
    auditMaxBytes: maxBytes,
    auditMaxFiles: maxFiles,
    agents: [],
  } as unknown as ConstructorParameters<typeof HostdServer>[0]);
}

/** Write N audit rows through the real (private) append path. */
async function writeRows(
  server: HostdServer,
  n: number,
  pad = 2000,
): Promise<void> {
  const append = (
    server as unknown as {
      appendAuditRow: (r: Record<string, unknown>) => Promise<void>;
    }
  ).appendAuditRow.bind(server);
  for (let i = 0; i < n; i++) {
    await append({
      ts: new Date(1_700_000_000_000 + i).toISOString(),
      op: "agent_restart",
      caller: { kind: "agent", name: "reggie" },
      request_id: `req-${i}`,
      result: "ok",
      exit_code: 0,
      duration_ms: 1,
      stdout_tail: "z".repeat(pad),
    });
  }
}

describe("hostd audit log rotation (#3596)", () => {
  it("bounds the active log instead of growing to 44 MB", async () => {
    const cap = 32 * 1024;
    const server = makeServer(cap);
    await writeRows(server, 60); // ≈ 130 KB of rows, 4x the cap
    const active = fs.statSync(logPath).size;
    // One row can push past the cap before the NEXT check rotates, so
    // allow one row of slack — but nothing like the unbounded total.
    expect(active).toBeLessThan(cap + 8 * 1024);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    const total = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("host-control-audit.log"))
      .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThan((2 + 1) * (cap + 8 * 1024));
  });

  it("retains at most maxFiles generations", async () => {
    const server = makeServer(8 * 1024, 2);
    await writeRows(server, 60);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
  });

  it("keeps the hash chain valid across the rotation seam", async () => {
    const server = makeServer(16 * 1024);
    await writeRows(server, 40);
    // Rows written after the seam live in the active file and continue
    // the in-process chain (no re-seed) — every row must still be
    // self-consistent, and the verdict must be "ok", never "tampered".
    for (const p of [`${logPath}.1`, logPath]) {
      const verdict = verifyAuditLog(fs.readFileSync(p, "utf-8"));
      expect(verdict.state, `${p}: ${verdict.reason ?? ""}`).toBe("ok");
      expect(verdict.chainedRows).toBeGreaterThan(0);
    }
    // Concatenated (rotated + active) the sequence is continuous — the
    // rotation itself introduced no segment break.
    const joined = verifyAuditLog(
      fs.readFileSync(`${logPath}.1`, "utf-8") +
        fs.readFileSync(logPath, "utf-8"),
    );
    expect(joined.state).toBe("ok");
    expect(joined.segments).toBe(1);
  });

  it("the reader still surfaces pre-rotation rows after a rotation", async () => {
    // Cap small enough to force a rotation, retention deep enough that the
    // first row is still ON DISK (retention-dropped rows are gone by
    // design — that's the "retains at most maxFiles" test above).
    const server = makeServer(64 * 1024, 3);
    await writeRows(server, 40);
    // The active file alone holds only the tail; the seam-aware reader
    // back-fills from `.1`, so early request ids are still visible.
    const activeOnly = readAndFilter(
      fs.readFileSync(logPath, "utf-8"),
      {},
      1000,
    ).map((e) => e.request_id);
    const seamAware = readAndFilter(readAuditRaw(logPath), {}, 1000).map(
      (e) => e.request_id,
    );
    expect(activeOnly).not.toContain("req-0");
    expect(seamAware).toContain("req-0");
    expect(seamAware).toContain("req-39");
    expect(seamAware.length).toBeGreaterThan(activeOnly.length);
    // Chronological order is preserved across the seam.
    expect(seamAware.indexOf("req-0")).toBeLessThan(
      seamAware.indexOf("req-39"),
    );
  });

  it("readAuditRaw drops a torn leading line rather than emitting garbage", async () => {
    const server = makeServer(16 * 1024);
    await writeRows(server, 40);
    // Simulate a rotated file whose first line is torn (crash mid-append)
    // by reading with a window smaller than the file, forcing a mid-line
    // start inside `.1`.
    const raw = readAuditRaw(logPath, 4 * 1024);
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue;
      // Every emitted line must be parseable — the torn one was dropped.
      expect(parseAuditLine(line)).not.toBeNull();
    }
  });

  it("a negative cap disables rotation entirely", async () => {
    const server = makeServer(-1);
    await writeRows(server, 20);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(fs.statSync(logPath).size).toBeGreaterThan(20 * 2000);
  });
});
