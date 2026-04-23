/**
 * Programmatic vault write from the Telegram plugin path.
 *
 * Reuses the existing `runVaultCli`-style approach (spawn `switchroom vault
 * set` with SWITCHROOM_VAULT_PASSPHRASE in env and the secret piped on
 * stdin) so we don't have to import and open the vault directly from this
 * subprocess.
 *
 * Exposed as a pure function for testability: callers inject the spawn
 * helper in tests to avoid needing a real vault on disk.
 */
import { execFileSync } from 'node:child_process'

export interface VaultWriteResult {
  ok: boolean
  output: string
}

export type VaultWriteFn = (
  slug: string,
  value: string,
  passphrase: string,
) => VaultWriteResult

export type VaultListFn = (passphrase: string) => { ok: boolean; keys: string[] }

export const defaultVaultWrite: VaultWriteFn = (slug, value, passphrase) => {
  const env = { ...process.env, SWITCHROOM_VAULT_PASSPHRASE: passphrase }
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
  const env = { ...process.env, SWITCHROOM_VAULT_PASSPHRASE: passphrase }
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
