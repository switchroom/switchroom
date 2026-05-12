/**
 * Pure resolver for the vault grant-card approval posture.
 *
 * Extracted from gateway.ts so unit tests can exercise the negative
 * path (telegram-id with unreadable auto-unlock blob) without dragging
 * the gateway's top-level startup IIFE under the vitest runner.
 *
 * Behaviour pinned by `tests/vault-approval-posture.test.ts`:
 *  - `approvalAuth` absent / `passphrase` → returns passphrase posture
 *    with no passphrase loaded.
 *  - `approvalAuth: telegram-id` + readable blob → returns telegram-id
 *    posture with the blob contents.
 *  - `approvalAuth: telegram-id` + unreadable blob → THROWS. The
 *    gateway propagates this and refuses to boot. We never silently
 *    downgrade the operator's declared posture.
 */

export interface VaultBrokerPostureConfig {
  approvalAuth?: string
  autoUnlockCredentialPath?: string
}

export interface ResolvedPosture {
  mode: 'passphrase' | 'telegram-id'
  passphrase: string | null
  credPath?: string
}

export function resolveVaultApprovalPosture(
  broker: VaultBrokerPostureConfig | undefined,
  reader: (path: string) => string,
  // Accept the wider `NodeJS.ProcessEnv` shape so callers can pass
  // `process.env` directly. The narrow `{ HOME?: string }` shape this
  // had before tripped tsc (TS2559 — no overlap with ProcessEnv) under
  // the strict plugin-references lint check.
  env: NodeJS.ProcessEnv | { HOME?: string } = process.env,
): ResolvedPosture {
  if (broker?.approvalAuth !== 'telegram-id') {
    return { mode: 'passphrase', passphrase: null }
  }
  const credPathRaw = broker.autoUnlockCredentialPath ?? '~/.switchroom/vault-auto-unlock'
  const credPath = credPathRaw.replace(/^~/, env.HOME ?? '')
  let loaded: string
  try {
    loaded = reader(credPath)
  } catch (err) {
    throw new Error(
      `telegram gateway: vault.broker.approvalAuth=telegram-id but reading ` +
        `auto-unlock blob at ${credPath} failed: ${(err as Error).message}. ` +
        `Refusing to boot — silently falling back to passphrase posture ` +
        `would invert the operator's declared security posture. ` +
        `Either repair the auto-unlock blob (rerun \`switchroom setup\` / ` +
        `\`switchroom vault auto-unlock\`) or remove ` +
        `vault.broker.approvalAuth from switchroom.yaml.`,
    )
  }
  // An empty / whitespace-only blob is just as dangerous as a missing one
  // under telegram-id posture: the gateway would hold "" as the auto-
  // unlock passphrase, and any Approve tap would invoke the broker with
  // an empty passphrase. The broker rejects that, but the operator
  // discovers it only by tapping Approve on a real grant card. Refuse
  // to boot instead — same security stance as the read-error path.
  if (loaded.trim().length === 0) {
    throw new Error(
      `telegram gateway: vault.broker.approvalAuth=telegram-id but the ` +
        `auto-unlock blob at ${credPath} is empty / whitespace-only. ` +
        `Refusing to boot — an empty passphrase would silently invert the ` +
        `operator's declared security posture. Rerun \`switchroom vault ` +
        `broker enable-auto-unlock\` to repair the blob, or remove ` +
        `vault.broker.approvalAuth from switchroom.yaml.`,
    )
  }
  return { mode: 'telegram-id', passphrase: loaded, credPath }
}
