/**
 * hostd `config_propose_edit` — IDEMPOTENCY + the failure-class corpus
 * seed for the 2026-06-15 klanker debacle.
 *
 * Failure recap: the agent's MCP wire timed out at 10s on an op that
 * BLOCKS server-side until the operator taps (up to ~10 min). The agent
 * misread the timeout as a wire failure and RE-FIRED, stacking phantom
 * approval cards; multiple taps then double-wrote a config entry
 * (`postureMintAgents: - marko` appeared twice).
 *
 * The timeout itself is fixed on the MCP side (see
 * `src/mcp/hostd/server.test.ts` — per-op wire timeout). THIS file pins
 * the deeper invariant that must survive the whole failure CLASS, not
 * just the one bug: an identical in-flight proposal is collapsed onto a
 * single approval card and applied EXACTLY ONCE, no matter how many
 * times it is (re-)fired or how the operator's tap latency varies.
 *
 * The `describe("property — ...")` block IS the KEN-29 probabilistic-UAT
 * seed: a fuzzed corpus over {verdict × burst size × tap latency} that
 * asserts the invariants on every schedule so this class cannot
 * silently recur.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer } from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";
import type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalResult,
  ApprovalVerdict,
} from "../../src/host-control/approval-gateway.js";

let tmp: string;
let server: HostdServer;
let stubBin: string;
let configPath: string;

const VALID_BASE_YAML =
  "switchroom:\n" +
  "  version: 1\n" +
  "telegram:\n" +
  '  bot_token: "x"\n' +
  '  forum_chat_id: "1"\n' +
  "agents: {}\n";

// Applies cleanly to VALID_BASE_YAML (lines 1-3: switchroom: / version / telegram:).
const DIFF_A =
  "--- a/switchroom.yaml\n" +
  "+++ b/switchroom.yaml\n" +
  "@@ -1,3 +1,3 @@\n" +
  " switchroom:\n" +
  "-  version: 1\n" +
  "+  version: 1  # touched-a\n" +
  " telegram:\n";

// A DIFFERENT clean diff (distinct content hash → must NOT dedupe with A).
// It edits a DIFFERENT region (forum_chat_id, lines 3-6) than DIFF_A (the
// version line, lines 1-3), so the two are genuinely NON-CONFLICTING: whichever
// applies first, the other's stored diff STILL applies cleanly against the
// drifted file (#3084 — the apply path re-applies the stored diff under the
// lock, so non-conflicting concurrent edits both survive). If DIFF_B instead
// rewrote the SAME line as DIFF_A, the second apply would correctly abort with
// E_CONFIG_CHANGED — that conflict path is covered in config-propose-edit.test.ts.
const DIFF_B =
  "--- a/switchroom.yaml\n" +
  "+++ b/switchroom.yaml\n" +
  "@@ -3,4 +3,4 @@\n" +
  " telegram:\n" +
  '   bot_token: "x"\n' +
  '-  forum_chat_id: "1"\n' +
  '+  forum_chat_id: "1"  # touched-b\n' +
  " agents: {}\n";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeServer(approvalGateway: ApprovalGateway) {
  return new HostdServer({
    homeDir: tmp,
    agentUids: { klanker: 10001 },
    config: {
      agents: { klanker: { admin: true } },
      hostd: { config_edit_enabled: true },
    },
    switchroomBin: stubBin,
    auditLogPath: join(tmp, "audit.log"),
    allowNonLinux: true,
    configPath,
    approvalGateway,
  });
}

/**
 * Gateway that holds each approval open for `holdMs` before returning
 * `verdict`. Holding the card open is what lets a re-fired proposal
 * arrive WHILE the first is still in flight — the dedupe window.
 * Counts requestApproval invocations and finalize outcomes.
 */
function holdingGateway(verdict: ApprovalVerdict, holdMs: number) {
  const requests: ApprovalRequest[] = [];
  const finalizeCalls: Array<{ outcome: string }> = [];
  const gw: ApprovalGateway = {
    async requestApproval(req): Promise<ApprovalResult> {
      requests.push(req);
      await sleep(holdMs);
      return {
        verdict,
        finalize: async (out) => {
          finalizeCalls.push({ outcome: out.outcome });
        },
      };
    },
  };
  return { gw, requests, finalizeCalls };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-cpe-idem-"));
  stubBin = join(tmp, "switchroom-stub.sh");
  // Reconcile stub always succeeds.
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
  configPath = join(tmp, "switchroom.yaml");
  writeFileSync(configPath, VALID_BASE_YAML);
});

afterEach(async () => {
  if (server) await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

function sock(owner = "klanker"): string {
  return server.getBoundPaths().find((p) => p.endsWith(`/${owner}/sock`))!;
}

function send(unified_diff: string, request_id: string) {
  return hostdRequest(
    { socketPath: sock(), timeoutMs: 60_000 },
    {
      v: 1,
      op: "config_propose_edit",
      request_id,
      args: { unified_diff, reason: "test", target_path: "/state/config/switchroom.yaml" },
    },
  );
}

describe("config_propose_edit — idempotency (dedupe in-flight)", () => {
  it("collapses two identical in-flight proposals onto ONE card + ONE apply", async () => {
    const { gw, requests, finalizeCalls } = holdingGateway("approve", 120);
    server = makeServer(gw);
    await server.start();

    // Fire both before the first resolves (the card is held 120ms).
    const p1 = send(DIFF_A, "dup-1");
    await sleep(20); // let the first reach the dedupe point
    const p2 = send(DIFF_A, "dup-2");
    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one approval card was raised, one apply finalized.
    expect(requests.length).toBe(1);
    expect(finalizeCalls.filter((f) => f.outcome === "applied").length).toBe(1);
    // Both callers got a terminal, successful result (shared promise).
    expect(r1.result).toBe("completed");
    expect(r2.result).toBe("completed");
    // The edit landed once.
    expect(readFileSync(configPath, "utf-8")).toContain("# touched-a");
  });

  it("does NOT dedupe two DISTINCT diffs (different content hash)", async () => {
    const { gw, requests } = holdingGateway("approve", 80);
    server = makeServer(gw);
    await server.start();

    const p1 = send(DIFF_A, "distinct-1");
    await sleep(15);
    const p2 = send(DIFF_B, "distinct-2");
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(requests.length).toBe(2); // two separate cards
    expect(r1.result).toBe("completed");
    expect(r2.result).toBe("completed");
    // #3084 — the two edits touch DIFFERENT regions, so re-applying each stored
    // diff under the lock preserves the other. BOTH survive; a naive whole-file
    // post-image write would keep only the last writer's version.
    const live = readFileSync(configPath, "utf-8");
    expect(live).toContain("# touched-a");
    expect(live).toContain("# touched-b");
  });

  it("releases the dedupe key after resolution — a later identical proposal gets a fresh card", async () => {
    // Use deny so the file stays at VALID_BASE_YAML and the 2nd identical
    // proposal still validates (a re-apply of an applied diff would be
    // rejected by the validator, which is a different, complementary
    // guard). This isolates the key-release behaviour.
    const { gw, requests } = holdingGateway("deny", 0);
    server = makeServer(gw);
    await server.start();

    const r1 = await send(DIFF_A, "seq-1"); // fully resolves (denied)
    const r2 = await send(DIFF_A, "seq-2"); // identical, but after release
    expect(requests.length).toBe(2); // fresh card the second time
    expect(r1.result).toBe("denied");
    expect(r2.result).toBe("denied");
  });
});

// ── KEN-29 corpus seed ────────────────────────────────────────────────
// Fuzz the schedule that produced the debacle: a burst of N identical
// (re-fired) proposals racing a variable operator tap latency, across
// approve / deny / timeout. Invariants must hold on EVERY schedule.
describe("property — re-fired identical proposals: exactly-once apply, always terminal", () => {
  // Seeded LCG so a failing schedule is reproducible (no Math.random).
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
  }
  const verdicts: ApprovalVerdict[] = ["approve", "deny", "timeout"];
  const ITERATIONS = 60;

  it(
    `holds invariants across ${ITERATIONS} fuzzed schedules`,
    async () => {
    const rand = lcg(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i++) {
      const verdict = verdicts[Math.floor(rand() * verdicts.length)]!;
      const burst = 2 + Math.floor(rand() * 3); // 2..4 identical re-fires
      // Simulated operator tap latency. The card only needs to stay open
      // longer than the burst's sub-ms arrival spread to exercise the
      // in-flight dedupe overlap — the ABSOLUTE magnitude is irrelevant to
      // every invariant here, so a wide 0..59ms range was pure sequential
      // wall-clock cost (~1.9s of setTimeout sleeps summed over 60 schedules,
      // the dominant term that pushed this loop past the 5s default under CI
      // fork contention — #3170). Both regimes stay anchored deterministically
      // by the sibling tests (the dedupe-collapse test pins overlap; the
      // key-release test pins the sequential/non-overlap path), so shrinking
      // the range keeps full coverage while cutting the sleep budget ~3x.
      const holdMs = Math.floor(rand() * 20); // 0..19ms tap latency
      const arrivalJitter = Math.floor(rand() * 12); // stagger re-fires

      // Fresh server + file per schedule.
      writeFileSync(configPath, VALID_BASE_YAML);
      const { gw, requests, finalizeCalls } = holdingGateway(verdict, holdMs);
      server = makeServer(gw);
      await server.start();

      const inflight: Array<Promise<{ result: string }>> = [];
      for (let k = 0; k < burst; k++) {
        inflight.push(send(DIFF_A, `fuzz-${i}-${k}`) as Promise<{ result: string }>);
        if (arrivalJitter) await sleep(arrivalJitter > 6 ? 1 : 0);
      }
      const results = await Promise.all(inflight);

      const ctx = `schedule#${i} verdict=${verdict} burst=${burst} hold=${holdMs} jitter=${arrivalJitter}`;

      // INVARIANT 1 — bounded cards. Re-fires that genuinely OVERLAP in
      // flight collapse onto one card (proven exactly in the deterministic
      // dedupe test above). Re-fires that DON'T overlap (tiny tap latency)
      // are sequential and each may raise its own card — that's correct;
      // their safety is carried by INVARIANT 2 + validation, not dedupe.
      // So here we only bound: at least one, never more than the burst.
      expect(requests.length, `${ctx}: cards in [1,burst]`).toBeGreaterThanOrEqual(1);
      expect(requests.length, `${ctx}: cards in [1,burst]`).toBeLessThanOrEqual(burst);

      // INVARIANT 2 — exactly-once apply: applied iff approved, never twice.
      // This is the load-bearing one — the marko-written-twice guarantee.
      // Holds under overlap (dedupe) AND non-overlap (a late identical
      // re-fire validates against the already-mutated file and is rejected
      // before it can apply again).
      const applies = finalizeCalls.filter((f) => f.outcome === "applied").length;
      expect(applies, `${ctx}: apply count`).toBe(verdict === "approve" ? 1 : 0);

      // INVARIANT 3 — every caller reaches a terminal state (no hangs).
      for (const r of results) {
        expect(["completed", "denied", "error"], `${ctx}: terminal`).toContain(r.result);
      }
      // (Under genuine overlap all callers share ONE outcome — proven in
      //  the deterministic dedupe test. Under non-overlap a late identical
      //  re-fire is correctly rejected at validation, so outcomes may
      //  legitimately differ; the safety guarantee is INVARIANT 2, not a
      //  uniform return code.)

      // INVARIANT 4 — file mutated iff approved.
      const after = readFileSync(configPath, "utf-8");
      expect(after.includes("# touched-a"), `${ctx}: file state`).toBe(verdict === "approve");

      await server.stop();
    }
  },
    // Explicit generous budget (default is 5s). After the holdMs shrink this
    // loop runs in ~2s locally, but its irreducible floor is 60×(2..4) REAL
    // `git apply` subprocess spawns (propose-time validation + the under-lock
    // re-apply) whose wall time is legitimately load-dependent — under CI
    // shards (`VITEST_MAX_FORKS: 2`, co-scheduled suites contending for CPU +
    // process spawns) it can stretch several-fold. 30s is ~15x the local
    // runtime: it leaves ample headroom for shard contention yet still trips
    // on a genuine hang/deadlock (the failure this suite guards against). #3170
    30_000,
  );
});
