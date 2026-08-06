/**
 * Runtime proof that the Hindsight bank hermeticity guard is installed and
 * actually intercepts a test process's request to a FLEET Hindsight.
 *
 * ── What it is guarding against ─────────────────────────────────────────
 *
 * On 2026-07-30T23:51-23:55Z a harness/parity sweep minted eleven throwaway
 * banks in the fleet's LIVE Hindsight (verified in `GET /v1/default/banks` on
 * the production instance; `created_at` 23:51:08Z-23:55:37Z). Every name is a
 * switchroom test fixture. One was `clerk` — a live agent's name. Agent
 * `clerk` actually writes to the bank `assistant` (86,240 facts), and the
 * empty decoy `clerk` bank carried a warning annotation in its `mission`
 * saying exactly that, so nobody would mistake it for lost memory. The sweep
 * replaced the bank and erased the annotation; a week later an agent read the
 * empty bank and reported clerk's memory as lost.
 *
 * Hindsight has no missing-bank error — `get_or_create_bank_profile`
 * (engine/retain/bank_utils.py) and `ensure_bank_exists`
 * (engine/retain/fact_storage.py) auto-create on miss and return zeros — so a
 * single stray request is enough, and deleting a stray does not help because
 * the next lookup recreates it.
 *
 * ── Why these assertions are an honest alarm ────────────────────────────
 *
 * The guard lives in `tests/vitest-setup/hindsight-bank-guard.mjs`, wired as a
 * `test.setupFiles` entry in vitest.config.ts and as a `preload` in both
 * bunfigs. It is invisible to the suites it protects — which is the point
 * (nothing to remember per file) and also the risk (nothing fails loudly if
 * someone deletes a wiring). This file is that alarm, asserted as outcomes:
 *
 *   1. Replaying the sweep — the same eleven bank paths, against a fleet
 *      Hindsight port — rejects with the guard marker AND is observed to have
 *      hit the guard. A trip count of zero means the guard is not installed.
 *   2. A non-fleet origin still goes through, so the guard has not simply
 *      broken every test that talks to a local HTTP server.
 *
 * The replay deliberately targets 192.0.2.1 (TEST-NET-1, RFC 5737) rather
 * than the live 127.0.0.1 endpoint: it is unroutable, so an UNWIRED run fails
 * on the marker assertion instead of doing the very thing this guard exists
 * to prevent. The literal production origin is covered by the pure predicate
 * tests below, which make no network call at all.
 *
 * NOTE: this file imports the CORE module, never the setup file. The core
 * installs nothing, so this test cannot install the guard it is verifying —
 * if `setupFiles` is unwired in vitest.config.ts, these tests FAIL rather than
 * silently self-heal. Same shape as `src/auth/broker/net-hermeticity.test.ts`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import {
  ALLOW_ORIGINS_ENV_VAR,
  FLEET_HINDSIGHT_PORTS,
  HINDSIGHT_BANK_GUARD_MARKER,
  HINDSIGHT_SENTINEL_URL,
  HINDSIGHT_URL_ENV_VARS,
  buildHindsightGuardPolicy,
  hindsightBankGuardTrips,
  resetHindsightBankGuardTrips,
  shouldBlockHindsightRequest,
} from "./vitest-setup/hindsight-bank-guard-core.mjs";
import { HINDSIGHT_DEFAULT_API_PORT } from "../src/setup/hindsight.js";

/**
 * The eleven banks the sweep actually minted, read off the live instance.
 * `clerk` is the collision that cost real recovery time; the rest are the
 * clutter that proves the leak was a whole sweep, not one bad call.
 */
const SWEPT_BANKS = [
  "probe",
  "general",
  "gamma",
  "test-agent",
  "memory-agent",
  "clerk",
  "parity-default-no-tools-",
  "parity-dangerous-mode-true",
  "parity-webkite-opted-out",
  "parity-explicit-tools-allow",
  "parity-tools-allow-all-",
];

/** Unroutable stand-in for the fleet host — same PORT, which is what the
 *  guard actually keys on. See the header note. */
const FLEET_PORT = FLEET_HINDSIGHT_PORTS[0];
const REPLAY_HOST = `http://192.0.2.1:${FLEET_PORT}`;

/** The request shapes that auto-create a bank in Hindsight. */
const bankPaths = (bank: string): string[] => [
  `/v1/default/banks/${encodeURIComponent(bank)}/config`,
  `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`,
  `/v1/default/banks/${encodeURIComponent(bank)}/stats`,
];

/**
 * Short abort on every replay call. The guard rejects before `fetch` runs, so
 * this is inert when the wiring is intact. When the wiring is GONE the call
 * reaches the network stack against an unroutable address, and without this it
 * would hang until vitest's 5s per-test timeout — turning a precise "the guard
 * is not installed" failure into twelve slow, vague ones.
 */
const replayInit = (init: RequestInit = {}): RequestInit => ({
  ...init,
  signal: AbortSignal.timeout(250),
});

beforeEach(() => {
  resetHindsightBankGuardTrips();
});

describe("hindsight bank guard — the 2026-07-30 sweep, replayed", () => {
  it.each(SWEPT_BANKS)(
    "refuses to let a test process touch bank %s on a fleet Hindsight",
    async (bank) => {
      for (const path of bankPaths(bank)) {
        await expect(fetch(`${REPLAY_HOST}${path}`, replayInit())).rejects.toThrow(
          HINDSIGHT_BANK_GUARD_MARKER,
        );
      }
      // Outcome, not code path: the guard is what stopped it. Zero here means
      // the wiring is gone and every one of those requests went to the wire.
      expect(hindsightBankGuardTrips()).toBe(bankPaths(bank).length);
    },
  );

  it("refuses a retain POST too, not only reads", async () => {
    await expect(
      fetch(
        `${REPLAY_HOST}/v1/default/banks/clerk/memories`,
        replayInit({
          method: "POST",
          body: JSON.stringify({ content: "synthetic test fact" }),
        }),
      ),
    ).rejects.toThrow(HINDSIGHT_BANK_GUARD_MARKER);
    expect(hindsightBankGuardTrips()).toBe(1);
  });

  it("names the incident in the failure, so the next author knows why", async () => {
    await expect(fetch(`${REPLAY_HOST}/v1/default/banks/clerk/config`, replayInit())).rejects.toThrow(
      /FLEET Hindsight origin/,
    );
    await expect(fetch(`${REPLAY_HOST}/v1/default/banks/clerk/config`, replayInit())).rejects.toThrow(
      new RegExp(ALLOW_ORIGINS_ENV_VAR),
    );
  });
});

describe("hindsight bank guard — what it must NOT break", () => {
  it("lets a request to an ephemeral local server through", async () => {
    // `listen(0)` allocates from the Linux ephemeral range (32768-60999),
    // which can never collide with the fleet port. This is the shape used by
    // tests/hindsight-mcp-shim.test.ts and tests/hindsight-write-redaction.test.ts,
    // both of which drive real `/v1/default/banks/...` paths against a real
    // local server — they must keep working.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(String(port)).not.toBe(FLEET_PORT);
      const res = await fetch(`http://127.0.0.1:${port}/v1/default/banks/probe/config`);
      expect(res.status).toBe(200);
      expect(hindsightBankGuardTrips()).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("hindsight bank guard — the predicate", () => {
  const empty = { blockedOrigins: [], allowedOrigins: [] };

  it("blocks the LITERAL production endpoint the sweep used", () => {
    // No network: this is the one place the real fleet URL appears, and it is
    // only ever handed to a pure function.
    for (const bank of SWEPT_BANKS) {
      expect(
        shouldBlockHindsightRequest(
          `http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}/v1/default/banks/${bank}/config`,
          empty,
        ),
      ).toBe(true);
    }
  });

  it("blocks by ORIGIN, not by bank name — a fixture name is not the hazard", () => {
    // `clerk` on someone's own instance is fine; `newbie` on the fleet is not.
    expect(
      shouldBlockHindsightRequest("http://127.0.0.1:41234/v1/default/banks/clerk/config", empty),
    ).toBe(false);
    expect(
      shouldBlockHindsightRequest(
        `http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}/v1/default/banks/newbie/config`,
        empty,
      ),
    ).toBe(true);
  });

  it("blocks an ambient env origin even on a non-default port", () => {
    // Inside an agent container `npm test` inherits HINDSIGHT_API_URL pointed
    // at the fleet. A fleet moved off 18888 must still be blocked.
    const policy = buildHindsightGuardPolicy({ HINDSIGHT_API_URL: "http://memhost:7777" });
    expect(policy.blockedOrigins).toContain("http://memhost:7777");
    expect(
      shouldBlockHindsightRequest("http://memhost:7777/v1/default/banks/clerk/config", policy),
    ).toBe(true);
    expect(shouldBlockHindsightRequest("http://memhost:7778/v1/x", policy)).toBe(false);
  });

  it("seeds the blocked set from every Hindsight URL env var", () => {
    const env: Record<string, string> = {};
    for (const [i, k] of HINDSIGHT_URL_ENV_VARS.entries()) env[k] = `http://h${i}:9${i}00`;
    const policy = buildHindsightGuardPolicy(env);
    for (const k of HINDSIGHT_URL_ENV_VARS) {
      expect(policy.blockedOrigins).toContain(new URL(env[k]).origin);
    }
  });

  it("honours the explicit opt-in allowlist", () => {
    const url = `http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}/v1/default/banks/clerk/config`;
    expect(shouldBlockHindsightRequest(url, empty)).toBe(true);
    const policy = buildHindsightGuardPolicy({
      [ALLOW_ORIGINS_ENV_VAR]: `http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}`,
    });
    expect(shouldBlockHindsightRequest(url, policy)).toBe(false);
  });

  it("ignores inputs that are not URLs rather than blocking them", () => {
    for (const junk of ["", "not a url", "/relative/path", undefined, null, 42]) {
      expect(shouldBlockHindsightRequest(junk, empty)).toBe(false);
    }
  });

  it("accepts a Request-shaped object, not only a string", () => {
    expect(
      shouldBlockHindsightRequest(
        { url: `http://127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}/v1/default/banks/clerk/config` },
        empty,
      ),
    ).toBe(true);
  });
});

describe("hindsight bank guard — coverage pins", () => {
  it("guards the fleet API port the source actually declares", () => {
    // A repoint of HINDSIGHT_DEFAULT_API_PORT that forgets the guard would
    // leave the new port wide open while every other test here still passes.
    // `scripts/check-hindsight-bank-hermeticity.mjs` enforces the same thing
    // statically; this is the runtime half.
    expect(FLEET_HINDSIGHT_PORTS).toContain(String(HINDSIGHT_DEFAULT_API_PORT));
  });

  it("has scrubbed the ambient Hindsight URLs to the sentinel", () => {
    // Inside an agent container these arrive pointed at the LIVE fleet. After
    // the guard loads they must never still name a real endpoint — code that
    // reads the env and fetches would otherwise reach production directly.
    for (const k of HINDSIGHT_URL_ENV_VARS) {
      expect([undefined, HINDSIGHT_SENTINEL_URL]).toContain(process.env[k]);
    }
  });

  it("keeps the sentinel itself blocked, so a scrubbed read fails loudly", () => {
    expect(
      shouldBlockHindsightRequest(`${HINDSIGHT_SENTINEL_URL}/v1/default/banks/clerk/config`, {
        blockedOrigins: [],
        allowedOrigins: [],
      }),
    ).toBe(true);
  });
});
