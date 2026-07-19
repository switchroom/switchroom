/**
 * Shared symlink-safe mirror write primitive (#1393 WS1 → M1 TOCTOU close).
 *
 * The auth-broker runs as ROOT with CAP_DAC_OVERRIDE and mirrors the
 * effective account's OAuth credentials into two agent/consumer-writable
 * trees:
 *
 *   - per-agent   ~/.switchroom/agents/<name>/.claude/.credentials.json
 *   - per-consumer <consumer.mirror_dir>/.credentials.json
 *
 * Both destinations live under a directory the (potentially
 * prompt-injected) consumer/agent owns and can pre-plant with symlinks.
 * A raw `mkdirSync({recursive}) + atomicWriteFileSync + chownSync(path)`
 * would dereference those symlinks and let the peer redirect a
 * root-owned write/chown to an arbitrary host path — an agent→host
 * trust-boundary crossing on every fanout.
 *
 * This module centralises the write half so BOTH callers share one
 * hardened path:
 *
 *   1. The caller lstat-validates every controllable path component
 *      (agentsDir/agentDir/.claude/target, or mirror_dir-parent/mirror_dir/
 *      target) and refuses a symlink or wrong type — fail closed.
 *   2. `safeMirrorWrite` re-pins the containing directory's *canonical*
 *      (`realpathSync`) location against the caller's `expectedRealParent`
 *      immediately before the write. This closes the residual
 *      lstat→open TOCTOU: if a peer raced a controllable component into a
 *      symlink after the sweep, the resolved path diverges and we refuse.
 *   3. The write itself goes through `atomicWriteFileSync`, which opens
 *      the tempfile `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, `fchmod`/`fchown`s
 *      the **fd** (never a path — kills the symlink-following chown), then
 *      `rename(2)`s over the destination (rename replaces a symlink at the
 *      target rather than following it).
 *
 * Node lacks the `*at()` syscall family, so canonical-parent pinning plus
 * fd-relative metadata ops is the strongest guard available; the residual
 * is a parent-directory swap in the sub-millisecond window between the
 * `realpathSync` check and the `rename` (documented, accepted).
 *
 * Fail closed per-target: `safeMirrorWrite` returns false + audits, and
 * never throws across the fanout — one poisoned peer must not deny the
 * whole fleet's auth (doctrine of #1393).
 */

import { lstatSync, realpathSync, type Stats } from "node:fs";

import { atomicWriteFileSync } from "../../util/atomic.js";

/** Audit + log a refusal for a controllable component. Never throws. */
export type MirrorRefuse = (component: string, reason: string) => void;

export interface SafeMirrorWriteInput {
  /**
   * The directory that will contain the target file — already
   * lstat-validated (real dir) and, where applicable, created by the
   * caller.
   */
  parentDir: string;
  /**
   * The expected canonical (`realpathSync`) location of `parentDir`,
   * derived by the caller from a TRUSTED anchor's realpath + the
   * lstat-validated controllable component names. `safeMirrorWrite`
   * recomputes `realpathSync(parentDir)` and refuses on any divergence
   * (the M1 TOCTOU pin).
   */
  expectedRealParent: string;
  /** Absolute path of the target file inside `parentDir`. */
  targetPath: string;
  content: string;
  /** uid/gid to `fchown` the fd to before rename (fd-based, symlink-proof). */
  uid: number;
  gid?: number;
  mode?: number;
  /**
   * Swallow an `fchown` EPERM on CAP_CHOWN-less dev hosts — the mirror
   * still lands (just not re-owned). MUST NOT abort the write.
   */
  onChownError: (err: unknown) => void;
  /** Audit + log a symlink/TOCTOU refusal. */
  refuse: MirrorRefuse;
  /** Log a non-security write failure. */
  logErr: (msg: string) => void;
}

/** `lstat` a path, returning null (not throwing) when it doesn't exist. */
export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Perform the pinned, symlink-safe mirror write. Returns true on
 * success, false on refusal or a non-fatal write failure (both already
 * logged/audited). Never throws.
 */
export function safeMirrorWrite(input: SafeMirrorWriteInput): boolean {
  // M1: re-pin the parent's canonical path right before the write. If a
  // peer swapped any controllable component to a symlink after the
  // caller's lstat sweep, the fully-resolved path diverges → refuse.
  let realParent: string;
  try {
    realParent = realpathSync(input.parentDir);
  } catch (err) {
    input.logErr(`mirror parent realpath failed: ${(err as Error).message}`);
    return false;
  }
  if (realParent !== input.expectedRealParent) {
    input.refuse("parentDir", "realpath-mismatch");
    return false;
  }

  try {
    atomicWriteFileSync(input.targetPath, input.content, {
      mode: input.mode ?? 0o600,
      uid: input.uid,
      gid: input.gid ?? input.uid,
      onChownError: input.onChownError,
    });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // O_NOFOLLOW/O_EXCL trip: a symlink or inode was raced into place at
    // the temp/target path between validation and open. Treat as a
    // security refusal, not a generic failure.
    if (e.code === "ELOOP" || e.code === "EEXIST") {
      input.refuse("targetPath", `open-${e.code}`);
      return false;
    }
    input.logErr(`mirror write failed: ${e.message}`);
    return false;
  }
}
