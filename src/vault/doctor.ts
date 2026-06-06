/**
 * vault-doctor — pure-functional health checks for the vault security model.
 *
 * All checks accept injected inputs so they are testable without I/O.
 * The CLI in src/cli/vault-doctor.ts handles loading + calling these.
 */

export type DiagnosticLevel = "ok" | "warn" | "fail" | "info";

export interface Diagnostic {
  level: DiagnosticLevel;
  check: string;
  message: string;
  /** Actionable hint shown below the message. */
  fix?: string;
}

// Regex for sensitive-looking key names.
//
// Each keyword requires `(?![a-zA-Z])` after it — the next character
// must NOT be an ASCII letter. This permits snake_case / kebab-case
// suffixes (`db_password`, `auth_token`, `secret-key`) while excluding
// false positives where the keyword is a prefix of a benign word
// (`tokenizer-config` → `token` followed by `i` → no match).
//
// Plural forms (`passwords`, `secrets`) miss this filter but are rare
// in practice for vault key names — operators typically store one
// secret per key, not collections.
const SENSITIVE_KEY_RE =
  /oauth(?![a-zA-Z])|token(?![a-zA-Z])|secret(?![a-zA-Z])|api[-_]?key(?![a-zA-Z])|password(?![a-zA-Z])/i;

/**
 * True when a vault VALUE looks like a public identifier — digits, optionally
 * grouped with spaces or dashes (account/customer IDs, phone numbers, numeric
 * handles) — rather than a high-entropy secret.
 *
 * These are the values an agent often must pass *literally* in a tool call,
 * at which point the secret-guard PreToolUse hook blocks them: that hook
 * matches stored vault values verbatim and cannot tell a public ID from a
 * token. Such a value almost never belongs in the vault — it belongs in
 * plain config. We bound the length so a long all-numeric secret (rare) does
 * not trip the heuristic, and require >= 8 digits so we only flag values the
 * hook would actually guard (its MIN_VALUE_LENGTH_TO_GUARD is 8).
 */
export function looksLikeIdentifierValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 8 || v.length > 24) return false;
  // Only digits and group separators (space / dash), digit-bounded.
  if (!/^[0-9][0-9 -]*[0-9]$/.test(v)) return false;
  const digitCount = v.replace(/[^0-9]/g, "").length;
  return digitCount >= 8;
}

/**
 * Input shape for analyseVaultHealth.
 *
 * All fields are optional so callers can provide only what they have
 * (e.g. vault passphrase unavailable → vaultKeys undefined).
 */
export interface VaultHealthInput {
  /**
   * Keys currently in the vault, keyed by name.
   * undefined means the vault could not be opened (passphrase not set, etc.).
   */
  vaultKeys?: Record<
    string,
    {
      /** Per-entry scope, if set. */
      scope?: { allow?: string[]; deny?: string[] };
      /**
       * True when the entry's VALUE looks like a public identifier (digits,
       * optionally dash/space-grouped) rather than a secret. Computed by the
       * CLI via looksLikeIdentifierValue() so raw values never enter this
       * pure layer. Drives the identifier-stored-as-secret warning.
       */
      looksLikeIdentifier?: boolean;
    }
  >;

  /**
   * Agent/schedule configuration, keyed by agent name.
   * Each agent has a schedule array; each schedule entry has a secrets array.
   */
  agentSchedules: Record<
    string,
    Array<{ secrets?: string[] }>
  >;

  /**
   * Whether the broker is configured to be enabled in switchroom.yaml.
   */
  brokerConfigured: boolean;

  /**
   * Whether the broker is currently reachable on its Unix socket.
   * true = reachable (running), false = not reachable, undefined = unknown.
   */
  brokerRunning: boolean | undefined;
}

/**
 * Analyse vault health and return a list of diagnostics.
 *
 * No I/O — accepts pre-loaded inputs and returns Diagnostic records.
 * Ordering: fails first, then warns, then info.
 */
export function analyseVaultHealth(input: VaultHealthInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // ── Broker configured but not running ─────────────────────────────────
  if (input.brokerConfigured && input.brokerRunning === false) {
    diagnostics.push({
      level: "fail",
      check: "broker-running",
      message: "Vault broker is configured but not running.",
      fix: "Run `switchroom vault broker unlock` or check the broker container with `docker ps`",
    });
  }

  if (input.vaultKeys !== undefined) {
    // ── Collect all keys referenced in schedule secrets[] ─────────────
    const referencedKeys = new Set<string>();
    const missingKeys: Array<{ agent: string; index: number; key: string }> = [];

    for (const [agentName, schedule] of Object.entries(input.agentSchedules)) {
      for (let i = 0; i < schedule.length; i++) {
        const secrets = schedule[i].secrets ?? [];
        for (const key of secrets) {
          referencedKeys.add(key);
          if (!(key in input.vaultKeys)) {
            missingKeys.push({ agent: agentName, index: i, key });
          }
        }
      }
    }

    // ── Crons referencing keys that don't exist in the vault ──────────
    if (missingKeys.length > 0) {
      const details = missingKeys
        .map((m) => `  ${m.agent}/schedule[${m.index}]: '${m.key}'`)
        .join("\n");
      diagnostics.push({
        level: "fail",
        check: "missing-vault-keys",
        message:
          `${missingKeys.length} key(s) referenced in schedule secrets[] do not exist in the vault:\n${details}`,
        fix: "Run `switchroom vault set <key>` for each missing key, or remove it from secrets[]",
      });
    }

    // ── Sensitive keys without a scope ───────────────────────────────
    const unscopedSensitive: string[] = [];
    for (const [keyName, entry] of Object.entries(input.vaultKeys)) {
      if (!SENSITIVE_KEY_RE.test(keyName)) continue;
      const hasScope =
        (entry.scope?.allow?.length ?? 0) > 0 ||
        (entry.scope?.deny?.length ?? 0) > 0;
      if (!hasScope) {
        unscopedSensitive.push(keyName);
      }
    }

    if (unscopedSensitive.length > 0) {
      const keyList = unscopedSensitive.map((k) => `  ${k}`).join("\n");
      diagnostics.push({
        level: "warn",
        check: "sensitive-keys-unscoped",
        message:
          `${unscopedSensitive.length} sensitive-looking key(s) have no per-key ACL:\n${keyList}`,
        fix: "Consider `switchroom vault set <key> --allow <agent>` to restrict access",
      });
    }

    // ── Public identifiers stored as secrets ─────────────────────────
    // A value that looks like an account/customer ID, not a token. If an
    // agent must pass it in a tool call, the secret-guard PreToolUse hook
    // blocks it (it matches stored values verbatim and can't tell a public
    // ID from a secret) — so such values belong in plain config, not here.
    const identifierKeys: string[] = [];
    for (const [keyName, entry] of Object.entries(input.vaultKeys)) {
      if (entry.looksLikeIdentifier) identifierKeys.push(keyName);
    }

    if (identifierKeys.length > 0) {
      const keyList = identifierKeys.map((k) => `  ${k}`).join("\n");
      diagnostics.push({
        level: "warn",
        check: "identifier-stored-as-secret",
        message:
          `${identifierKeys.length} vault key(s) hold an identifier-like value (digits only):\n${keyList}\n` +
          `If an agent must pass one of these in a tool call, the secret-guard hook will block it — it cannot tell a public ID from a secret.`,
        fix: "If the value is a public identifier (account/customer ID), remove it from the vault and pass it as plain config (e.g. hardcode it in the MCP launcher). If it is genuinely secret, ignore this.",
      });
    }

    // ── Vault keys not referenced anywhere ───────────────────────────
    const unreferencedKeys: string[] = [];
    for (const keyName of Object.keys(input.vaultKeys)) {
      if (!referencedKeys.has(keyName)) {
        unreferencedKeys.push(keyName);
      }
    }

    if (unreferencedKeys.length > 0) {
      const keyList = unreferencedKeys.map((k) => `  ${k}`).join("\n");
      diagnostics.push({
        level: "info",
        check: "unreferenced-vault-keys",
        message:
          `${unreferencedKeys.length} vault key(s) are not referenced in any schedule secrets[]:\n${keyList}`,
        fix: "These keys are candidates for cleanup (`switchroom vault remove <key>`) if no longer needed",
      });
    }
  }

  // If no issues found, emit a single ok diagnostic.
  if (diagnostics.length === 0) {
    diagnostics.push({
      level: "ok",
      check: "vault-health",
      message: "Vault health looks good.",
    });
  }

  return diagnostics;
}
