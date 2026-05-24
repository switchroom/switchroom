/**
 * Programmatic vault write from the Telegram plugin path.
 *
 * Two flavors:
 *
 *   1. `defaultVaultWrite(slug, value, passphrase)` — shell-out to
 *      `switchroom vault set`. The CLI forwards the passphrase to the
 *      broker as operator-attestation (#969 P1a). Used by passphrase-
 *      mode approval flows where the gateway cached the operator's
 *      passphrase via /vault unlock.
 *
 *   2. `defaultVaultWritePosture(slug, value)` — direct broker call via
 *      `putViaBroker(..., attest_via_posture: true)`. Used by
 *      telegram-id-mode approval flows where the broker auto-unlocked
 *      at boot and the gateway never needs the passphrase
 *      (`vault.broker.approvalAuth: telegram-id` in switchroom.yaml).
 *      Closes the UX gap where tapping Save on a `vault_request_save`
 *      card surfaced a misleading "🔒 Vault is locked" message when
 *      the operator hadn't run /vault unlock in that chat — even
 *      though the broker had been unlocked for hours. The tracked
 *      follow-up of #1115; broker side has supported the flag since
 *      PR #1115 follow-up rev 3.
 *
 * Exposed as pure functions for testability: callers inject the spawn /
 * broker helper in tests to avoid needing a real vault on disk.
 */
import { execFileSync } from 'node:child_process'
import { putViaBroker, resolveBrokerSocketPath } from '../../src/vault/broker/client.js'

export interface VaultWriteResult {
  ok: boolean
  output: string
}

export type VaultWriteFn = (
  slug: string,
  value: string,
  passphrase: string,
) => VaultWriteResult

/**
 * Posture-attested vault write — no passphrase required. Returns the
 * same `VaultWriteResult` shape as `defaultVaultWrite` for drop-in
 * substitution at the gateway save / defer / auto-save callsites.
 *
 * Caller MUST verify `vault.broker.approvalAuth === 'telegram-id'` in
 * config before invoking — the broker will reject `attest_via_posture`
 * under passphrase mode with `attest_via_posture requires
 * vault.broker.approvalAuth: telegram-id` (server.ts:1500). The
 * gateway's `VAULT_APPROVAL_AUTH_MODE` flag is the canonical signal.
 *
 * Returns `{ ok: false, output: ... }` on any broker error so the
 * gateway's existing parseVaultCliError / renderVaultCliError path
 * still works.
 */
export type VaultWritePostureFn = (
  slug: string,
  value: string,
) => Promise<VaultWriteResult>

export const defaultVaultWritePosture: VaultWritePostureFn = async (slug, value) => {
  const socket = resolveBrokerSocketPath()
  const result = await putViaBroker(
    slug,
    { kind: 'string', value },
    { socket, attest_via_posture: true, timeoutMs: 10000 },
  )
  if (result.kind === 'ok') {
    return { ok: true, output: `sent (key: ${slug})` }
  }
  // Mirror the CLI's error format so the existing parseVaultCliError
  // / renderVaultCliError stack handles broker-mediated failures
  // without a special branch.
  const prefix =
    result.kind === 'unreachable'
      ? 'VAULT-BROKER-UNREACHABLE'
      : result.kind === 'denied'
        ? `VAULT-BROKER-DENIED (${result.code})`
        : `VAULT-BROKER-${result.code}`
  return { ok: false, output: `${prefix}: ${result.msg}` }
}

export type VaultListFn = (passphrase: string) => { ok: boolean; keys: string[] }

export const defaultVaultWrite: VaultWriteFn = (slug, value, passphrase) => {
  // Suppress the #969 P3 deprecation warning — the gateway forwarding
  // the operator's passphrase per-spawn is the canonical P1a flow.
  const env = {
    ...process.env,
    SWITCHROOM_VAULT_PASSPHRASE: passphrase,
    SWITCHROOM_NO_VAULT_DEPRECATION_WARNING: '1',
  }
  try {
    const result = execFileSync(
      process.env.SWITCHROOM_CLI_PATH ?? 'switchroom',
      ['vault', 'set', slug],
      { input: value, encoding: 'utf8', env, timeout: 10000 },
    )
    return { ok: true, output: result.trim() }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const detail = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim()
    return { ok: false, output: detail }
  }
}

export const defaultVaultList: VaultListFn = (passphrase) => {
  // Suppress the #969 P3 deprecation warning — the gateway forwarding
  // the operator's passphrase per-spawn is the canonical P1a flow.
  const env = {
    ...process.env,
    SWITCHROOM_VAULT_PASSPHRASE: passphrase,
    SWITCHROOM_NO_VAULT_DEPRECATION_WARNING: '1',
  }
  try {
    const result = execFileSync(
      process.env.SWITCHROOM_CLI_PATH ?? 'switchroom',
      ['vault', 'list'],
      { encoding: 'utf8', env, timeout: 10000 },
    )
    const keys = result.split('\n').map((l) => l.trim()).filter(Boolean)
    return { ok: true, keys }
  } catch {
    return { ok: false, keys: [] }
  }
}
