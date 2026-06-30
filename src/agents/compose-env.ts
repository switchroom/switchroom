import { existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Path of the compose-adjacent `.env` file for a given compose path. Holds
 * `VOICE_SIDECAR_TOKEN` (written 0600 by the apply-time provisioner) — the
 * value is NOT in the YAML, only here.
 */
export function composeEnvPath(composePath: string): string {
  return dirname(composePath) + "/.env";
}

/**
 * Top-level `docker compose` arguments that load the compose-adjacent `.env`.
 *
 * docker compose only auto-loads a `.env` from its *project directory* (which
 * defaults to the invoking process CWD), NOT from the directory of the `-f`
 * compose file. Every fleet command we run passes `-f <abs path>` with an
 * unrelated CWD, so without this the compose-adjacent `.env` is never read,
 * `${VOICE_SIDECAR_TOKEN}` interpolates to empty, and the voice sidecar 401s
 * every `/stt` (silently degrading to "(voice message)") — #2700.
 *
 * Returns `[]` when the file is absent (cloud hosts emit no sidecar and write
 * no `.env`) so compose never errors on a missing `--env-file`. The flag is a
 * top-level option, so splice the result in BEFORE the subcommand.
 */
export function composeEnvFileArgs(composePath: string): string[] {
  const envPath = composeEnvPath(composePath);
  return existsSync(envPath) ? ["--env-file", envPath] : [];
}
