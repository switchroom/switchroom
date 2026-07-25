/**
 * Integration tests for telegram-plugin/hooks/secret-guard-pretool.mjs.
 *
 * The hook must:
 *   - Connect to the vault broker over unix socket and load all string-kind
 *     entries.
 *   - Block (decision: "block") when tool_input contains any loaded value
 *     verbatim.
 *   - Allow when tool_input contains none of the values.
 *   - Fail open when the broker is unreachable (no socket, ECONNREFUSED,
 *     timeout, locked broker).
 *
 * We run the hook as a child process and stand up a fake NDJSON broker on
 * a tmpdir socket — this is the same protocol shape the production broker
 * speaks (see src/vault/broker/protocol.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'

const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'secret-guard-pretool.mjs')

interface FakeBroker {
  socketPath: string
  stop: () => Promise<void>
  connectionCount: number
  /** High-water mark of `get` requests being serviced simultaneously. */
  maxConcurrentGets: number
}

/**
 * Stand up a minimal NDJSON broker. Responds to `list` with the supplied
 * keys, and to `get` requests with the entry shape Telegram-plugin expects.
 */
function startFakeBroker(
  values: Record<string, string>,
  opts: {
    /** Artificial per-request service delay, ms. Models the real broker's
     *  round-trip cost so a sequential implementation is distinguishable
     *  from a concurrent one by wall clock. */
    delayMs?: number
    /** Keys whose `get` should return DENIED instead of a value. */
    denyKeys?: string[]
    /** Keys whose `get` should never be answered at all (socket left open). */
    hangKeys?: string[]
  } = {},
): Promise<FakeBroker> {
  return new Promise((resolveStart) => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-broker-'))
    const socketPath = join(dir, 'broker.sock')
    const delayMs = opts.delayMs ?? 0
    const denyKeys = new Set(opts.denyKeys ?? [])
    const hangKeys = new Set(opts.hangKeys ?? [])
    let connectionCount = 0
    let inFlightGets = 0
    let maxConcurrentGets = 0
    const server: Server = createServer((sock: Socket) => {
      connectionCount++
      let buf = ''
      sock.on('error', () => { /* client destroys sockets after one turn */ })
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          let req
          try { req = JSON.parse(line) } catch { continue }
          const isGet = req?.op === 'get'
          if (isGet) {
            inFlightGets++
            if (inFlightGets > maxConcurrentGets) maxConcurrentGets = inFlightGets
          }
          const reply = (obj: unknown) => {
            setTimeout(() => {
              if (isGet) inFlightGets--
              try { sock.write(JSON.stringify(obj) + '\n') } catch { /* closed */ }
            }, delayMs)
          }
          if (req?.op === 'list') {
            reply({ ok: true, keys: Object.keys(values) })
          } else if (isGet && typeof req.key === 'string') {
            if (hangKeys.has(req.key)) continue // never reply, never decrement
            const v = values[req.key]
            if (denyKeys.has(req.key)) {
              reply({ ok: false, code: 'DENIED', msg: req.key })
            } else if (v !== undefined) {
              reply({ ok: true, entry: { kind: 'string', value: v } })
            } else {
              reply({ ok: false, code: 'UNKNOWN_KEY', msg: req.key })
            }
          }
        }
      })
    })
    server.listen(socketPath, () => {
      resolveStart({
        socketPath,
        get connectionCount() { return connectionCount },
        get maxConcurrentGets() { return maxConcurrentGets },
        stop: () => new Promise<void>((stopResolve) => {
          server.close(() => {
            try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
            stopResolve()
          })
        }),
      })
    })
  })
}

/**
 * Run the hook as a child process. Async (NOT spawnSync) so the in-process
 * fake broker's event loop keeps spinning and can accept the child's
 * connection — spawnSync would block the parent and the broker would never
 * service the request.
 */
function runHook(opts: {
  toolInput: unknown
  brokerSocket?: string | null
}): Promise<{ stdout: string; stderr: string; status: number; elapsedMs: number }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_PATH: process.env.NODE_PATH ?? '',
    HOME: process.env.HOME ?? '',
  }
  if (opts.brokerSocket != null) {
    env.SWITCHROOM_VAULT_BROKER_SOCK = opts.brokerSocket
  }
  const stdinJson = JSON.stringify({
    session_id: 'test',
    tool_name: 'Bash',
    tool_input: opts.toolInput,
  })
  return new Promise((resolveRun) => {
    const t0 = Date.now()
    const child = spawn('node', [HOOK_PATH], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (status) => {
      resolveRun({ stdout, stderr, status: status ?? 1, elapsedMs: Date.now() - t0 })
    })
    child.stdin.end(stdinJson)
  })
}

let broker: FakeBroker | null = null

afterEach(async () => {
  if (broker) {
    await broker.stop()
    broker = null
  }
})

describe('secret-guard-pretool.mjs (broker-direct)', () => {
  it('blocks when tool_input contains a vaulted value', async () => {
    broker = await startFakeBroker({ 'gh-token': 'ghp_secret_token_12345' })
    const r = await runHook({
      toolInput: { command: 'curl -H "Authorization: Bearer ghp_secret_token_12345" https://api.github.com/' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"decision":"block"')
    // The reason must name the offending key and explain the real fix.
    expect(r.stdout).toContain('gh-token')
    expect(r.stdout).toContain('Secrets must never appear in a tool call')
    // It must NOT resurrect the old, misleading "reference it as vault:<key>"
    // suggestion — there is no vault: resolver for tool arguments, and that
    // advice sent agents down a dead end (see the hook's block-reason note).
    expect(r.stdout).not.toContain('reference it as vault:')
  })

  it('allows when tool_input contains no vaulted value', async () => {
    broker = await startFakeBroker({ 'gh-token': 'ghp_secret_token_12345' })
    const r = await runHook({
      toolInput: { command: 'ls -la' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('fails open when the broker socket does not exist', async () => {
    const r = await runHook({
      toolInput: { command: 'echo hello' },
      brokerSocket: '/tmp/no-such-broker-' + Date.now() + '.sock',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('issues the per-key gets concurrently, not one at a time (#3543)', async () => {
    // The old implementation awaited each `get` before sending the next, so
    // its cost was 1 + N round trips. The fan-out must have several gets in
    // flight at the same time. This asserts the OUTCOME (overlapping
    // in-flight requests observed by the broker), not that a particular
    // function was called.
    broker = await startFakeBroker({
      'a': 'aaaaaaaa-secret-value-aaaaaaaa',
      'b': 'bbbbbbbb-secret-value-bbbbbbbb',
      'c': 'cccccccc-secret-value-cccccccc',
      'd': 'dddddddd-secret-value-dddddddd',
    }, { delayMs: 40 })
    await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    expect(broker.maxConcurrentGets).toBe(4)
  })

  it('total cost is ~2 round trips, not 1 + N (#3543)', async () => {
    // 8 keys at a 40ms service delay. Sequential => >= 9 * 40 = 360ms of
    // broker time. Concurrent => ~2 * 40 = 80ms. The 250ms ceiling sits far
    // below the sequential floor and far above the concurrent cost plus
    // node startup, so it discriminates the two without being flaky.
    const values: Record<string, string> = {}
    for (let i = 0; i < 8; i++) values['k' + i] = `secret-value-number-${i}-xxxxxxxx`
    broker = await startFakeBroker(values, { delayMs: 40 })
    const r = await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.elapsedMs).toBeLessThan(250)
  })

  it('does not fork a child process per key', async () => {
    // The generation-1 shape forked `switchroom vault get` per key. The
    // broker must see exactly one connection per request turn and the hook
    // must speak the socket itself — so connections are bounded by 1 + N,
    // and no `switchroom` binary is required on PATH at all (the env we
    // hand the child has no SWITCHROOM_CLI_PATH).
    broker = await startFakeBroker({
      'a': 'aaaaaaaa-secret-value-aaaaaaaa',
      'b': 'bbbbbbbb-secret-value-bbbbbbbb',
      'c': 'cccccccc-secret-value-cccccccc',
    })
    await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    // 1 list + 3 gets, one request per connection (the shape the broker
    // protocol documents; see protocol.ts:8-11).
    expect(broker.connectionCount).toBe(4)
  })

  it('still blocks on the other keys when one key is DENIED', async () => {
    // Security posture: a per-key failure must not disable the guard for
    // the keys that DID resolve. This is the case the sequential version
    // handled with `continue`; the fan-out must preserve it.
    broker = await startFakeBroker({
      'denied-key': 'denied-secret-value-aaaaaaaa',
      'live-key': 'live-secret-value-bbbbbbbb',
    }, { denyKeys: ['denied-key'] })
    const r = await runHook({
      toolInput: { command: 'echo live-secret-value-bbbbbbbb' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"decision":"block"')
    expect(r.stdout).toContain('live-key')
  })

  it('still blocks on resolved keys when another key never responds', async () => {
    // A hung `get` used to stall the whole sequential loop until the 1500ms
    // deadline and then discard EVERY value (fail open). Now the other keys
    // resolve independently and are still guarded.
    broker = await startFakeBroker({
      'hung-key': 'hung-secret-value-aaaaaaaa',
      'live-key': 'live-secret-value-bbbbbbbb',
    }, { hangKeys: ['hung-key'] })
    const r = await runHook({
      toolInput: { command: 'echo live-secret-value-bbbbbbbb' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"decision":"block"')
    expect(r.stdout).toContain('live-key')
  }, 10_000)

  it('fails open when the broker denies `list`', async () => {
    // No key set is knowable => nothing to guard against => allow. Same as
    // the sequential version; asserted so a refactor cannot silently turn
    // this into a hard block that wedges every session.
    const dir = mkdtempSync(join(tmpdir(), 'deny-broker-'))
    const socketPath = join(dir, 'broker.sock')
    const server = createServer((sock: Socket) => {
      sock.on('error', () => {})
      sock.on('data', () => {
        sock.write(JSON.stringify({ ok: false, code: 'LOCKED', msg: 'locked' }) + '\n')
      })
    })
    await new Promise<void>((r) => server.listen(socketPath, () => r()))
    try {
      const res = await runHook({ toolInput: { command: 'echo hi' }, brokerSocket: socketPath })
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips values shorter than the minimum guard length', async () => {
    // Values < 8 chars are excluded — too short to be a meaningful secret
    // and would false-positive-block obvious tool inputs.
    broker = await startFakeBroker({ 'short': 'abc', 'long': 'this-is-long-enough-to-guard' })
    const r = await runHook({
      toolInput: { command: 'echo abc' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('does nothing when stdin is empty (claude smoke check)', () => {
    const r = spawnSync('node', [HOOK_PATH], {
      input: '',
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf-8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout ?? '').toBe('')
  })
})
