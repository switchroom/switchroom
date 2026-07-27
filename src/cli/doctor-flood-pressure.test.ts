/**
 * `switchroom doctor` flood-pressure section.
 *
 * The classifier itself is proved against the real incident stream in
 * `telegram-plugin/tests/flood-429-ledger.test.ts`. What is proved here is the
 * operator-facing wiring: the right per-agent file is read, a healthy or
 * absent ledger is silent, and the incident ledger produces a FAIL row that
 * names the number an operator needs.
 */
import { describe, it, expect } from "vitest";

import { runFloodPressureChecks } from "./doctor-flood-pressure.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  foldFlood429Observation,
  type Flood429Episode,
} from "../../telegram-plugin/flood-429-ledger.js";
import { REAL_429_STREAM } from "../../telegram-plugin/tests/fixtures/real-429-stream.js";

const AGENTS_DIR = "/nonexistent-test-agents";

function config(...names: string[]): SwitchroomConfig {
  const agents: Record<string, unknown> = {};
  for (const n of names) agents[n] = {};
  return { agents } as unknown as SwitchroomConfig;
}

function ledger(obs: Array<{ ts: number; retryAfterSec: number }>): string {
  let episodes: Flood429Episode[] = [];
  for (const o of obs) episodes = foldFlood429Observation(episodes, o, o.ts);
  return JSON.stringify(episodes);
}

/** Read seam that serves `files` and throws ENOENT for anything else. */
function reader(files: Record<string, string>) {
  return (p: string): string => {
    if (p in files) return files[p];
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  };
}

const path = (agent: string) =>
  `${AGENTS_DIR}/${agent}/telegram/429-ledger.json`;

const t = (iso: string) => Date.parse(iso);

describe("runFloodPressureChecks", () => {
  it("is silent for an agent with no ledger", () => {
    const results = runFloodPressureChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({}),
      now: t("2026-07-27T00:00:00Z"),
    });
    expect(results).toEqual([]);
  });

  it("is silent for an agent whose ledger holds only short rate nudges", () => {
    const nudges = Array.from({ length: 6 }, (_, i) => ({
      ts: t("2026-07-24T08:00:00Z") + i * 3_600_000,
      retryAfterSec: 3,
    }));
    const results = runFloodPressureChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({ [path("alpha")]: ledger(nudges) }),
      now: t("2026-07-24T23:59:59Z"),
    });
    expect(results).toEqual([]);
  });

  it("FAILS the day before the incident, naming the 62-minute ban", () => {
    // The real ledger state as of 2026-07-26: five short nudges plus the
    // 2026-07-25T23:43:07Z retry_after=3713 ban.
    const obs = [
      { ts: t("2026-07-25T05:24:04.941Z"), retryAfterSec: 3 },
      { ts: t("2026-07-25T22:50:39.203Z"), retryAfterSec: 3 },
      { ts: t("2026-07-25T22:50:48.981Z"), retryAfterSec: 3 },
      { ts: t("2026-07-25T23:43:07.861Z"), retryAfterSec: 3713 },
      { ts: t("2026-07-26T14:07:07.428Z"), retryAfterSec: 3 },
      { ts: t("2026-07-26T22:43:03.042Z"), retryAfterSec: 3 },
    ];
    const results = runFloodPressureChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({ [path("alpha")]: ledger(obs) }),
      // 20 hours and 20 minutes before the 4.4h ban at 20:19:57Z.
      now: t("2026-07-27T00:00:00Z"),
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].name).toBe("429 flood pressure: alpha");
    expect(results[0].detail).toContain("3713");
    expect(results[0].fix).toBeTruthy();
  });

  it("reports each agent independently and skips the healthy ones", () => {
    const banned = [{ ts: t("2026-07-27T20:19:56Z"), retryAfterSec: 15908 }];
    const fine = [{ ts: t("2026-07-27T10:00:00Z"), retryAfterSec: 3 }];
    const results = runFloodPressureChecks(config("alpha", "beta", "gamma"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({
        [path("alpha")]: ledger(fine),
        [path("beta")]: ledger(banned),
      }),
      now: t("2026-07-27T21:00:00Z"),
    });
    expect(results.map((r) => r.name)).toEqual(["429 flood pressure: beta"]);
    expect(results[0].detail).toContain("OPEN");
  });

  it("WARNS on a corrupt ledger rather than passing it off as healthy", () => {
    const results = runFloodPressureChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({ [path("alpha")]: "{ this is not json" }),
      now: t("2026-07-27T00:00:00Z"),
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("corrupt");
  });

  it("WARNS when the ledger exists but cannot be read", () => {
    const results = runFloodPressureChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: (p: string) => {
        const err = new Error(`EACCES: permission denied, open '${p}'`);
        (err as NodeJS.ErrnoException).code = "EACCES";
        throw err;
      },
      now: t("2026-07-27T00:00:00Z"),
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].detail).toContain("unreadable");
    // The distinction that matters: a missing ledger is silent, an
    // unreadable one is not.
    expect(
      runFloodPressureChecks(config("alpha"), {
        agentsDir: AGENTS_DIR,
        readFile: reader({}),
        now: t("2026-07-27T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("would have printed a FAIL row before the 2026-07-27 outage", () => {
    // The capstone. Replay every real 429 the agent's gateway saw up to
    // 2026-07-27T00:00:00Z into a ledger, then run the doctor section over it.
    // If this row does not appear, the feature has not done its job.
    const cutoff = t("2026-07-27T00:00:00Z");
    const incident = t("2026-07-27T20:19:56.704Z");
    let episodes: Flood429Episode[] = [];
    for (const o of REAL_429_STREAM) {
      if (o.ts > cutoff) break;
      episodes = foldFlood429Observation(episodes, o, o.ts);
    }

    const results = runFloodPressureChecks(config("alpha"), {
      agentsDir: AGENTS_DIR,
      readFile: reader({ [path("alpha")]: JSON.stringify(episodes) }),
      now: cutoff,
    });

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(incident - cutoff).toBeGreaterThan(20 * 60 * 60 * 1000);
  });

  it("returns nothing when no agents are configured", () => {
    expect(
      runFloodPressureChecks(config(), { agentsDir: AGENTS_DIR, readFile: reader({}) }),
    ).toEqual([]);
  });
});
