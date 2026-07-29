/**
 * How switchroom re-invokes ITSELF as a subprocess (#3963).
 *
 * THE BUG THIS CLOSES
 *
 * Half a dozen commands shell out to another switchroom subcommand
 * rather than calling into it in-process (`rollout` runs `apply` then
 * `agent restart …`; `update` runs `apply` / `hostd install` / `webd
 * install` / `memory setup` / `doctor`; `apply` re-execs itself under
 * sudo; `skill push` runs `apply`; `vault broker start` daemonises
 * itself). Every one of them was written the same way:
 *
 *     spawn(process.execPath, [process.argv[1], ...args])
 *
 * That is correct for a JS install — `process.execPath` is the bun/node
 * interpreter and `argv[1]` is a real `dist/cli/switchroom.js` on disk.
 * It is WRONG for the artifact `install.sh` actually publishes. Inside a
 * `bun build --compile` single-file executable, `process.execPath` is
 * the switchroom binary itself and `process.argv[1]` is the VIRTUAL
 * bundle path `/$bunfs/root/switchroom-linux-amd64` — not a file, and
 * not something the binary will accept as an argument. The spawn became
 *
 *     /usr/local/bin/switchroom  /$bunfs/root/switchroom-linux-amd64  apply …
 *
 * and commander parsed the bunfs path as the subcommand:
 *
 *     error: unknown command '/$bunfs/root/switchroom-linux-amd64'
 *
 * `switchroom rollout` was therefore dead on arrival in every published
 * binary — it stopped at step 1 with zero agents rolled (reproduced on
 * v0.19.32).
 *
 * THE RULE
 *
 * A compiled binary is its own entrypoint: spawn `process.execPath` with
 * the subcommand args and NOTHING in front of them. A JS install needs
 * the interpreter plus the script path. {@link resolveSelfInvocation}
 * returns exactly that split so no call site has to remember it, and
 * {@link isCompiledBinaryPath} is the single definition of the tell.
 *
 * WHY A PATH PREFIX AND NOT A FILESYSTEM PROBE
 *
 * The bunfs root is virtual — `existsSync(argv[1])` is not a reliable
 * discriminator across bun versions, and probing the filesystem on every
 * self-spawn is both slower and less predictable than a string test. The
 * repo already discriminates the compiled case exactly this way in
 * `self-update.ts` (`detectInstallKind`, `p.bundleDir.startsWith("/$bunfs")`)
 * and in `apply.ts`'s embedded-template comments. This module keeps that
 * one convention.
 *
 * Pure and dependency-free on purpose: every call site can inject the
 * probe, so the compiled-binary behaviour is unit-assertable on a host
 * that has no compiled binary (CI included).
 */

/**
 * Virtual root of a `bun build --compile` single-file executable's
 * embedded filesystem on POSIX. Same literal `self-update.ts` matches.
 */
export const BUNFS_POSIX_PREFIX = "/$bunfs";

/**
 * Windows flavour of the same virtual root. Bun mounts the embedded
 * filesystem at `B:\~BUN\root\…` there. Matched case-insensitively and
 * on either slash so a normalised path still trips it.
 */
const BUNFS_WINDOWS_RE = /^[a-z]:[/\\]~BUN[/\\]/i;

/**
 * True when `scriptPath` is a compiled binary's virtual bundle path
 * rather than a real file on disk.
 *
 * This is the ONLY place the tell is defined. Anything that needs to
 * know "am I a published static binary?" for self-invocation purposes
 * asks here.
 */
export function isCompiledBinaryPath(scriptPath: string | undefined | null): boolean {
  if (!scriptPath) return false;
  return (
    scriptPath.startsWith(BUNFS_POSIX_PREFIX) || BUNFS_WINDOWS_RE.test(scriptPath)
  );
}

/** What to pass to `spawn`/`spawnSync` to re-invoke switchroom. */
export interface SelfInvocation {
  /** Executable to spawn. */
  command: string;
  /**
   * Arguments that must come BEFORE the subcommand args. `[scriptPath]`
   * for a JS install; EMPTY for a compiled binary, which is its own
   * entrypoint.
   */
  prefixArgs: string[];
  /** True when {@link command} is the compiled switchroom binary itself. */
  compiled: boolean;
}

/** Inputs to {@link resolveSelfInvocation}. Injectable for tests. */
export interface SelfInvokeProbe {
  /** `process.execPath` — the interpreter, or the binary when compiled. */
  execPath?: string;
  /** `process.argv[1]` — the script path, or the bunfs path when compiled. */
  scriptPath?: string;
}

/**
 * Resolve how to re-invoke this switchroom.
 *
 * Compiled binary  → `{ command: <the binary>, prefixArgs: [] }`
 * JS install       → `{ command: <bun|node>,   prefixArgs: [<script>] }`
 *
 * Degenerate inputs fall back to the bare `switchroom` name and let
 * $PATH resolve it — the same fallback the call sites used before, and
 * strictly better than spawning an empty string.
 */
export function resolveSelfInvocation(probe: SelfInvokeProbe = {}): SelfInvocation {
  const execPath = probe.execPath ?? process.execPath;
  const scriptPath = probe.scriptPath ?? process.argv[1] ?? "";

  if (isCompiledBinaryPath(scriptPath)) {
    // The binary is its own entrypoint. Passing the bunfs path along is
    // exactly the #3963 bug.
    if (execPath) return { command: execPath, prefixArgs: [], compiled: true };
    // A compiled binary with no execPath should not be reachable, but
    // spawning "" certainly fails; let $PATH answer instead.
    return { command: "switchroom", prefixArgs: [], compiled: true };
  }

  if (!execPath || !scriptPath) {
    return { command: "switchroom", prefixArgs: [], compiled: false };
  }
  return { command: execPath, prefixArgs: [scriptPath], compiled: false };
}

/**
 * Convenience wrapper: the complete `[command, argv]` pair for running
 * `switchroom <args…>` as a subprocess of this one.
 */
export function selfInvokeArgv(
  args: readonly string[],
  probe: SelfInvokeProbe = {},
): { command: string; argv: string[] } {
  const inv = resolveSelfInvocation(probe);
  return { command: inv.command, argv: [...inv.prefixArgs, ...args] };
}
