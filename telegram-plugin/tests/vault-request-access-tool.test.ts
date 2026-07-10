/**
 * Pin the agent-initiated vault ACL request flow shipped in #1012.
 *
 * Regressions guarded here:
 *   1. `vault_request_access` MCP tool dropping from bridge.ts schema
 *      (the agent would lose the tool with no compile-time signal).
 *   2. `vault_request_access` missing from the gateway's ALLOWED_TOOLS
 *      set (bridge would emit it but gateway would 403 with
 *      `tool not allowed`).
 *   3. The `vra:` callback prefix losing its dispatcher branch (taps
 *      on [Approve] / [Deny] silently fall through to the trailing
 *      "unknown callback" arm).
 *   4. The 90-day TTL ceiling and `read|write` scope shape — both are
 *      part of the threat model (agents can't request perpetual or
 *      undefined-scope grants).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const bridgeSrc = readFileSync(
  resolve(__dirname, '..', 'bridge', 'bridge.ts'),
  'utf-8',
)
// #2996 Phase 5: the callback-query handler families moved verbatim to
// gateway/callback-query-handlers.ts; these pins read the gateway source
// COMBINED with that module so the wiring assertions keep covering the
// same runtime source text.
const gatewaySrc =
  readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8') +
  '\n' +
  readFileSync(resolve(__dirname, '..', 'gateway', 'callback-query-handlers.ts'), 'utf-8')

describe('vault_request_access (#1012)', () => {
  it('bridge advertises the tool to MCP clients', () => {
    // fails when: the schema is removed from TOOL_SCHEMAS — agents
    // running the new tool will hit a generic "unknown tool" path
    // before they ever see the gateway.
    expect(bridgeSrc).toContain("name: 'vault_request_access'")
  })

  it('bridge schema declares the threat-model-critical fields', () => {
    // fails when: a refactor drops `scope` (defaults to read) or
    // `duration` (caps requested TTL at 90d). Both gates are part of
    // the agent-can-only-request-not-mint boundary described in #1012.
    const block = bridgeSrc.split("name: 'vault_request_access'")[1]?.split("name: '")[0] ?? ''
    expect(block).toContain("'read'")
    expect(block).toContain("'write'")
    expect(block).toMatch(/duration/)
    // Required fields: chat_id + key. Value is NOT required (this is
    // an access request, not a save — the agent doesn't have the
    // value, it wants permission to read it).
    expect(block).toMatch(/required:\s*\[\s*'chat_id',\s*'key'\s*\]/)
  })

  it('gateway accepts vault_request_access in ALLOWED_TOOLS', () => {
    // fails when: the ALLOWED_TOOLS set is touched and the entry
    // gets dropped. Bridge would forward the call and the gateway
    // would reject with `tool not allowed`.
    expect(gatewaySrc).toMatch(/ALLOWED_TOOLS[\s\S]*?'vault_request_access'/)
  })

  it('gateway routes vault_request_access in executeToolCall', () => {
    // fails when: the switch arm is dropped. Tool would be accepted
    // by ALLOWED_TOOLS but fall through to the `unknown tool` branch.
    expect(gatewaySrc).toMatch(/case\s+'vault_request_access':\s*\n\s*return\s+executeVaultRequestAccess/)
  })

  it('gateway dispatches vra: callback prefix', () => {
    // fails when: the callback_query dispatcher loses the `vra:`
    // branch. Operator taps on [Approve] / [Deny] would fall to the
    // catch-all "unknown callback" path and the card would stay
    // open forever.
    expect(gatewaySrc).toMatch(/data\.startsWith\('vra:'\)/)
    expect(gatewaySrc).toMatch(/handleVaultRequestAccessCallback/)
  })

  it('approve handler mints via broker (not direct grants.db write)', () => {
    // fails when: someone tries to short-circuit by writing to the
    // grants DB directly. The broker is the single point of grant
    // issuance — bypassing it skips audit-log emission and breaks
    // the path-as-identity ACL contract.
    //
    // The mint call lives in performVaultAccessApproval — the helper
    // factored out so both the direct-approve path AND the
    // tap-on-locked → passphrase-resume path drive identical minting
    // (see telegram-plugin/tests/vault-request-access-unlock-resume.test.ts).
    const mintHelperBlock =
      gatewaySrc
        .split('async function performVaultAccessApproval')[1]
        ?.split('async function handleVaultRequestAccessCallback')[0] ?? ''
    expect(mintHelperBlock).toMatch(/mintGrantViaBroker/)
    // Description string must carry the audit breadcrumb so post-hoc
    // forensics can tell agent-initiated grants apart from
    // operator-host-CLI grants and from /vault audit one-tap grants.
    expect(mintHelperBlock).toMatch(/vault_request_access/)
    expect(mintHelperBlock).toMatch(/#1012/)
  })

  it('duration parser enforces the 90-day ceiling', () => {
    // fails when: the cap is removed or widened without a corresponding
    // doc/threat-model update. Agent-initiated grants must have a
    // finite sunset; "never" must be refused outright.
    const execBlock = gatewaySrc.split('async function executeVaultRequestAccess')[1]?.split('async function ')[0] ?? ''
    expect(execBlock).toMatch(/NINETY_DAYS/)
    expect(execBlock).toMatch(/90\s*\*\s*86400/)
  })

  it('approve handler is gated on the operator allowFrom list', () => {
    // fails when: the access check is dropped. Without this gate any
    // chat member could approve a grant — breaks the operator-only
    // mint authority that's load-bearing for #1012's threat model.
    const handlerBlock = gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function handleVaultRequestSaveCallback')[0] ?? ''
    expect(handlerBlock).toMatch(/loadAccess\(\)/)
    expect(handlerBlock).toMatch(/allowFrom\.includes/)
  })
})

/**
 * Fix B (#1487 follow-up): vault_request_access must NOT card/mint when
 * the agent's STANDING ACL already covers the key — and must decide
 * that by probing the BROKER as the agent (no-token listViaBroker over
 * the per-agent socket — path-as-identity), never a gateway-side
 * config/checkAclByAgent read (the gateway can see newer config than
 * the broker has loaded → "covered here, denied there"). Read scope
 * only; fail-open on probe error. Source-pattern assertions matching
 * this file's established style (the flow has Telegram + module-state
 * side effects that aren't behaviourally unit-testable here).
 */
describe('Fix B: vault_request_access standing-ACL-aware (#1487 follow-up)', () => {
  const execBlock =
    gatewaySrc.split('async function executeVaultRequestAccess')[1]?.split('\nasync function ')[0] ?? ''
  const approveBlock =
    gatewaySrc.split('async function performVaultAccessApproval')[1]?.split('\nasync function ')[0] ?? ''

  it('request path: read-scope broker-probe short-circuits BEFORE the card is staged/sent', () => {
    expect(execBlock).toContain('listViaBroker(')
    expect(execBlock).toMatch(/scopeRaw === 'read'/)
    const probeIdx = execBlock.indexOf('listViaBroker(')
    const stageIdx = execBlock.indexOf('pendingVaultRequestAccesses.set(stageId')
    expect(probeIdx).toBeGreaterThan(-1)
    expect(stageIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeLessThan(stageIdx)
    expect(execBlock).toMatch(/ALREADY covered[\s\S]*?return\s*{/)
  })

  it('request path: decides via the BROKER, not a gateway-side config/ACL read (B2 — no config drift)', () => {
    expect(execBlock).not.toContain('checkAclByAgent(')
    expect(execBlock).not.toContain('loadSwitchroomConfig(')
  })

  it('operator-approve path: parallel guard short-circuits BEFORE mintGrantViaBroker', () => {
    expect(approveBlock).toContain('listViaBroker(')
    expect(approveBlock).toMatch(/pending\.scope === 'read'/)
    const probeIdx = approveBlock.indexOf('listViaBroker(')
    const mintIdx = approveBlock.indexOf('mintGrantViaBroker(mintArgs)')
    expect(probeIdx).toBeGreaterThan(-1)
    expect(mintIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeLessThan(mintIdx)
    expect(approveBlock).toMatch(/listViaBroker\([\s\S]*?pendingVaultRequestAccesses\.delete\(stageId\)[\s\S]*?return/)
    expect(approveBlock).not.toContain('checkAclByAgent(')
  })

  it('both guards are fail-open (probe error → normal card/mint flow)', () => {
    expect(execBlock).toMatch(/try\s*{[\s\S]*?listViaBroker\([\s\S]*?}\s*catch/)
    expect(approveBlock).toMatch(/try\s*{[\s\S]*?listViaBroker\([\s\S]*?}\s*catch/)
  })
})

describe('vault_request_access — `why` alias for `reason`', () => {
  // The sibling tool vault_request_save uses `why`; agents cross-
  // contaminate the two schemas. Without the alias the rationale
  // silently drops off the approval card ("why: not provided") and
  // operators tend to Deny.
  it('gateway accepts args.why as a fallback when args.reason is absent', () => {
    expect(gatewaySrc).toMatch(
      /const reason =\s*\n?\s*typeof args\.reason === 'string' \? args\.reason : typeof args\.why === 'string' \? args\.why : undefined/,
    )
  })

  it('bridge schema documents the alias on both fields', () => {
    const block = bridgeSrc.split("name: 'vault_request_access'")[1]?.split("name: '")[0] ?? ''
    expect(block).toMatch(/why:\s*{\s*type:\s*'string'/)
    expect(block).toContain('Alias for `reason`')
    expect(block).toContain('`why` is accepted as an alias')
  })

  it('reason wins when both are supplied (ordering: reason checked first)', () => {
    const idx = gatewaySrc.indexOf("typeof args.reason === 'string' ? args.reason : typeof args.why === 'string'")
    expect(idx).toBeGreaterThan(-1)
  })
})
