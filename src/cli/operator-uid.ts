/**
 * Operator-identity + post-sudo ownership restore (#1473 prevention).
 *
 * `switchroom apply` self-elevates by re-exec'ing the WHOLE process
 * under `sudo` (`reexecUnderSudo`). Everything it then writes —
 * `migrateVaultLayout` rewriting `vault/vault.enc`, the audit-log
 * mkdirs, etc. — is created as root, with no chown-back. The broker
 * still reads via CAP_DAC_READ_SEARCH, so it's invisible until the
 * operator runs `switchroom vault …` and gets EACCES (the recurring
 * lockout this prevents — detected by doctor since #1474, now also
 * prevented at the source).
 *
 * Scattered per-artifact chowns regress every time a new operator-owned
 * artifact lands, so this is ONE generic sweep over the operator-owned
 * `~/.switchroom` subtree. Per-agent state dirs are intentionally NOT
 * touched — `alignAgentUid` owns those at the per-agent UID.
 */

import {
  chownSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The canonical in-container mount point of the operator's home.
 *
 * hostd pins `HOME=/host-home` and bind-mounts `~/.switchroom` there
 * (src/cli/hostd.ts:302); the root-tier agent container mounts the same
 * host home at the same path. It is deliberately NOT a valid bind SOURCE
 * (see `assertPlausibleHostHome`) — but it IS a valid place to READ the
 * operator's ownership from, because a bind mount preserves the host
 * inode's uid.
 */
const CONTAINER_OPERATOR_HOME = "/host-home";

/**
 * Marker that a directory really is a switchroom home, so we never adopt
 * the uid of some unrelated `.switchroom` directory.
 */
const SWITCHROOM_HOME_MARKER = "switchroom.yaml";

export interface OperatorUidOwnershipDeps {
  env?: NodeJS.ProcessEnv;
  /** The process home. Defaults to `os.homedir()` at the call site. */
  home?: string;
  /** True when `path` exists (follows symlinks). */
  exists?: (path: string) => boolean;
  /** Owning uid of `path`, or undefined when unreadable. */
  statUid?: (path: string) => number | undefined;
}

/**
 * The switchroom-home directories to read operator ownership from, in
 * precedence order. Deduped, `.switchroom` appended to each.
 *
 * `SWITCHROOM_HOST_HOME` first (authoritative when the host path is also
 * visible here — the host shell), then the process home (correct inside
 * hostd, whose HOME is pinned to `/host-home`), then `/host-home`
 * explicitly (an agent container's HOME is its own state dir, so only the
 * literal mount point finds the operator home there).
 */
export function operatorHomeCandidates(
  env: NodeJS.ProcessEnv,
  home: string | undefined,
): string[] {
  const roots = [env.SWITCHROOM_HOST_HOME?.trim(), home, CONTAINER_OPERATOR_HOME];
  const out: string[] = [];
  for (const r of roots) {
    if (!r || r.length === 0) continue;
    const dir = join(r, ".switchroom");
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * Last-resort operator identity: the OWNER of the switchroom home itself.
 *
 * WHY (#3928 amendment). Switchroom's contract is that an operator drives
 * the fleet from Telegram, never a host shell. But `webd install` refused
 * outright when it could not resolve an operator uid, and root-with-no-
 * SUDO_UID is exactly what an agent/hostd container is — so the only
 * remediation the CLI could offer for a stale `switchroom-web` was "open
 * a shell as the operator". That is the design failure, not the peercred
 * invariant it protects: the uid is right there on disk.
 *
 * It also closes the recursive hole that produced #3928's live evidence.
 * `hostd install` run as root omits `SWITCHROOM_HOSTD_OPERATOR_UID` from
 * the compose it generates (src/cli/hostd.ts:638 passes
 * `resolveOperatorUid()`, and the env line is emitted only when it is
 * defined) — so the hostd container it creates ALSO cannot resolve the
 * uid, and the rollout's in-plan `refresh-web` step inside that container
 * fails for the same reason. One fix at this layer closes both.
 *
 * Deliberately reads the DIRECTORY, not a file inside it: on the
 * reference host `~/.switchroom/switchroom.yaml` is root-owned (written
 * by a root-mode apply) while `~/.switchroom` itself is `1000:1000`. The
 * directory is the operator-owned artifact (`operatorOwnedPaths`, and
 * `restoreOperatorOwnership` keeps it that way); the file contents are
 * not a reliable identity signal.
 *
 * Fail-closed: uid 0 is REJECTED (root is never "the operator" — adopting
 * it would write `user: "0:0"` into the web compose and 503 every webhook
 * forward, the exact silent breakage the refusal existed to prevent), as
 * is a directory with no `switchroom.yaml` in it.
 */
export function resolveOperatorUidFromOwnership(
  deps: OperatorUidOwnershipDeps = {},
): number | undefined {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const exists = deps.exists ?? ((p) => existsSync(p));
  const statUid =
    deps.statUid ??
    ((p) => {
      try {
        return statSync(p).uid;
      } catch {
        return undefined;
      }
    });

  for (const dir of operatorHomeCandidates(env, home)) {
    if (!exists(join(dir, SWITCHROOM_HOME_MARKER))) continue;
    const uid = statUid(dir);
    if (uid !== undefined && Number.isFinite(uid) && uid > 0) return uid;
  }
  return undefined;
}

/**
 * Resolve the real invoking operator's uid even under sudo. `sudo`
 * exports the underlying user's uid as `SUDO_UID` (process.getuid()
 * would return 0). Falls back to getuid() when >0, then to the
 * hostd-injected `SWITCHROOM_HOSTD_OPERATOR_UID`, then to the OWNER of
 * the switchroom home on disk, else undefined.
 *
 * The ownership tier is strictly additive: it is reached only where the
 * three env/syscall tiers already returned `undefined` — i.e. exactly
 * today's degraded outcomes (compose generated without the broker
 * operator socket, a skipped chown-back, `webd install` refusing). No
 * call that resolves today changes answer. See
 * `resolveOperatorUidFromOwnership` for why it exists (#3928).
 *
 * The hostd fallback is load-bearing: `switchroom apply` shelled out by
 * hostd runs as root WITHOUT sudo, so `SUDO_UID` is unset and getuid()
 * is 0 — resolveOperatorUid() would return undefined and generateCompose
 * then omits the broker's operator-socket bind (compose.ts gates it on
 * operatorUid !== undefined). That silently breaks host-shell vault
 * access AND the litellm key-confirm probe on the *next* apply (which
 * strips litellm routing fleet-wide). hostd already exports the real
 * host operator uid as SWITCHROOM_HOSTD_OPERATOR_UID (same host-fact
 * injection pattern as SWITCHROOM_HOST_HOME) — consume it here so a
 * hostd-driven rollout emits the operator socket just like a host-shell
 * `sudo apply` does.
 */
export function resolveOperatorUid(
  /** Test seam for the ownership tier only — production passes nothing. */
  ownershipDeps: OperatorUidOwnershipDeps = {},
): number | undefined {
  const sudoUid = process.env.SUDO_UID;
  if (sudoUid !== undefined) {
    const parsed = parseInt(sudoUid, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (uid > 0) return uid;
  }
  const hostdUid = process.env.SWITCHROOM_HOSTD_OPERATOR_UID;
  if (hostdUid !== undefined) {
    const parsed = parseInt(hostdUid, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return resolveOperatorUidFromOwnership(ownershipDeps);
}

export interface OwnershipRestoreDeps {
  chown?: (path: string, uid: number, gid: number) => void;
  exists?: (path: string) => boolean;
  /** True if path is a directory (follows symlinks). */
  isDir?: (path: string) => boolean;
  /** True if path is itself a symlink (no follow). */
  isSymlink?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readdir?: (path: string) => string[];
}

/**
 * Operator-owned artifacts directly under `~/.switchroom` that a
 * root-mode `apply` can leave root-owned and thereby lock the operator
 * out of. NOT per-agent dirs (alignAgentUid handles those at the agent
 * UID — chowning them to the operator would itself break the agents).
 */
export function operatorOwnedPaths(home: string): string[] {
  const root = join(home, ".switchroom");
  return [
    join(root, "vault"), // dir (recursive) — holds vault.enc
    join(root, "vault-auto-unlock"), // machine-id-keyed unlock blob
    join(root, "vault-audit.log"),
    join(root, "host-control-audit.log"),
    join(root, "accounts"), // dir (recursive) — OAuth account store
    join(root, "compose"), // dir (recursive) — generated docker-compose.yml
  ];
}

/** Resolve the injectable IO shims once, applying the real-fs defaults. */
function resolveWalkDeps(deps: OwnershipRestoreDeps): Required<
  Pick<OwnershipRestoreDeps, "exists" | "isDir" | "isSymlink" | "realpath" | "readdir">
> {
  return {
    exists: deps.exists ?? ((p) => existsSync(p)),
    isSymlink:
      deps.isSymlink ??
      ((p) => {
        try {
          return lstatSync(p).isSymbolicLink();
        } catch {
          return false;
        }
      }),
    isDir:
      deps.isDir ??
      ((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      }),
    realpath:
      deps.realpath ??
      ((p) => {
        try {
          return realpathSync(p);
        } catch {
          return p;
        }
      }),
    readdir:
      deps.readdir ??
      ((p) => {
        try {
          return readdirSync(p);
        } catch {
          return [];
        }
      }),
  };
}

/**
 * Walk the operator-owned `~/.switchroom` subtree and return the real
 * targets (symlinks resolved, directories recursed, deduped, in
 * parent-before-child order). Missing paths are skipped silently — not
 * every install has every artifact.
 *
 * This is the single source of truth for "which paths should the
 * operator own": both `restoreOperatorOwnership` (chown-back after a
 * root-mode apply) and the doctor's ownership probe consume it, so the
 * sweep set and the symlink-resolution rules can't drift between the
 * fix and the diagnostic.
 *
 * Symlinks resolve to their real target (the v0.7.12 `vault.enc ->
 * vault/vault.enc` legacy link, accounts symlinks, …) so callers act on
 * the actual file, not the link entry.
 */
export function walkOperatorOwnedTargets(
  home: string,
  deps: OwnershipRestoreDeps = {},
  roots: string[] = operatorOwnedPaths(home),
): string[] {
  const { exists, isSymlink, isDir, realpath, readdir } = resolveWalkDeps(deps);

  const targets: string[] = [];
  const seen = new Set<string>();

  const visit = (path: string): void => {
    if (!exists(path)) return;
    const target = isSymlink(path) ? realpath(path) : path;
    if (seen.has(target)) return;
    seen.add(target);
    targets.push(target);
    if (isDir(target)) {
      for (const entry of readdir(target)) {
        visit(join(target, entry));
      }
    }
  };

  for (const p of roots) visit(p);
  return targets;
}

/**
 * Best-effort: chown the operator-owned `~/.switchroom` subtree back to
 * `operatorUid:operatorUid`. Recurses into directories. Every chown is
 * best-effort (dev/non-docker, missing path, no CAP_CHOWN, raced
 * delete) — a failure on one path never aborts the rest. Returns the
 * realpaths it successfully chowned (logging/tests).
 *
 * For the `vault` dir this resolves the real target so the v0.7.12
 * legacy symlink (`vault.enc -> vault/vault.enc`) doesn't matter.
 */
export function restoreOperatorOwnership(
  home: string,
  operatorUid: number,
  deps: OwnershipRestoreDeps = {},
): string[] {
  const chown = deps.chown ?? ((p, u, g) => chownSync(p, u, g));

  const chowned: string[] = [];
  for (const target of walkOperatorOwnedTargets(home, deps)) {
    try {
      chown(target, operatorUid, operatorUid);
      chowned.push(target);
    } catch {
      /* best-effort: dev/no CAP_CHOWN/raced; keep going */
    }
  }
  return chowned;
}
