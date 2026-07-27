import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WATCH_STALE_MS,
  checkHindsightWatchArmed,
  classifyWatchArmed,
} from "./doctor-hindsight-watch.js";

const NOW = Date.parse("2026-07-27T07:00:00Z");

/**
 * The point of this check: an UNARMED watchdog must be LOUD. Every assertion
 * below is on `status`, because a row that renders a helpful message while
 * still reporting `ok` would reproduce the exact failure — a fleet that looks
 * healthy because nothing is looking.
 */
describe("classifyWatchArmed", () => {
  it("FAILS when nothing is installed and nothing has ever ticked", () => {
    const r = classifyWatchArmed(false, null, NOW);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("not armed");
    expect(r.fix).toContain("--install-cron");
  });

  it("FAILS differently when the cron exists but no tick ever completed", () => {
    // Distinct diagnosis on purpose: an operator who already ran the installer
    // must be pointed at cron itself, not sent to run it a second time.
    const r = classifyWatchArmed(true, null, NOW);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("never completed a tick");
    expect(r.detail).not.toContain("not armed:");
  });

  it("FAILS when the last tick is stale past the cap", () => {
    const r = classifyWatchArmed(true, NOW - WATCH_STALE_MS - 60_000, NOW);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("stale");
  });

  it("passes a fresh tick", () => {
    const r = classifyWatchArmed(true, NOW - 5 * 60_000, NOW);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("5m ago");
  });

  it("is not fooled into 'extremely fresh' by a future-dated state file", () => {
    const r = classifyWatchArmed(true, NOW + 3 * WATCH_STALE_MS, NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("FUTURE");
  });

  it("still passes a fresh tick with no cron file, but says where it came from", () => {
    // Legitimate under a systemd timer or a manual run loop.
    const r = classifyWatchArmed(false, NOW - 60_000, NOW);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("running from somewhere else");
  });
});

describe("checkHindsightWatchArmed", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hw-doctor-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the real host facts: absent state file ⇒ fail", () => {
    const r = checkHindsightWatchArmed(NOW, join(dir, "cron"), join(dir, "state.json"));
    expect(r.status).toBe("fail");
  });

  it("reads the real host facts: fresh state file ⇒ ok", () => {
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, "{}");
    const now = Date.now();
    expect(checkHindsightWatchArmed(now, join(dir, "cron"), statePath).status).toBe("ok");
  });

  it("reads the real host facts: aged state file ⇒ fail", () => {
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, "{}");
    const old = (Date.now() - WATCH_STALE_MS - 600_000) / 1000;
    utimesSync(statePath, old, old);
    expect(checkHindsightWatchArmed(Date.now(), join(dir, "cron"), statePath).status).toBe("fail");
  });
});
