/**
 * In-place writer for an agent's `.vault-token` capability-token file.
 *
 * ## Why this exists (#3751)
 *
 * `mint_grant` used to publish the freshly minted token with the classic
 * atomic-write dance: `writeFileSync(tmp)` + `renameSync(tmp, tokenPath)`.
 * That is exactly wrong for this file.
 *
 * Each agent's token file is bind-mounted into the broker container as a
 * **bare file** (`src/agents/compose.ts`, the per-agent
 * `…/.switchroom/agents/<a>/.vault-token:/root/.switchroom/agents/<a>/.vault-token`
 * loop). A bind-mounted file IS a mountpoint: `rename(2)` over it — and
 * `unlink(2)` of it — fail with `EBUSY` from inside the container. So the
 * write failed on *every* mint on the live fleet:
 *
 *   [vault-broker] mint_grant: failed to write token file for agent gymbro:
 *   EBUSY: resource busy or locked, rename
 *   '/root/.switchroom/agents/gymbro/.vault-token.tmp.6' ->
 *   '/root/.switchroom/agents/gymbro/.vault-token'
 *
 * …and it went unnoticed for months because the Telegram gateway happens to
 * write the same token on its own path afterwards, and the broker logged the
 * failure and shrugged.
 *
 * An in-place `O_TRUNC` write (`writeFileSync` with the default `"w"` flag)
 * keeps the SAME inode, so it:
 *   - works over the bare-file bind mount (no mountpoint is replaced), and
 *   - preserves the file's agent-UID ownership and `0600` mode, which the
 *     tmp+rename path destroyed on every write (a rename installs a
 *     root-owned inode — see CLAUDE.md "Dev flow & PR hygiene" §2).
 *
 * Same constraint and same remedy as the reaper in #3749
 * (`reap-token-file.ts`), which documented the EBUSY and adopted in-place
 * `O_TRUNC` for the truncate-to-empty case. This module is the mint-side
 * counterpart — the write-bytes case — and deliberately keeps the same
 * shape (injectable fs seams, in-place `writeFileSync`, no rename/unlink)
 * rather than inventing a second style. They differ in failure policy, and
 * must: reaping is hygiene and swallows every error into an outcome code,
 * minting is load-bearing and throws.
 *
 * ## Why it throws
 *
 * The old callsite swallowed every failure into a stderr line, so the caller
 * believed the mint had succeeded when the token had never reached disk. A
 * grant row that exists while its token file does not is precisely the
 * inconsistent state behind the "grant reported success but the agent still
 * can't read the secret" symptom. This module therefore treats a failed or
 * unverified write as a hard error and lets it propagate; `mint_grant` rolls
 * the grant back and fails the RPC.
 */

import { chownSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allocateAgentUid } from "../../agents/agent-uid.js";

/**
 * Thrown when the token file could not be written, or was written but did
 * not read back byte-identical. Never swallowed by the caller.
 */
export class TokenFileWriteError extends Error {
  readonly tokenPath: string;
  constructor(tokenPath: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TokenFileWriteError";
    this.tokenPath = tokenPath;
  }
}

/** Injection seams — real fs by default; tests override to force failures. */
export interface WriteAgentTokenFileDeps {
  mkdir?: (path: string) => void;
  /** MUST be an in-place truncating write. Never tmp+rename. */
  writeFile?: (path: string, data: string) => void;
  readFile?: (path: string) => string;
  chown?: (path: string, uid: number, gid: number) => void;
  agentUid?: (agent: string) => number;
}

export interface WriteAgentTokenFileArgs {
  /** Resolved agents dir, e.g. `~/.switchroom/agents`. */
  agentsDir: string;
  /** Agent slug (already validated by the wire schema). */
  agent: string;
  /** The exact token string to publish. */
  token: string;
}

export interface WriteAgentTokenFileResult {
  /** Absolute path that was written. */
  tokenPath: string;
  /**
   * Non-fatal ownership-repair warning, or null. Only populated when the
   * file had to be CREATED (fresh agent / dev host without the pre-created
   * mount source) and the follow-up chown failed. On the normal in-place
   * path the inode — and therefore its ownership — is untouched, so no
   * chown is required at all.
   */
  chownWarning: string | null;
}

/**
 * Publish `token` to `<agentsDir>/<agent>/.vault-token`, in place.
 *
 * @throws {TokenFileWriteError} if the directory cannot be created, the
 *   write fails (`EBUSY`, `EISDIR`, `EACCES`, `ENOSPC`, …), or the bytes do
 *   not read back identical.
 */
export function writeAgentTokenFile(
  args: WriteAgentTokenFileArgs,
  deps: WriteAgentTokenFileDeps = {},
): WriteAgentTokenFileResult {
  const { agentsDir, agent, token } = args;

  const mkdir = deps.mkdir ?? ((p: string) => { mkdirSync(p, { recursive: true }); });
  // Default flag for writeFileSync is "w" = O_CREAT|O_TRUNC|O_WRONLY — an
  // in-place truncating write that preserves the inode when the file
  // already exists. `mode` only applies on creation, which is what we want:
  // an existing agent-owned 0600 file keeps its own mode.
  const writeFile =
    deps.writeFile ?? ((p: string, d: string) => { writeFileSync(p, d, { mode: 0o600 }); });
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const chown = deps.chown ?? ((p: string, uid: number, gid: number) => { chownSync(p, uid, gid); });
  const agentUid = deps.agentUid ?? allocateAgentUid;

  const tokenDir = join(agentsDir, agent);
  const tokenPath = join(tokenDir, ".vault-token");

  try {
    mkdir(tokenDir);
  } catch (err) {
    throw new TokenFileWriteError(
      tokenPath,
      `cannot create agent token dir ${tokenDir}: ${errText(err)}`,
      { cause: err },
    );
  }

  // Did the file already exist? Decides whether an ownership repair is
  // needed afterwards (an existing inode keeps its owner through O_TRUNC).
  let preExisting: boolean;
  try {
    readFile(tokenPath);
    preExisting = true;
  } catch {
    preExisting = false;
  }

  try {
    writeFile(tokenPath, token);
  } catch (err) {
    throw new TokenFileWriteError(
      tokenPath,
      `cannot write token file ${tokenPath}: ${errText(err)}`,
      { cause: err },
    );
  }

  // Read back. The whole point of #3751 is that a write we merely *believe*
  // happened is worse than no write: verify the bytes are actually on disk
  // before the caller is allowed to report success.
  let onDisk: string;
  try {
    onDisk = readFile(tokenPath);
  } catch (err) {
    throw new TokenFileWriteError(
      tokenPath,
      `token file ${tokenPath} is unreadable after write: ${errText(err)}`,
      { cause: err },
    );
  }
  if (onDisk !== token) {
    throw new TokenFileWriteError(
      tokenPath,
      `token file ${tokenPath} did not verify after write ` +
        `(${onDisk.length} bytes on disk, ${token.length} expected)`,
    );
  }

  let chownWarning: string | null = null;
  if (!preExisting) {
    // Only the create path needs this. The broker runs as root, so a file
    // it created lands root:root and the agent — which reads the token from
    // inside its own container as its own uid — could not open it.
    // CAP_CHOWN is granted to the broker (compose.ts cap_add); dev hosts
    // without it degrade to a warning rather than failing the mint, because
    // the token is still returned over IPC.
    try {
      const uid = agentUid(agent);
      chown(tokenPath, uid, uid);
    } catch (err) {
      chownWarning =
        `token file ${tokenPath} created but chown to the agent UID failed: ` +
        `${errText(err)} (CAP_CHOWN missing?)`;
    }
  }

  return { tokenPath, chownWarning };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
