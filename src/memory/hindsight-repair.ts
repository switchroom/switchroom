/**
 * Reachability for hindsight 0.8.5's `hindsight-admin repair-bank`.
 *
 * ## The failure this exists for
 *
 * Hindsight creates its per-(bank, fact_type) partial vector indexes when a
 * bank is first created — instant, because the bank is empty. A bank that
 * arrives ALREADY POPULATED never takes that path: logical restore, a
 * cross-version upgrade, a vector-extension switch. Recall on such a bank does
 * not fail. It falls back to a global index plus a post-filter and quietly
 * under-returns.
 *
 * The fleet ran that way. Seven banks returned 0–4 semantic candidates out of
 * 100 for roughly three months and nothing in switchroom noticed, because
 * every surface that could have noticed was checking liveness, not coverage.
 * Upstream closed the detection/repair half in 0.8.5
 * (vectorize-io/hindsight#2645) with `repair-bank`, which rebuilds missing OR
 * invalid coverage using `CREATE INDEX CONCURRENTLY`.
 *
 * A backend capability nobody can reach is the same as not having it. The
 * command lives inside the container's venv at a path no operator would guess,
 * so this module is the reachable surface: `switchroom memory repair`.
 *
 * ## Why a first-class verb and not a passthrough or a doctor auto-fix
 *
 * - **Not a raw passthrough** (`switchroom memory admin -- …`). A passthrough
 *   is undiscoverable — you have to already know `repair-bank` exists to type
 *   it, which is the exact condition that let the outage run for three months.
 *   It also cannot preflight: against a pre-0.8.5 server a passthrough yields
 *   typer's `No such command 'repair-bank'`, which reads like a typo rather
 *   than "your image is too old". {@link classifyRepairPreflight} turns that
 *   into the real sentence.
 * - **Not a doctor auto-fix.** `doctor` is a read-only diagnostic and must stay
 *   that way; `CREATE INDEX CONCURRENTLY` across every bank is a mutation on a
 *   live database and deserves explicit operator intent. Doctor's job is to say
 *   "coverage is missing, run `switchroom memory repair --all`" — the split
 *   between detection and repair, not the merger of them.
 *
 * The argv builder and the output parser are pure so they can be tested
 * without a container.
 */
import { HINDSIGHT_MIN_API_VERSION } from "./hindsight-tools.js";

/** Default name of the local hindsight container. */
export const HINDSIGHT_CONTAINER_NAME = "switchroom-hindsight";

/**
 * Absolute path to the admin CLI inside the image. It is installed into the
 * API's venv and is NOT on the container's default PATH (verified 2026-07-27:
 * `command -v hindsight-admin` is empty in a running `switchroom-hindsight`),
 * so the absolute path is the reliable form. We still prefer PATH when it
 * resolves, in case a future image puts it there.
 */
export const HINDSIGHT_ADMIN_BIN = "/app/api/.venv/bin/hindsight-admin";

export interface RepairBankOptions {
  /** Repair a single bank by id. Mutually exclusive with `all`. */
  bank?: string;
  /** Repair every bank in the base schema plus discovered tenant schemas. */
  all?: boolean;
  /** Limit to a single schema (defaults to base + discovered tenant schemas). */
  schema?: string;
  /** Report what would change without creating or dropping any index. */
  dryRun?: boolean;
  /** Override the container name (defaults to `switchroom-hindsight`). */
  container?: string;
}

/**
 * Pure: build the full `docker` argv for a repair-bank run.
 *
 * Throws on an option combination upstream would reject with exit 2, so the
 * error arrives before we spawn anything.
 *
 * The `sh -c … --` shape passes user-supplied values as positional args
 * (`"$@"`), never interpolated into the shell string — a bank id or schema
 * name containing a quote or `;` cannot become shell syntax.
 */
export function buildRepairBankArgv(opts: RepairBankOptions): string[] {
  const hasBank = typeof opts.bank === "string" && opts.bank.length > 0;
  if (hasBank === Boolean(opts.all)) {
    throw new Error("pass exactly one of --bank <id> or --all");
  }

  const cmdArgs: string[] = ["repair-bank"];
  if (hasBank) cmdArgs.push("--bank", opts.bank as string);
  if (opts.all) cmdArgs.push("--all");
  if (opts.schema) cmdArgs.push("--schema", opts.schema);
  if (opts.dryRun) cmdArgs.push("--dry-run");

  const script =
    `if command -v hindsight-admin >/dev/null 2>&1; then exec hindsight-admin "$@"; fi; ` +
    `exec ${HINDSIGHT_ADMIN_BIN} "$@"`;

  return [
    "exec",
    opts.container ?? HINDSIGHT_CONTAINER_NAME,
    "sh",
    "-c",
    script,
    "--",
    ...cmdArgs,
  ];
}

/**
 * Exit code for `switchroom memory repair --dry-run` when coverage IS missing.
 *
 * Distinct from 1 (the repair itself failed) so a health script can tell
 * "needs repair" from "repair broke". A dry run that found gaps must not exit
 * 0: the only other way to know is to read the prose, and prose being the only
 * signal is how three months of degraded recall went unnoticed.
 */
export const REPAIR_COVERAGE_MISSING_EXIT = 2;

/** Totals from repair-bank's final `Done:` line. */
export interface RepairSummary {
  schemas: number;
  banksScanned: number;
  alreadyPresent: number;
  created: number;
  toCreate: number;
  failed: number;
}

/**
 * Pure: parse repair-bank's terminal summary line.
 *
 *   `Done: 2 schema(s), 14 bank(s) scanned, 40 already present, 6 created, 0 to-create (dry-run), 0 failed`
 *
 * Returns null when the line is absent — which is itself meaningful: the
 * command exited before reaching it (backend without per-bank indexes, missing
 * database URL, crash). Callers must not treat a null as success.
 */
export function parseRepairSummary(stdout: string): RepairSummary | null {
  const m = stdout.match(
    /Done:\s*(\d+)\s+schema\(s\),\s*(\d+)\s+bank\(s\) scanned,\s*(\d+)\s+already present,\s*(\d+)\s+created,\s*(\d+)\s+to-create \(dry-run\),\s*(\d+)\s+failed/,
  );
  if (!m) return null;
  return {
    schemas: Number(m[1]),
    banksScanned: Number(m[2]),
    alreadyPresent: Number(m[3]),
    created: Number(m[4]),
    toCreate: Number(m[5]),
    failed: Number(m[6]),
  };
}

/**
 * Pure: compare two dotted numeric version strings.
 *
 * Returns <0 when `a` precedes `b`, 0 when equal, >0 when `a` follows `b`.
 * Missing components count as 0 (`"0.9"` === `"0.9.0"`). A trailing
 * non-numeric suffix (`"0.8.5rc1"`, `"0.8.5-dev"`) is ignored on that
 * component, so a pre-release compares equal to its release rather than
 * sorting arbitrarily — deliberately lenient, because the consumer is a
 * warning and a false alarm on an operator's dev build is worse than a miss.
 */
export function compareApiVersion(a: string, b: string): number {
  const part = (v: string, i: number): number => {
    const raw = v.split(".")[i];
    if (raw === undefined) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const len = Math.max(a.split(".").length, b.split(".").length);
  for (let i = 0; i < len; i++) {
    const d = part(a, i) - part(b, i);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Best-effort: read the live server's `api_version` from `GET <origin>/version`.
 *
 * Derives the origin from the MCP url the same way the /health probe does.
 * Returns null on any failure (unreachable, non-200, unparseable, no
 * `api_version` field) — callers decide what an unknown version means, and
 * every current caller degrades rather than blocking.
 */
export async function fetchHindsightApiVersion(
  mcpUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const origin = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await doFetch(`${origin}/version`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { api_version?: unknown };
    return typeof body?.api_version === "string" ? body.api_version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface RepairPreflight {
  ok: boolean;
  /** Operator-facing reason when `ok` is false. */
  reason?: string;
}

/**
 * Pure: decide whether `repair-bank` can run against the live server.
 *
 * `liveVersion === null` means the version probe failed. We proceed anyway:
 * refusing on an unknown version would make the escape hatch unavailable in
 * exactly the degraded state it exists for, and upstream's own arg validation
 * is the real backstop. Only a *confirmed* older version blocks.
 */
export function classifyRepairPreflight(liveVersion: string | null): RepairPreflight {
  if (liveVersion === null) return { ok: true };
  if (compareApiVersion(liveVersion, HINDSIGHT_MIN_API_VERSION) < 0) {
    return {
      ok: false,
      reason:
        `hindsight ${liveVersion} has no \`repair-bank\` command — it lands in ` +
        `${HINDSIGHT_MIN_API_VERSION} (upstream #2645). Without it there is no ` +
        `supported way to rebuild a bank's vector-index coverage. Update the ` +
        `pinned image in docker/Dockerfile.hindsight and recreate the container ` +
        `with \`switchroom memory --update\`, then re-run this command.`,
    };
  }
  return { ok: true };
}
