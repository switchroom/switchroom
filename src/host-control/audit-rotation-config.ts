/**
 * Rotation constants for `~/.switchroom/host-control-audit.log`.
 *
 * Their own module (not `server.ts`) so the pure reader — `audit-reader.ts`,
 * imported by the CLI, the web API and the MCP server — can derive its
 * generation walk from the SAME values the writer uses without pulling the
 * hostd daemon into those bundles. #3600 review, finding 6: the reader
 * previously hand-mirrored `3`, so `SWITCHROOM_HOSTD_AUDIT_MAX_FILES=6`
 * wrote six generations and read three.
 */

/**
 * Rotation cap: 32 MiB, the same threshold the vault broker's audit log
 * uses (`DEFAULT_AUDIT_MAX_BYTES`). Rows here are fatter than the
 * broker's (~4 KiB with redacted terminal tails vs ~300 B), so this is
 * ~8k rows per generation. The live host reached 44,325,086 bytes
 * unrotated before this existed. Env: `SWITCHROOM_HOSTD_AUDIT_MAX_BYTES`
 * (negative disables rotation).
 */
export const DEFAULT_HOSTD_AUDIT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Rotated generations retained: `.1` … `.3`. Total on-disk hostd audit
 * history is bounded at ~(3 + 1) × 32 MiB = 128 MiB. Env:
 * `SWITCHROOM_HOSTD_AUDIT_MAX_FILES`.
 */
export const DEFAULT_HOSTD_AUDIT_MAX_FILES = 3;
