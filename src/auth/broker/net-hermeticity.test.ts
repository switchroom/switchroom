/**
 * Runtime proof that the auth-broker hermeticity guard is installed and
 * actually intercepts the live quota probe (#3612).
 *
 * The guard lives in `tests/vitest-setup/auth-net-guard.mjs`, wired as
 * `test.setupFiles` in vitest.config.ts. It is invisible to the suites it
 * protects — which is the point (nothing to forget per file) and also the
 * risk (nothing fails loudly if someone deletes the wiring). These tests
 * are that alarm, asserted as outcomes rather than as configuration:
 *
 *   1. `fetch` inside an auth test rejects instead of dialling out.
 *   2. The mark-exhausted roll — the exact path that timed out on main —
 *      completes far inside the harness deadline AND is observed to have
 *      hit the guard. A trip count of zero means the probe no longer
 *      happens there and this proof has stopped proving anything.
 *
 * Note the broker below is deliberately constructed WITHOUT the
 * `_testFetchQuota` seam. That is the defective shape from #3612; it is
 * safe here only because the runner-level guard makes it hermetic.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import { writeAccountCredentials } from "../account-store.js";
import type { SwitchroomConfig } from "../../config/schema.js";
// NOTE: import the CORE module, never the setup file. The core registers
// no hooks, so this test cannot install the guard it is verifying — if
// `test.setupFiles` is unwired in vitest.config.ts, these tests fail.
import {
  AUTH_NET_GUARD_MARKER,
  authNetGuardTrips,
  shouldGuardSource,
} from "../../../tests/vitest-setup/auth-net-guard-core.mjs";

/** Same 3s deadline the sibling broker harnesses enforce. */
const RPC_DEADLINE_MS = 3000;

const tmps: string[] = [];

afterEach(() => {
  for (const t of tmps.splice(0)) {
    try { rmSync(t, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function rpc(socketPath: string, req: object): Promise<unknown> {
  return await new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* ignore */ }
      if (err) rejectP(err); else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try { settle(decodeResponse(buf.slice(0, nl))); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), RPC_DEADLINE_MS);
  });
}

describe("auth-broker hermeticity guard", () => {
  it("global fetch is replaced by the guard: an outbound call rejects, it does not dial out", async () => {
    const before = authNetGuardTrips();
    await expect(fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      AUTH_NET_GUARD_MARKER,
    );
    expect(authNetGuardTrips()).toBe(before + 1);
  });

  it("scopes itself by file content: a broker/quota test is guarded, an unrelated one is not", () => {
    expect(shouldGuardSource("const b = new AuthBroker(config, opts);")).toBe(true);
    expect(shouldGuardSource("const r = await fetchQuota({ accessToken });")).toBe(true);
    expect(shouldGuardSource("expect(add(1, 2)).toBe(3);")).toBe(false);
  });

  it("mark-exhausted's live probe goes through the guard, not the wire, well inside the deadline", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "auth-broker-hermeticity-"));
    tmps.push(tmp);
    const home = join(tmp, "home");
    const agentsDir = join(home, ".switchroom", "agents");
    const stateDir = join(home, ".switchroom", "state", "auth-broker");
    const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(join(agentsDir, "ziggy"), { recursive: true });

    for (const label of ["default", "secondary"]) {
      writeAccountCredentials(
        label,
        {
          claudeAiOauth: {
            accessToken: `at-${label}`,
            refreshToken: `rt-${label}`,
            expiresAt: Date.now() + 3_600_000,
            scopes: ["user:inference"],
            subscriptionType: "max",
          },
        },
        home,
      );
    }

    const config = ({
      switchroom: { version: 1, agents_dir: agentsDir },
      telegram: {},
      agents: { ziggy: {} },
      auth: { active: "default", fallback_order: ["default", "secondary"] },
    } as unknown) as SwitchroomConfig;

    // No `_testFetchQuota` — the #3612 shape on purpose.
    const broker = new AuthBroker(config, {
      home,
      stateDir,
      socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    try {
      const tripsBefore = authNetGuardTrips();
      const startedAt = Date.now();
      const resp = await rpc(join(socketRoot, "ziggy", "sock"), {
        v: 1, id: "1", op: "mark-exhausted", until: Date.now() + 60_000,
      }) as { ok: boolean; data: { account: string; rolledTo: string | null } };
      const elapsed = Date.now() - startedAt;

      expect(resp.ok).toBe(true);
      expect(resp.data.account).toBe("default");
      expect(resp.data.rolledTo).toBe("secondary");
      // A live probe would burn up to 10s here (fetchQuota's default abort)
      // and blow the 3s deadline. Guarded, the roll is sub-second.
      expect(elapsed).toBeLessThan(RPC_DEADLINE_MS / 2);
      // …and it really did take the probe path: the guard was tripped.
      expect(authNetGuardTrips()).toBeGreaterThan(tripsBefore);
    } finally {
      broker.stop();
    }
  });
});
