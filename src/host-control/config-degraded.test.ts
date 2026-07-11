/**
 * hostd config-error resilience (degraded mode) — see config-degraded.ts.
 *
 * Outcome assertions, not path assertions:
 *   - a hostd boot against a broken config does NOT terminate; it recovers
 *     once the config loads again;
 *   - the degraded marker file exists while degraded and is gone after;
 *   - the operator is notified on entry AND on recovery;
 *   - a pending self-bump rollout marker written before the outage is
 *     STILL FRESH after a degraded window longer than the 15-min cutoff
 *     (the exact silent-abandon failure from the 2026-07-11 incident).
 */

import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  CONFIG_DEGRADED_MARKER_FILENAME,
  buildDegradedMarker,
  formatDegradedNotice,
  formatRecoveredNotice,
  shiftPendingRolloutMarker,
  waitForConfigRecovery,
} from "./config-degraded.js";
import {
  SELF_BUMP_MARKER_FILENAME,
  SELF_BUMP_MARKER_MAX_AGE_MS,
  encodePendingRolloutMarker,
  isMarkerFresh,
  parsePendingRolloutMarker,
  type PendingRolloutMarker,
} from "./self-bump.js";

let tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hostd-degraded-test-"));
  tempRoots.push(home);
  return home;
}

function makeMarker(createdAtMs: number): PendingRolloutMarker {
  return {
    v: 1,
    request_id: "req-123",
    pin: "v9.9.9",
    caller: { kind: "operator" },
    created_at: new Date(createdAtMs).toISOString(),
    prior_hostd_version: "0.18.9",
  };
}

const fakeConfig = { agents: {} } as unknown as SwitchroomConfig;

describe("shiftPendingRolloutMarker", () => {
  it("shifts created_at forward by the degraded duration", () => {
    const t0 = Date.parse("2026-07-11T00:00:00.000Z");
    const raw = encodePendingRolloutMarker(makeMarker(t0));
    const shifted = shiftPendingRolloutMarker(raw, 20 * 60_000);
    expect(shifted).not.toBeNull();
    const out = parsePendingRolloutMarker(shifted!);
    expect(out).not.toBeNull();
    expect(Date.parse(out!.created_at)).toBe(t0 + 20 * 60_000);
    // Everything else is preserved verbatim.
    expect(out!.request_id).toBe("req-123");
    expect(out!.pin).toBe("v9.9.9");
  });

  it("returns null for malformed input and non-positive durations", () => {
    expect(shiftPendingRolloutMarker("not json", 1000)).toBeNull();
    expect(shiftPendingRolloutMarker("{}", 1000)).toBeNull();
    const raw = encodePendingRolloutMarker(makeMarker(Date.now()));
    expect(shiftPendingRolloutMarker(raw, 0)).toBeNull();
    expect(shiftPendingRolloutMarker(raw, -5)).toBeNull();
  });
});

describe("notices", () => {
  it("degraded notice carries the error and the recovery instruction", () => {
    const text = formatDegradedNotice(
      new ConfigError("Invalid YAML in /x/switchroom.yaml", [
        "  Map keys must be unique at line 2",
      ]),
    );
    expect(text).toContain("DEGRADED");
    expect(text).toContain("Invalid YAML in /x/switchroom.yaml");
    expect(text).toContain("Map keys must be unique");
    expect(text).toContain("switchroom config check");
  });

  it("recovered notice mentions a preserved rollout only when there is one", () => {
    expect(formatRecoveredNotice(120_000, true)).toContain("self-bump rollout");
    expect(formatRecoveredNotice(120_000, false)).not.toContain("self-bump");
  });

  it("buildDegradedMarker captures error + details + since", () => {
    const m = buildDegradedMarker(new ConfigError("boom", ["  d1"]), 1_000);
    expect(m).toEqual({
      v: 1,
      since: new Date(1_000).toISOString(),
      error: "boom",
      details: ["  d1"],
    });
  });
});

describe("waitForConfigRecovery", () => {
  it("survives failing loads, keeps the marker while degraded, recovers, notifies twice, and preserves a pending rollout past the 15-min cutoff", async () => {
    const home = makeHome();
    const hostdDir = join(home, ".switchroom", "hostd");
    mkdirSync(hostdDir, { recursive: true });

    // Pending rollout marker written 5 minutes before the outage begins.
    let clock = Date.parse("2026-07-11T12:00:00.000Z");
    const pendingPath = join(hostdDir, SELF_BUMP_MARKER_FILENAME);
    writeFileSync(pendingPath, encodePendingRolloutMarker(makeMarker(clock - 5 * 60_000)));

    const notices: string[] = [];
    let attempts = 0;
    let markerSeenWhileDegraded = false;
    const degradedPath = join(hostdDir, CONFIG_DEGRADED_MARKER_FILENAME);
    // Simulated outage: 30 min of wall-clock (well past the 15-min marker
    // cutoff) compressed into 3 fast retry ticks by advancing the injected
    // clock 10 min per attempt.
    const cfg = await waitForConfigRecovery({
      initialError: new ConfigError("Invalid YAML in /x/switchroom.yaml"),
      homeDir: home,
      loadFn: () => {
        attempts += 1;
        clock += 10 * 60_000;
        markerSeenWhileDegraded ||= existsSync(degradedPath);
        if (attempts < 3) throw new ConfigError("still broken");
        return fakeConfig;
      },
      notify: (t) => notices.push(t),
      log: () => {},
      retryMs: 10,
      nowFn: () => clock,
    });

    expect(cfg).toBe(fakeConfig);
    expect(attempts).toBe(3);
    // Marker existed during the outage, gone after recovery.
    expect(markerSeenWhileDegraded).toBe(true);
    expect(existsSync(degradedPath)).toBe(false);
    // Operator notified on entry and on recovery.
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("DEGRADED");
    expect(notices[1]).toContain("normal service resumed");
    expect(notices[1]).toContain("self-bump rollout");
    // The pending rollout marker is STILL FRESH at the recovered "now",
    // despite 30 simulated minutes of outage + 5 min of pre-outage age —
    // i.e. the degraded window did not count against the resume cutoff.
    const preserved = parsePendingRolloutMarker(readFileSync(pendingPath, "utf8"));
    expect(preserved).not.toBeNull();
    expect(isMarkerFresh(preserved!, clock)).toBe(true);
    // Sanity: without the shift it would have been stale.
    expect(30 * 60_000 + 5 * 60_000).toBeGreaterThan(SELF_BUMP_MARKER_MAX_AGE_MS);
  });

  it("writes the degraded marker with the error even when no gateway notify works, and clears it on recovery", async () => {
    const home = makeHome();
    const degradedPath = join(home, ".switchroom", "hostd", CONFIG_DEGRADED_MARKER_FILENAME);
    let first = true;
    let markerContentWhileDegraded = "";
    await waitForConfigRecovery({
      initialError: new ConfigError("Invalid YAML in /y.yaml", ["  dup key"]),
      homeDir: home,
      loadFn: () => {
        if (first) {
          first = false;
          markerContentWhileDegraded = readFileSync(degradedPath, "utf8");
          throw new ConfigError("still broken");
        }
        return fakeConfig;
      },
      notify: () => {
        throw new Error("gateway down"); // must be swallowed
      },
      log: () => {},
      retryMs: 10,
    });
    const parsed = JSON.parse(markerContentWhileDegraded) as { error: string; details: string[] };
    expect(parsed.error).toBe("Invalid YAML in /y.yaml");
    expect(parsed.details).toEqual(["  dup key"]);
    expect(existsSync(degradedPath)).toBe(false);
  });

  it("rethrows a non-ConfigError from the reload (genuine bug → fatal handler)", async () => {
    const home = makeHome();
    await expect(
      waitForConfigRecovery({
        initialError: new ConfigError("bad yaml"),
        homeDir: home,
        loadFn: () => {
          throw new TypeError("programmer error");
        },
        notify: () => {},
        log: () => {},
        retryMs: 5,
      }),
    ).rejects.toThrow(TypeError);
  });
});
