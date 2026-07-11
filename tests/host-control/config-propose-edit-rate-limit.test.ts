/**
 * hostd `config_propose_edit` — SERVER-SIDE RATE LIMIT + audit-at-card-post.
 *
 * Loop-not-fully-closed recap: the in-flight dedupe is byte-exact on the
 * unified_diff, so a looping agent re-firing DISTINCT diffs (any whitespace
 * / context drift) posts a fresh operator card every time. The
 * `config_edit_rate_per_hour` config field existed but was never enforced.
 * These tests pin:
 *
 *   1. A caller exceeding `config_edit_rate_per_hour` distinct proposals in
 *      the sliding hour is rejected with `E_RATE_LIMITED` BEFORE another
 *      approval card is raised (the operator stops getting spammed).
 *   2. A `requested` audit row is emitted at card-post time, so an operator
 *      can retroactively see "agent fired Nx" even for proposals that never
 *      reach the apply path; and a `rate_limited` row is emitted on throttle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer } from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";
import type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalResult,
} from "../../src/host-control/approval-gateway.js";

let tmp: string;
let server: HostdServer;
let stubBin: string;
let configPath: string;
let auditPath: string;

const VALID_BASE_YAML =
  "switchroom:\n" +
  "  version: 1\n" +
  "telegram:\n" +
  '  bot_token: "x"\n' +
  '  forum_chat_id: "1"\n' +
  "agents: {}\n";

// N distinct-but-clean diffs (each touches the version line differently, so
// the byte-exact dedupe never collapses them — exactly the loop case).
function distinctDiff(tag: string): string {
  return (
    "--- a/switchroom.yaml\n" +
    "+++ b/switchroom.yaml\n" +
    "@@ -1,3 +1,3 @@\n" +
    " switchroom:\n" +
    "-  version: 1\n" +
    `+  version: 1  # ${tag}\n` +
    " telegram:\n"
  );
}

// A gateway that DENIES every card immediately (so the file is never mutated
// and each distinct diff keeps validating). Counts the cards raised.
function denyingGateway() {
  const requests: ApprovalRequest[] = [];
  const gw: ApprovalGateway = {
    async requestApproval(req): Promise<ApprovalResult> {
      requests.push(req);
      return { verdict: "deny", denySource: "operator", finalize: async () => {} };
    },
  };
  return { gw, requests };
}

// #2975 Stage 2 — a gateway that reports `checkPreApproved` true only for one
// specific diff (the operator-consented persist), and approves that same diff's
// requestApproval while denying everything else. Mirrors the real
// mental-model / always-allow bypass: the pre-approved persist skips the rate
// limit, any other proposal still posts a (here: denied) card.
function bypassGateway(opts: { preApprovedDiff: string; approve: boolean }) {
  const requests: ApprovalRequest[] = [];
  const preChecks: Array<{ agent: string; diff: string }> = [];
  const gw: ApprovalGateway = {
    async requestApproval(req): Promise<ApprovalResult> {
      requests.push(req);
      if (req.unifiedDiff === opts.preApprovedDiff && opts.approve) {
        return { verdict: "approve", finalize: async () => {} };
      }
      return { verdict: "deny", denySource: "operator", finalize: async () => {} };
    },
    async checkPreApproved(agentName, unifiedDiff): Promise<boolean> {
      preChecks.push({ agent: agentName, diff: unifiedDiff });
      return unifiedDiff === opts.preApprovedDiff;
    },
  };
  return { gw, requests, preChecks };
}

function makeServer(
  gw: ApprovalGateway,
  ratePerHour?: number,
  runReconcile?: (args: { requestId: string }) => Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
  }>,
) {
  return new HostdServer({
    homeDir: tmp,
    agentUids: { klanker: 10001 },
    config: {
      agents: { klanker: { admin: true } },
      hostd: {
        config_edit_enabled: true,
        ...(ratePerHour !== undefined ? { config_edit_rate_per_hour: ratePerHour } : {}),
      },
    },
    switchroomBin: stubBin,
    auditLogPath: auditPath,
    allowNonLinux: true,
    configPath,
    approvalGateway: gw,
    ...(runReconcile ? { runReconcile } : {}),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-cpe-rate-"));
  stubBin = join(tmp, "switchroom-stub.sh");
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
  configPath = join(tmp, "switchroom.yaml");
  writeFileSync(configPath, VALID_BASE_YAML);
  auditPath = join(tmp, "audit.log");
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
      args: { unified_diff, reason: "loop test", target_path: "/state/config/switchroom.yaml" },
    },
  );
}

function readAuditRows(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("config_propose_edit — server-side rate limit (#config-edit-hardening)", () => {
  it("throttles a looping agent after config_edit_rate_per_hour distinct cards", async () => {
    const { gw, requests } = denyingGateway();
    server = makeServer(gw, 3); // 3 cards/hour
    await server.start();

    // Three DISTINCT proposals all reach a card (and get denied).
    const r1 = await send(distinctDiff("a"), "rl-1");
    const r2 = await send(distinctDiff("b"), "rl-2");
    const r3 = await send(distinctDiff("c"), "rl-3");
    // The fourth distinct proposal trips the limiter — NO fourth card.
    const r4 = await send(distinctDiff("d"), "rl-4");

    expect(r1.result).toBe("denied");
    expect(r2.result).toBe("denied");
    expect(r3.result).toBe("denied");
    // The throttled one is denied with the rate-limit code, and crucially
    // never reached the gateway (no fourth card spammed at the operator).
    expect(r4.result).toBe("denied");
    expect(r4.error ?? "").toMatch(/E_RATE_LIMITED|rate limit/i);
    expect(requests.length).toBe(3);
  });

  it("uses the schema default (3/hour) when config_edit_rate_per_hour is unset", async () => {
    const { gw, requests } = denyingGateway();
    server = makeServer(gw); // no explicit rate → default 3
    await server.start();

    for (const tag of ["a", "b", "c"]) await send(distinctDiff(tag), `def-${tag}`);
    const over = await send(distinctDiff("d"), "def-d");
    expect(over.error ?? "").toMatch(/E_RATE_LIMITED|rate limit/i);
    expect(requests.length).toBe(3);
  });
});

describe("config_propose_edit — audit at card-post time (#config-edit-hardening item 5)", () => {
  it("emits a `requested` row when a card is posted (visible before apply)", async () => {
    const { gw } = denyingGateway();
    server = makeServer(gw, 5);
    await server.start();

    await send(distinctDiff("a"), "aud-1");
    // Give the best-effort audit append a tick to flush.
    await new Promise<void>((r) => setTimeout(r, 30));

    const rows = readAuditRows();
    const requested = rows.filter(
      (r) => r.op === "config_propose_edit" && r.phase === "requested",
    );
    expect(requested.length).toBe(1);
    expect(requested[0]!.request_id).toBe("aud-1");
    expect(requested[0]!.result).toBe("started");
    expect((requested[0]!.caller as { name?: string }).name).toBe("klanker");
  });

  it("emits a `rate_limited` row when a proposal is throttled", async () => {
    const { gw } = denyingGateway();
    server = makeServer(gw, 1); // 1/hour → second is throttled
    await server.start();

    await send(distinctDiff("a"), "rlr-1");
    await send(distinctDiff("b"), "rlr-2"); // throttled
    await new Promise<void>((r) => setTimeout(r, 30));

    const rows = readAuditRows();
    const throttled = rows.filter(
      (r) => r.op === "config_propose_edit" && r.phase === "rate_limited",
    );
    expect(throttled.length).toBe(1);
    expect(throttled[0]!.request_id).toBe("rlr-2");
    expect(throttled[0]!.result).toBe("denied");
  });
});

describe("config_propose_edit — pre-approval bypass (#2975 Stage 2)", () => {
  it("an exhausted bucket + gateway pre-approval → applies immediately, no E_RATE_LIMITED, audit pre_approved:true", async () => {
    const preApprovedDiff = distinctDiff("preapproved");
    const { gw, preChecks } = bypassGateway({ preApprovedDiff, approve: true });
    server = makeServer(gw, 3, async () => ({ exit_code: 0, stdout: "", stderr: "" })); // 3/hour, reconcile ok
    await server.start();

    // Fill the bucket with three ordinary (denied) proposals.
    await send(distinctDiff("a"), "bp-a");
    await send(distinctDiff("b"), "bp-b");
    await send(distinctDiff("c"), "bp-c");

    // The pre-approved persist, with the bucket EXHAUSTED, still applies —
    // it never returns E_RATE_LIMITED because checkPreApproved answered true.
    const pre = await send(preApprovedDiff, "bp-pre");
    expect(pre.result).toBe("completed");
    expect(pre.error ?? "").not.toMatch(/E_RATE_LIMITED|rate limit/i);

    // The gateway WAS consulted for the pre-approval decision.
    expect(preChecks.some((c) => c.diff === preApprovedDiff && c.agent === "klanker")).toBe(true);

    await new Promise<void>((r) => setTimeout(r, 30));
    const rows = readAuditRows();
    const preRow = rows.find(
      (r) => r.op === "config_propose_edit" && r.phase === "requested" && r.request_id === "bp-pre",
    );
    expect(preRow).toBeDefined();
    expect(preRow!.pre_approved).toBe(true);
    // An ordinary requested row carries NO pre_approved flag.
    const ordinaryRow = rows.find(
      (r) => r.op === "config_propose_edit" && r.phase === "requested" && r.request_id === "bp-a",
    );
    expect(ordinaryRow).toBeDefined();
    expect(ordinaryRow!.pre_approved).toBeUndefined();
  });

  it("the bypassed call does NOT consume the bucket — the agent's next unapproved proposal still hits the limit", async () => {
    const preApprovedDiff = distinctDiff("preapproved");
    // approve:false — keep the pre-approved diff a DENY so the config file is
    // never mutated and the later distinct diffs keep validating cleanly. The
    // point here is bucket accounting, not the apply.
    const { gw } = bypassGateway({ preApprovedDiff, approve: false });
    server = makeServer(gw, 1); // 1/hour — a single ordinary slot
    await server.start();

    // Pre-approved persist: bypasses the rate limit, must NOT spend the slot.
    const pre = await send(preApprovedDiff, "cn-pre");
    expect(pre.result).toBe("denied"); // operator-denied card, not rate-limited
    expect(pre.error ?? "").not.toMatch(/E_RATE_LIMITED|rate limit/i);

    // First ordinary proposal: consumes the one slot (denied at the card).
    const n1 = await send(distinctDiff("n1"), "cn-n1");
    expect(n1.result).toBe("denied");
    expect(n1.error ?? "").not.toMatch(/E_RATE_LIMITED|rate limit/i);

    // Second ordinary proposal: NOW the bucket is full → E_RATE_LIMITED. If the
    // bypass had wrongly consumed the slot, n1 would already have been limited.
    const n2 = await send(distinctDiff("n2"), "cn-n2");
    expect(n2.result).toBe("denied");
    expect(n2.error ?? "").toMatch(/E_RATE_LIMITED|rate limit/i);
  });

  it("fail-closed: a gateway with no checkPreApproved → identical to today (E_RATE_LIMITED with fix.retry_after)", async () => {
    // denyingGateway has NO checkPreApproved method — the mixed-version / old
    // gateway case. The bypass must degrade to today's exact rate-limit path.
    const { gw } = denyingGateway();
    server = makeServer(gw, 1); // 1/hour
    await server.start();

    await send(distinctDiff("fc-1"), "fc-1"); // consumes the slot (denied)
    const limited = await send(distinctDiff("fc-2"), "fc-2"); // throttled

    expect(limited.result).toBe("denied");
    expect(limited.error ?? "").toMatch(/E_RATE_LIMITED|rate limit/i);
    // Stage 1 depends on the structured retry_after fix being present.
    const env = (limited as { error_envelope?: { code?: string; fix?: { kind?: string; retry_at?: string } } }).error_envelope;
    expect(env?.code).toBe("E_RATE_LIMITED");
    expect(env?.fix?.kind).toBe("retry_after");
    expect(typeof env?.fix?.retry_at).toBe("string");
    expect(Number.isNaN(Date.parse(env!.fix!.retry_at!))).toBe(false);
  });
});
