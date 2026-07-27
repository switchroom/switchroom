/**
 * credit-watch.test.ts — outcome tests for proactive OpenRouter credit
 * monitoring.
 *
 * THE RISK. #3868 made a spent OpenRouter balance visible AFTER it breaks a
 * request. This is the proactive half, and it has two ways to be worse than
 * useless:
 *
 *   1. It reports GREEN when it cannot actually see anything — the uncapped-key
 *      case, which is the fleet's default state. That manufactures confidence.
 *   2. It pages the operator about the same standing fact every hour, which
 *      trains them to mute the channel.
 *
 * So these tests assert the OBSERVABLE result an operator would experience:
 * the exact `switchroom doctor` line, and the exact operator DM (or the
 * deliberate absence of one), driven end-to-end through the real state file on
 * disk. Fakes exist only at the two edges that touch the world — the vault
 * read and the HTTP GET — so no live credential is ever needed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OPENROUTER_KEY_ENDPOINT,
  OPENROUTER_VAULT_KEY,
  evaluateCredit,
  parseKeySnapshot,
  type CreditFetchFn,
} from "./credit.js";
import { renderCron, installCron, CRON_SCHEDULE } from "./install-cron.js";
import { tick } from "./run.js";
import { loadState, saveState } from "./state.js";
import { RENOTIFY_MS } from "./watch.js";
import { runOpenRouterCreditChecks, usesOpenRouter } from "../cli/doctor-openrouter-credit.js";

/**
 * A stand-in for the real API key. Every test asserts this string never
 * escapes into a doctor line, an operator DM, or a log line.
 */
const FAKE_KEY = "sk-or-v1-FAKEKEYVALUE-must-never-be-printed";

const HOUR = 3_600_000;

/** Build a `GET /api/v1/key` body in the documented shape. */
function keyBody(over: Record<string, unknown> = {}): unknown {
  return {
    data: {
      label: "switchroom-proxy",
      limit: null,
      limit_reset: null,
      limit_remaining: null,
      include_byok_in_limit: false,
      usage: 12.34,
      usage_daily: 1,
      usage_weekly: 5,
      usage_monthly: 12,
      byok_usage: 0,
      is_free_tier: false,
      ...over,
    },
  };
}

/** A fetch fake that records the calls it saw. */
function fakeFetch(
  respond: (url: string) => { ok?: boolean; status: number; body?: unknown; throws?: Error },
): { fetchFn: CreditFetchFn; calls: Array<{ url: string; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchFn: CreditFetchFn = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const r = respond(url);
    if (r.throws) throw r.throws;
    return {
      ok: r.ok ?? (r.status >= 200 && r.status < 300),
      status: r.status,
      json: async () => r.body,
    };
  };
  return { fetchFn, calls };
}

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openrouter-watch-"));
  statePath = join(dir, "state.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Drive one tick with fakes, capturing every DM and log line. */
async function runTick(opts: {
  respond: (url: string) => { ok?: boolean; status: number; body?: unknown; throws?: Error };
  now: number;
  secret?: string | null;
  deliver?: boolean;
  dryRun?: boolean;
}) {
  const dms: string[] = [];
  const logs: string[] = [];
  const { fetchFn, calls } = fakeFetch(opts.respond);
  const result = await tick({
    statePath,
    readSecret: async (k) => {
      const secret = opts.secret === undefined ? FAKE_KEY : opts.secret;
      return k === OPENROUTER_VAULT_KEY ? secret : null;
    },
    fetchFn,
    notify: async (text) => {
      dms.push(text);
      return opts.deliver ?? true;
    },
    now: () => opts.now,
    dryRun: opts.dryRun,
    log: (m) => logs.push(m),
  });
  return { result, dms, logs, calls };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the uncapped key — the case that actually applies today", () => {
  const uncapped = () => ({ status: 200, body: keyBody() });

  it("doctor reports WARN and says WHY it cannot measure — never a green tick", async () => {
    const [res] = await runOpenRouterCreditChecks({
      enabled: true,
      readSecret: async () => FAKE_KEY,
      fetchFn: fakeFetch(uncapped).fetchFn,
    });
    // The whole point: a monitor that passes when it cannot see is worse than
    // no monitor, because it manufactures confidence.
    expect(res.status).toBe("warn");
    expect(res.status).not.toBe("ok");
    expect(res.detail).toMatch(/no per-key credit limit/i);
    expect(res.detail).toMatch(/no account-balance field/i);
    expect(res.fix).toContain("https://openrouter.ai/settings/keys");
    expect(res.fix).toMatch(/manual console action/i);
  });

  it("the scheduled watch stays SILENT about it — a config gap is not an incident", async () => {
    const { result, dms } = await runTick({ respond: uncapped, now: 1_000_000 });
    expect(result.assessment.status).toBe("warn");
    expect(result.assessment.actionable).toBe(false);
    // Paging hourly, forever, about a fact that will be equally true in six
    // weeks is exactly how an alert channel gets muted.
    expect(dms).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("stays silent across a whole week of hourly ticks", async () => {
    const dms: string[] = [];
    for (let h = 0; h < 24 * 7; h++) {
      const r = await runTick({ respond: uncapped, now: h * HOUR });
      dms.push(...r.dms);
    }
    expect(dms).toEqual([]);
  });
});

describe("a quantified shortfall reaches the operator", () => {
  const low = () => ({
    status: 200,
    body: keyBody({ limit: 50, limit_remaining: 6, limit_reset: "monthly", usage: 44 }),
  });
  const critical = () => ({
    status: 200,
    body: keyBody({ limit: 50, limit_remaining: 2, limit_reset: "monthly", usage: 48 }),
  });
  const healthy = () => ({
    status: 200,
    body: keyBody({ limit: 50, limit_remaining: 40, limit_reset: "monthly", usage: 10 }),
  });

  it("DMs once when credit runs low, naming the numbers and the action", async () => {
    const { result, dms } = await runTick({ respond: low, now: 0 });
    expect(result.assessment.status).toBe("warn");
    expect(result.exitCode).toBe(10);
    expect(dms).toHaveLength(1);
    expect(dms[0]).toContain("OpenRouter credit");
    expect(dms[0]).toContain("$6.00 of $50.00 remaining");
    expect(dms[0]).toContain("https://openrouter.ai/credits");
  });

  it("escalates to FAIL when a single session could exhaust it", async () => {
    const { result, dms } = await runTick({ respond: critical, now: 0 });
    expect(result.assessment.status).toBe("fail");
    expect(dms[0]).toMatch(/CRITICALLY low/);
    expect(dms[0]).toMatch(/^🚨/);
  });

  it("says EXHAUSTED, not merely low, at zero", () => {
    const a = evaluateCredit(parseKeySnapshot(keyBody({ limit: 50, limit_remaining: 0 }))!);
    expect(a.status).toBe("fail");
    expect(a.detail).toMatch(/EXHAUSTED/);
    expect(a.detail).toMatch(/402/);
    expect(a.actionable).toBe(true);
  });

  it("says nothing at all while there is real headroom", async () => {
    const { result, dms } = await runTick({ respond: healthy, now: 0 });
    expect(result.assessment.status).toBe("ok");
    expect(dms).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("warns on the ABSOLUTE floor even when the percentage looks fine", () => {
    // $8 of a $20 limit is 40% — a percentage-only rule calls that healthy,
    // and on a small limit $8 is about a day. The dollar floor is what makes
    // the warning arrive before the outage rather than after it.
    const a = evaluateCredit(parseKeySnapshot(keyBody({ limit: 20, limit_remaining: 8 }))!);
    expect(a.status).toBe("warn");
    expect(a.actionable).toBe(true);
    // …and the same shape at the critical floor: 25% of $10 is not "fine".
    const b = evaluateCredit(parseKeySnapshot(keyBody({ limit: 10, limit_remaining: 2.5 }))!);
    expect(b.status).toBe("fail");
  });

  it("warns on the PERCENTAGE even when the dollar figure looks large", () => {
    // $60 sounds fine until you know the limit is $500 and it is 12% left.
    const a = evaluateCredit(parseKeySnapshot(keyBody({ limit: 500, limit_remaining: 60 }))!);
    expect(a.status).toBe("warn");
    expect(a.actionable).toBe(true);
  });
});

describe("the operator is told once, not every hour", () => {
  const low = () => ({
    status: 200,
    body: keyBody({ limit: 50, limit_remaining: 6, usage: 44 }),
  });

  it("suppresses a repeat of the same severity inside the 6h window", async () => {
    const first = await runTick({ respond: low, now: 0 });
    expect(first.dms).toHaveLength(1);
    // Five more hourly ticks with the shortfall unchanged.
    const later: string[] = [];
    for (let h = 1; h <= 5; h++) {
      later.push(...(await runTick({ respond: low, now: h * HOUR })).dms);
    }
    expect(later).toEqual([]);
    // Still firing — the cron exit code says so even while the DM is silent.
    const quiet = await runTick({ respond: low, now: 2 * HOUR });
    expect(quiet.result.firing).toBe(true);
    expect(quiet.result.exitCode).toBe(10);
  });

  it("re-notifies once the window has elapsed, flagged as unresolved", async () => {
    await runTick({ respond: low, now: 0 });
    const again = await runTick({ respond: low, now: RENOTIFY_MS + 1 });
    expect(again.dms).toHaveLength(1);
    expect(again.dms[0]).toMatch(/still unresolved/i);
  });

  it("ESCALATES immediately — a warn that becomes critical beats the cooldown", async () => {
    await runTick({ respond: low, now: 0 });
    const worse = await runTick({
      respond: () => ({ status: 200, body: keyBody({ limit: 50, limit_remaining: 1 }) }),
      now: 30 * 60_000, // half an hour later, deep inside the quiet window
    });
    expect(worse.dms).toHaveLength(1);
    expect(worse.dms[0]).toMatch(/ESCALATED/);
  });

  it("clears the ledger on recovery so the NEXT incident is not swallowed", async () => {
    await runTick({ respond: low, now: 0 });
    await runTick({
      respond: () => ({ status: 200, body: keyBody({ limit: 50, limit_remaining: 45 }) }),
      now: HOUR,
    });
    // A brand-new shortfall an hour later must notify at once, even though
    // that is well inside 6h of the FIRST alert.
    const fresh = await runTick({ respond: low, now: 2 * HOUR });
    expect(fresh.dms).toHaveLength(1);
  });

  it("does NOT start a 6h silence about an alert that reached nobody", async () => {
    const undelivered = await runTick({ respond: low, now: 0, deliver: false });
    expect(undelivered.dms).toHaveLength(1);
    expect(undelivered.result.delivered).toBe(false);
    // Loud: a watchdog that cannot speak is an incident.
    expect(undelivered.result.exitCode).toBe(1);
    // And the very next tick tries again rather than assuming it landed.
    const retry = await runTick({ respond: low, now: 60_000, deliver: true });
    expect(retry.dms).toHaveLength(1);
    expect(retry.result.delivered).toBe(true);
  });

  it("--dry-run neither sends nor records", async () => {
    const dry = await runTick({ respond: low, now: 0, dryRun: true });
    expect(dry.dms).toEqual([]);
    expect(dry.result.notice).not.toBeNull();
    expect(loadState(statePath)).toEqual({});
  });
});

describe("a broken key is an incident; an unreachable API is not", () => {
  it("FAILs and DMs when OpenRouter rejects the key outright", async () => {
    const { result, dms } = await runTick({
      respond: () => ({ status: 401, ok: false, body: {} }),
      now: 0,
    });
    expect(result.assessment.status).toBe("fail");
    expect(dms).toHaveLength(1);
    expect(dms[0]).toMatch(/invalid, revoked or disabled/);
    // Names the vault key so the operator knows what to replace.
    expect(dms[0]).toContain(OPENROUTER_VAULT_KEY);
  });

  it("exits 1 and stays silent when the API cannot be reached", async () => {
    const { result, dms } = await runTick({
      respond: () => ({ status: 0, throws: new Error("ENOTFOUND openrouter.ai") }),
      now: 0,
    });
    expect(result.exitCode).toBe(1);
    expect(dms).toEqual([]);
    expect(result.assessment.status).toBe("skip");
  });

  it("treats an unrecognised body as UNKNOWN, never as healthy", async () => {
    const { result, dms } = await runTick({
      respond: () => ({ status: 200, body: { data: { something_else: 1 } } }),
      now: 0,
    });
    expect(result.assessment.status).toBe("warn");
    expect(result.assessment.status).not.toBe("ok");
    expect(dms).toEqual([]); // an API-shape change is not a credit incident
  });

  it("exits 1 without DMing when the vault key is not readable", async () => {
    const { result, dms, calls } = await runTick({
      respond: () => ({ status: 200, body: keyBody() }),
      now: 0,
      secret: null,
    });
    expect(result.exitCode).toBe(1);
    expect(dms).toEqual([]);
    expect(calls).toEqual([]); // never attempts an unauthenticated call
  });

  it("doctor SKIPs cleanly when nothing routes through OpenRouter", async () => {
    const [res] = await runOpenRouterCreditChecks({
      enabled: false,
      readSecret: async () => {
        throw new Error("must not be called");
      },
      fetchFn: async () => {
        throw new Error("must not be called");
      },
    });
    expect(res.status).toBe("skip");
  });
});

describe("the key VALUE never escapes", () => {
  it("appears in no DM, no doctor line and no log, on every outcome", async () => {
    const responses: Array<() => { ok?: boolean; status: number; body?: unknown; throws?: Error }> = [
      () => ({ status: 200, body: keyBody() }),
      () => ({ status: 200, body: keyBody({ limit: 50, limit_remaining: 1 }) }),
      () => ({ status: 401, ok: false, body: {} }),
      () => ({ status: 500, ok: false, body: {} }),
      () => ({ status: 0, throws: new Error("ECONNRESET") }),
      () => ({ status: 200, body: { nope: true } }),
    ];
    for (const respond of responses) {
      rmSync(statePath, { force: true });
      const { result, dms, logs, calls } = await runTick({ respond, now: 0 });
      const surface = [
        result.assessment.detail,
        result.assessment.fix ?? "",
        result.notice ?? "",
        ...dms,
        ...logs,
      ].join("\n");
      expect(surface).not.toContain(FAKE_KEY);
      // …while the key WAS used, as an Authorization header and nowhere else.
      if (calls.length > 0) {
        expect(calls[0].url).toBe(OPENROUTER_KEY_ENDPOINT);
        expect(calls[0].headers?.authorization).toBe(`Bearer ${FAKE_KEY}`);
      }
    }
  });

  it("names the vault KEY, never a value, in the doctor fix line", async () => {
    const [res] = await runOpenRouterCreditChecks({
      enabled: true,
      readSecret: async () => null,
      fetchFn: async () => {
        throw new Error("must not be called");
      },
    });
    expect(res.status).toBe("warn");
    expect(res.fix).toContain(OPENROUTER_VAULT_KEY);
  });
});

describe("the state file degrades safely", () => {
  it("round-trips the ledger", () => {
    saveState(statePath, { lastNotifiedAt: 42, lastNotifiedStatus: "warn" });
    expect(loadState(statePath)).toEqual({ lastNotifiedAt: 42, lastNotifiedStatus: "warn" });
  });

  it("treats an absent or torn file as an empty ledger, never a throw", () => {
    expect(loadState(join(dir, "nope.json"))).toEqual({});
    writeFileSync(statePath, "{not json");
    expect(loadState(statePath)).toEqual({});
    writeFileSync(statePath, JSON.stringify({ v: 99, lastNotifiedAt: 1 }));
    expect(loadState(statePath)).toEqual({});
  });

  it("a torn ledger costs at most ONE extra DM, never a missed one", async () => {
    const low = () => ({ status: 200, body: keyBody({ limit: 50, limit_remaining: 6 }) });
    await runTick({ respond: low, now: 0 });
    writeFileSync(statePath, "garbage");
    const after = await runTick({ respond: low, now: HOUR });
    expect(after.dms).toHaveLength(1); // fails toward telling, not toward silence
  });
});

describe("arming the watchdog is a mechanism, not a doc", () => {
  it("renders a cron line that cron will actually run", () => {
    const line = renderCron({ user: "kenthompson", binary: "/usr/local/bin/switchroom" });
    // flock -n: two overlapping ticks would race on the re-notify ledger.
    expect(line).toContain("/usr/bin/flock -n /run/lock/openrouter-watch.lock");
    // cron silently ignores a fragment whose last line has no newline.
    expect(line.endsWith("\n")).toBe(true);
    // cron's default PATH is /usr/bin:/bin.
    expect(line).toMatch(/^PATH=.*\/usr\/local\/bin/m);
    expect(line).toContain(`${CRON_SCHEDULE} kenthompson `);
    expect(line).toContain("switchroom openrouter-watch");
  });

  it("is idempotent", () => {
    const path = join(dir, "cron.d-fragment");
    const opts = { user: "kenthompson", binary: "/usr/local/bin/switchroom", path };
    expect(installCron(opts).status).toBe("installed");
    expect(installCron(opts).status).toBe("unchanged");
    expect(readFileSync(path, "utf8")).toBe(renderCron(opts));
  });

  it("ticks at most hourly — one third-party GET per hour, not per minute", () => {
    const [minute] = CRON_SCHEDULE.split(" ");
    expect(minute).toMatch(/^\d+$/); // a fixed minute, not a */N sub-hour step
  });
});

describe("enablement is read from the real proxy config shape", () => {
  it("detects an OpenRouter-backed model group", () => {
    expect(usesOpenRouter("  - model_name: gpt-5\n    litellm_params:\n      model: openrouter/openai/gpt-5\n")).toBe(true);
    expect(usesOpenRouter("      api_key: os.environ/OPENROUTER_API_KEY\n")).toBe(true);
  });

  it("does not claim OpenRouter for a config that has none", () => {
    expect(usesOpenRouter("  - model_name: sonnet\n    litellm_params:\n      model: anthropic/claude\n")).toBe(false);
    expect(usesOpenRouter(null)).toBe(false);
  });
});
