/**
 * Telegram-native Microsoft connect — device-code flow (RFC #1873 /
 * out-of-box, Phase 2).
 *
 * The headline "connect from your phone" path: a user runs
 * `/connect microsoft`, the gateway shows a card with a Microsoft
 * sign-in link + a short code, the user approves on their phone, and the
 * gateway registers the resulting account with the auth-broker — no host
 * shell, no Azure portal (the shipped default app is used unless the
 * operator BYO'd one).
 *
 * This module is the framework-agnostic core: it talks to Microsoft's
 * device-code endpoints (RFC 8628, engine in `src/microsoft/oauth.ts`)
 * and the auth-broker, and returns plain data. The gateway owns the
 * Telegram surface (card rendering, edits, callbacks). All network +
 * broker boundaries are injectable so the flow is testable without
 * hitting Microsoft or a live broker, and it contains NO raw bot.api
 * calls (the bot-api-wrapping lint trap lives only in the gateway).
 *
 * Mirrors `auth-add-flow.ts` (the Anthropic `/auth add` template) but
 * needs no child subprocess and no pasted code: device-code consent
 * happens entirely on Microsoft's domain, so nothing secret is ever
 * pasted into chat (strictly better than paste-back — no redaction
 * needed). Personal Microsoft accounts (outlook.com/hotmail) are the
 * clean case at `/common`; a work/school account that fails device-code
 * at `/common` surfaces a clear "use the host CLI" error (the documented
 * "personal-first, work best-effort" boundary).
 */

import {
  requestDeviceCode as realRequestDeviceCode,
  pollDeviceToken as realPollDeviceToken,
  type MicrosoftDeviceCodeResponse,
  type MicrosoftOAuthClientConfig,
} from '../../src/microsoft/oauth.js'
import { selectMicrosoftScopes } from '../../src/microsoft/scopes.js'
import { buildMicrosoftCredentials } from '../../src/microsoft/credentials.js'
import { resolveMicrosoftClientId } from '../../src/auth/default-oauth-clients.js'
import { isVaultReference } from '../../src/vault/resolver.js'
import { addAccountViaBroker } from './auth-broker-client.js'
import type { MicrosoftAddAccountCredentials } from '../../src/auth/broker/client.js'

/** A connect flow in flight, keyed by `chatKey(chatId, threadId)`. */
export interface PendingMicrosoftConnectFlow {
  /** Telegram user id that started the flow (consent owner; Phase 3). */
  initiatedBy: string
  /** Card we posted, so the poll loop can edit it on completion. */
  cardChatId: number | string
  cardMessageId: number
  device: MicrosoftDeviceCodeResponse
  clientId: string
  scopes: string[]
  startedAt: number
  /** Flipped by cancel so the in-flight poll bails without writing. */
  cancelled: boolean
}

export const pendingMicrosoftConnectFlows = new Map<
  string,
  PendingMicrosoftConnectFlow
>()

export interface MicrosoftConnectDeps {
  /** `config.microsoft_workspace?.microsoft_client_id` (may be a vault: ref). */
  configClientId?: string
  orgMode?: boolean
  requestDeviceCode?: (
    cfg: MicrosoftOAuthClientConfig,
  ) => Promise<MicrosoftDeviceCodeResponse>
  pollDeviceToken?: typeof realPollDeviceToken
  addAccount?: (
    label: string,
    credentials: MicrosoftAddAccountCredentials,
    opts: { replace?: boolean; provider: 'microsoft' },
  ) => Promise<{ label: string; expiresAt?: number }>
  now?: () => number
}

export type StartResult =
  | {
      kind: 'started'
      device: MicrosoftDeviceCodeResponse
      clientId: string
      scopes: string[]
      /** 'default' = shipped app; 'config'/'env' = BYO. */
      source: 'env' | 'config' | 'default'
    }
  | {
      // The operator BYO'd a Microsoft client via a vault: reference,
      // which the gateway can't resolve in-process — host CLI only.
      kind: 'byo-vault'
      ref: string
    }
  | { kind: 'error'; message: string }

/**
 * Request a device code and return the data the gateway needs to render
 * the connect card. Does NOT mutate the pending map — the gateway stores
 * the pending entry (with the card message id) after it posts the card.
 */
export async function startMicrosoftConnect(
  deps: MicrosoftConnectDeps = {},
): Promise<StartResult> {
  const resolved = resolveMicrosoftClientId(deps.configClientId)

  // A vaulted BYO client_id can't be resolved from the gateway process
  // (the gateway has no passphrase / vault-broker read path here). The
  // shipped default and literal config values are fine.
  if (isVaultReference(resolved.clientId)) {
    return { kind: 'byo-vault', ref: resolved.clientId }
  }

  const scopes = selectMicrosoftScopes(deps.orgMode ?? false)
  const cfg: MicrosoftOAuthClientConfig = {
    client_id: resolved.clientId,
    scopes,
  }
  try {
    const device = await (deps.requestDeviceCode ?? realRequestDeviceCode)(cfg)
    return {
      kind: 'started',
      device,
      clientId: resolved.clientId,
      scopes,
      source: resolved.source,
    }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }
}

export type PollResult =
  | {
      kind: 'connected'
      account: string
      accountType: 'personal' | 'work'
      expiresAt: number
    }
  | { kind: 'cancelled' }
  | { kind: 'no-refresh-token' }
  | { kind: 'failed'; message: string }

/**
 * Poll Microsoft for consent completion, then register the account with
 * the broker. Blocks (with the device-code `interval`) up to the
 * device's `expires_in`. Returns a discriminated result the gateway
 * turns into a card edit. Reads `flow.cancelled` after the (potentially
 * long) poll so a `/connect cancel` between consent and write is
 * honored.
 */
export async function runMicrosoftConnectPoll(
  flow: Pick<
    PendingMicrosoftConnectFlow,
    'device' | 'clientId' | 'scopes' | 'cancelled'
  >,
  deps: MicrosoftConnectDeps = {},
): Promise<PollResult> {
  const now = deps.now ?? Date.now
  const cfg: MicrosoftOAuthClientConfig = {
    client_id: flow.clientId,
    scopes: flow.scopes,
  }

  let tokens
  try {
    tokens = await (deps.pollDeviceToken ?? realPollDeviceToken)(
      cfg,
      flow.device,
      { now },
    )
  } catch (err) {
    return { kind: 'failed', message: (err as Error).message }
  }

  if (flow.cancelled) return { kind: 'cancelled' }

  const built = buildMicrosoftCredentials({
    tokens,
    clientId: flow.clientId,
    accountEmail: '', // device-code learns the email from the id_token
    fallbackScope: flow.scopes.join(' '),
    now,
  })

  // offline_access is requested, so a refresh token is expected; without
  // one the account dies at the first access-token expiry — fail loud
  // rather than register an un-refreshable account.
  if (!built.credentials.microsoftOauth.refreshToken) {
    return { kind: 'no-refresh-token' }
  }

  const account = built.resolvedEmail
  if (!account) {
    return {
      kind: 'failed',
      message: 'Microsoft did not return an account identity (no id_token).',
    }
  }

  const addAccount = deps.addAccount ?? defaultAddAccount
  try {
    await addAccount(account, built.credentials as MicrosoftAddAccountCredentials, {
      provider: 'microsoft',
      // replace:true so reconnecting an already-linked account just
      // refreshes its tokens rather than erroring.
      replace: true,
    })
  } catch (err) {
    return { kind: 'failed', message: (err as Error).message }
  }

  return {
    kind: 'connected',
    account,
    accountType: built.credentials.microsoftOauth.accountType,
    expiresAt: built.credentials.microsoftOauth.expiresAt,
  }
}

function defaultAddAccount(
  label: string,
  credentials: MicrosoftAddAccountCredentials,
  opts: { replace?: boolean; provider: 'microsoft' },
): Promise<{ label: string; expiresAt?: number }> {
  return addAccountViaBroker(label, credentials, opts)
}
