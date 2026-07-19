/**
 * 4c — long-mark corroboration probe (auth-broker fix package PR4).
 *
 * An UNCORROBORATED long exhaustion mark (the +7d weekly-wall shape accepted
 * without a fresh contradicting snapshot) is legitimate under #2218
 * weekly-durability, so it is NEVER hard-clamped. Instead a one-shot live
 * corroboration probe runs after the mark; a COMPLETE probe (F0
 * `sevenDayUtilPresent`) that positively contradicts the weekly wall clamps the
 * PERSISTED `exhausted_until` to 5h. A failed/incomplete/still-walled probe
 * leaves the durable weekly mark intact.
 *
 * These drive `corroborateExhaustionMark` directly (`_testCorroborationDelayMs:
 * 0` disables auto-scheduling; the probe is injected via `_testFetchQuota`),
 * plus a clampMarkExpiry pin for the synchronous mark-time clamp.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import { clampMarkExpiry } from "./account-eligibility.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { QuotaResult } from "../quota.js";

const MARK_EXHAUSTED_DEFAULT_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_784_000_000_000;
const IDENTITY = { kind: "operator" as const };

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}
let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-mark-corrob-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try { rmSync(h.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  harnesses = [];
});

function makeConfig(h: Harness, active: string): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: { ziggy: {} },
    auth: { active },
    google_workspace: undefined,
  } as unknown) as SwitchroomConfig;
}

function seedAccount(h: Harness, label: string): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: `at-${label}`,
        refreshToken: `rt-${label}`,
        expiresAt: NOW + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    h.home,
  );
}

/** A probe result. `sevenDayUtilPresent:false` models an INCOMPLETE probe that
 *  never measured the weekly window. */
function probe(
  five: number,
  seven: number,
  sevenPresent = true,
): QuotaResult {
  return {
    ok: true as const,
    data: {
      fiveHourUtilizationPct: five,
      sevenDayUtilizationPct: seven,
      fiveHourResetAt: new Date(NOW + 60 * 60 * 1000),
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      fiveHourUtilPresent: true,
      sevenDayUtilPresent: sevenPresent,
    },
  } as unknown as QuotaResult;
}

function makeBroker(
  h: Harness,
  fetchImpl: () => Promise<QuotaResult>,
): AuthBroker {
  return new AuthBroker(makeConfig(h, "default"), {
    home: h.home,
    stateDir: h.stateDir,
    socketRoot: h.socketRoot,
    disableRefreshLoop: true,
    skipHealthyMarker: true,
    now: () => NOW,
    _testCorroborationDelayMs: 0,
    _testFetchQuota: fetchImpl,
  });
}

/** Seed an uncorroborated long (+7d) exhaustion mark directly in the ledger. */
function seedLongMark(broker: AuthBroker, account: string): number {
  const until = NOW + SEVEN_DAYS_MS;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (broker as any).quota[account] = { exhausted_until: until, marked_at: NOW };
  return until;
}

describe("4c — corroborateExhaustionMark", () => {
  it("uncorroborated +7d mark + contradicting COMPLETE probe → clamped to 5h", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    // 5h high (NOT clearly-healthy, so cacheQuotaSnapshot's self-heal does not
    // pre-empt) but 7d LOW → positively contradicts the weekly wall.
    const broker = makeBroker(h, async () => probe(95, 10));
    seedLongMark(broker, "default");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (broker as any).corroborateExhaustionMark("default", NOW, IDENTITY);
    expect(res.clamped).toBe(true);
    expect(broker._state().quota["default"].exhausted_until).toBe(
      NOW + MARK_EXHAUSTED_DEFAULT_MS,
    );
    broker.stop();
  });

  it("probe FAILS (fetch throws) → mark kept intact", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = makeBroker(h, async () => {
      throw new Error("network down");
    });
    const until = seedLongMark(broker, "default");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (broker as any).corroborateExhaustionMark("default", NOW, IDENTITY);
    expect(res.clamped).toBe(false);
    expect(res.reason).toBe("probe-failed");
    expect(broker._state().quota["default"].exhausted_until).toBe(until);
    broker.stop();
  });

  it("probe INCOMPLETE (7d window absent) → mark kept (F0 guard)", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    // 7d filler 0 but sevenDayUtilPresent=false: the probe never saw the weekly
    // window, so it must NOT clamp a legitimate weekly mark.
    const broker = makeBroker(h, async () => probe(95, 0, false));
    const until = seedLongMark(broker, "default");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (broker as any).corroborateExhaustionMark("default", NOW, IDENTITY);
    expect(res.clamped).toBe(false);
    expect(broker._state().quota["default"].exhausted_until).toBe(until);
    broker.stop();
  });

  it("probe complete but STILL walled (7d≥wall) → mark kept", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = makeBroker(h, async () => probe(95, 99.9));
    const until = seedLongMark(broker, "default");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (broker as any).corroborateExhaustionMark("default", NOW, IDENTITY);
    expect(res.clamped).toBe(false);
    expect(res.reason).toBe("not-contradicted");
    expect(broker._state().quota["default"].exhausted_until).toBe(until);
    broker.stop();
  });

  it("mark superseded since scheduling (marked_at mismatch) → no-op", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = makeBroker(h, async () => probe(95, 10));
    const until = seedLongMark(broker, "default");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (broker as any).corroborateExhaustionMark("default", NOW - 1, IDENTITY);
    expect(res.clamped).toBe(false);
    expect(res.reason).toBe("mark-superseded");
    expect(broker._state().quota["default"].exhausted_until).toBe(until);
    broker.stop();
  });

  it("short mark (already <=5h) → not-long no-op", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const broker = makeBroker(h, async () => probe(95, 10));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (broker as any).quota["default"] = {
      exhausted_until: NOW + MARK_EXHAUSTED_DEFAULT_MS,
      marked_at: NOW,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (broker as any).corroborateExhaustionMark("default", NOW, IDENTITY);
    expect(res.clamped).toBe(false);
    expect(res.reason).toBe("not-long");
    broker.stop();
  });
});

describe("4c pin — synchronous mark-time clamp (existing behaviour)", () => {
  it("a FRESH complete contradicting snapshot clamps a +7d mark to 5h at mark time", () => {
    const proposedUntil = NOW + SEVEN_DAYS_MS;
    const clamped = clampMarkExpiry({
      proposedUntil,
      now: NOW,
      shortMs: MARK_EXHAUSTED_DEFAULT_MS,
      snapshot: {
        fiveHourUtilizationPct: 95,
        sevenDayUtilizationPct: 10,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: null,
        overageStatus: null,
        overageDisabledReason: null,
        capturedAt: NOW,
        fiveHourUtilPresent: true,
        sevenDayUtilPresent: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    expect(clamped).toBe(NOW + MARK_EXHAUSTED_DEFAULT_MS);
  });

  it("no snapshot → the long weekly mark is TRUSTED (no clamp; #2218 durability)", () => {
    const proposedUntil = NOW + SEVEN_DAYS_MS;
    const clamped = clampMarkExpiry({
      proposedUntil,
      now: NOW,
      shortMs: MARK_EXHAUSTED_DEFAULT_MS,
    });
    expect(clamped).toBe(proposedUntil);
  });
});
