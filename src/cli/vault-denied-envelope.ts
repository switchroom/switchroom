/**
 * Emit a structured `error_envelope` JSON line for a VAULT-BROKER-DENIED
 * stderr event (#1770 Phase 3 of the #1758 error-envelope rollout).
 *
 * Sibling of the legacy `VAULT-BROKER-DENIED [<code>]: <msg>` stderr
 * line — the legacy line is kept byte-identical for any decoder (audit
 * reader, gateway response handler) still string-matching the old
 * form. Structured consumers parse the second line which is a single-
 * line JSON object prefixed with `ERROR-ENVELOPE:` for easy grep-
 * and-slice. The sentinel is deliberately distinct from the legacy
 * `VAULT-BROKER-DENIED` prefix so a loose `/^VAULT-BROKER-DENIED/`
 * decoder regex can't accidentally match the envelope line and try
 * to parse `ENVELOPE: {...}` as a legacy code (#1777). The
 * `ERROR-ENVELOPE:` name is also canonical — reusable across any
 * future envelope-emitting CLI without a per-domain prefix.
 *
 * The envelope's `fix.kind` is always `request_vault_grant` with
 * `vault_key` populated from the denial context — that's the unlock-
 * card hint the gateway's auto-resume flow consumes.
 *
 * Schema-aligned with `ErrorEnvelopeSchema` in
 * `src/host-control/protocol.ts` (single source of truth). The shape
 * is constructed inline rather than imported as a type because that
 * module re-exports zod schemas; the type alias would carry trivial
 * weight either way. End-to-end conformance is verified by the test
 * (`vault-denied-envelope.test.ts`) which `safeParse`s the emitted
 * line against the canonical schema.
 *
 * Split out of `vault.ts` so unit tests don't pull in the broker
 * client / sqlite-backed grants store via transitive imports.
 */
/**
 * Stderr line prefix for structured error envelopes. Canonical across
 * all envelope-emitting CLIs — chosen to NOT share a prefix with any
 * legacy domain-specific sentinel (e.g. `VAULT-BROKER-DENIED`) so a
 * loose decoder regex can't cross-match.
 */
export const ENVELOPE_SENTINEL = "ERROR-ENVELOPE:";

export function writeVaultDeniedEnvelope(
  vaultKey: string,
  brokerCode: string,
  human: string,
): void {
  const envelope = {
    v: 1 as const,
    code: "VAULT-BROKER-DENIED",
    human: `${brokerCode}: ${human}`,
    fix: {
      kind: "request_vault_grant" as const,
      vault_key: vaultKey,
    },
    request_id: `vault-cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  process.stderr.write(
    `${ENVELOPE_SENTINEL} ${JSON.stringify(envelope)}\n`,
  );
}
