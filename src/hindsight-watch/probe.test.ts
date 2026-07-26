import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeError, probeSpool } from "./probe.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hw-probe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function hindsight(agent: string): string {
  const d = join(dir, agent, "home", ".hindsight");
  mkdirSync(d, { recursive: true });
  return d;
}

function queue(agent: string, files: Record<string, string>): void {
  const d = join(hindsight(agent), "pending-retains");
  mkdirSync(d, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
}

describe("probeSpool — what counts as a queued entry", () => {
  it("counts *.json as pending and *.json.dead as dead, and nothing else", () => {
    queue("alpha", {
      "1-a-x.json": "{}",
      "2-b-y.json": "{}",
      "3-c-z.json.dead": "{}",
      // A torn tmp+rename leaves these behind (8 live on the fleet today).
      // They are not queue entries and must not inflate the depth signal.
      "4-d-w.json.tmp": "{}",
      "README": "not an entry",
    });
    expect(probeSpool(dir)).toEqual({ pending: 2, dead: 1, evicted: 0, drops: 0, agents: 1 });
  });

  it("sums across agents and ignores dirs with no spool at all", () => {
    queue("alpha", { "a.json": "{}" });
    queue("beta", { "b.json": "{}", "c.json.dead": "{}" });
    mkdirSync(join(dir, "gamma", "home"), { recursive: true }); // never spooled
    const s = probeSpool(dir);
    expect(s.pending).toBe(2);
    expect(s.dead).toBe(1);
    expect(s.agents).toBe(2);
  });

  it("THROWS when the agents dir is unreadable — blindness is a signal, not a zero", () => {
    expect(() => probeSpool(join(dir, "nope"))).toThrow(ProbeError);
  });
});

describe("probeSpool — #3599's loss channels are siblings, not queue entries", () => {
  it("counts pending-evicted/ separately and never as queue depth", () => {
    queue("alpha", { "a.json": "{}" });
    const ev = join(hindsight("alpha"), "pending-evicted");
    mkdirSync(ev, { recursive: true });
    writeFileSync(join(ev, "e1.json"), "{}");
    writeFileSync(join(ev, "e2.json"), "{}");
    const s = probeSpool(dir);
    expect(s.evicted).toBe(2);
    expect(s.pending).toBe(1); // NOT 3
  });

  it("counts pending-dead/ so relocating markers cannot zero the loss signal", () => {
    queue("alpha", { "a.json": "{}" });
    const dd = join(hindsight("alpha"), "pending-dead");
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "d1.json.dead"), "{}");
    writeFileSync(join(dd, "d2.json.dead"), "{}");
    const s = probeSpool(dir);
    expect(s.dead).toBe(2);
    expect(s.pending).toBe(1); // NOT 3
  });

  it("counts dead in BOTH locations while legacy in-queue markers survive", () => {
    // A fleet mid-migration has markers in the old and the new place at once.
    // Counting only one would under-report the loss channel.
    queue("alpha", { "a.json": "{}", "legacy.json.dead": "{}" });
    const dd = join(hindsight("alpha"), "pending-dead");
    mkdirSync(dd, { recursive: true });
    writeFileSync(join(dd, "moved.json.dead"), "{}");
    expect(probeSpool(dir).dead).toBe(2);
  });

  it("sums the record_drop ledger count", () => {
    queue("alpha", {});
    writeFileSync(
      join(hindsight("alpha"), "pending-drops.json"),
      JSON.stringify({ schema: 1, count: 7, last_dropped_at: "2026-07-26T00:00:00Z" }),
    );
    queue("beta", {});
    writeFileSync(join(hindsight("beta"), "pending-drops.json"), JSON.stringify({ count: 3 }));
    expect(probeSpool(dir).drops).toBe(10);
  });

  it("reads 0 from a torn, foreign-shaped or absurdly large ledger rather than inventing a loss", () => {
    queue("torn", {});
    writeFileSync(join(hindsight("torn"), "pending-drops.json"), '{"count": 4');
    queue("foreign", {});
    writeFileSync(join(hindsight("foreign"), "pending-drops.json"), '"just a string"');
    queue("negative", {});
    writeFileSync(join(hindsight("negative"), "pending-drops.json"), '{"count": -5}');
    queue("huge", {});
    writeFileSync(
      join(hindsight("huge"), "pending-drops.json"),
      `{"count": 9, "junk": "${"x".repeat(70_000)}"}`,
    );
    // `retain-loss` fires on ANY rise, so a garbage read that produced a
    // number would page the operator about a memory that was never lost.
    expect(probeSpool(dir).drops).toBe(0);
  });

  it("still sees the loss channels when the queue dir itself has been removed", () => {
    // An operator clearing `pending-retains` must not silently zero the
    // eviction/drop history — a decrease is treated as a re-baseline by
    // `evaluateRetainLoss`, so hiding it here would lose the incident.
    const h = hindsight("alpha"); // no pending-retains dir at all
    mkdirSync(join(h, "pending-evicted"), { recursive: true });
    writeFileSync(join(h, "pending-evicted", "e1.json"), "{}");
    writeFileSync(join(h, "pending-drops.json"), JSON.stringify({ count: 2 }));
    const s = probeSpool(dir);
    expect(s.evicted).toBe(1);
    expect(s.drops).toBe(2);
    expect(s.agents).toBe(0); // no readable queue dir
  });
});
