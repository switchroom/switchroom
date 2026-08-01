/**
 * PR-06 (#3944) — rollout warnings end-to-end.
 *
 * #3944: `encodeRolloutResultLine` has always put the roll's non-fatal
 * `warnings` on the sentinel wire, and `parseRolloutResultLine` parses them —
 * but hostd's sentinel-lift in `spawnRollout` dropped them on the floor. They
 * never reached the status entry, so `get_status` and the narration card were
 * blind to them. These tests assert the warnings ROUND-TRIP: sentinel → child
 * stdout → lifted onto the status entry → surfaced in the get_status payload.
 *
 * The spawnRollout harness mirrors rollout-timeout-latch.test.ts: a real
 * `node -e` child emits the result sentinel and exits, so the lift runs against
 * genuine child stdout, not a hand-built object.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer, type ServerOptions } from "./server.js";
import { encodeRolloutResultLine, type RolloutResult } from "../cli/rollout.js";
import { renderRolloutStatus } from "./render-rollout-status.js";

type Entry = {
  request_id: string;
  op: string;
  result?: string;
  exit_code?: number | null;
  warnings?: string[];
  drifted?: string[];
  failed_step?: string;
  rolled?: string[];
};

type Internals = {
  fleetMutationInFlight: { request_id: string } | null;
  spawnRollout(args: string[], entry: Entry): void;
  statusEntryToResponse(request_id: string, entry: Entry): { payload?: string };
  writeTerminalAudit(entry: Entry): Promise<void>;
  pushRolloutTerminal(entry: Entry): void;
};

function childArgs(stdout: string, code: number): string[] {
  return [
    "-e",
    `process.stdout.write(${JSON.stringify(stdout)});process.exit(${code});`,
  ];
}

function makeServer(): Internals {
  const server = new HostdServer({
    homeDir: mkdtempSync(join(tmpdir(), "hostd-warn-")),
    switchroomBin: process.execPath,
  } as unknown as ServerOptions);
  const internals = server as unknown as Internals;
  // Neutralise durable-audit + chat side-effects (need a real state dir/relay).
  internals.writeTerminalAudit = async () => undefined;
  internals.pushRolloutTerminal = () => undefined;
  return internals;
}

async function until(predicate: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function runRoll(stdout: string, code: number): Promise<{ internals: Internals; entry: Entry }> {
  const internals = makeServer();
  const entry: Entry = { request_id: `req-${code}-${Math.random()}`, op: "rollout" };
  internals.fleetMutationInFlight = { request_id: entry.request_id };
  internals.spawnRollout(childArgs(stdout, code), entry);
  await until(() => internals.fleetMutationInFlight === null);
  return { internals, entry };
}

describe("#3944 — rollout warnings round-trip from the sentinel to the status entry", () => {
  it("lifts warnings off a successful roll's sentinel onto the entry AND get_status payload", async () => {
    const warnings = [
      "web dashboard refresh (webd install) failed — dashboard may be stale",
      "hostd template regen skipped — run host-side",
    ];
    const sentinel = encodeRolloutResultLine({
      ok: true,
      rolled: ["clerk", "scout"],
      warnings,
    } as RolloutResult);

    const { internals, entry } = await runRoll(sentinel + "\n", 0);

    // The lift: warnings reach the structured entry (pre-fix: undefined).
    expect(entry.result).toBe("completed");
    expect(entry.warnings).toEqual(warnings);

    // And they surface on the get_status payload a Telegram reader polls —
    // on an otherwise-clean roll where warnings are the ONLY non-rolled field.
    const resp = internals.statusEntryToResponse(entry.request_id, entry);
    expect(resp.payload).toBeDefined();
    const payload = JSON.parse(resp.payload!) as { warnings?: string[] };
    expect(payload.warnings).toEqual(warnings);
  });

  it("leaves warnings undefined when the roll emitted none", async () => {
    const sentinel = encodeRolloutResultLine({
      ok: true,
      rolled: ["clerk"],
      warnings: [],
    } as RolloutResult);

    const { entry } = await runRoll(sentinel + "\n", 0);

    expect(entry.result).toBe("completed");
    expect(entry.warnings).toBeUndefined();
  });

  it("also lifts warnings off a FAILED roll's sentinel", async () => {
    const warnings = ["persist-pin requested but no persist hook wired; pin NOT durable"];
    const sentinel = encodeRolloutResultLine({
      ok: false,
      rolled: [],
      failedStep: "apply",
      warnings,
    } as RolloutResult);

    const { entry } = await runRoll(sentinel + "\n", 1);

    expect(entry.result).toBe("error");
    expect(entry.warnings).toEqual(warnings);
  });
});

describe("#3944 — the narration card renders the roll's warnings", () => {
  it("renders a Warnings section on a completed roll", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: ["clerk"],
      warnings: ["web dashboard refresh failed — dashboard may be stale"],
    });
    expect(out).toContain("Warnings:");
    expect(out).toContain("web dashboard refresh failed");
  });

  it("renders a Warnings section on a stopped/error roll", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "error",
      failedStep: "apply",
      rolled: [],
      warnings: ["persist-pin requested but no persist hook wired"],
    });
    expect(out).toContain("Warnings:");
    expect(out).toContain("persist-pin requested");
  });

  it("omits the Warnings section when there are none", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: ["clerk"],
    });
    expect(out).not.toContain("Warnings:");
  });
});
