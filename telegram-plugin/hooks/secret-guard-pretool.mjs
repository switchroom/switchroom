#!/usr/bin/env node
/**
 * PreToolUse hook — blocks any tool call whose input contains a currently-
 * active vault value verbatim. Second-line defense: if a secret slips past
 * the Telegram-plugin detector (e.g. Claude synthesized it, or it came from
 * another channel), this catches it before the tool fires.
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON on stdout with `decision: "block"` + `reason` → block.
 *
 * Performance note (closes #472 finding #7):
 *   Earlier versions forked `switchroom vault list` + `switchroom vault get`
 *   per key — each fork paid ~785ms of CLI cold-start cost. With N vault
 *   keys × every tool call, that compounded to seconds of overhead per turn.
 *
 *   This version connects directly to the running vault-broker daemon via
 *   its NDJSON unix socket protocol (see src/vault/broker/protocol.ts) and
 *   issues sequential list+get requests over a single connection. Sub-10ms
 *   total even with several keys, vs 800ms × (1 + N) before.
 *
 *   When the broker is unreachable (not running, socket missing, denied)
 *   the hook fails open — same behavior as before. Vault security is owned
 *   by the broker; we are an opportunistic second-line checker.
 */

import { readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ─── Tunables ─────────────────────────────────────────────────────────────

const BROKER_SOCKET =
  process.env.SWITCHROOM_VAULT_BROKER_SOCK
  ?? join(homedir(), '.switchroom', 'vault-broker.sock')
const BROKER_TIMEOUT_MS = 1500
const MIN_VALUE_LENGTH_TO_GUARD = 8

// ─── Stdin ────────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// ─── Token-file discovery (mirrors src/vault/broker/client.ts) ────────────

function readVaultToken() {
  const slug = process.env.SWITCHROOM_AGENT_NAME
  if (!slug) return null
  const path = join(homedir(), '.switchroom', 'agents', slug, '.vault-token')
  try {
    // 0o600 enforcement matches the TS client. The broker treats the token
    // as full auth (peercred ACL is bypassed), so a widened mode is a
    // real privilege-escalation surface — same UID processes could
    // exfiltrate the bearer.
    const st = statSync(path)
    if ((st.mode & 0o077) !== 0) return null
    const raw = readFileSync(path, 'utf8')
    const tok = raw.split('\n')[0].trim()
    return tok.length > 0 ? tok : null
  } catch {
    return null
  }
}

// ─── Inline NDJSON broker client ──────────────────────────────────────────

/**
 * Open a connection, run sequential request/response pairs, close.
 * Fails open (returns []) on any error — connection refused, timeout,
 * malformed response, broker locked, etc.
 */
function loadVaultValuesViaBroker() {
  return new Promise((resolve) => {
    const token = readVaultToken()
    const sock = connect(BROKER_SOCKET)
    let buf = ''
    let done = false
    let pending = null   // { resolve(line) }
    const finish = (result) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* best-effort */ }
      resolve(result)
    }

    const timer = setTimeout(() => finish([]), BROKER_TIMEOUT_MS)

    sock.on('error', () => finish([]))
    sock.on('close', () => {
      clearTimeout(timer)
      if (!done) finish([])
    })

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      // Split on newlines; emit complete lines through the pending request.
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (pending) {
          const p = pending
          pending = null
          p.resolve(line)
        }
      }
    })

    function send(req) {
      return new Promise((respond) => {
        pending = { resolve: respond }
        sock.write(JSON.stringify(req) + '\n')
      })
    }

    sock.on('connect', async () => {
      try {
        // 1. list keys
        const listReq = token ? { v: 1, op: 'list', token } : { v: 1, op: 'list' }
        const listLine = await send(listReq)
        let listRsp
        try { listRsp = JSON.parse(listLine) } catch { return finish([]) }
        if (!listRsp || listRsp.ok !== true || !Array.isArray(listRsp.keys)) {
          // LOCKED / DENIED / etc. — fall through, no values.
          return finish([])
        }
        // 2. fetch each value
        const values = []
        for (const k of listRsp.keys) {
          const getReq = token
            ? { v: 1, op: 'get', key: k, token }
            : { v: 1, op: 'get', key: k }
          const getLine = await send(getReq)
          let getRsp
          try { getRsp = JSON.parse(getLine) } catch { continue }
          if (!getRsp || getRsp.ok !== true || !getRsp.entry) continue
          // Only string-kind entries are scannable haystack candidates;
          // binary/files entries can't be substring-matched against a
          // tool-input string in any meaningful way.
          if (getRsp.entry.kind === 'string'
              && typeof getRsp.entry.value === 'string'
              && getRsp.entry.value.length >= MIN_VALUE_LENGTH_TO_GUARD) {
            values.push({ key: k, value: getRsp.entry.value })
          }
        }
        finish(values)
      } catch {
        finish([])
      }
    })
  })
}

// ─── Scan ─────────────────────────────────────────────────────────────────

function scanToolInput(toolInput, vaultValues) {
  const haystack = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? '')
  for (const v of vaultValues) {
    if (haystack.includes(v.value)) return v
  }
  return null
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const raw = readStdin().trim()
  if (!raw) {
    process.exit(0)
  }
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  const toolInput = event.tool_input
  if (toolInput == null) {
    process.exit(0)
  }
  const vaultValues = await loadVaultValuesViaBroker()
  if (vaultValues.length === 0) {
    // Fail-open when the broker is unreachable or locked. Vault security
    // is owned by the broker; we are an opportunistic checker. Blocking
    // every tool call when the broker hiccups would break the session.
    process.exit(0)
  }
  const hit = scanToolInput(toolInput, vaultValues)
  if (hit) {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `tool_input contains a vaulted secret — reference it as vault:${hit.key} instead`,
      }),
    )
    process.exit(0)
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
