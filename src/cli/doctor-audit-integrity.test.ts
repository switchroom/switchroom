/**
 * doctor-audit-integrity — WS10-F4 (#1420). Pins the detection
 * contract: missing/empty/unchained-legacy → warn (actionable, not a
 * tamper signal), chained-valid → ok, chained-broken → fail.
 */

import { describe, it, expect } from "vitest";

import { runAuditIntegrityChecks } from "./doctor-audit-integrity.js";
import { chainRow, CHAIN_GENESIS, type ChainState } from "../util/audit-hashchain.js";

const HOME = "/h";
const VAULT = "/h/.switchroom/vault-audit.log";
const HOSTD = "/h/.switchroom/host-control-audit.log";

function chainedLog(rows: Record<string, unknown>[]): string {
  return chainedFrom({ seq: 0, lastHash: CHAIN_GENESIS }, rows);
}

/** Chain rows starting from an arbitrary state — used to simulate a
 *  real post-rollout host where the broker's seedChain poisoned the
 *  anchor off a pre-#1433 legacy tail (first chained row has
 *  _seq=1, _prev="CORRUPT-TAIL-…", NOT GENESIS). */
function chainedFrom(
  initial: ChainState,
  rows: Record<string, unknown>[],
): string {
  let st = initial;
  let t = "";
  for (const r of rows) {
    const { line, next } = chainRow(st, r);
    t += line;
    st = next;
  }
  return t;
}

/** A legacy (pre-#1433, unchained) audit row — plain JSON, no _seq. */
function legacyRow(o: Record<string, unknown>): string {
  return JSON.stringify({ caller: "c", pid: 1, result: "allowed", ...o }) + "\n";
}

/** A reader that serves `files[path]`; absent path → throw (ENOENT). */
function reader(files: Record<string, string>) {
  return (p: string) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };
}

function run(files: Record<string, string>) {
  return runAuditIntegrityChecks({ homeDir: HOME, readFileSync: reader(files) });
}

describe("runAuditIntegrityChecks", () => {
  it("warns when a root audit log is missing", () => {
    const r = run({ [VAULT]: chainedLog([{ ts: "t", op: "get" }]) });
    const hostd = r.find((c) => c.name.includes("hostd audit log present"));
    expect(hostd?.status).toBe("warn");
  });

  it("warns when a log exists but is empty (F3 fail-open symptom)", () => {
    const r = run({ [VAULT]: "", [HOSTD]: chainedLog([{ ts: "t", op: "x" }]) });
    expect(
      r.find((c) => c.name.includes("vault-broker audit log non-empty"))?.status,
    ).toBe("warn");
  });

  it("warns (NOT fail) on a pre-#1433 legacy unchained log", () => {
    const legacy =
      JSON.stringify({ ts: "t", op: "get", caller: "c", pid: 1, result: "allowed" }) +
      "\n";
    const r = run({ [VAULT]: legacy, [HOSTD]: legacy });
    const c = r.find((x) => x.name.includes("vault-broker audit tamper-evidence"));
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/legacy log/);
  });

  it("ok when the chain verifies from genesis", () => {
    const good = chainedLog([
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
    ]);
    const r = run({ [VAULT]: good, [HOSTD]: good });
    expect(
      r.filter((c) => c.name.includes("audit chain valid") && c.status === "ok"),
    ).toHaveLength(2);
  });

  it("FAILS when a chained log was tampered", () => {
    const good = chainedLog([
      { ts: "t1", op: "get", key: "a" },
      { ts: "t2", op: "put", key: "b" },
    ]);
    const lines = good.trim().split("\n");
    const row0 = JSON.parse(lines[0]);
    row0.key = "TAMPERED";
    lines[0] = JSON.stringify(row0);
    const tampered = lines.join("\n") + "\n";
    const r = run({ [VAULT]: tampered, [HOSTD]: chainedLog([{ ts: "t", op: "x" }]) });
    const broken = r.find((c) => c.name.includes("vault-broker audit chain BROKEN"));
    expect(broken?.status).toBe("fail");
    expect(broken?.detail).toMatch(/file line 1/);
  });

  // ── Mixed legacy→chained logs — the real post-rollout host shape.
  // Any host that predates #1433 keeps appending to the SAME log, so
  // it has a pre-#1433 legacy PREAMBLE then chained rows. The old
  // looksChained() inspected only the first row, so these were
  // permanently misreported "pre-#1433 legacy / inactive" (warn that
  // never clears) AND verifyAuditChain never ran (a tampered chained
  // suffix behind the preamble was undetectable).

  it("ok on a pre-#1433 legacy preamble followed by a VALID chained suffix", () => {
    const legacy = legacyRow({ ts: "L1", op: "get" }) + legacyRow({ ts: "L2", op: "put" });
    // Real host: seedChain poisoned the anchor off the legacy tail.
    const chained = chainedFrom({ seq: 0, lastHash: "CORRUPT-TAIL-deadbeef" }, [
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
    ]);
    const log = legacy + chained;
    const r = run({ [VAULT]: log, [HOSTD]: log });
    const c = r.find((x) => x.name.includes("vault-broker audit chain valid"));
    expect(c?.status).toBe("ok");
    expect(c?.detail).toMatch(/2 pre-#1433 legacy preamble row\(s\)/);
    expect(c?.detail).toMatch(/tamper-evidence active/);
    // Must NOT be the stale "legacy / inactive" warn anymore.
    expect(
      r.find((x) => x.name.includes("vault-broker audit tamper-evidence")),
    ).toBeUndefined();
  });

  it("FAILS (not warn) when the chained suffix behind a legacy preamble is tampered", () => {
    const legacy = legacyRow({ ts: "L1", op: "get" });
    const chained = chainedFrom({ seq: 0, lastHash: "CORRUPT-TAIL-deadbeef" }, [
      { ts: "t1", op: "get", key: "a" },
      { ts: "t2", op: "put", key: "b" },
    ]);
    const cl = chained.trim().split("\n");
    const r0 = JSON.parse(cl[0]);
    r0.key = "TAMPERED"; // edit body, keep its _hash
    cl[0] = JSON.stringify(r0);
    const log = legacy + cl.join("\n") + "\n";
    const r = run({
      [VAULT]: log,
      [HOSTD]: chainedFrom({ seq: 0, lastHash: CHAIN_GENESIS }, [{ ts: "t", op: "x" }]),
    });
    const broken = r.find((c) => c.name.includes("vault-broker audit chain BROKEN"));
    expect(broken?.status).toBe("fail");
    // 1 legacy preamble row → the tampered first chained row is file line 2.
    expect(broken?.detail).toMatch(/file line 2/);
    // Pre-fix this was silently a "legacy / inactive" warn — tamper
    // behind a legacy preamble was undetectable.
    expect(
      r.find((c) => c.name.includes("vault-broker audit tamper-evidence")),
    ).toBeUndefined();
  });

  // ─── fail-open counter (sec WS10-F3 / #1420) ────────────────────────────────

  it("warns when the vault-broker fail-open counter is non-zero", () => {
    const r = runAuditIntegrityChecks({
      homeDir: HOME,
      readFileSync: reader({ [VAULT]: chainedLog([{ ts: "t", op: "get" }]) }),
      readFailOpenState: () => ({
        failOpenCount: 3,
        lastFailureTs: "2026-07-11T00:00:00.000Z",
        lastError: "EROFS: read-only file system",
      }),
    });
    const c = r.find((x) => x.name === "vault-broker audit fail-open counter");
    expect(c?.status).toBe("warn");
    expect(c?.detail).toMatch(/3 audit append\(s\) failed/);
    expect(c?.detail).toContain("EROFS");
  });

  it("ok when the fail-open counter is zero (or sidecar absent)", () => {
    const r = runAuditIntegrityChecks({
      homeDir: HOME,
      readFileSync: reader({ [VAULT]: chainedLog([{ ts: "t", op: "get" }]) }),
      readFailOpenState: () => ({ failOpenCount: 0 }),
    });
    const c = r.find((x) => x.name === "vault-broker audit fail-open counter");
    expect(c?.status).toBe("ok");
  });
});
