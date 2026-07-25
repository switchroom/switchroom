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
import { mkdtempSync, rmSync, unlinkSync, existsSync, writeFileSync, chmodSync } from 'node:fs'
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
    /** Artificial per-request service delay, ms, implemented with
     *  setTimeout. This models NETWORK/IO latency only — it does NOT occupy
     *  the broker's event loop, so it makes client-side fan-out look like a
     *  pure win. Use `cpuMs` for the honest model of the real broker. */
    delayMs?: number
    /** Artificial per-request SYNCHRONOUS CPU cost, ms. This is what the
     *  real broker actually does: every tokened request awaits a
     *  `bcryptjs.compare` (src/vault/grants.ts, BCRYPT_COST=10), and
     *  bcryptjs is pure JS that blocks the event loop — measured ~57ms per
     *  compare, with 8 "concurrent" compares taking 459ms (fully
     *  serialized). A busy-wait reproduces that; a setTimeout does not. */
    cpuMs?: number
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
    const cpuMs = opts.cpuMs ?? 0
    /** Block the event loop for `cpuMs`, the way bcryptjs.compare does. */
    const burnCpu = () => {
      if (cpuMs <= 0) return
      const until = Date.now() + cpuMs
      while (Date.now() < until) { /* deliberate busy-wait */ }
    }
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
          // The real broker awaits validateGrant -> bcryptjs.compare BEFORE
          // it can reply, and that call blocks its single event loop. Burn
          // here, synchronously, for the same reason and at the same point.
          burnCpu()
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
  /** Prepended to the child's PATH — used to plant a `switchroom` shim. */
  pathPrefix?: string
}): Promise<{ stdout: string; stderr: string; status: number; elapsedMs: number }> {
  const basePath = process.env.PATH ?? ''
  const env: Record<string, string> = {
    PATH: opts.pathPrefix ? `${opts.pathPrefix}:${basePath}` : basePath,
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

/**
 * Plant an executable `switchroom` on a fresh directory that records every
 * invocation by touching a sentinel file, then returns a plausible-looking
 * success so a forking implementation would appear to work (and therefore
 * would NOT be caught by the block/allow assertions alone).
 *
 * Returns the directory to prepend to PATH and the sentinel path.
 */
function plantSwitchroomShim(): { dir: string; sentinel: string } {
  // NOT under os.tmpdir(): /tmp is mounted `noexec` in the agent containers
  // this suite runs in (verified 2026-07-25 — `findmnt -no OPTIONS /tmp` =>
  // `rw,nosuid,nodev,noexec`). A shim planted there is silently unrunnable,
  // which would make the no-fork assertion below vacuously true — the exact
  // class of bug this test exists to close. Plant it beside the test file,
  // on the repo filesystem, which is executable.
  const dir = mkdtempSync(join(__dirname, '.shim-'))
  const sentinel = join(dir, 'FORKED')
  const shim = join(dir, 'switchroom')
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${sentinel}"\nexit 0\n`)
  chmodSync(shim, 0o755)

  // Self-check: prove the shim is REACHABLE and RECORDS, so "sentinel
  // absent" can only ever mean "the hook did not fork" — never "the shim
  // could not run". Without this the test can go vacuous again the moment
  // it runs on a noexec mount.
  const probe = spawnSync('switchroom', ['self-check'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
  })
  if (probe.status !== 0 || !existsSync(sentinel)) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(
      `no-fork shim is not executable (status=${probe.status}, `
      + `error=${probe.error?.message ?? 'none'}) — the no-fork assertion `
      + `would be vacuous. Fix the shim location, do not skip this test.`,
    )
  }
  unlinkSync(sentinel)

  return { dir, sentinel }
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
    // Deliberately NOT a wall-clock assertion. The earlier version of this
    // test asserted elapsedMs < 250; measured node cold start for this hook
    // is 104-127ms on an idle box and this suite runs under `bun test` on a
    // 2-vCPU CI runner alongside the rest of telegram-plugin/tests, so a
    // 250ms ceiling had ~65ms of headroom and would have flaked (#3574
    // review F3).
    //
    // `maxConcurrentGets` is the timing-INDEPENDENT discriminator for the
    // same property: the sequential 1 + N implementation could never exceed
    // 1 in flight no matter how fast or slow the box is, while the fan-out
    // has all 8 outstanding at once. Same guarantee, zero clock dependence.
    const values: Record<string, string> = {}
    for (let i = 0; i < 8; i++) values['k' + i] = `secret-value-number-${i}-xxxxxxxx`
    broker = await startFakeBroker(values, { delayMs: 40 })
    const r = await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(broker.maxConcurrentGets).toBe(8)
    // 1 list + 8 gets, one request per connection.
    expect(broker.connectionCount).toBe(9)
  })

  it('client fan-out does NOT reduce wall time against a CPU-bound broker (#3574)', async () => {
    // The honest counterpart to the test above. The `delayMs` fake sleeps,
    // so it credits the fan-out with a speedup that CANNOT exist against
    // the real broker, whose per-request cost is a synchronous, event-loop-
    // blocking `bcryptjs.compare` inside validateGrant. `cpuMs` reproduces
    // that.
    //
    // Asserted property: with a CPU-bound broker the client's concurrency
    // is irrelevant to wall time — total cost is still ~(N+1) × cpuMs,
    // i.e. STRICTLY MORE than the serialized floor. This is a lower bound
    // (>=), so it cannot flake upward on a loaded runner; it fails only if
    // someone re-introduces the false "concurrency makes it O(1)" model.
    // This is a DIFFERENTIAL, not an absolute budget, for the reason F3
    // flagged: an absolute wall-clock ceiling has to leave room for node
    // cold start (measured 104-127ms for this hook on an idle box) and
    // flakes on a loaded CI runner. Running the SAME hook against both
    // broker models subtracts node startup and every other fixed cost
    // automatically — the baseline is measured, not assumed.
    //
    //   sleeping broker (delayMs): fan-out wins   => ~startup + 2 × COST
    //   CPU-bound broker (cpuMs):  fan-out cannot => ~startup + (N+1) × COST
    //
    // so the gap should be ~(N-1) × COST = 160ms. We assert only that it
    // exceeds 2 × COST (80ms): if concurrency helped a CPU-bound broker the
    // way it helps a sleeping one, the gap would be ~0. Load inflates both
    // runs, so the LOWER bound on a difference is what stays stable.
    const N = 5
    const COST_MS = 40
    const values: Record<string, string> = {}
    for (let i = 0; i < N; i++) values['c' + i] = `cpu-secret-value-${i}-xxxxxxxx`

    const sleepy = await startFakeBroker(values, { delayMs: COST_MS })
    let sleepyMs: number
    try {
      const rs = await runHook({ toolInput: { command: 'echo hi' }, brokerSocket: sleepy.socketPath })
      expect(rs.status).toBe(0)
      sleepyMs = rs.elapsedMs
    } finally {
      await sleepy.stop()
    }

    broker = await startFakeBroker(values, { cpuMs: COST_MS })
    const r = await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.elapsedMs - sleepyMs).toBeGreaterThan(2 * COST_MS)
    // And the guard must still be COMPLETE despite that cost: every key
    // resolved within the deadline, including the last. Partial coverage is
    // the security failure mode this whole area is about.
    expect(broker.connectionCount).toBe(N + 1)
    expect(r.stderr).not.toContain('DEGRADED')
  }, 20_000)

  it('caps the fan-out at MAX_CONCURRENT_GETS and still guards every key past the cap', async () => {
    // Two properties the fan-out owes us on a vault larger than the cap
    // (MAX_CONCURRENT_GETS = 32), both timing-independent:
    //   1. the cap is real — 40 keys must never put more than 32 gets in
    //      flight (an unbounded fan-out would show 40);
    //   2. the batch loop drains the remainder — key #40, which can only be
    //      fetched in the second batch, is still guarded.
    const values: Record<string, string> = {}
    for (let i = 0; i < 40; i++) values['k' + i] = `secret-value-number-${i}-xxxxxxxxxx`
    broker = await startFakeBroker(values, { delayMs: 40 })
    const r = await runHook({
      // k39 is the 40th key — past the first batch of 32.
      toolInput: { command: 'echo secret-value-number-39-xxxxxxxxxx' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('"decision":"block"')
    expect(r.stdout).toContain('k39')
    expect(broker.maxConcurrentGets).toBeLessThanOrEqual(32)
    expect(broker.maxConcurrentGets).toBeGreaterThan(1)
    expect(broker.connectionCount).toBe(41)
  }, 10_000)

  it('does not fork a child process per key', async () => {
    // The generation-1 shape forked `switchroom vault get` per key. Asserting
    // a connection COUNT cannot prove that — a fork-per-key implementation
    // produces the same 1 + N connections, because each forked CLI opens its
    // own (#3574 review F2). So plant an executable `switchroom` on PATH that
    // records every invocation and assert it was never invoked.
    const { dir, sentinel } = plantSwitchroomShim()
    try {
      broker = await startFakeBroker({
        'a': 'aaaaaaaa-secret-value-aaaaaaaa',
        'b': 'bbbbbbbb-secret-value-bbbbbbbb',
        'c': 'cccccccc-secret-value-cccccccc',
      })
      await runHook({
        toolInput: { command: 'echo hi' },
        brokerSocket: broker.socketPath,
        pathPrefix: dir,
      })
      // The shim is genuinely reachable and would have fired — the hook
      // simply never shells out. (It exits 0 with plausible output, so a
      // forking implementation would still allow/block correctly and could
      // only be caught here.)
      expect(existsSync(sentinel)).toBe(false)
      // Secondary: the hook speaks the socket itself, one request per
      // connection turn (the shape protocol.ts:8-11 documents).
      expect(broker.connectionCount).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logs a DEGRADED line when a `get` gets no broker response (#3574)', async () => {
    // The fan-out silently drops any key whose `get` never returns, and a
    // dropped key is an unguarded secret. That is exactly what a broker
    // connection cap would cause (this hook needs N+1 connections where the
    // sequential version needed 1). Prose in a comment can't catch it, so
    // the hook must leave a deterministic trace on stderr.
    broker = await startFakeBroker({
      'hung-key': 'hung-secret-value-aaaaaaaa',
      'live-key': 'live-secret-value-bbbbbbbb',
    }, { hangKeys: ['hung-key'] })
    const r = await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('DEGRADED')
    expect(r.stderr).toContain('1/2')
    // Decision channel stays clean — the warning must not leak to stdout,
    // where Claude Code parses the block decision.
    expect(r.stdout).toBe('')
  }, 10_000)

  it('does not log DEGRADED when every key resolves', async () => {
    // Guards the inverse: a DENIED reply is a broker ANSWER, not an
    // unreachable connection, so it must not raise the degradation signal
    // (otherwise the line is noise and gets ignored).
    broker = await startFakeBroker({
      'denied-key': 'denied-secret-value-aaaaaaaa',
      'live-key': 'live-secret-value-bbbbbbbb',
    }, { denyKeys: ['denied-key'] })
    const r = await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('DEGRADED')
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
