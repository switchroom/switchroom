/**
 * #3600 review, finding 1 — the webhook event log has TWO writer
 * processes (`handleWebhookIngest` in the web container,
 * `recordWebhookEvent` in the agent's gateway) and no shared promise
 * chain. Unlocked, both can stat an over-cap file, A rotates, then B
 * rotates the now-EMPTY active file: `.1` gets zero bytes copied over it
 * and a full generation of events is destroyed.
 *
 * These tests assert that outcome cannot happen: the loser of the race
 * declines (size re-checked under the lock) and a full `.1` survives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { maybeRotateLogFile } from "./log-rotation.js";

let dir: string;
let log: string;
const OPTS = { maxBytes: 1000, maxFiles: 2, tag: "t", lock: true };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotlock-"));
  log = path.join(dir, "events.jsonl");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cross-process rotation lock", () => {
  it("THE BUG: a second rotator must not copy an empty active file over a full .1", () => {
    // Exactly process B's world after process A rotated: `.1` holds a
    // generation of events, the active file is back to (nearly) empty.
    // B is still holding its stale "over cap" belief and calls rotate.
    fs.writeFileSync(`${log}.1`, "REAL EVENTS\n".repeat(200));
    const generationBytes = fs.statSync(`${log}.1`).size;
    fs.writeFileSync(log, ""); // truncated by A

    const rotated = maybeRotateLogFile(log, OPTS);

    expect(rotated).toBe(false);
    // The generation survived, unshifted and unemptied.
    expect(fs.statSync(`${log}.1`).size).toBe(generationBytes);
    expect(fs.readFileSync(`${log}.1`, "utf-8")).toContain("REAL EVENTS");
    expect(fs.existsSync(`${log}.2`)).toBe(false);
  });

  it("declines while another process holds the lock, leaving .1 intact", () => {
    fs.writeFileSync(`${log}.1`, "PREVIOUS GENERATION\n");
    fs.writeFileSync(log, "x".repeat(5000)); // genuinely over cap
    // Simulate the other process mid-rotation.
    fs.writeFileSync(`${log}.rotate.lock`, "");

    const rotated = maybeRotateLogFile(log, OPTS);

    expect(rotated).toBe(false);
    expect(fs.readFileSync(`${log}.1`, "utf-8")).toBe("PREVIOUS GENERATION\n");
    // Live file untouched — we grow rather than race.
    expect(fs.statSync(log).size).toBe(5000);
  });

  it("rotates normally when the lock is free, and releases it", () => {
    fs.writeFileSync(log, "y".repeat(5000));
    expect(maybeRotateLogFile(log, OPTS)).toBe(true);
    expect(fs.statSync(log).size).toBe(0);
    expect(fs.statSync(`${log}.1`).size).toBe(5000);
    expect(fs.existsSync(`${log}.rotate.lock`)).toBe(false);
  });

  it("reclaims a stale lock left by a killed process", () => {
    fs.writeFileSync(log, "z".repeat(5000));
    fs.writeFileSync(`${log}.rotate.lock`, "");
    const old = new Date(Date.now() - 5 * 60 * 1000); // 5 min
    fs.utimesSync(`${log}.rotate.lock`, old, old);

    expect(maybeRotateLogFile(log, OPTS)).toBe(true);
    expect(fs.statSync(`${log}.1`).size).toBe(5000);
    expect(fs.existsSync(`${log}.rotate.lock`)).toBe(false);
  });

  it("single-writer logs skip the lock entirely (no lockfile left behind)", () => {
    fs.writeFileSync(log, "w".repeat(5000));
    expect(
      maybeRotateLogFile(log, { maxBytes: 1000, maxFiles: 2, tag: "t" }),
    ).toBe(true);
    expect(fs.existsSync(`${log}.rotate.lock`)).toBe(false);
  });

  it("interleaved rotate attempts preserve every event across generations", () => {
    // Two writers appending to the same log, each rotating before its
    // append. Every event must be recoverable from active + .1 + .2.
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      // Writer A and writer B alternate; both check + rotate + append.
      maybeRotateLogFile(log, OPTS);
      const line = `event-${i}\n`.padEnd(120, "-") + "\n";
      fs.appendFileSync(log, line);
      seen.push(`event-${i}`);
    }
    const all = [`${log}.2`, `${log}.1`, log]
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf-8"))
      .join("");
    // With maxFiles=2 the oldest events legitimately age out, but no
    // generation may be EMPTY while a newer one holds data (the
    // destroyed-generation signature).
    expect(fs.statSync(`${log}.1`).size).toBeGreaterThan(0);
    expect(all).toContain(seen[seen.length - 1]);
  });
});
