/**
 * doctor-audit-integrity — WS10-F4 (MEDIUM), audit #1403 / epic #1389.
 *
 * Pre-#1420 `doctor` had ZERO audit-integrity detection: nothing
 * checked that the vault / hostd audit logs are actually being
 * written, haven't been truncated, or — once #1417/#1433 landed the
 * per-row hash chain — that the chain still verifies. Audit-blinding
 * is a cheap pre-attack step (WS10-F3: vault audit fails OPEN), so a
 * silently-empty or rewritten log must surface to the operator.
 *
 * This probe (DI-testable, mirrors doctor-drive.ts /
 * doctor-inlined-secrets.ts) reports per root-written log:
 *   - missing            → warn (no audit trail at all)
 *   - empty              → warn (audit-blinding / F3 fail-open symptom)
 *   - present, unchained → warn, ACTIONABLE: deploy the post-#1433
 *     broker/hostd image to enable tamper-evidence (NOT a fail — a
 *     pre-chain legacy log is expected during the rollout window)
 *   - chained + valid    → ok
 *   - chained + BROKEN   → fail (tamper signal: a row was edited,
 *     deleted, reordered, or the head truncated)
 *
 * Scope note: this is the F4 *detection* half. F3 (a configurable
 * fail-closed secret-release mode + the fail-open counter) and F5
 * (proactive integrity events) are the higher-risk / cross-cutting
 * follow-up (tracked on #1420) — deliberately not bundled.
 */

import { readFileSync as fsReadFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { verifyAuditLog } from "../util/audit-hashchain.js";
import { resolveRotationConfig } from "../util/log-rotation.js";
import {
  DEFAULT_HOSTD_AUDIT_MAX_BYTES,
  DEFAULT_HOSTD_AUDIT_MAX_FILES,
} from "../host-control/audit-rotation-config.js";
import {
  failOpenStatePath,
  readFailOpenState,
  DEFAULT_AUDIT_MAX_BYTES,
  DEFAULT_AUDIT_MAX_FILES,
  type FailOpenState,
} from "../vault/broker/audit-log.js";

import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface AuditIntegrityDeps {
  /** Override the home dir used to resolve default log paths. */
  homeDir?: string;
  /** Reads a log file's text. Defaults to fs.readFileSync; a thrown
   *  ENOENT is treated as "missing". */
  readFileSync?: (p: string) => string;
  /**
   * Reads the vault-broker fail-open counter sidecar (sec WS10-F3 / #1420).
   * Defaults to the real `readFailOpenState`; injectable for tests. Returns
   * a zeroed state when the sidecar is absent/unreadable.
   */
  readFailOpenState?: (statePath: string) => FailOpenState;
}

interface LogTarget {
  label: string;
  path: string;
  /** Rotated generations (`<path>.1` … `.N`) this log retains — resolved
   *  from the writer's own config so a raised retention is still fully
   *  verified (#3600). */
  maxFiles: number;
}

function rootWrittenLogs(home: string): LogTarget[] {
  return [
    {
      label: "vault-broker",
      path: join(home, ".switchroom", "vault-audit.log"),
      maxFiles: resolveRotationConfig({
        envBytesVar: "SWITCHROOM_VAULT_AUDIT_MAX_BYTES",
        envFilesVar: "SWITCHROOM_VAULT_AUDIT_MAX_FILES",
        defaultBytes: DEFAULT_AUDIT_MAX_BYTES,
        defaultFiles: DEFAULT_AUDIT_MAX_FILES,
      }).maxFiles,
    },
    {
      label: "hostd",
      path: join(home, ".switchroom", "host-control-audit.log"),
      maxFiles: resolveRotationConfig({
        envBytesVar: "SWITCHROOM_HOSTD_AUDIT_MAX_BYTES",
        envFilesVar: "SWITCHROOM_HOSTD_AUDIT_MAX_FILES",
        defaultBytes: DEFAULT_HOSTD_AUDIT_MAX_BYTES,
        defaultFiles: DEFAULT_HOSTD_AUDIT_MAX_FILES,
      }).maxFiles,
    },
  ];
}

/**
 * Concatenate the log's retained history OLDEST-first: `<path>.N` … `.1`
 * then the active file. An absent generation is skipped rather than
 * ending the walk, so a gap (a crashed rotation, an operator deleting one
 * file) still gets the surviving generations verified.
 *
 * Returns the combined text plus the paths that actually contributed —
 * an empty `sources` means "nothing on disk at all", which is the
 * genuinely missing case.
 */
function readRetainedHistory(
  read: (p: string) => string,
  path: string,
  maxFiles: number,
): { text: string; sources: string[] } {
  const parts: { path: string; text: string }[] = [];
  for (let n = maxFiles; n >= 1; n--) {
    const gen = `${path}.${n}`;
    let t: string;
    try {
      t = read(gen);
    } catch {
      continue; // absent generation — older ones may still exist
    }
    parts.push({ path: gen, text: t });
  }
  try {
    parts.push({ path, text: read(path) });
  } catch {
    /* active file absent — rotated generations (if any) still count */
  }
  const text = parts
    .map((p) => (p.text.endsWith("\n") || p.text.length === 0 ? p.text : p.text + "\n"))
    .join("");
  return { text, sources: parts.map((p) => p.path) };
}

export function runAuditIntegrityChecks(
  deps: AuditIntegrityDeps = {},
): CheckResult[] {
  const home = deps.homeDir ?? homedir();
  const read =
    deps.readFileSync ?? ((p: string) => fsReadFileSync(p, "utf8"));
  const readFailOpen = deps.readFailOpenState ?? readFailOpenState;
  const results: CheckResult[] = [];

  // sec WS10-F3 / #1420 — the vault-broker fail-open counter. A non-zero
  // count means at least one secret release happened (fail-open) or was
  // DENIED (fail-closed) while its audit append failed — a durable signal
  // the operator must not miss. The count lives in a sidecar beside the
  // vault-broker audit log so a failed append doesn't recursively fail to
  // record itself.
  const vaultAuditLog = join(home, ".switchroom", "vault-audit.log");
  const failOpen = readFailOpen(failOpenStatePath(vaultAuditLog));
  if (failOpen.failOpenCount > 0) {
    const when = failOpen.lastFailureTs ? ` (last at ${failOpen.lastFailureTs})` : ``;
    const why = failOpen.lastError ? ` — last error: ${failOpen.lastError}` : ``;
    results.push({
      name: "vault-broker audit fail-open counter",
      status: "warn",
      detail: `${failOpen.failOpenCount} audit append(s) failed${when}${why}. Each failure meant a secret release was either NOT durably audited (fail-open) or denied (fail-closed) — investigate the audit volume (mount/permissions/disk) before trusting recent access records (WS10-F3).`,
      fix: `Check the vault-broker's audit volume is mounted, writable, and not full; review vault-broker stderr for '[vault-audit] ERROR' lines. Once healed, reset the counter by removing ${failOpenStatePath(vaultAuditLog)}.`,
    });
  } else {
    results.push({
      name: "vault-broker audit fail-open counter",
      status: "ok",
      detail: `no failed audit appends recorded (every secret release was durably audited)`,
    });
  }

  for (const { label, path, maxFiles } of rootWrittenLogs(home)) {
    // #3600 review, finding 2 — BOTH root-written logs are size-rotated
    // now, so verifying only the active file would silently shrink this
    // tamper check to the current generation: after the first rotation
    // doctor would report "ok" while attesting nothing about the ~96 MiB
    // sitting in `.1`-`.3`. Verify the whole RETAINED history,
    // oldest-first, so the chain is checked exactly as it was written.
    const { text, sources } = readRetainedHistory(read, path, maxFiles);

    if (sources.length === 0) {
      results.push({
        name: `${label} audit log present`,
        status: "warn",
        detail: `no audit log at ${path} (nor any rotated generation) — the ${label} may never have written one, or it was removed (audit-blinding is a cheap pre-attack step; WS10-F3/F4)`,
        fix: `Confirm the ${label} is running and its audit volume is mounted; investigate if the file vanished.`,
      });
      continue;
    }

    if (text.trim().length === 0) {
      // An empty ACTIVE file is normal for a few ms after a rotation (and
      // persists if the triggering append then fails), so this only fires
      // when every retained generation is empty too — which really is the
      // fail-open / audit-blinding symptom.
      results.push({
        name: `${label} audit log non-empty`,
        status: "warn",
        detail: `${sources.join(", ")} exist but are empty — expected at least boot/activity rows; an emptied audit trail is the WS10-F3 fail-open symptom`,
        fix: `Investigate whether audit writes are failing (check ${label} stderr) and whether the file was truncated.`,
      });
      continue;
    }

    const v = verifyAuditLog(text);
    const preamble =
      v.legacyRows > 0
        ? `${v.legacyRows} pre-#1433 legacy preamble row(s) + `
        : ``;
    const restarts =
      v.segments > 1
        ? ` across ${v.segments} segment(s) (${v.segments - 1} broker restart re-anchor(s))`
        : ``;

    if (v.state === "legacy") {
      results.push({
        name: `${label} audit tamper-evidence`,
        status: "warn",
        detail: `${path} is present but NO rows are hash-chained — this is a pre-#1433 legacy log; tamper-evidence is inactive until the post-#1433 ${label} image is deployed`,
        fix: `Run \`switchroom update\` to roll the ${label} image forward (#1433 added the chain). Expected during the rollout window; not itself a tamper signal.`,
      });
    } else if (v.state === "ok") {
      results.push({
        name: `${label} audit chain valid`,
        status: "ok",
        detail: `${preamble}${v.chainedRows} hash-chained row(s)${restarts}, every row self-consistent (tamper-evidence active)`,
      });
    } else {
      // state === "tampered": a chained row's _hash ≠ recompute (or a
      // non-JSON / chain-stripped row inside the chained region). A
      // broker restart can NEVER cause this (its re-anchored rows are
      // still self-hashed) — so this is a genuine WS10-F2 signal, not
      // a benign re-anchor.
      results.push({
        name: `${label} audit chain BROKEN`,
        status: "fail",
        detail: `${path}: tamper detected at file line ${v.brokenAtLine} — ${v.reason} (WS10-F2: a row was forensically rewritten). ${preamble}${v.chainedRows} prior chained row(s) verified.`,
        fix: `Treat the ${label} audit trail as compromised at/after file line ${v.brokenAtLine}. Preserve the file for forensics; investigate host/broker compromise before trusting subsequent rows.`,
      });
    }
  }

  return results;
}
