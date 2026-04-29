/**
 * Tests for #309: boot card uses the agent slug (not display name) for
 * systemd unit probes.
 *
 * Root cause: probeAgentProcess and probeCronTimers were called with
 * opts.agentName (the persona display name, e.g. "Klanker") instead of
 * the lowercase slug ("klanker"). systemctl returns LoadState=not-found
 * for the capitalised name because unit files are always lowercase.
 *
 * Fix: RunProbesOpts.agentSlug carries the slug separately; runAllProbes
 * passes opts.agentSlug (falling back to opts.agentName for compat) to
 * both probeAgentProcess and probeCronTimers.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

import { runAllProbes } from '../gateway/boot-card.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

type ExecFileResult = { stdout: string; stderr: string }
type RecordedCall = { cmd: string; args: string[] }

/**
 * Build an execFile mock that records every (cmd, args) call and dispatches
 * the response based on which systemctl sub-command is being called.
 *
 * `show`       → responds with a valid "active" systemctl kv blob so that
 *               probeAgentProcess resolves immediately without retrying.
 * `list-timers`→ responds with empty JSON array (0 timers).
 * anything else→ responds with empty stdout.
 */
function makeDispatchingExecFile(slug: string): {
  fn: (cmd: string, args: string[]) => Promise<ExecFileResult>
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  return {
    fn: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      if (cmd === 'systemctl') {
        if (args.includes('show')) {
          // Return a valid active systemd kv blob so probeAgentProcess exits
          // immediately on the first call (no retry needed).
          return {
            stdout: [
              'MainPID=9999',
              'ActiveState=active',
              'MemoryCurrent=52428800',
              'ActiveEnterTimestamp=1700000000000000',
            ].join('\n') + '\n',
            stderr: '',
          }
        }
        if (args.includes('list-timers')) {
          return { stdout: '[]', stderr: '' }
        }
      }
      return { stdout: '', stderr: '' }
    },
    calls,
  }
}

// ── Core probe-target tests ───────────────────────────────────────────────────

describe('#309: runAllProbes — slug vs display name for systemd calls', () => {
  function makeTmpAgentDir(): string {
    return mkdtempSync(join(tmpdir(), 'switchroom-test-'))
  }

  it('probeAgentProcess target is switchroom-<slug>.service, not switchroom-<displayName>.service', async () => {
    const tmpDir = makeTmpAgentDir()
    try {
      const { fn: execFileMock, calls } = makeDispatchingExecFile('klanker')

      await runAllProbes({
        agentName: 'Klanker',   // persona display name — capitalised
        agentSlug: 'klanker',   // systemd slug — lowercase
        version: 'v0.3.0',
        agentDir: tmpDir,
        gatewayInfo: { pid: 12345, startedAtMs: Date.now() },
        fetchImpl: async () => new Response('', { status: 200 }),
        settleWindowMs: 0,
        agentLiveWindowMs: 0,   // disable live loop
        probeExecFileImpl: execFileMock,
      })

      // probeAgentProcess calls: systemctl --user show switchroom-<name>.service -p ...
      const agentProbeCall = calls.find(c =>
        c.cmd === 'systemctl' && c.args.includes('show'),
      )
      expect(agentProbeCall, 'probeAgentProcess must call systemctl show').toBeDefined()
      const unitArg = agentProbeCall!.args.find(a => a.startsWith('switchroom-'))
      // Must use the slug, not the capitalised display name.
      expect(unitArg).toBe('switchroom-klanker.service')
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('probeCronTimers target is switchroom-<slug>-cron-*, not switchroom-<displayName>-cron-*', async () => {
    const tmpDir = makeTmpAgentDir()
    try {
      const { fn: execFileMock, calls } = makeDispatchingExecFile('klanker')

      await runAllProbes({
        agentName: 'Klanker',
        agentSlug: 'klanker',
        version: 'v0.3.0',
        agentDir: tmpDir,
        gatewayInfo: { pid: 12345, startedAtMs: Date.now() },
        fetchImpl: async () => new Response('', { status: 200 }),
        settleWindowMs: 0,
        agentLiveWindowMs: 0,
        probeExecFileImpl: execFileMock,
      })

      // probeCronTimers calls: systemctl --user list-timers switchroom-<name>-cron-*
      const cronProbeCall = calls.find(c =>
        c.cmd === 'systemctl' && c.args.includes('list-timers'),
      )
      expect(cronProbeCall, 'probeCronTimers must call systemctl list-timers').toBeDefined()
      const cronGlob = cronProbeCall!.args.find(a => a.includes('cron'))
      expect(cronGlob).toBe('switchroom-klanker-cron-*')
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('no systemctl call uses the capitalised display name as the unit target', async () => {
    const tmpDir = makeTmpAgentDir()
    try {
      const { fn: execFileMock, calls } = makeDispatchingExecFile('klanker')

      await runAllProbes({
        agentName: 'Klanker',
        agentSlug: 'klanker',
        version: 'v0.3.0',
        agentDir: tmpDir,
        gatewayInfo: { pid: 12345, startedAtMs: Date.now() },
        fetchImpl: async () => new Response('', { status: 200 }),
        settleWindowMs: 0,
        agentLiveWindowMs: 0,
        probeExecFileImpl: execFileMock,
      })

      const systemctlCalls = calls.filter(c => c.cmd === 'systemctl')
      expect(systemctlCalls.length, 'execFileMock must be called at least once').toBeGreaterThan(0)

      for (const call of systemctlCalls) {
        for (const arg of call.args) {
          expect(
            arg,
            `systemctl was invoked with arg "${arg}" which contains the display name "Klanker" — expected slug "klanker"`,
          ).not.toContain('Klanker')
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })

  it('falls back to agentName when agentSlug is not provided (backwards compat)', async () => {
    const tmpDir = makeTmpAgentDir()
    try {
      const { fn: execFileMock, calls } = makeDispatchingExecFile('myagent')

      await runAllProbes({
        agentName: 'myagent',
        // no agentSlug — should fall back to agentName
        version: 'v0.3.0',
        agentDir: tmpDir,
        gatewayInfo: { pid: 12345, startedAtMs: Date.now() },
        fetchImpl: async () => new Response('', { status: 200 }),
        settleWindowMs: 0,
        agentLiveWindowMs: 0,
        probeExecFileImpl: execFileMock,
      })

      const agentProbeCall = calls.find(c =>
        c.cmd === 'systemctl' && c.args.includes('show'),
      )
      expect(agentProbeCall, 'probeAgentProcess must call systemctl show').toBeDefined()
      const unitArg = agentProbeCall!.args.find(a => a.startsWith('switchroom-'))
      expect(unitArg).toBe('switchroom-myagent.service')
    } finally {
      rmSync(tmpDir, { recursive: true })
    }
  })
})
