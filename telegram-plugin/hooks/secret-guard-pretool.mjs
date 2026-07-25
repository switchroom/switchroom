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
 * Performance note (#472 finding #7, then #3543):
 *   Generation 1 forked `switchroom vault list` + `switchroom vault get` per
 *   key — each fork paid ~785ms of CLI cold-start. Seconds per turn.
 *
 *   Generation 2 spoke the broker's NDJSON unix-socket protocol directly
 *   (see src/vault/broker/protocol.ts) but issued `list` + N `get` requests
 *   SEQUENTIALLY over one connection. Its header claimed "sub-10ms total
 *   even with several keys". That claim was wrong by ~15×: measured
 *   in-container on 2026-07-25 the hook cost ~145ms per tool call, of which
 *   ~132ms was 1 + N sequential round trips at ~19ms each (#3543). A false
 *   perf claim in a header comment is how that stayed invisible; the numbers
 *   below are measured, not assumed.
 *
 *   Generation 3 (this one) keeps the same two logical phases but fans the
 *   `get` phase out CONCURRENTLY, one request per connection, so the CLIENT
 *   issues ~2 round trips' worth of requests instead of 1 + N serialized
 *   ones.
 *
 *   ⚠ READ THIS BEFORE QUOTING A NUMBER. Client concurrency is NOT the
 *   whole cost, and an earlier draft of this header claimed "~2 round trips
 *   regardless of key count" — which was false against the real broker, for
 *   the same reason generation 2's "sub-10ms" claim was false. Whenever the
 *   request carries a token (which is ALWAYS, in an agent container:
 *   readVaultToken() below always finds `.vault-token`), the broker runs
 *   `validateGrant` per request — `list` at src/vault/broker/server.ts:1105
 *   and every `get` at :1284 — and that awaits a `bcryptjs.compare`
 *   (src/vault/grants.ts, BCRYPT_COST=10). bcryptjs is pure JS and BLOCKS
 *   the broker's single event loop: measured 2026-07-25, one compare is
 *   ~57ms on the fleet host and 8 "concurrent" compares took 459ms — fully
 *   serialized. The broker is shared by every agent, so N keys cost the
 *   broker (N+1) × compare of serialized CPU that no amount of client
 *   fan-out can shorten.
 *
 *   That is why #3574 also added an exact positive-result memo for the
 *   bcrypt comparison in src/vault/grants.ts (revocation/expiry/key_allow
 *   are still read live from SQLite on every call — only the immutable
 *   "does this secret hash to this digest" fact is memoized). With it, the
 *   per-request broker CPU collapses to a Map lookup after the first
 *   request and the fan-out delivers what it promises. Without it, this
 *   hook's real cost is dominated by broker CPU, not by round trips.
 *
 *   The failure mode when broker CPU DOES saturate is a security
 *   degradation, not a hang: on deadline expiry we keep whatever arrived
 *   and scan a PARTIAL key set, so a secret can be guarded on one tool call
 *   and unguarded on the next. `warnOnUnreachableGets` below exists so that
 *   can never happen silently.
 *
 *   Why one request per connection rather than pipelining N gets down the
 *   single connection: the broker dispatches each line to an async handler
 *   WITHOUT awaiting it (src/vault/broker/server.ts:924), and the `get`
 *   handler awaits `validateGrant` before replying (server.ts:1284). So
 *   pipelined responses are not guaranteed to come back in request order,
 *   and the wire format carries no request id to correlate them by
 *   (protocol.ts:452 OkEntryResponseSchema is `{ ok, entry }` — no key, no
 *   id). One request per connection is exactly the shape the protocol
 *   documents ("one request per connection turn, one response") and needs
 *   no broker change, so it ships without a broker restart.
 *
 *   Why not a TTL cache of vault values: values rotate at runtime through
 *   the broker's `put` op, and this hook cannot see the vault file to key an
 *   invalidation off its mtime. A cache would let a freshly-rotated secret
 *   go unguarded for the cache lifetime — i.e. it would make the guard fail
 *   open in a case where it currently blocks. Rejected on those grounds.
 *
 *   Measured client-side only (fake broker with an ASYNC 19ms service delay,
 *   6 keys, median of 5): sequential 167.7ms → concurrent ~59ms. Treat this
 *   as an upper bound on what the fan-out alone buys — a fake broker that
 *   sleeps does not model the real broker's synchronous bcrypt CPU. See the
 *   CPU-bound fake-broker test in the sibling test file.
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
/**
 * Max concurrent `get` connections to the broker (#3543). The fan-out is
 * what makes this hook O(1) round trips instead of O(N), but an unbounded
 * fan-out on a large vault would open one unix socket per key at once. 32
 * keeps a typical vault (single digits to low tens of keys) at a single
 * round trip while capping the worst case at ceil(N/32) rounds.
 *
 * ⚠ COUPLING — this hook now needs up to MAX_CONCURRENT_GETS + 1 broker
 * connections where generation 2 needed exactly ONE. That makes the guard
 * sensitive to a limit the broker does not currently impose. Verified as of
 * 2026-07-25: src/vault/broker/server.ts sets no `maxConnections`, no rate
 * limit and no per-connection mutex, `validateGrant` is a read-only SQLite
 * lookup, and the socket is bind-mounted into agent containers with no
 * relay in between — so nothing caps us today.
 *
 * But if a future operator adds DoS hardening (server.maxConnections, a
 * connection rate limiter, an inetd-style relay), the surplus `get`
 * connections would be refused, `brokerRequest` would resolve null for
 * those keys, and a tool call carrying one of their secrets would turn
 * from BLOCK into a silent allow. Reproduced against a 1-connection and a
 * 3-connection fake broker: old = BLOCK, new = allow.
 *
 * The deterministic guard for that is `warnOnUnreachableGets` below — a
 * connection cap can no longer degrade the guard silently; it always
 * leaves a line on stderr (captured by bin/run-hook.sh). If you ever cap
 * broker connections, lower MAX_CONCURRENT_GETS below that cap.
 */
const MAX_CONCURRENT_GETS = 32

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
 * Run exactly ONE request/response turn on a fresh connection, then close.
 *
 * This is the unit the broker protocol documents (protocol.ts:8-11 — "one
 * request per connection turn, one response"). Keeping it to one request per
 * socket is what makes it safe to run many of these concurrently: no
 * response-ordering assumption is needed, because each socket only ever
 * carries one response.
 *
 * Never rejects. Resolves `null` on ANY failure — connect refused, socket
 * error, deadline passed, short read, malformed JSON. Callers treat `null`
 * as "this key contributed nothing", which is the same fail-open posture the
 * sequential implementation had.
 *
 * @param {object} req  request object to serialize
 * @param {number} deadline  absolute `Date.now()` ms after which we give up
 * @returns {Promise<object|null>} parsed response object, or null
 */
function brokerRequest(req, deadline) {
  return new Promise((resolve) => {
    let settled = false
    let sock
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock?.destroy() } catch { /* best-effort */ }
      resolve(result)
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) return finish(null)
    timer = setTimeout(() => finish(null), remaining)

    try {
      sock = connect(BROKER_SOCKET)
    } catch {
      return finish(null)
    }

    let buf = ''
    sock.on('error', () => finish(null))
    // A close before we saw a full line is a failure, not an empty success.
    sock.on('close', () => finish(null))
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const idx = buf.indexOf('\n')
      if (idx < 0) return
      const line = buf.slice(0, idx)
      let parsed
      try { parsed = JSON.parse(line) } catch { return finish(null) }
      finish(parsed)
    })
    sock.on('connect', () => {
      try {
        sock.write(JSON.stringify(req) + '\n')
      } catch {
        finish(null)
      }
    })
  })
}

/**
 * Map `worker` over `items` with at most `limit` in flight at once.
 * Preserves input order in the result array.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Load every guardable vault value: one `list` turn, then a CONCURRENT fan-out
 * of `get` turns (#3543 — this replaces a sequential 1 + N round-trip loop).
 *
 * Fail-open contract, unchanged from the sequential version except where
 * noted:
 *   - `list` fails / is denied / broker locked  → `[]` (hook allows).
 *   - an individual `get` fails or is denied    → that key is skipped, the
 *     remaining keys are still guarded.
 *   - overall deadline expires                  → whatever HAS been fetched
 *     is returned and still scanned. The sequential version discarded
 *     everything on timeout, so this is strictly MORE coverage, never less.
 */
async function loadVaultValuesViaBroker() {
  const deadline = Date.now() + BROKER_TIMEOUT_MS
  const token = readVaultToken()

  // 1. list keys — one round trip.
  const listRsp = await brokerRequest(
    token ? { v: 1, op: 'list', token } : { v: 1, op: 'list' },
    deadline,
  )
  if (!listRsp || listRsp.ok !== true || !Array.isArray(listRsp.keys)) {
    // LOCKED / DENIED / unreachable / malformed — no values.
    return []
  }

  // 2. fetch every value concurrently — one round trip regardless of N
  //    (up to MAX_CONCURRENT_GETS in flight).
  //    `unreachable` counts keys whose `get` produced NO response at all
  //    (connect refused, socket error, deadline) as opposed to a broker
  //    reply of DENIED/UNKNOWN_KEY. That distinction is the connection-cap
  //    signal — see the MAX_CONCURRENT_GETS note above.
  let unreachable = 0
  const fetched = await mapWithConcurrency(
    listRsp.keys,
    MAX_CONCURRENT_GETS,
    async (k) => {
      const getRsp = await brokerRequest(
        token ? { v: 1, op: 'get', key: k, token } : { v: 1, op: 'get', key: k },
        deadline,
      )
      if (getRsp === null) unreachable++
      if (!getRsp || getRsp.ok !== true || !getRsp.entry) return null
      // Only string-kind entries are scannable haystack candidates;
      // binary/files entries can't be substring-matched against a
      // tool-input string in any meaningful way.
      if (getRsp.entry.kind === 'string'
          && typeof getRsp.entry.value === 'string'
          && getRsp.entry.value.length >= MIN_VALUE_LENGTH_TO_GUARD) {
        return { key: k, value: getRsp.entry.value }
      }
      return null
    },
  )

  warnOnUnreachableGets(unreachable, listRsp.keys.length)

  return fetched.filter((v) => v !== null)
}

/**
 * Deterministic degradation signal (#3574 review).
 *
 * The fan-out silently drops any key whose `get` never came back, and a
 * dropped key is an UNGUARDED secret — exactly the failure a broker
 * connection cap would produce. Prose in a comment cannot catch that at
 * runtime, so emit one line on stderr instead. bin/run-hook.sh captures
 * hook stderr, so `grep secret-guard ...` answers "is the guard degraded?"
 * without anyone having to reason about connection budgets.
 *
 * One aggregate line, not one per key: bounded output regardless of vault
 * size. stderr only — stdout is the hook's decision channel and must stay
 * empty on allow.
 */
function warnOnUnreachableGets(unreachable, total) {
  if (unreachable <= 0) return
  try {
    process.stderr.write(
      `secret-guard-pretool: DEGRADED — ${unreachable}/${total} vault `
      + `key(s) unresolved within the ${BROKER_TIMEOUT_MS}ms deadline `
      + `(no broker response: deadline expired, connection refused, or `
      + `socket error). Those secrets are NOT guarded for this tool call. `
      + `Likely causes: broker CPU saturation (per-request bcrypt in `
      + `validateGrant), or a broker connection cap below `
      + `MAX_CONCURRENT_GETS (currently ${MAX_CONCURRENT_GETS}).\n`,
    )
  } catch { /* stderr closed — never let logging change the decision */ }
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
    // The reason is read by the model. It must be CORRECT and actionable:
    // earlier versions said "reference it as vault:<key> instead", which
    // suggested a `vault:` resolver that does not exist for tool arguments
    // — sending agents (and operators) chasing a phantom mechanism. State
    // the two real resolutions instead, and do NOT imply a resolver.
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          `Blocked: this tool input contains the value of vault secret '${hit.key}'. ` +
          `Secrets must never appear in a tool call. ` +
          `If '${hit.key}' is a real secret, do not pass it as an argument — the launcher injects it into the tool's environment, so you never type it. ` +
          `If '${hit.key}' is actually a public identifier (e.g. an account or customer ID that must appear in the call), it should not be in the vault — ask the operator to move it to plain config.`,
      }),
    )
    process.exit(0)
  }
  process.exit(0)
}

main().catch(() => process.exit(0))
