/**
 * #2781 — the `E_RECONCILE_FAILED_ROLLED_BACK` response must CARRY the failed
 * reconcile's stdout/stderr tails, mirroring the success path's
 * stdout_tail/stderr_tail fields. Pre-fix, `reconcileFailedRolledBack`
 * discarded the child's output entirely, so a rolled-back config edit
 * surfaced only "reconcile exit 1" with zero diagnostics — the operator had
 * nothing to identify the underlying apply failure with.
 *
 * `reconcileFailedRolledBack` is a private method that touches no server
 * state (pure response construction from its arguments), so we exercise it
 * directly on a bare instance via a cast — same pattern as other
 * private-method unit tests in this repo.
 */

import { describe, it, expect } from "vitest";
import { HostdServer, type ServerOptions } from "./server.js";
import type { HostdRequest, HostdResponse } from "./protocol.js";
import type { SocketIdentity } from "./peercred.js";

type ConfigProposeReq = Extract<HostdRequest, { op: "config_propose_edit" }>;

const req: ConfigProposeReq = {
  v: 1,
  request_id: "req-2781",
  op: "config_propose_edit",
  args: {
    unified_diff: "@@ -1 +1 @@\n-a\n+b\n",
    reason: "test",
    target_path: "/state/config/switchroom.yaml",
  },
} as ConfigProposeReq;

const caller: SocketIdentity = { kind: "agent", name: "overlord" } as SocketIdentity;

type RollbackOutput = {
  primary: { stdout: string; stderr: string };
  recovery?: { stdout: string; stderr: string; exit_code: number };
};

function invoke(output?: RollbackOutput): HostdResponse {
  const server = new HostdServer({} as unknown as ServerOptions);
  return (
    server as unknown as {
      reconcileFailedRolledBack: (
        detail: string,
        req: ConfigProposeReq,
        caller: SocketIdentity,
        started: number,
        output?: RollbackOutput,
      ) => HostdResponse;
    }
  ).reconcileFailedRolledBack(
    "reconcile exit 1; rolled back successfully",
    req,
    caller,
    Date.now(),
    output,
  );
}

describe("reconcileFailedRolledBack — carries reconcile output (#2781)", () => {
  it("threads the failed reconcile's stdout/stderr into the response tails", () => {
    const res = invoke({
      primary: {
        stdout: "Scaffolded 0/12 agents. 12 failed.",
        stderr: "x litellm/overlord: vault-broker unreachable",
      },
      recovery: { stdout: "", stderr: "", exit_code: 0 },
    });
    expect(res.result).toBe("error");
    expect(res.error).toBe(
      "E_RECONCILE_FAILED_ROLLED_BACK: reconcile exit 1; rolled back successfully",
    );
    expect(res.stdout_tail).toContain("Scaffolded 0/12 agents");
    expect(res.stderr_tail).toContain("vault-broker unreachable");
    // Recovery succeeded → its (empty) output is not appended.
    expect(res.stdout_tail).not.toContain("recovery reconcile");
  });

  it("appends the recovery reconcile's output when the recovery ALSO failed", () => {
    const res = invoke({
      primary: { stdout: "primary out", stderr: "primary err" },
      recovery: {
        stdout: "recovery out",
        stderr: "recovery err",
        exit_code: 1,
      },
    });
    expect(res.stdout_tail).toContain("primary out");
    expect(res.stdout_tail).toContain("--- recovery reconcile stdout ---");
    expect(res.stdout_tail).toContain("recovery out");
    expect(res.stderr_tail).toContain("primary err");
    expect(res.stderr_tail).toContain("--- recovery reconcile stderr ---");
    expect(res.stderr_tail).toContain("recovery err");
  });

  it("omits the tails when no output was captured (write-failed callsites)", () => {
    const res = invoke(undefined);
    expect(res.result).toBe("error");
    expect(res.stdout_tail).toBeUndefined();
    expect(res.stderr_tail).toBeUndefined();
    // Legacy string preserved verbatim for audit-reader decoders.
    expect(res.error).toMatch(/^E_RECONCILE_FAILED_ROLLED_BACK: /);
  });
});
