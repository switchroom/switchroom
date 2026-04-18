/**
 * Contract conformance tests — every fixture must round-trip and every
 * Client→Gateway fixture must pass the server-side validator.
 *
 * Keeps the gateway's validator and the bridge's encoder pinned to the
 * exact same wire shape. If they drift, this test is the earliest place
 * the drift surfaces.
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'
import {
  allClientFixtures,
  allGatewayFixtures,
} from './protocol-fixtures.js'

describe('IPC protocol fixtures', () => {
  describe('client → gateway', () => {
    it.each(allClientFixtures.map((f) => [f.decoded.type, f] as const))(
      '%s: wire matches JSON.stringify(decoded)',
      (_type, fixture) => {
        expect(fixture.wire).toBe(JSON.stringify(fixture.decoded))
      },
    )

    it.each(allClientFixtures.map((f) => [f.decoded.type, f] as const))(
      '%s: wire parses back to the decoded shape',
      (_type, fixture) => {
        expect(JSON.parse(fixture.wire)).toEqual(fixture.decoded)
      },
    )

    it.each(allClientFixtures.map((f) => [f.decoded.type, f] as const))(
      '%s: passes validateClientMessage',
      (_type, fixture) => {
        expect(validateClientMessage(JSON.parse(fixture.wire))).toBe(true)
      },
    )
  })

  describe('gateway → client', () => {
    it.each(allGatewayFixtures.map((f) => [f.decoded.type, f] as const))(
      '%s: wire round-trips through JSON.parse(JSON.stringify(...))',
      (_type, fixture) => {
        const reparsed = JSON.parse(fixture.wire)
        expect(reparsed).toEqual(fixture.decoded)
      },
    )
  })

  describe('no fixture decodes to undefined / loses information', () => {
    it('all fixtures are idempotent under re-encoding', () => {
      for (const f of [...allClientFixtures, ...allGatewayFixtures]) {
        const reEncoded = JSON.stringify(JSON.parse(f.wire))
        expect(reEncoded).toBe(f.wire)
      }
    })
  })
})
