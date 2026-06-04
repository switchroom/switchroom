import { describe, it, expect } from 'vitest'

import {
  startMicrosoftConnect,
  runMicrosoftConnectPoll,
} from '../gateway/microsoft-connect-flow.js'
import { DEFAULT_MICROSOFT_CLIENT_ID } from '../../src/auth/default-oauth-clients.js'
import type {
  MicrosoftDeviceCodeResponse,
  MicrosoftOAuthClientConfig,
  MicrosoftTokenResponse,
} from '../../src/microsoft/oauth.js'

const PERSONAL_MSA_TID = '9188040d-6c67-4c5b-b112-36a304b66dad'

const DEVICE: MicrosoftDeviceCodeResponse = {
  device_code: 'dc-abc',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://microsoft.com/devicelogin',
  expires_in: 900,
  interval: 5,
}

function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

describe('startMicrosoftConnect', () => {
  it('uses the shipped default client_id + default scopes when there is no config', async () => {
    let seen: MicrosoftOAuthClientConfig | undefined
    const res = await startMicrosoftConnect({
      requestDeviceCode: async (cfg) => {
        seen = cfg
        return DEVICE
      },
    })
    expect(res.kind).toBe('started')
    if (res.kind === 'started') {
      expect(res.source).toBe('default')
      expect(res.clientId).toBe(DEFAULT_MICROSOFT_CLIENT_ID)
      expect(res.scopes).toContain('offline_access')
      expect(res.device.user_code).toBe('ABCD-EFGH')
    }
    expect(seen?.client_id).toBe(DEFAULT_MICROSOFT_CLIENT_ID)
  })

  it('refuses a vaulted BYO client (gateway can\'t resolve vault refs)', async () => {
    const res = await startMicrosoftConnect({
      configClientId: 'vault:microsoft-oauth-client-id',
      requestDeviceCode: async () => DEVICE,
    })
    expect(res.kind).toBe('byo-vault')
    if (res.kind === 'byo-vault') {
      expect(res.ref).toBe('vault:microsoft-oauth-client-id')
    }
  })

  it('uses a literal BYO config client_id (source=config)', async () => {
    const res = await startMicrosoftConnect({
      configClientId: 'byo-literal-123',
      requestDeviceCode: async () => DEVICE,
    })
    expect(res.kind).toBe('started')
    if (res.kind === 'started') {
      expect(res.source).toBe('config')
      expect(res.clientId).toBe('byo-literal-123')
    }
  })

  it('returns an error when the device-code request fails', async () => {
    const res = await startMicrosoftConnect({
      requestDeviceCode: async () => {
        throw new Error('device_code request failed (400): boom')
      },
    })
    expect(res.kind).toBe('error')
    if (res.kind === 'error') expect(res.message).toContain('boom')
  })
})

describe('runMicrosoftConnectPoll', () => {
  const flow = {
    device: DEVICE,
    clientId: 'client-1',
    scopes: ['offline_access', 'Mail.ReadWrite'],
    cancelled: false,
  }

  function tokens(o: Partial<MicrosoftTokenResponse> = {}): MicrosoftTokenResponse {
    return {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'Mail.ReadWrite',
      ...o,
    }
  }

  it('connects: registers the account via the broker keyed by the authenticated email', async () => {
    const id_token = fakeIdToken({
      tid: PERSONAL_MSA_TID,
      oid: 'oid-1',
      preferred_username: 'Lisa@Outlook.com',
    })
    const calls: Array<{ label: string; opts: unknown; refreshToken: string }> = []
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => tokens({ id_token }),
      addAccount: async (label, creds, opts) => {
        calls.push({
          label,
          opts,
          refreshToken: creds.microsoftOauth.refreshToken,
        })
        return { label }
      },
    })
    expect(res.kind).toBe('connected')
    if (res.kind === 'connected') {
      expect(res.account).toBe('lisa@outlook.com')
      expect(res.accountType).toBe('personal')
    }
    expect(calls).toHaveLength(1)
    expect(calls[0].label).toBe('lisa@outlook.com')
    expect(calls[0].opts).toEqual({ provider: 'microsoft', replace: true })
    expect(calls[0].refreshToken).toBe('rt')
  })

  it('cancelled: does NOT register if the flow was cancelled during the poll', async () => {
    let added = false
    const res = await runMicrosoftConnectPoll(
      { ...flow, cancelled: true },
      {
        pollDeviceToken: async () => tokens(),
        addAccount: async () => {
          added = true
          return { label: 'x' }
        },
      },
    )
    expect(res.kind).toBe('cancelled')
    expect(added).toBe(false)
  })

  it('no-refresh-token: refuses to register an un-refreshable account', async () => {
    let added = false
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => tokens({ refresh_token: undefined }),
      addAccount: async () => {
        added = true
        return { label: 'x' }
      },
    })
    expect(res.kind).toBe('no-refresh-token')
    expect(added).toBe(false)
  })

  it('failed: surfaces a poll error (e.g. a work account rejected at /common)', async () => {
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => {
        throw new Error('Token poll failed: AADSTS9001023 work account')
      },
      addAccount: async () => ({ label: 'x' }),
    })
    expect(res.kind).toBe('failed')
    if (res.kind === 'failed') expect(res.message).toContain('AADSTS9001023')
  })

  it('failed: refuses to register when Microsoft returns no id_token (no account identity)', async () => {
    let added = false
    const res = await runMicrosoftConnectPoll(flow, {
      // Has a refresh token but no id_token → no resolvable email to key
      // the broker account by; must NOT register a label-less account.
      pollDeviceToken: async () => tokens({ id_token: undefined }),
      addAccount: async () => {
        added = true
        return { label: 'x' }
      },
    })
    expect(res.kind).toBe('failed')
    if (res.kind === 'failed') expect(res.message).toContain('account identity')
    expect(added).toBe(false)
  })
})
