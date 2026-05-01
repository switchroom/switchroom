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
}

/**
 * Stand up a minimal NDJSON broker. Responds to `list` with the supplied
 * keys, and to `get` requests with the entry shape Telegram-plugin expects.
 */
function startFakeBroker(values: Record<string, string>): Promise<FakeBroker> {
  return new Promise((resolveStart) => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-broker-'))
    const socketPath = join(dir, 'broker.sock')
    let connectionCount = 0
    const server: Server = createServer((sock: Socket) => {
      connectionCount++
      let buf = ''
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          let req
          try { req = JSON.parse(line) } catch { continue }
          if (req?.op === 'list') {
            sock.write(JSON.stringify({ ok: true, keys: Object.keys(values) }) + '\n')
          } else if (req?.op === 'get' && typeof req.key === 'string') {
            const v = values[req.key]
            if (v !== undefined) {
              sock.write(JSON.stringify({ ok: true, entry: { kind: 'string', value: v } }) + '\n')
            } else {
              sock.write(JSON.stringify({ ok: false, code: 'UNKNOWN_KEY', msg: req.key }) + '\n')
            }
          }
        }
      })
    })
    server.listen(socketPath, () => {
      resolveStart({
        socketPath,
        get connectionCount() { return connectionCount },
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
}): Promise<{ stdout: string; stderr: string; status: number }> {
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
    const child = spawn('node', [HOOK_PATH], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (status) => {
      resolveRun({ stdout, stderr, status: status ?? 1 })
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
    expect(r.stdout).toContain('vault:gh-token')
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

  it('opens a single broker connection per invocation (no per-key forks)', async () => {
    broker = await startFakeBroker({
      'a': 'aaaaaaaa-secret-value-aaaaaaaa',
      'b': 'bbbbbbbb-secret-value-bbbbbbbb',
      'c': 'cccccccc-secret-value-cccccccc',
    })
    await runHook({
      toolInput: { command: 'echo hi' },
      brokerSocket: broker.socketPath,
    })
    // The hook must keep one socket connection open and pipeline list +
    // N get requests over it. Forking a child per key was the old shape
    // and is what this PR fixes.
    expect(broker.connectionCount).toBe(1)
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
