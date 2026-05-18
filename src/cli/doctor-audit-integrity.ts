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

export type CheckStatus = "ok" | "warn" | "fail";

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
}

interface LogTarget {
  label: string;
  path: string;
}

function rootWrittenLogs(home: string): LogTarget[] {
  return [
    { label: "vault-broker", path: join(home, ".switchroom", "vault-audit.log") },
    {
      label: "hostd",
      path: join(home, ".switchroom", "host-control-audit.log"),
    },
  ];
}

export function runAuditIntegrityChecks(
  deps: AuditIntegrityDeps = {},
): CheckResult[] {
  const home = deps.homeDir ?? homedir();
  const read =
    deps.readFileSync ?? ((p: string) => fsReadFileSync(p, "utf8"));
  const results: CheckResult[] = [];

  for (const { label, path } of rootWrittenLogs(home)) {
    let text: string;
    try {
      text = read(path);
    } catch {
      results.push({
        name: `${label} audit log present`,
        status: "warn",
        detail: `no audit log at ${path} — the ${label} may never have written one, or it was removed (audit-blinding is a cheap pre-attack step; WS10-F3/F4)`,
        fix: `Confirm the ${label} is running and its audit volume is mounted; investigate if the file vanished.`,
      });
      continue;
    }

    if (text.trim().length === 0) {
      results.push({
        name: `${label} audit log non-empty`,
        status: "warn",
        detail: `${path} exists but is empty — expected at least boot/activity rows; an emptied audit trail is the WS10-F3 fail-open symptom`,
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
