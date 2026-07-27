/**
 * Deterministic garbage-collection of unusable agent `.vault-token` files.
 *
 * ## Why this exists
 *
 * When an agent presents a token whose grant row is gone (`grant-invalid`)
 * or whose grant has lapsed (`grant-expired`), the broker's READ-path
 * fall-through deliberately treats it as *no token at all* and serves the
 * agent from its standing config ACL instead (see the fall-through note in
 * `server.ts`, and `server-token-fallthrough.test.ts`). That behaviour is
 * correct — an unusable token must never be MORE restrictive than presenting
 * none — but it also means nothing ever *notices* the dead token. It sits on
 * disk forever:
 *
 *   - `switchroom doctor` reports it as an orphan on every run, permanently;
 *   - the fleet accretes one more orphan per broker-recreate / TTL lapse;
 *   - the agent keeps paying a bcrypt validate on every `vault get` for a
 *     token that can never succeed.
 *
 * This module closes the loop at the point where the unusable token is
 * *already* detected on use: truncate the file back to the empty state that
 * `apply` pre-creates, so the next call is an honest no-token call.
 *
 * ## Why truncate in place, and never rename/unlink
 *
 * Each agent's token file is bind-mounted into the broker container as a
 * **bare file** (`compose.ts`: `…/agents/<a>/.vault-token:/root/.switchroom/
 * agents/<a>/.vault-token`). A bind-mounted file is a mountpoint: you cannot
 * `rename(2)` over it or `unlink(2)` it from inside the container — the
 * kernel returns `EBUSY`. This is not theoretical; the live broker logs it
 * on every mint, because `mint_grant` uses the tmp+rename atomic-write
 * pattern:
 *
 *   [vault-broker] mint_grant: failed to write token file for agent gymbro:
 *   EBUSY: resource busy or locked, rename
 *   '/root/.switchroom/agents/gymbro/.vault-token.tmp.6' ->
 *   '/root/.switchroom/agents/gymbro/.vault-token'
 *
 * An in-place `O_TRUNC` write keeps the same inode, so it works over the
 * bind mount AND preserves the file's agent-UID ownership and 0600 mode —
 * no chown needed afterwards, unlike the rename path.
 *
 * ## Safety rails
 *
 * - Only `grant-invalid` / `grant-expired` are reaped. `grant-key-not-allowed`
 *   means the grant is ALIVE and merely doesn't cover this key — reaping it
 *   would destroy a working capability. `grant-revoked` never reaches here
 *   (it hard-denies upstream) and is deliberately left alone so the operator
 *   kill-switch stays visible.
 * - The on-disk bytes must still be the token that was presented. A concurrent
 *   `mint_grant` may have replaced the file between the agent's read and this
 *   call; in that case the fresh token wins and we keep it.
 * - Every failure is swallowed into an outcome code. Reaping is hygiene, never
 *   a reason to fail a `get`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Grant-validation failure reasons that mean "this token is dead". */
const REAPABLE_REASONS = new Set(["grant-invalid", "grant-expired"]);

export type ReapOutcome =
  /** File truncated to the empty (no-token) state. */
  | "reaped"
  /** Reason is not one of the dead-token reasons (e.g. grant-key-not-allowed). */
  | "kept:reason-not-reapable"
  /** No socket-bound agent identity, so no token path can be derived. */
  | "kept:no-agent-identity"
  /** Nothing on disk, or already empty — nothing to collect. */
  | "kept:nothing-on-disk"
  /** On-disk token differs from the presented one — a fresher mint won. */
  | "kept:superseded"
  /** Read or write failed (permissions, missing dir, …). */
  | "kept:io-error";

export interface ReapDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => void;
}

export interface ReapArgs {
  /** Host/container agents dir, e.g. `~/.switchroom/agents`. */
  agentsDir: string;
  /** Socket-bound agent identity, or null when there is none. */
  agent: string | null;
  /** The exact token string the caller presented. */
  presentedToken: string;
  /** `validateGrant` failure reason. */
  reason: string;
}

/**
 * Truncate an agent's `.vault-token` when the token it holds is provably
 * dead. Returns an outcome code describing what happened; never throws.
 */
export function reapUnusableGrantToken(args: ReapArgs, deps: ReapDeps = {}): ReapOutcome {
  const { agentsDir, agent, presentedToken, reason } = args;
  if (!REAPABLE_REASONS.has(reason)) return "kept:reason-not-reapable";
  if (!agent) return "kept:no-agent-identity";

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeFile =
    deps.writeFile ?? ((p: string, d: string) => writeFileSync(p, d, { mode: 0o600 }));

  const tokenPath = join(agentsDir, agent, ".vault-token");

  let onDisk: string;
  try {
    onDisk = readFile(tokenPath);
  } catch {
    // ENOENT (never minted) or EACCES — nothing safe to do.
    return "kept:nothing-on-disk";
  }
  if (onDisk.trim() === "") return "kept:nothing-on-disk";
  if (onDisk.trim() !== presentedToken.trim()) return "kept:superseded";

  try {
    // In-place O_TRUNC — NOT tmp+rename. See the module header: rename over a
    // bare-file bind mount is EBUSY, and truncation preserves inode ownership.
    writeFile(tokenPath, "");
  } catch {
    return "kept:io-error";
  }
  return "reaped";
}
