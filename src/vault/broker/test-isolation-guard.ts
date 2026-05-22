/**
 * test-isolation-guard — keeps a vault/broker test from touching the
 * operator's PRODUCTION state tree (`~/.switchroom/`).
 *
 * Background: on 2026-05-22 a broker test running on the live host
 * resolved its vault path to the default `~/.switchroom/vault/vault.enc`
 * and a `put` re-encrypted the whole 414-byte fixture vault over the
 * operator's real 77-key vault. See "Vault & shared-state test
 * discipline" in CLAUDE.md.
 *
 * Policy: **redirect, don't throw.** Under the test runner, a vault or
 * audit-log path that resolves into the real `~/.switchroom` tree is
 * silently redirected to an isolated tmpdir (with a one-time stderr
 * warning). A throw would fail dozens of pre-existing mis-isolated
 * broker tests for no safety gain — redirection makes mis-isolation
 * *harmless* instead of *catastrophic*, which is the actual goal. The
 * CLAUDE.md directive remains the human-facing teaching; this module is
 * the safety net.
 *
 * Every check is a no-op outside the test runner — production is
 * untouched. `SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST=1` disables it for
 * the rare test that genuinely must use the real tree.
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** True when running under vitest (`VITEST`) or any `NODE_ENV=test` runner. */
export function isTestRuntime(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
}

/** Escape hatch for the rare test that genuinely must use the real tree. */
function escapeHatchSet(): boolean {
  return process.env.SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST === "1";
}

/**
 * Absolute path to the operator's real `~/.switchroom` dir, resolved
 * from `os.homedir()` at call time — so a test that overrides `$HOME`
 * to a tmpdir is correctly seen as already isolated.
 */
function realSwitchroomHome(): string {
  return resolve(homedir(), ".switchroom");
}

/** True if `p` is the real `~/.switchroom` dir or a path inside it. */
export function isUnderRealSwitchroomHome(p: string): boolean {
  const home = realSwitchroomHome();
  const r = resolve(p);
  return r === home || r.startsWith(home + sep);
}

let warnedVault = false;

/**
 * Given the vault path a broker resolved, return a safe one. Outside
 * the test runner — or for a path already outside `~/.switchroom` — the
 * path is returned unchanged. Under the test runner a path inside the
 * real `~/.switchroom` tree is redirected to a FRESH per-call tmpdir,
 * so a mis-isolated broker can neither read nor clobber the operator's
 * live vault. A fresh dir per call keeps two brokers in two tests from
 * colliding on one file.
 */
export function safeVaultPath(requestedPath: string): string {
  if (!isTestRuntime() || escapeHatchSet()) return requestedPath;
  if (!isUnderRealSwitchroomHome(requestedPath)) return requestedPath;
  const redirected = join(
    mkdtempSync(join(tmpdir(), "sw-test-vault-")),
    "vault.enc",
  );
  if (!warnedVault) {
    warnedVault = true;
    process.stderr.write(
      `[test-isolation guard] vault path redirected away from the ` +
        `production tree to an isolated tmpdir — a vault/broker test ` +
        `resolved its vault path inside ~/.switchroom. See CLAUDE.md ` +
        `"Vault & shared-state test discipline".\n`,
    );
  }
  return redirected;
}

let warnedAudit = false;
let cachedTmpAuditLog: string | undefined;

/**
 * Given the audit-log path a caller wants, return a safe one. Outside
 * the test runner — or for a path already outside `~/.switchroom` — the
 * path is returned unchanged. Under the test runner a would-be-
 * production path is redirected to a per-process tmp file, so a broker
 * constructed without an explicit `_testAuditLogger` cannot pollute the
 * operator's real `vault-audit.log` (or desync its tamper-evident hash
 * chain). One shared file per process is fine here — the audit log is
 * append-only telemetry, not per-test state.
 */
export function safeAuditLogPath(requestedPath: string): string {
  if (!isTestRuntime() || escapeHatchSet()) return requestedPath;
  if (!isUnderRealSwitchroomHome(requestedPath)) return requestedPath;
  if (!cachedTmpAuditLog) {
    cachedTmpAuditLog = join(
      mkdtempSync(join(tmpdir(), "sw-test-audit-")),
      "vault-audit.log",
    );
  }
  if (!warnedAudit) {
    warnedAudit = true;
    process.stderr.write(
      `[test-isolation guard] audit log redirected away from the ` +
        `production path to ${cachedTmpAuditLog} — a broker was ` +
        `constructed without _testAuditLogger. See CLAUDE.md ` +
        `"Vault & shared-state test discipline".\n`,
    );
  }
  return cachedTmpAuditLog;
}
