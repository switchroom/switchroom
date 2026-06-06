/**
 * Propose a switchroom.yaml edit to hostd from the web dashboard.
 *
 * The dashboard is NOT a trusted writer (an agent on host networking can
 * forge its loopback auth). So a "grant access" click never writes config
 * — it proposes a unified diff to hostd over the OPERATOR socket. hostd
 * validates the patch, raises an Allow/Deny card in the operator's
 * Telegram (an out-of-band channel an agent can't forge), and applies it
 * with `git apply` ONLY on the tap. hostd is the sole writer; this is the
 * leash.
 *
 * `config_propose_edit` BLOCKS server-side until the operator decides or
 * the 10-minute approval window expires, so the client timeout is set
 * above that. The caller runs this in the background and exposes a poll
 * endpoint — the HTTP POST must not hang on a human tap.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { hostdRequest } from "../host-control/client.js";
import type { HostdRequest } from "../host-control/protocol.js";

/** Slightly above hostd's 10-min CONFIG_APPROVAL_TIMEOUT_MS. */
export const PROPOSE_TIMEOUT_MS = 11 * 60 * 1000;

export type ProposeOutcome =
  | { state: "applied" }
  | { state: "denied"; reason: string }
  | { state: "error"; reason: string };

/**
 * Resolve the hostd operator socket without an infra/env change. Order:
 *   1. `SWITCHROOM_HOSTD_OPERATOR_SOCKET` override (tests / custom),
 *   2. `/host-home/.switchroom/hostd/operator/sock` — the switchroom-web
 *      container mounts the operator's `~/.switchroom` here,
 *   3. `~/.switchroom/hostd/operator/sock` — host CLI.
 * Returns the first that exists, or null when hostd isn't reachable.
 */
export function resolveHostdOperatorSocket(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const override = env.SWITCHROOM_HOSTD_OPERATOR_SOCKET;
  if (override && override.length > 0) return override;
  const candidates = [
    "/host-home/.switchroom/hostd/operator/sock",
    join(homedir(), ".switchroom", "hostd", "operator", "sock"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface ProposeArgs {
  unifiedDiff: string;
  reason: string;
  requestId: string;
  socketPath: string;
  timeoutMs?: number;
  /** Injectable for tests (defaults to the real hostd client). */
  send?: typeof hostdRequest;
}

/**
 * Send the proposal and map hostd's response to a {@link ProposeOutcome}.
 * Never throws — connection/timeout/decode failures become
 * `{ state: "error" }`.
 */
export async function proposeConfigEditViaHostd(
  args: ProposeArgs,
): Promise<ProposeOutcome> {
  const req: HostdRequest = {
    v: 1,
    op: "config_propose_edit",
    request_id: args.requestId,
    args: {
      unified_diff: args.unifiedDiff,
      reason: args.reason,
      target_path: "/state/config/switchroom.yaml",
    },
  };
  const send = args.send ?? hostdRequest;
  try {
    const resp = await send(
      { socketPath: args.socketPath, timeoutMs: args.timeoutMs ?? PROPOSE_TIMEOUT_MS },
      req,
    );
    if (resp.result === "completed") return { state: "applied" };
    if (resp.result === "denied") {
      return { state: "denied", reason: resp.error ?? "operator denied the change" };
    }
    return { state: "error", reason: resp.error ?? `hostd returned '${resp.result}'` };
  } catch (err) {
    return { state: "error", reason: (err as Error).message };
  }
}
