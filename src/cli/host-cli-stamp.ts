/**
 * The host operator CLI stamp — making the host binary's version OBSERVABLE
 * from inside a container, so a rollout can order it FIRST instead of
 * apologising for it LAST (#4571).
 *
 * ## The bug this closes
 *
 * Switchroom's one enumerative "is everything on the same version?" check
 * (`component-versions.ts`) reports a `cli (host)` row whose version is
 * `SWITCHROOM_VERSION` — *the version of the process doing the checking*.
 * On the host shell that is correct: the process IS the host CLI. On the
 * agent-invoked path (hostd spawns `switchroom rollout` inside its own
 * container) it is not: the row reports the hostd IMAGE's bundled CLI and
 * labels it `(host)`. The host operator's npm/binary install is never
 * measured by anything, at any point in a roll.
 *
 * That is why the host CLI on the reference host sat on 0.20.16 while the
 * fleet rolled to 0.20.21 — five releases of drift, with every roll exiting
 * green and emitting a trailing "still on the PRIOR version" warning nobody
 * actioned. A warning scrolls past once; nothing held a checkable answer.
 *
 * ## Why a stamp
 *
 * hostd mounts exactly one host path: `~/.switchroom` (src/cli/hostd.ts:332).
 * It has no view of `/usr/local/bin`, no view of an nvm tree, and no way to
 * `npm i -g` on the host. So the roll cannot GO AND LOOK at the host CLI, and
 * it cannot install it either. The only thing that can report the host CLI's
 * version into the shared directory is the host CLI itself.
 *
 * So: every host-context invocation of the CLI refreshes
 * `~/.switchroom/host-cli.json` with its own version and how it was installed
 * (idempotent — a byte-identical stamp is not rewritten). An agent-invoked
 * rollout reads that file through the `/host-home/.switchroom` mount and
 * REFUSES to roll the fleet past a host CLI that is behind the target
 * (`shouldRefuseStaleHostCli`, consumed by `rollout.ts`).
 *
 * ## Why the install command is derived, never hardcoded
 *
 * The pre-existing warning told operators to run `sudo npm i -g switchroom@X`.
 * On the reference host that advice is actively wrong: the CLI lives in the
 * operator's nvm tree (`~/.nvm/versions/node/vX/lib/node_modules/switchroom`)
 * owned by the operator, not root — `sudo npm i -g` there either installs into
 * a different prefix or root-poisons the tree. The stamp therefore records the
 * npm prefix and the owning user it OBSERVED, and {@link hostCliInstallCommand}
 * renders the command from those facts.
 */

import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareReleaseTags } from "../config/release-resolve.js";
import type { HostCliObservation } from "./component-versions.js";
import { detectInstallKind, type InstallKind } from "./self-update.js";

/** File name of the stamp inside the switchroom home. */
export const HOST_CLI_STAMP_FILENAME = "host-cli.json";

/** Marker that a directory really is a switchroom home. */
const SWITCHROOM_HOME_MARKER = "switchroom.yaml";

/**
 * The in-container mount point of the operator's home. hostd pins
 * `HOME=/host-home` and bind-mounts `~/.switchroom` there (hostd.ts:332), and
 * the root-tier agent container mounts the same host home at the same path —
 * so this is where a container-side READ finds the stamp.
 */
const CONTAINER_OPERATOR_HOME = "/host-home";

/** What the host CLI records about itself. Serialized as JSON. */
export interface HostCliStamp {
  /** Bare semver as the CLI reports it (`0.20.21`), or the raw string. */
  version: string;
  /** How the host CLI was installed, per {@link detectInstallKind}. */
  installKind: InstallKind;
  /** The entrypoint that was actually executed (script or binary path). */
  path: string;
  /** npm global prefix, when `installKind === "npm-global"`. */
  npmPrefix?: string;
  /** Login name owning the install tree, when resolvable. */
  ownerUser?: string;
  /** uid owning the install tree, when readable. */
  ownerUid?: number;
}

export interface StampIo {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  statUid?: (path: string) => number | undefined;
  /** Resolve a login name from a uid. Default reads `/etc/passwd`. */
  userForUid?: (uid: number) => string | undefined;
  /** Effective uid of this process. Drives the root-write ownership handoff. */
  getuid?: () => number | undefined;
  /** Ownership handoff for a stamp written as root. */
  chown?: (path: string, uid: number, gid: number) => void;
  /** uid/gid of an existing directory, for the handoff. */
  statOwner?: (path: string) => { uid: number; gid: number } | undefined;
}

function resolveIo(io: StampIo): Required<Omit<StampIo, "env" | "home">> & {
  env: NodeJS.ProcessEnv;
  home: string;
} {
  return {
    env: io.env ?? process.env,
    home: io.home ?? homedir(),
    exists: io.exists ?? ((p) => existsSync(p)),
    readFile: io.readFile ?? ((p) => readFileSync(p, "utf8")),
    writeFile:
      io.writeFile ??
      ((p, c) => {
        // tmp+rename so a reader never sees a half-written stamp.
        const tmp = `${p}.${process.pid}.tmp`;
        writeFileSync(tmp, c, { mode: 0o644 });
        renameSync(tmp, p);
      }),
    statUid:
      io.statUid ??
      ((p) => {
        try {
          return statSync(p).uid;
        } catch {
          return undefined;
        }
      }),
    userForUid: io.userForUid ?? userFromPasswd,
    getuid: io.getuid ?? (() => process.getuid?.()),
    chown: io.chown ?? ((p, uid, gid) => chownSync(p, uid, gid)),
    statOwner:
      io.statOwner ??
      ((p) => {
        try {
          const st = statSync(p);
          return { uid: st.uid, gid: st.gid };
        } catch {
          return undefined;
        }
      }),
  };
}

/** Best-effort login name for a uid, from `/etc/passwd`. */
function userFromPasswd(uid: number): string | undefined {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[2] !== undefined && parseInt(f[2], 10) === uid && f[0]) return f[0];
    }
  } catch {
    /* no passwd / unreadable */
  }
  return undefined;
}

/** Best-effort home dir for a login name, from `/etc/passwd`. */
function homeFromPasswd(user: string): string | undefined {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = line.split(":");
      if (f[0] === user && f[5]) return f[5];
    }
  } catch {
    /* no passwd / unreadable */
  }
  return undefined;
}

/**
 * Candidate switchroom homes, in precedence order.
 *
 * `SWITCHROOM_HOST_HOME` first (hostd injects the real host home), then the
 * *invoking* operator's home under sudo (`SUDO_USER`'s passwd entry — under
 * `sudo switchroom …` the process home is `/root`, which is NOT where the
 * fleet lives), then the process home, then the container mount point.
 */
export function stampHomeCandidates(
  env: NodeJS.ProcessEnv,
  home: string | undefined,
  homeForUser: (user: string) => string | undefined = homeFromPasswd,
): string[] {
  const sudoUser = env.SUDO_USER;
  const roots = [
    env.SWITCHROOM_HOST_HOME?.trim(),
    sudoUser && sudoUser !== "root" ? homeForUser(sudoUser) : undefined,
    home,
    CONTAINER_OPERATOR_HOME,
  ];
  const out: string[] = [];
  for (const r of roots) {
    if (!r) continue;
    const dir = join(r, ".switchroom");
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * The switchroom home to read/write the stamp in: the first candidate that
 * actually contains a `switchroom.yaml`. Returns undefined when none does —
 * a dev checkout with no installed fleet, and there is nothing to stamp.
 */
export function resolveStampDir(io: StampIo = {}): string | undefined {
  const { env, home, exists } = resolveIo(io);
  const homeForUser = (u: string) => homeFromPasswd(u);
  for (const dir of stampHomeCandidates(env, home, homeForUser)) {
    if (exists(join(dir, SWITCHROOM_HOME_MARKER))) return dir;
  }
  return undefined;
}

/**
 * The npm global prefix implied by an npm-installed entrypoint path.
 *
 * `<prefix>/lib/node_modules/switchroom/dist/cli/switchroom.js` → `<prefix>`.
 * Returns undefined for any path that does not carry that shape, so the
 * renderer degrades to a prefix-free command rather than inventing one.
 */
export function npmPrefixFromScriptPath(scriptPath: string): string | undefined {
  const marker = "/lib/node_modules/switchroom/";
  const at = scriptPath.indexOf(marker);
  if (at <= 0) return undefined;
  return scriptPath.slice(0, at);
}

/** The install-tree path whose ownership identifies who may `npm i -g`. */
export function npmPackageRoot(scriptPath: string): string | undefined {
  const marker = "/lib/node_modules/switchroom/";
  const at = scriptPath.indexOf(marker);
  if (at <= 0) return undefined;
  return scriptPath.slice(0, at + marker.length - 1);
}

export interface BuildStampInput {
  version: string;
  execPath: string;
  scriptPath: string;
  bundleDir: string;
  inContainer: boolean;
}

/**
 * Build the stamp for the RUNNING process. Pure apart from the injectable
 * ownership probe, so the exact recorded bytes are unit-asserted.
 */
export function buildHostCliStamp(
  input: BuildStampInput,
  io: StampIo = {},
): HostCliStamp | undefined {
  if (input.inContainer) return undefined; // a container CLI is not the host CLI
  const { statUid, userForUid } = resolveIo(io);
  const detection = detectInstallKind({
    bundleDir: input.bundleDir,
    execPath: input.execPath,
    scriptPath: input.scriptPath,
    inContainer: false,
  });
  const path =
    detection.kind === "static-binary"
      ? (detection.binaryPath ?? input.execPath)
      : input.scriptPath || input.execPath;
  const stamp: HostCliStamp = {
    version: input.version.replace(/^v/, ""),
    installKind: detection.kind,
    path,
  };
  if (detection.kind === "npm-global") {
    const prefix = npmPrefixFromScriptPath(input.scriptPath);
    if (prefix) stamp.npmPrefix = prefix;
  }
  const ownedPath =
    detection.kind === "npm-global" ? (npmPackageRoot(input.scriptPath) ?? path) : path;
  const uid = statUid(ownedPath);
  if (uid !== undefined && Number.isFinite(uid)) {
    stamp.ownerUid = uid;
    const user = userForUid(uid);
    if (user) stamp.ownerUser = user;
  }
  return stamp;
}

/** Stable serialization so an unchanged stamp is a byte-identical no-op. */
export function serializeStamp(stamp: HostCliStamp): string {
  return `${JSON.stringify(stamp, ["version", "installKind", "path", "npmPrefix", "ownerUser", "ownerUid"], 2)}\n`;
}

/**
 * Refresh `~/.switchroom/host-cli.json` for the running host CLI.
 *
 * Best-effort and total: every failure path returns a reason instead of
 * throwing, because this runs on EVERY CLI invocation and must never be able
 * to break a command. Returns what it did, for tests.
 */
export function refreshHostCliStamp(
  input: BuildStampInput,
  io: StampIo = {},
): { status: "written" | "unchanged" | "skipped"; reason?: string; path?: string } {
  const stamp = buildHostCliStamp(input, io);
  if (!stamp) return { status: "skipped", reason: "running in a container" };
  return writeHostCliStamp(stamp, io);
}

/**
 * Write a stamp into the resolved switchroom home.
 *
 * Split out of {@link refreshHostCliStamp} so the ROLLOUT path can record a
 * host CLI it upgraded out-of-band (#4585). After the heal helper swaps the
 * host binary, nothing has run that binary in host context — so without this
 * the stamp would keep reporting the old version and the gate would keep
 * refusing, which is the "stamp doesn't refresh from a container" trap called
 * out on #4585. The heal is only complete when the observable record moves
 * with it.
 *
 * Best-effort and total, like its caller: every failure returns a reason.
 */
export function writeHostCliStamp(
  stamp: HostCliStamp,
  io: StampIo = {},
): { status: "written" | "unchanged" | "skipped"; reason?: string; path?: string } {
  try {
    const dir = resolveStampDir(io);
    if (!dir) return { status: "skipped", reason: "no switchroom home found" };
    const { exists, readFile, writeFile, getuid, chown, statOwner } = resolveIo(io);
    const path = join(dir, HOST_CLI_STAMP_FILENAME);
    const content = serializeStamp(stamp);
    if (exists(path)) {
      try {
        if (readFile(path) === content) return { status: "unchanged", path };
      } catch {
        /* unreadable — rewrite */
      }
    }
    mkdirSync(dir, { recursive: true });
    writeFile(path, content);
    // A `sudo switchroom …` run would otherwise leave a ROOT-OWNED stamp in the
    // operator's home, and every later unprivileged run's tmp+rename would
    // EACCES — freezing the stamp at whatever root last wrote and re-opening
    // the exact silent-drift hole this file closes. Hand it back to whoever
    // owns the switchroom home. Best-effort: a chown failure is not fatal.
    if (getuid() === 0) {
      try {
        const owner = statOwner(dir);
        if (owner && owner.uid !== 0) chown(path, owner.uid, owner.gid);
      } catch {
        /* not fatal — the stamp is still written */
      }
    }
    return { status: "written", path };
  } catch (err) {
    return { status: "skipped", reason: (err as Error).message };
  }
}

/** True when this process is running inside a container. */
export function runningInContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHROOM_HOSTD_CONTEXT === "1" || existsSync("/.dockerenv");
}

/**
 * What the CURRENT process can honestly say about the HOST operator CLI.
 *
 * The single production derivation, shared by `doctor` and `update --check` so
 * the two can't disagree about whose version the `cli (host)` row is showing.
 */
export function observeHostCli(
  io: StampIo = {},
  inContainer: boolean = runningInContainer(io.env ?? process.env),
): HostCliObservation {
  if (!inContainer) return { inContainer: false };
  const stamp = readHostCliStamp(io);
  return { inContainer: true, ...(stamp ? { observedVersion: stamp.version } : {}) };
}

/** Read the stamp, or undefined when absent/unreadable/malformed. */
export function readHostCliStamp(io: StampIo = {}): HostCliStamp | undefined {
  try {
    const dir = resolveStampDir(io);
    if (!dir) return undefined;
    const { exists, readFile } = resolveIo(io);
    const path = join(dir, HOST_CLI_STAMP_FILENAME);
    if (!exists(path)) return undefined;
    const parsed = JSON.parse(readFile(path)) as Partial<HostCliStamp>;
    if (typeof parsed.version !== "string" || parsed.version.length === 0) return undefined;
    return {
      version: parsed.version,
      installKind: (parsed.installKind as InstallKind) ?? "unknown",
      path: typeof parsed.path === "string" ? parsed.path : "",
      ...(parsed.npmPrefix ? { npmPrefix: parsed.npmPrefix } : {}),
      ...(parsed.ownerUser ? { ownerUser: parsed.ownerUser } : {}),
      ...(typeof parsed.ownerUid === "number" ? { ownerUid: parsed.ownerUid } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The command that brings the OBSERVED host CLI onto `target`.
 *
 * Derived from the stamp, never hardcoded — see the module header for why
 * `sudo npm i -g` is wrong on an nvm/user-prefix install. `target` may be
 * `vX.Y.Z` or bare; npm wants it bare.
 */
export function hostCliInstallCommand(
  stamp: HostCliStamp | undefined,
  target: string,
): string {
  const bare = target.replace(/^v/, "");
  if (!stamp) {
    return (
      `upgrade the host operator CLI to ${bare} host-side ` +
      `(\`switchroom update\` for a static-binary install; ` +
      `\`npm i -g switchroom@${bare}\` for an npm install — as the user who owns ` +
      `the npm prefix)`
    );
  }
  switch (stamp.installKind) {
    case "npm-global": {
      // `--prefix` is spelled out whenever the stamp recorded one. npm resolves
      // the global prefix from the INVOKING user's npmrc, which under `sudo` is
      // root's, not the one the observed install actually lives in — so a bare
      // `npm i -g` can quietly converge a different tree and leave the drift
      // exactly where it was.
      const npmCmd = `npm i -g${stamp.npmPrefix ? ` --prefix ${stamp.npmPrefix}` : ""} switchroom@${bare}`;
      if (stamp.ownerUid === 0) return `sudo ${npmCmd}`;
      const who = stamp.ownerUser ?? (stamp.ownerUid !== undefined ? `uid ${stamp.ownerUid}` : undefined);
      const asNote = who
        ? ` — run as ${who}, NOT under sudo`
        : ` — run as the user owning ${stamp.path}, NOT under sudo`;
      return `${npmCmd}${asNote}`;
    }
    case "static-binary":
      return `switchroom update --pin v${bare}  (replaces the static binary at ${stamp.path})`;
    case "source-checkout":
      return `git pull && bun install && npm run build  (source checkout at ${stamp.path})`;
    case "container":
    case "unknown":
    default:
      return (
        `upgrade the host operator CLI at ${stamp.path} to ${bare} using the ` +
        `method it was installed with`
      );
  }
}

/**
 * The host-CLI upgrade as a RUNNABLE shell command, or undefined when there
 * isn't one that can be safely pasted.
 *
 * {@link hostCliInstallCommand} is prose-with-a-command: it carries the "run as
 * <user>, NOT under sudo" caveat that makes the command correct. That caveat
 * cannot survive being `&&`-chained into a copy-paste block, so this returns
 * undefined precisely in the cases where the caveat is load-bearing (a
 * user-owned npm prefix, an unknown install, no stamp at all). Callers that
 * want to collapse commands into one line must fall back to two lines then —
 * which is the point: a wrong copy-paste is worse than a second line.
 */
export function hostCliInstallShellCommand(
  stamp: HostCliStamp | undefined,
  target: string,
): string | undefined {
  if (!stamp) return undefined;
  const bare = target.replace(/^v/, "");
  if (stamp.installKind === "static-binary") return `switchroom update --pin v${bare}`;
  if (stamp.installKind === "npm-global" && stamp.ownerUid === 0) {
    // Carry the observed prefix, for the same reason the prose command does:
    // `sudo` swaps in root's npmrc prefix, so a bare `-g` can install into a
    // tree that is not the one this stamp measured.
    return `sudo npm i -g${stamp.npmPrefix ? ` --prefix ${stamp.npmPrefix}` : ""} switchroom@${bare}`;
  }
  return undefined;
}

/**
 * `failedStep` label for a roll refused up-front because the HOST operator
 * CLI is behind the target. Distinct from `preflight-stale-cli` (which is
 * about the CLI *driving* the roll — inside hostd on the agent path) because
 * the remediation is a host-side install, not a hostd refresh.
 */
export const PREFLIGHT_HOST_CLI_STALE_STEP = "preflight-host-cli-stale";

/**
 * Pure guard: true when the roll must be refused because the observed host
 * operator CLI is STRICTLY OLDER than the target.
 *
 * Conservative in exactly the same shape as `shouldRefuseStaleCli`: an absent
 * stamp, or a version on either side that is not a clean `vX.Y.Z`, is
 * unorderable and never blocks. An absent stamp is the first-upgrade
 * chicken-and-egg case (a host CLI predating this feature writes no stamp) —
 * refusing there would brick every roll on every host on the release that
 * introduces the gate.
 */
export function shouldRefuseStaleHostCli(
  stamp: HostCliStamp | undefined,
  target: string,
): boolean {
  return compareHostCliToTarget(stamp, target) === "behind";
}

/**
 * Where the observed host CLI sits relative to `target`. THREE states, not two.
 *
 * `unknown` is the one that matters: an absent stamp, or a version that is not
 * a clean `vX.Y.Z` (a `-rc.N` / `-dev` / `sha-…` build — `switchroom update
 * --channel rc` produces exactly these), is unorderable. `shouldRefuseStaleHostCli`
 * folds `unknown` in with `current` deliberately, because the ROLL must not
 * block on what it cannot order. Nothing may fold it in the other direction and
 * ASSERT convergence: a card that reads "on 0.20.16-rc.1 — nothing to do" while
 * the fleet rolls to v0.20.22 is the same silent all-clear this whole file
 * exists to delete. Use {@link hostCliConvergedOnTarget} for that question.
 */
export function compareHostCliToTarget(
  stamp: HostCliStamp | undefined,
  target: string,
): "behind" | "current-or-ahead" | "unknown" {
  if (!stamp) return "unknown";
  const cmp = compareReleaseTags(
    `v${stamp.version.replace(/^v/, "")}`,
    `v${target.replace(/^v/, "")}`,
  );
  if (cmp === null) return "unknown";
  return cmp < 0 ? "behind" : "current-or-ahead";
}

/**
 * True ONLY when the host CLI was observed and is provably on-or-past `target`.
 *
 * The affirmative counterpart to {@link shouldRefuseStaleHostCli}: anything
 * unobserved or unorderable is NOT converged, so a surface that reports
 * outstanding host-side work keeps reporting it rather than guessing.
 */
export function hostCliConvergedOnTarget(
  stamp: HostCliStamp | undefined,
  target: string,
): boolean {
  return compareHostCliToTarget(stamp, target) === "current-or-ahead";
}
