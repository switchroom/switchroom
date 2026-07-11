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
  MAX_PRESERVED_DEGRADED_MS,
  buildDegradedMarker,
  formatDegradedNotice,
  formatRecoveredNotice,
  postOperatorNoticeViaGateways,
  readDegradedSince,
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

  it("recovered notice states pin + marker age for a preserved rollout, and nothing when there is none", () => {
    const preserved = formatRecoveredNotice(120_000, {
      pin: "v9.9.9",
      ageMs: 6 * 60_000,
      preserved: true,
    });
    expect(preserved).toContain("v9.9.9");
    expect(preserved).toContain("6m old");
    expect(preserved).toContain("will resume now");
    expect(formatRecoveredNotice(120_000, null)).not.toContain("self-bump");
  });

  it("recovered notice warns with pin + age when the roll was NOT preserved (cap exceeded)", () => {
    const text = formatRecoveredNotice(5 * 3_600_000, {
      pin: "v9.9.9",
      ageMs: 5 * 3_600_000 + 6 * 60_000,
      preserved: false,
    });
    expect(text).toContain("NOT auto-resumed");
    expect(text).toContain("v9.9.9");
    expect(text).toContain("preservation cap");
    expect(text).toContain("re-run");
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

describe("postOperatorNoticeViaGateways", () => {
  it("skips a dead socket path and delivers via the first LIVE listener", async () => {
    const { createServer } = await import("node:net");
    const dir = makeHome();
    const deadSock = join(dir, "dead.sock");
    writeFileSync(deadSock, ""); // inode exists, nobody listening
    const liveSock = join(dir, "live.sock");
    const received: string[] = [];
    const server = createServer((conn) => {
      conn.on("data", (d) => received.push(d.toString()));
    });
    await new Promise<void>((r) => server.listen(liveSock, r));
    try {
      const via = await postOperatorNoticeViaGateways(
        [
          { agent: "aaa-dead", sock: deadSock },
          { agent: "bbb-live", sock: liveSock },
        ],
        "hello operator",
        () => {},
        500,
      );
      expect(via).toBe("bbb-live");
      // Give the server loop a beat to flush the data event.
      await new Promise((r) => setTimeout(r, 50));
      const line = JSON.parse(received.join("").trim()) as Record<string, unknown>;
      expect(line.type).toBe("rollout_status_post");
      expect(line.agentName).toBe("bbb-live");
      expect(line.text).toBe("hello operator");
    } finally {
      server.close();
    }
  });

  it("returns null (and never throws) when every candidate is dead", async () => {
    const dir = makeHome();
    const via = await postOperatorNoticeViaGateways(
      [
        { agent: "x", sock: join(dir, "nope.sock") },
        { agent: "y", sock: join(dir, "also-nope.sock") },
      ],
      "hello",
      () => {},
      200,
    );
    expect(via).toBeNull();
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
    expect(notices[1]).toContain("v9.9.9"); // the pin, so the operator can intervene
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

  it("does NOT preserve a pending rollout past the degraded-window cap, and says so with pin + age", async () => {
    const home = makeHome();
    const hostdDir = join(home, ".switchroom", "hostd");
    mkdirSync(hostdDir, { recursive: true });
    let clock = Date.parse("2026-07-11T12:00:00.000Z");
    const pendingPath = join(hostdDir, SELF_BUMP_MARKER_FILENAME);
    const originalRaw = encodePendingRolloutMarker(makeMarker(clock - 5 * 60_000));
    writeFileSync(pendingPath, originalRaw);

    const notices: string[] = [];
    let attempts = 0;
    await waitForConfigRecovery({
      initialError: new ConfigError("bad yaml"),
      homeDir: home,
      loadFn: () => {
        attempts += 1;
        clock += 100 * 60_000; // 3 ticks = 5h simulated outage (> 4h cap)
        if (attempts < 3) throw new ConfigError("still broken");
        return fakeConfig;
      },
      notify: (t) => notices.push(t),
      log: () => {},
      retryMs: 10,
      nowFn: () => clock,
    });

    // Sanity: this outage exceeds the preservation cap.
    expect(300 * 60_000).toBeGreaterThan(MAX_PRESERVED_DEGRADED_MS);
    // Marker untouched — created_at NOT shifted — so the boot-resume
    // freshness check treats it as stale and the roll does not auto-resume.
    expect(readFileSync(pendingPath, "utf8")).toBe(originalRaw);
    const marker = parsePendingRolloutMarker(readFileSync(pendingPath, "utf8"));
    expect(isMarkerFresh(marker!, clock)).toBe(false);
    // The operator is told exactly what was dropped and can intervene.
    expect(notices[1]).toContain("NOT auto-resumed");
    expect(notices[1]).toContain("v9.9.9");
    expect(notices[1]).toContain("preservation cap");
  });

  it("credits degraded time from the PERSISTED epoch when hostd died while degraded", async () => {
    const home = makeHome();
    const hostdDir = join(home, ".switchroom", "hostd");
    mkdirSync(hostdDir, { recursive: true });
    let clock = Date.parse("2026-07-11T12:00:00.000Z");
    // A previous hostd entered degraded mode 30 min ago, wrote the marker,
    // then died (docker restart). The pending rollout marker dates from
    // that entry — 30 min old, i.e. ALREADY past the 15-min cutoff if the
    // new process only credited its own in-memory window.
    const degradedPath = join(hostdDir, CONFIG_DEGRADED_MARKER_FILENAME);
    writeFileSync(
      degradedPath,
      JSON.stringify({ v: 1, since: new Date(clock - 30 * 60_000).toISOString(), error: "bad yaml" }),
    );
    const pendingPath = join(hostdDir, SELF_BUMP_MARKER_FILENAME);
    writeFileSync(pendingPath, encodePendingRolloutMarker(makeMarker(clock - 30 * 60_000)));
    expect(readDegradedSince(degradedPath)).toBe(clock - 30 * 60_000);

    let first = true;
    await waitForConfigRecovery({
      initialError: new ConfigError("bad yaml"),
      homeDir: home,
      loadFn: () => {
        if (first) {
          first = false;
          clock += 60_000; // this process itself is degraded for only ~1 min
          throw new ConfigError("still broken");
        }
        return fakeConfig;
      },
      notify: () => {},
      log: () => {},
      retryMs: 10,
      nowFn: () => clock,
    });

    // The full 31-min window (persisted 30 min + 1 min in-process) was
    // credited: the marker is FRESH at recovery. With only the in-memory
    // 1-min credit it would be 30 min old — stale.
    const preserved = parsePendingRolloutMarker(readFileSync(pendingPath, "utf8"));
    expect(isMarkerFresh(preserved!, clock)).toBe(true);
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
