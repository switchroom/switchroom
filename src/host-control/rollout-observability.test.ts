/**
 * #2726 — durable rollout observability: the audit-reader helper that
 * un-blinds `get_status` (latestRolloutRowForRequest) and the pure status
 * renderer (renderRolloutStatus). Both are pure functions exercised without a
 * daemon or a gateway.
 */

import { describe, it, expect } from "vitest";
import {
  latestRolloutRowForRequest,
  parseAuditLine,
} from "./audit-reader.js";
import {
  renderRolloutStatus,
  formatDurationMs,
} from "./render-rollout-status.js";
import { HOSTD_TEMPLATE_LAST_CHANGED } from "../config/hostd-template-version.js";
import type { HostCliStamp } from "../cli/host-cli-stamp.js";

/** Build one JSONL audit row (the shape hostd writes, chain fields elided —
 *  parseAuditLine ignores `_seq`/`_prev`/`_hash`). */
function row(o: Record<string, unknown>): string {
  return (
    JSON.stringify({
      ts: "2026-07-01T00:00:00.000Z",
      caller: { kind: "agent", name: "overlord" },
      exit_code: null,
      duration_ms: 10,
      ...o,
    }) + "\n"
  );
}

describe("latestRolloutRowForRequest", () => {
  const REQ = "req-abc";

  it("returns null when no rollout row exists for the request", () => {
    const log =
      row({ op: "apply", request_id: "other", result: "started" }) +
      row({ op: "rollout", request_id: "different", phase: "apply", result: "started" });
    expect(latestRolloutRowForRequest(log, REQ)).toBeNull();
  });

  it("returns the LATEST rollout row (last-written phase) for the request", () => {
    const log =
      row({ op: "rollout", request_id: REQ, phase: "apply", result: "started", pin: "v1.2.3" }) +
      row({ op: "rollout", request_id: REQ, phase: "canary-start", result: "started", pin: "v1.2.3", agent: "test-harness", n: 1, m: 3 }) +
      row({ op: "rollout", request_id: REQ, phase: "agent-start", result: "started", pin: "v1.2.3", agent: "clerk", n: 2, m: 3 });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.phase).toBe("agent-start");
    expect(latest?.agent).toBe("clerk");
    expect(latest?.n).toBe(2);
    expect(latest?.m).toBe(3);
    expect(latest?.pin).toBe("v1.2.3");
  });

  it("returns the terminal row once it is written", () => {
    const log =
      row({ op: "rollout", request_id: REQ, phase: "agent-start", result: "started", pin: "v1.2.3", agent: "clerk", n: 2, m: 3 }) +
      row({ op: "rollout", request_id: REQ, phase: "terminal", result: "completed", pin: "v1.2.3", rolled: ["test-harness", "clerk", "marko"], prior_pin: "v1.2.2" });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.phase).toBe("terminal");
    expect(latest?.result).toBe("completed");
    expect(latest?.rolled).toEqual(["test-harness", "clerk", "marko"]);
    expect(latest?.prior_pin).toBe("v1.2.2");
  });

  it("includes the synthetic rollout_orphaned op", () => {
    const log =
      row({ op: "rollout", request_id: REQ, result: "started" }) +
      row({ op: "rollout_orphaned", request_id: REQ, phase: "orphan_reconciled", result: "error" });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.op).toBe("rollout_orphaned");
    expect(latest?.result).toBe("error");
  });

  it("ignores non-rollout ops sharing the request_id", () => {
    const log =
      row({ op: "rollout", request_id: REQ, phase: "apply", result: "started" }) +
      // A different op (shouldn't happen with distinct request_ids, but be defensive).
      row({ op: "agent_restart", request_id: REQ, result: "completed" });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.op).toBe("rollout");
    expect(latest?.phase).toBe("apply");
  });

  it("tolerates torn / malformed lines (parseAuditLine returns null)", () => {
    const log =
      "{ not json\n" +
      row({ op: "rollout", request_id: REQ, phase: "canary-pass", result: "started" }) +
      "\n"; // trailing blank
    expect(latestRolloutRowForRequest(log, REQ)?.phase).toBe("canary-pass");
  });
});

describe("audit-reader parses rollout phase fields", () => {
  it("parses agent / n / m off a phase row", () => {
    const e = parseAuditLine(
      row({ op: "rollout", request_id: "r", phase: "agent-start", result: "started", agent: "clerk", n: 4, m: 9 }),
    );
    expect(e?.agent).toBe("clerk");
    expect(e?.n).toBe(4);
    expect(e?.m).toBe(9);
  });
});

describe("formatDurationMs", () => {
  it("formats seconds / minutes / hours compactly", () => {
    expect(formatDurationMs(42_000)).toBe("42s");
    expect(formatDurationMs(190_000)).toBe("3m 10s");
    expect(formatDurationMs(180_000)).toBe("3m");
    expect(formatDurationMs(3_900_000)).toBe("1h 5m");
    expect(formatDurationMs(-5)).toBe("0s");
  });
});

describe("renderRolloutStatus", () => {
  it("renders an in-flight applying header", () => {
    const out = renderRolloutStatus({ target: "v1.2.3", phase: "apply" });
    expect(out).toContain("v1.2.3");
    expect(out).toContain("applying");
    expect(out.startsWith("⏳")).toBe(true);
  });

  it("headers with from → to versions and the short request id", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      fromVersion: "v1.2.2",
      requestId: "ro-abcdef1234567890xyz",
      phase: "apply",
    });
    const header = out.split("\n")[0]!;
    expect(header).toContain("`v1.2.2` → `v1.2.3`");
    expect(header).toContain("req `ro-abcdef1234567…`");
  });

  it("renders agent N/M progress with the rolled count footer", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      agent: "clerk",
      n: 3,
      m: 8,
      rolled: ["test-harness", "marko"],
    });
    expect(out).toContain("agent 3/8");
    expect(out).toContain("clerk");
    expect(out).toContain("2/8 rolled");
  });

  it("renders the per-agent checklist (✓ done / ⏳ running / ✗ failed / · pending) with durations", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      agent: "clerk",
      n: 3,
      m: 5,
      rolled: ["test-harness", "marko"],
      agents: [
        { name: "test-harness", status: "done", canary: true, durationMs: 42_000 },
        { name: "marko", status: "done", durationMs: 38_000 },
        { name: "clerk", status: "running" },
      ],
    });
    expect(out).toContain("- ✓ `test-harness` (canary) — 42s");
    expect(out).toContain("- ✓ `marko` — 38s");
    expect(out).toContain("- ⏳ `clerk` — restarting…");
    // 5 total, 3 known → 2 collapsed pending.
    expect(out).toContain("- · 2 more pending");
    // No literal • bullets (progress-card vocabulary uses `-` lists).
    expect(out).not.toContain("•");
  });

  it("estimates a rough ETA from the mean per-agent duration so far", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      m: 4,
      rolled: ["a", "b"],
      agents: [
        { name: "a", status: "done", durationMs: 30_000 },
        { name: "b", status: "done", durationMs: 60_000 },
        { name: "c", status: "running" },
      ],
    });
    // mean 45s × 2 remaining = 1m 30s.
    expect(out).toContain("~1m 30s left (rough est.)");
  });

  it("shows elapsed from startedAtMs/nowMs while in flight", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      m: 3,
      startedAtMs: 1_000_000,
      nowMs: 1_105_000,
    });
    expect(out).toContain("elapsed 1m 45s");
  });

  /**
   * #4571 — the host-CLI residual is now DERIVED from the host CLI's own
   * install stamp rather than hardcoded to `sudo npm i -g`. These fixtures pin
   * the two install shapes: a root-owned npm tree (where `sudo npm i -g`
   * genuinely IS the command) and the user-owned nvm prefix this fleet
   * actually runs (where it is not).
   */
  const rootNpmHostCli = (version: string): HostCliStamp => ({
    version,
    installKind: "npm-global",
    path: "/usr/local/lib/node_modules/switchroom/dist/cli/switchroom.js",
    npmPrefix: "/usr/local",
    ownerUid: 0,
    ownerUser: "root",
  });
  const userNvmHostCli = (version: string): HostCliStamp => ({
    version,
    installKind: "npm-global",
    path: "/home/op/.nvm/versions/node/v22.22.2/lib/node_modules/switchroom/dist/cli/switchroom.js",
    npmPrefix: "/home/op/.nvm/versions/node/v22.22.2",
    ownerUid: 1000,
    ownerUser: "op",
  });

  it("renders the ✅ terminal summary with rolled list, elapsed total and deferred components", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: ["test-harness", "clerk"],
      m: 2,
      elapsedMs: 492_000,
      hostCli: rootNpmHostCli("1.2.0"),
    });
    expect(out.startsWith("✅")).toBe(true);
    expect(out).toContain("Done");
    expect(out).toContain("rolled 2/2 agent(s) in 8m 12s");
    expect(out).toContain("`test-harness`, `clerk`");
    // What is genuinely still host-side, with its exact command.
    expect(out).toContain("Still host-side");
    expect(out).toContain("sudo npm i -g --prefix /usr/local switchroom@1.2.3");
    expect(out).toContain("switchroom hostd install --tag v1.2.3");
  });

  it("a ✅ card no longer claims switchroom-web is stale (#3928)", () => {
    // `refresh-web` is in the plan on both paths and `verify-components`
    // FAILS the roll when web is behind — so a completed card telling the
    // operator to go run `webd install` host-side is both false and the
    // exact "go open a shell" instruction the managed path exists to
    // eliminate.
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: ["test-harness", "clerk"],
      m: 2,
    });
    expect(out).not.toContain("switchroom webd install");
    expect(out).not.toContain("still on the prior version");
    expect(out).toContain("Verified on v1.2.3");
  });

  // #4269 — the hostd-template-regen residual is DEFINITE when both roll
  // endpoints are clean tags. Tags are derived relative to
  // HOSTD_TEMPLATE_LAST_CHANGED so these stay true across constant bumps.
  const LC_MAJOR = Number(HOSTD_TEMPLATE_LAST_CHANGED.slice(1).split(".")[0]);
  const PRE_TEMPLATE_CHANGE = "v0.0.1"; // strictly before any plausible constant
  const POST_A = `v${LC_MAJOR + 1}.0.0`;
  const POST_B = `v${LC_MAJOR + 1}.0.1`;

  it("✅ card says regen NOT needed when the roll doesn't cross the template change (#4269 — the v0.19.48→v0.20.0 case)", () => {
    const out = renderRolloutStatus({
      target: POST_B,
      fromVersion: POST_A,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
      hostCli: rootNpmHostCli(PRE_TEMPLATE_CHANGE.slice(1)),
    });
    expect(out).toContain("not needed");
    expect(out).toContain(`unchanged since ${HOSTD_TEMPLATE_LAST_CHANGED}`);
    // No hedge, and no regen command the operator doesn't need.
    expect(out).not.toContain("only if the release changed");
    expect(out).not.toContain("switchroom hostd install");
    // The CLI residual is still named.
    expect(out).toContain(
      `sudo npm i -g --prefix /usr/local switchroom@${POST_B.slice(1)}`,
    );
  });

  it("✅ card says regen REQUIRED, as one copy-paste block, when the roll crosses the template change (#4269)", () => {
    const out = renderRolloutStatus({
      target: POST_A,
      fromVersion: PRE_TEMPLATE_CHANGE,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
      hostCli: rootNpmHostCli(PRE_TEMPLATE_CHANGE.slice(1)),
    });
    expect(out).toContain("REQUIRED");
    expect(out).toContain(`changed in ${HOSTD_TEMPLATE_LAST_CHANGED}`);
    expect(out).not.toContain("only if the release changed");
    // Both residuals collapse into a single copy-paste command line.
    expect(out).toContain(
      `\`sudo npm i -g --prefix /usr/local switchroom@${POST_A.slice(1)} && switchroom hostd install --tag ${POST_A}\``,
    );
  });

  it("✅ card keeps the hedged wording only when the from version is unknown (#4269)", () => {
    const out = renderRolloutStatus({
      target: POST_A,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
    });
    expect(out).toContain("only if the release changed hostd mounts/env");
    expect(out).toContain(`switchroom hostd install --tag ${POST_A}`);
  });

  // #4571 — the two regressions the hardcoded `sudo npm i -g` line caused on
  // the reference host: wrong advice, and advice for work already done.
  it("✅ card never tells a USER-OWNED npm install to sudo, and names the owner", () => {
    const out = renderRolloutStatus({
      target: POST_A,
      fromVersion: PRE_TEMPLATE_CHANGE,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
      hostCli: userNvmHostCli(PRE_TEMPLATE_CHANGE.slice(1)),
    });
    // `sudo npm i -g` into a user-owned nvm prefix installs into the WRONG
    // tree (or root-poisons this one) — it must never be emitted as a command.
    expect(out).not.toContain(`sudo npm i -g`);
    expect(out).toContain(
      `npm i -g --prefix /home/op/.nvm/versions/node/v22.22.2 switchroom@${POST_A.slice(1)}`,
    );
    expect(out).toContain("run as op");
    expect(out).toContain("/home/op/.nvm/versions/node/v22.22.2");
    // …and the regen command is NOT collapsed onto that line, because the
    // "run as op, NOT under sudo" caveat cannot survive an `&&` chain.
    expect(out).not.toContain(
      `&& switchroom hostd install --tag ${POST_A}\``,
    );
    expect(out).toContain(`switchroom hostd install --tag ${POST_A}`);
  });

  it("✅ card does NOT list the host CLI as outstanding once it is already on target", () => {
    // The roll refuses to start against a stale host CLI (#4571 preflight
    // gate), so on a completed roll the stamp normally reads >= target. Naming
    // it as "still host-side" then is the same false residual #3928 deleted
    // for switchroom-web — work the operator would redo for nothing.
    const out = renderRolloutStatus({
      target: POST_A,
      fromVersion: POST_A,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
      hostCli: userNvmHostCli(POST_A.slice(1)),
    });
    expect(out).not.toContain("npm i -g switchroom");
    expect(out).not.toContain("host operator CLI —");
    expect(out).toContain(`Host operator CLI: **on ${POST_A.slice(1)}**`);
  });

  // The inverse of the test above, and the one that matters. Dropping the
  // residual requires PROOF of convergence. `shouldRefuseStaleHostCli` is
  // false for an UNORDERABLE stamp as well as a converged one (deliberately —
  // the roll must not block on a version it cannot compare), so reusing it to
  // decide "nothing to do" turns every rc/dev/sha host CLI into a fresh
  // all-clear over exactly the drift this feature exists to expose.
  it("✅ card does NOT claim 'nothing to do' for an UNORDERABLE host CLI version", () => {
    const out = renderRolloutStatus({
      target: POST_A,
      fromVersion: POST_A,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
      // `switchroom update --channel rc` produces exactly this shape.
      hostCli: userNvmHostCli(`${PRE_TEMPLATE_CHANGE.slice(1)}-rc.1`),
    });
    expect(out).not.toContain("nothing to do");
    // Still listed as outstanding, and honest about WHY it can't be ordered.
    expect(out).toContain("Still host-side");
    expect(out).toContain("not comparable");
    expect(out).toContain("switchroom --version");
    expect(out).toContain(
      `npm i -g --prefix /home/op/.nvm/versions/node/v22.22.2 switchroom@${POST_A.slice(1)}`,
    );
  });

  it("✅ card never &&-collapses an UNORDERABLE host CLI into one copy-paste", () => {
    // Regen REQUIRED + a root-owned npm tree is the one shape that collapses.
    // An unorderable version must still not collapse: the "confirm host-side"
    // caveat is load-bearing and cannot survive an `&&` chain, exactly like
    // the "run as <user>" one.
    const out = renderRolloutStatus({
      target: POST_A,
      fromVersion: PRE_TEMPLATE_CHANGE,
      terminal: "completed",
      rolled: ["test-harness"],
      m: 1,
      hostCli: rootNpmHostCli(`${PRE_TEMPLATE_CHANGE.slice(1)}-rc.1`),
    });
    expect(out).toContain("REQUIRED");
    expect(out).not.toContain("One copy-paste");
    expect(out).not.toContain(`&& switchroom hostd install --tag ${POST_A}\``);
    expect(out).toContain("not comparable");
  });

  it("renders the ❌ terminal-error summary with the failed step + agent", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "error",
      failedStep: "restart-agent",
      failedAgent: "clerk",
      got: "1.2.2",
      rolled: ["test-harness"],
      elapsedMs: 65_000,
    });
    expect(out.startsWith("❌")).toBe(true);
    expect(out).toContain("STOPPED");
    expect(out).toContain("restart-agent");
    expect(out).toContain("clerk");
    expect(out).toContain("1.2.2");
    expect(out).toContain("test-harness");
    expect(out).toContain("after 1m 5s");
    // A failed roll must NOT advertise the deferred-update commands.
    expect(out).not.toContain("Deferred");
  });

  it("renders residual component drift as INCOMPLETE, naming what is behind (#3928)", () => {
    // The operator reads THIS in Telegram and has no host shell, so the
    // card must distinguish "the roll stopped, agents may be split" from
    // "every agent is on target, two components are not" — and must not
    // suggest re-rolling, which cannot fix it.
    const out = renderRolloutStatus({
      target: "v0.19.30",
      terminal: "error",
      failedStep: "verify-components",
      drifted: ["switchroom-web", "switchroom-hindsight-autoheal"],
      rolled: ["test-harness", "klanker"],
      m: 2,
      elapsedMs: 492_000,
    });
    expect(out.startsWith("⚠️")).toBe(true);
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("2/2 agent(s) reached v0.19.30");
    expect(out).toContain("`switchroom-web`");
    expect(out).toContain("`switchroom-hindsight-autoheal`");
    expect(out).toContain("Re-running the roll will NOT fix this");
    // Not the generic STOPPED wording, and no "everything is done" claim.
    expect(out).not.toContain("STOPPED");
    expect(out).not.toContain("Deferred");
  });

  it("still renders an INCOMPLETE card when the drift list did not survive", () => {
    const out = renderRolloutStatus({
      target: "v0.19.30",
      terminal: "error",
      failedStep: "verify-components",
      rolled: ["klanker"],
    });
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("see the roll's warnings");
  });

  it("code-spans agent names everywhere (underscores must not italicize in GFM)", () => {
    // Phase line + rolled join, in-flight.
    const inflight = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      agent: "data_pipeline_bot",
      n: 2,
      m: 3,
      rolled: ["test_harness"],
    });
    expect(inflight).toContain("restarting `data_pipeline_bot`");
    // Terminal joins.
    const done = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: ["test_harness", "data_pipeline_bot"],
    });
    expect(done).toContain("`test_harness`, `data_pipeline_bot`");
    const err = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "error",
      failedStep: "restart-agent",
      failedAgent: "data_pipeline_bot",
      got: null,
      rolled: ["test_harness"],
    });
    expect(err).toContain("Rolled before stop: `test_harness`.");
    // Canary phase lines.
    const canary = renderRolloutStatus({
      target: "v1.2.3",
      phase: "canary-pass",
      agent: "test_harness",
    });
    expect(canary).toContain("canary passed (`test_harness`)");
    // No agent name appears outside a code span in any of the renders.
    for (const out of [inflight, done, err, canary]) {
      expect(out).not.toMatch(/(^|[^`])(?:test_harness|data_pipeline_bot)([^`]|$)/);
    }
  });

  it("collapses the checklist when a big fleet would overflow the message-size ceiling", () => {
    // Synthetic 60-agent fleet with long names — the full render would exceed
    // Telegram's edit limit (the gateway swallows MESSAGE_TOO_LONG, silently
    // freezing the narration), so the render must fall back to compact mode.
    const names = Array.from(
      { length: 60 },
      (_, i) =>
        `agent-with-a-rather-long-and-quite-descriptive-container-name-${String(i).padStart(2, "0")}`,
    );
    const agents = names.map((name, i) => ({
      name,
      status: (i < 58 ? "done" : i === 58 ? "running" : "pending") as
        | "done"
        | "running"
        | "pending",
      ...(i < 58 ? { durationMs: 40_000 } : {}),
      ...(i === 0 ? { canary: true } : {}),
    }));
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      agent: names[58],
      n: 59,
      m: 60,
      rolled: names.slice(0, 58),
      agents,
    });
    expect(out.length).toBeLessThan(3900);
    // Completed agents folded into one count line; the active agent survives.
    expect(out).toContain("- ✓ 58 done");
    expect(out).toContain(`- ⏳ \`${names[58]}\` — restarting…`);
    expect(out).toContain("more pending");
    // Terminal render for the same fleet also stays under the ceiling.
    const done = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: names,
      m: 60,
      elapsedMs: 2_400_000,
      agents: agents.map((a) => ({ ...a, status: "done" as const })),
    });
    expect(done.length).toBeLessThan(3900);
    expect(done).toContain("- ✓ 60 done");
  });

  it("renders 'unreachable' when the failed agent version is null", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "error",
      failedStep: "restart-agent",
      failedAgent: "clerk",
      got: null,
    });
    expect(out).toContain("unreachable");
  });
});
