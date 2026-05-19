/**
 * doctor section: in-agent liveness via the hostd `agent_smoke` verb.
 *
 * The host operator cannot read agent-private 0600 state (WS6-F2), so
 * the rest of doctor honestly reports those rows as `skip`. This
 * section gets the VERIFIED truth by asking hostd — the one audited,
 * admin-gated component that holds the docker socket — to run a fixed
 * read-only probe battery INSIDE each agent and report back.
 *
 * Degrade-not-fail: hostd unreachable / host_control off / a down
 * agent → `skip`, never `fail` (infra or agent-down is not a health
 * defect this probe can act on; `agent_start` is the lever). Exactly
 * ONE compact row per agent — this section exists to ADD verified
 * signal, not to re-noise the summary the `skip` work just cleaned.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { CheckStatus } from "./doctor-status.js";
import { hostdRequest } from "../host-control/client.js";
import type { HostdResponse } from "../host-control/protocol.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

interface SmokeProbe {
  name: string;
  state: "ok" | "fail" | "skip";
  detail: string;
}

export interface AgentSmokeDeps {
  homeDir?: string;
  /** --fast / offline: omit the section entirely. */
  fast?: boolean;
  /** Injected for tests; defaults to the real UDS client. */
  hostdRequestImpl?: (sock: string, name: string) => Promise<HostdResponse>;
  /** Override the operator socket path (tests). */
  operatorSockPath?: string;
}

/** Be gentle on hostd: a handful of agents probed at a time. */
const CONCURRENCY = 4;

export async function runAgentSmokeChecks(
  config: { agents?: Record<string, unknown> },
  deps: AgentSmokeDeps = {},
): Promise<CheckResult[]> {
  if (deps.fast) return [];

  const home = deps.homeDir ?? homedir();
  const sock =
    deps.operatorSockPath ??
    join(home, ".switchroom", "hostd", "operator", "sock");

  if (!deps.hostdRequestImpl && !existsSync(sock)) {
    return [
      {
        name: "agent liveness",
        status: "skip",
        detail:
          "hostd operator socket not found — in-agent probes skipped (host_control disabled, or hostd not running)",
        fix: "Enable host_control + `switchroom update` for real in-agent liveness; or `switchroom doctor --fast` to silence.",
      },
    ];
  }

  const call =
    deps.hostdRequestImpl ??
    ((s: string, name: string) =>
      hostdRequest(
        { socketPath: s, timeoutMs: 8000 },
        {
          v: 1,
          request_id: `doctor-smoke-${randomUUID()}`,
          op: "agent_smoke",
          args: { name },
        },
      ));

  const names = Object.keys(config.agents ?? {});
  const results: CheckResult[] = [];

  for (let i = 0; i < names.length; i += CONCURRENCY) {
    const settled = await Promise.all(
      names.slice(i, i + CONCURRENCY).map(
        async (name): Promise<CheckResult> => {
          const label = `${name}: liveness`;
          try {
            const resp = await call(sock, name);
            if (resp.result === "denied") {
              return {
                name: label,
                status: "skip",
                detail: `hostd denied agent_smoke (${resp.error ?? "admin required"})`,
              };
            }
            let parsed: { container?: string; probes?: SmokeProbe[] };
            try {
              parsed = JSON.parse(resp.stdout_tail ?? "{}");
            } catch {
              return {
                name: label,
                status: "skip",
                detail: "hostd returned an unparseable agent_smoke payload",
              };
            }
            const probes = parsed.probes ?? [];
            if (parsed.container === "absent") {
              return {
                name: label,
                status: "skip",
                detail: `container not running — ${probes.length} probe(s) skipped`,
              };
            }
            const fails = probes.filter((p) => p.state === "fail");
            const summary = probes
              .map(
                (p) =>
                  `${p.name}:${p.state === "ok" ? "ok" : p.state === "fail" ? "FAIL" : "skip"}`,
              )
              .join(" ");
            if (fails.length > 0) {
              return {
                name: label,
                status: "fail",
                detail: summary,
                fix: `Investigate ${fails.map((f) => f.name).join(", ")} in switchroom-${name}.`,
              };
            }
            return { name: label, status: "ok", detail: summary };
          } catch (err) {
            return {
              name: label,
              status: "skip",
              detail: `hostd unreachable: ${(err as Error).message}`,
            };
          }
        },
      ),
    );
    results.push(...settled);
  }
  return results;
}
