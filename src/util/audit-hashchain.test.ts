import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chainRow,
  seedChain,
  verifyAuditChain,
  verifyAuditLog,
  CHAIN_GENESIS,
  type ChainState,
} from "./audit-hashchain.js";

function buildLog(entries: Record<string, unknown>[]): {
  text: string;
  finalState: ChainState;
} {
  let state: ChainState = { seq: 0, lastHash: CHAIN_GENESIS };
  let text = "";
  for (const e of entries) {
    const { line, next } = chainRow(state, e);
    text += line;
    state = next;
  }
  return { text, finalState: state };
}

describe("audit-hashchain — chainRow + verifyAuditChain", () => {
  it("produces a genesis-anchored, monotonically-sequenced, verifiable chain", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get", key: "a" },
      { ts: "t2", op: "put", key: "b" },
      { ts: "t3", op: "delete", key: "c" },
    ]);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]._seq).toBe(1);
    expect(lines[0]._prev).toBe(CHAIN_GENESIS);
    expect(lines[1]._seq).toBe(2);
    expect(lines[1]._prev).toBe(lines[0]._hash);
    expect(lines[2]._prev).toBe(lines[1]._hash);
    // Domain fields survive untouched alongside the chain meta.
    expect(lines[0].op).toBe("get");
    const v = verifyAuditChain(text);
    expect(v).toEqual({ ok: true, rows: 3 });
  });

  it("detects an in-place edit of a row body", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get", key: "a" },
      { ts: "t2", op: "put", key: "b" },
    ]);
    const lines = text.trim().split("\n");
    const row = JSON.parse(lines[0]);
    row.key = "TAMPERED"; // edit body, keep the original _hash
    lines[0] = JSON.stringify(row);
    const v = verifyAuditChain(lines.join("\n") + "\n");
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(1);
    expect(v.reason).toMatch(/hash mismatch/);
  });

  it("detects a deleted middle row (seq gap + prev break)", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
      { ts: "t3", op: "list" },
    ]);
    const lines = text.trim().split("\n");
    const without = [lines[0], lines[2]].join("\n") + "\n";
    const v = verifyAuditChain(without);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(2);
  });

  it("detects head truncation via expectedFirstPrev", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
    ]);
    // Drop row 1; row 2 now leads but its _prev != GENESIS and _seq=2.
    const tailOnly = text.trim().split("\n")[1] + "\n";
    const v = verifyAuditChain(tailOnly);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(1);
  });

  it("flags a row that had its chain fields stripped", () => {
    const { text } = buildLog([{ ts: "t1", op: "get" }]);
    const stripped = JSON.stringify({ ts: "t1", op: "get" }) + "\n";
    const v = verifyAuditChain(stripped);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/missing chain fields/);
  });

  it("flags a non-JSON row", () => {
    const v = verifyAuditChain("not json at all\n");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not valid JSON/);
  });
});

describe("audit-hashchain — seedChain", () => {
  let dir: string;
  it("genesis for an absent or empty file", () => {
    dir = mkdtempSync(join(tmpdir(), "ahc-"));
    try {
      expect(seedChain(join(dir, "nope.log"))).toEqual({
        seq: 0,
        lastHash: CHAIN_GENESIS,
      });
      const empty = join(dir, "empty.log");
      writeFileSync(empty, "");
      expect(seedChain(empty)).toEqual({ seq: 0, lastHash: CHAIN_GENESIS });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues from a valid existing tail (chain survives restart)", () => {
    dir = mkdtempSync(join(tmpdir(), "ahc-"));
    try {
      const p = join(dir, "a.log");
      const { text, finalState } = buildLog([
        { ts: "t1", op: "get" },
        { ts: "t2", op: "put" },
      ]);
      writeFileSync(p, text);
      const seeded = seedChain(p);
      expect(seeded).toEqual(finalState);
      // A continued write verifies end-to-end.
      const { line } = chainRow(seeded, { ts: "t3", op: "list" });
      const v = verifyAuditChain(text + line);
      expect(v).toEqual({ ok: true, rows: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("poisons the anchor on a corrupt tail so prior rows can't silently validate", () => {
    dir = mkdtempSync(join(tmpdir(), "ahc-"));
    try {
      const p = join(dir, "c.log");
      writeFileSync(p, '{"ts":"t1","op":"get"}\nGARBAGE-NOT-JSON\n');
      const seeded = seedChain(p);
      expect(seeded.lastHash).toMatch(/^CORRUPT-TAIL-/);
      // Anything we append now still won't make the old rows verify.
      const { line } = chainRow(seeded, { ts: "t2", op: "put" });
      const v = verifyAuditChain(
        '{"ts":"t1","op":"get"}\nGARBAGE-NOT-JSON\n' + line,
      );
      expect(v.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit-hashchain — verifyAuditLog (whole-file, restart-aware)", () => {
  function legacy(o: Record<string, unknown>): string {
    return JSON.stringify(o) + "\n";
  }
  /** Chain rows from an arbitrary starting state (simulates a
   *  post-restart seedChain re-anchor: seq jump/reset, fresh _prev). */
  function seg(initial: ChainState, rows: Record<string, unknown>[]): string {
    let st = initial;
    let t = "";
    for (const r of rows) {
      const { line, next } = chainRow(st, r);
      t += line;
      st = next;
    }
    return t;
  }

  it("state=legacy for a wholly pre-#1433 unchained log", () => {
    const v = verifyAuditLog(
      legacy({ ts: "t1", op: "get" }) + legacy({ ts: "t2", op: "put" }),
    );
    expect(v.state).toBe("legacy");
    expect(v.legacyRows).toBe(2);
    expect(v.chainedRows).toBe(0);
  });

  it("state=ok for a single from-genesis segment", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
    ]);
    const v = verifyAuditLog(text);
    expect(v).toMatchObject({ state: "ok", legacyRows: 0, chainedRows: 2, segments: 1 });
  });

  it("state=ok for a legacy preamble followed by a chained segment", () => {
    const text =
      legacy({ ts: "L1", op: "get" }) +
      legacy({ ts: "L2", op: "put" }) +
      seg({ seq: 0, lastHash: "CORRUPT-TAIL-deadbeef" }, [
        { ts: "t1", op: "get" },
        { ts: "t2", op: "put" },
      ]);
    const v = verifyAuditLog(text);
    expect(v).toMatchObject({ state: "ok", legacyRows: 2, chainedRows: 2, segments: 1 });
  });

  it("state=ok across broker-restart re-anchors (the real long-lived host shape — NO false tamper)", () => {
    // Segment A from genesis, then a restart where seedChain re-anchored
    // at a LOWER seq with an unrelated _prev (exactly what the real
    // vault-audit.log showed: seq 1075 → 1065). Every row is still
    // self-consistent, so this must be ok, NOT a tamper FAIL.
    const a = seg({ seq: 0, lastHash: CHAIN_GENESIS }, [
      { ts: "a1", op: "get" },
      { ts: "a2", op: "put" },
      { ts: "a3", op: "list" },
    ]);
    const b = seg({ seq: 1064, lastHash: "67ba215d031577ca9ea368cbe7" }, [
      { ts: "b1", op: "list" },
      { ts: "b2", op: "get" },
    ]);
    const v = verifyAuditLog(a + b);
    expect(v.state).toBe("ok");
    expect(v.chainedRows).toBe(5);
    expect(v.segments).toBe(2); // 1 benign restart re-anchor
  });

  it("state=tampered when a chained row body was edited (hash kept)", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get", key: "a" },
      { ts: "t2", op: "put", key: "b" },
      { ts: "t3", op: "list" },
    ]);
    const lines = text.trim().split("\n");
    const r1 = JSON.parse(lines[1]);
    r1.key = "TAMPERED"; // edit body, keep original _hash
    lines[1] = JSON.stringify(r1);
    const v = verifyAuditLog(lines.join("\n") + "\n");
    expect(v.state).toBe("tampered");
    expect(v.brokenAtLine).toBe(2);
    expect(v.reason).toMatch(/hash mismatch/);
  });

  it("state=tampered when a chained row was replaced by an unchained row", () => {
    const { text } = buildLog([
      { ts: "t1", op: "get" },
      { ts: "t2", op: "put" },
    ]);
    const lines = text.trim().split("\n");
    lines[1] = JSON.stringify({ ts: "t2", op: "put" }); // strip chain fields
    const v = verifyAuditLog(lines.join("\n") + "\n");
    expect(v.state).toBe("tampered");
    expect(v.reason).toMatch(/chain fields stripped/);
  });
});

describe("audit-hashchain — vault createAuditLogger integration", () => {
  it("writes a verifiable chain and detects tampering", async () => {
    const { createAuditLogger } = await import("../vault/broker/audit-log.js");
    const dir = mkdtempSync(join(tmpdir(), "ahc-vault-"));
    try {
      const p = join(dir, "vault-audit.log");
      const log = createAuditLogger({ path: p });
      log.write({
        ts: "2026-05-17T00:00:00.000Z",
        op: "get",
        key: "k1",
        caller: "switchroom-a.service",
        pid: 1,
        result: "allowed",
      });
      log.write({
        ts: "2026-05-17T00:00:01.000Z",
        op: "put",
        key: "k2",
        caller: "switchroom-a.service",
        pid: 1,
        result: "allowed",
      });
      const clean = readFileSync(p, "utf8");
      expect(verifyAuditChain(clean)).toEqual({ ok: true, rows: 2 });

      // Operator forensically rewrites row 1 to hide a `get`.
      const ls = clean.trim().split("\n");
      const r0 = JSON.parse(ls[0]);
      r0.op = "list";
      ls[0] = JSON.stringify(r0);
      expect(verifyAuditChain(ls.join("\n") + "\n").ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
