/**
 * switchroom#4641 — the agent-process identity record start.sh publishes
 * immediately before `exec claude`.
 *
 * The gateway's whole ability to tell "the agent restarted" from "only I
 * restarted" rests on this record being (a) correct for the process that
 * becomes claude and (b) written before the exec. Both are properties of
 * SHELL, so this test EXECUTES the block extracted from the template rather
 * than pattern-matching it, and then checks the emitted JSON against the real
 * `/proc` entry of the shell that ran it.
 *
 * The load-bearing subtlety it guards: `exec` REPLACES the shell without
 * forking, so the pid AND `/proc/<pid>/stat` field 22 (starttime, assigned at
 * fork) survive into claude unchanged — which is why start.sh can record them
 * before the exec at all. `comm` does NOT survive, which is why the record
 * deliberately omits it. The final case proves both halves against a real
 * `exec`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEMPLATE = join(__dirname, '..', 'profiles', '_base', 'start.sh.hbs')
const START_MARKER = '# --- Agent-process identity record (switchroom#4641) ---'

/** The record block, with the one handlebars token resolved. */
function extractBlock(agentDir: string): string {
  const src = readFileSync(TEMPLATE, 'utf-8')
  const start = src.indexOf(START_MARKER)
  expect(start, 'agent-process record block not found in start.sh.hbs')
    .toBeGreaterThanOrEqual(0)
  const end = src.indexOf('{{#if useSwitchroomPlugin}}', start)
  expect(end, 'exec block not found after the record block').toBeGreaterThan(start)
  const block = src.slice(start, end)
  // The only handlebars token in the block is the agent dir fallback.
  expect(block.match(/\{\{[^}]+\}\}/g)).toEqual(['{{agentDir}}'])
  return block.replaceAll('{{agentDir}}', agentDir)
}

let dir: string
let block: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-record-'))
  block = extractBlock(dir)
})

function runBlock(script: string, env: NodeJS.ProcessEnv = {}): string {
  const p = join(dir, 'run.sh')
  writeFileSync(p, `#!/bin/bash\n${block}\n${script}\n`)
  return execFileSync('bash', [p], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

function recordPath(stateDir: string): string {
  return join(stateDir, 'agent-process.json')
}

describe('start.sh agent-process record (#4641)', () => {
  it('records the running shell\'s real pid and /proc starttime', () => {
    const stateDir = join(dir, 'telegram-a')
    const out = runBlock('echo "$$ $(awk \'{print $22}\' /proc/$$/stat)"', {
      TELEGRAM_STATE_DIR: stateDir,
    })
    const [pid, starttime] = out.trim().split(/\s+/)

    const rec = JSON.parse(readFileSync(recordPath(stateDir), 'utf-8'))
    expect(rec.pid).toBe(Number(pid))
    // Independently derived (awk field 22) — not a re-read of what we wrote.
    expect(rec.starttime).toBe(starttime)
    expect(typeof rec.boot_at).toBe('number')
    // comm is deliberately absent: it is "bash" here and becomes claude's
    // after the exec, so recording it would guarantee a mismatch.
    expect(rec).not.toHaveProperty('comm')
  })

  it('parses starttime correctly even when comm contains a space and a paren', () => {
    // Rename the shell's own comm via /proc/self/comm-adjacent trick: run the
    // block from a bash whose argv0 makes comm hostile. `exec -a` sets argv[0];
    // the kernel derives comm from it for the exec'd binary.
    const stateDir = join(dir, 'telegram-paren')
    const p = join(dir, 'inner.sh')
    writeFileSync(p, `#!/bin/bash\n${block}\necho "$(awk '{print $22}' /proc/$$/stat)"\n`)
    const out = execFileSync(
      'bash',
      ['-c', `exec -a 'we ) ird' bash ${JSON.stringify(p)}`],
      { encoding: 'utf-8', env: { ...process.env, TELEGRAM_STATE_DIR: stateDir } },
    )
    const rec = JSON.parse(readFileSync(recordPath(stateDir), 'utf-8'))
    expect(rec.starttime).toBe(out.trim())
  })

  it('exports the pid/starttime into the environment claude inherits', () => {
    const stateDir = join(dir, 'telegram-env')
    const out = runBlock('echo "$SWITCHROOM_AGENT_PID/$SWITCHROOM_AGENT_STARTTIME"; echo "$$"', {
      TELEGRAM_STATE_DIR: stateDir,
    })
    const [exported, pid] = out.trim().split('\n')
    const rec = JSON.parse(readFileSync(recordPath(stateDir), 'utf-8'))
    expect(exported).toBe(`${pid}/${rec.starttime}`)
  })

  it('falls back to {{agentDir}}/telegram when TELEGRAM_STATE_DIR is unset', () => {
    const script = 'true'
    const p = join(dir, 'run-nofallback.sh')
    writeFileSync(p, `#!/bin/bash\n${block}\n${script}\n`)
    const env = { ...process.env }
    delete env.TELEGRAM_STATE_DIR
    execFileSync('bash', [p], { encoding: 'utf-8', env })
    expect(existsSync(recordPath(join(dir, 'telegram')))).toBe(true)
  })

  it('records identity that SURVIVES the exec into another program', () => {
    // The property the whole fix depends on: the record is written pre-exec,
    // and after `exec` the SAME pid carries the SAME starttime (only comm
    // changes). Recorded by the shell, verified against the exec'd process.
    const stateDir = join(dir, 'telegram-exec')
    const p = join(dir, 'exec.sh')
    writeFileSync(p, `#!/bin/bash\n${block}\nexec sleep 5\n`)
    const child = spawn('bash', [p], {
      stdio: 'ignore',
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
    })
    try {
      // Wait for the record, then read the post-exec /proc entry.
      const deadline = Date.now() + 5000
      while (!existsSync(recordPath(stateDir)) && Date.now() < deadline) {
        execFileSync('sleep', ['0.05'])
      }
      const rec = JSON.parse(readFileSync(recordPath(stateDir), 'utf-8'))
      // Give the exec a moment to land.
      execFileSync('sleep', ['0.3'])
      const stat = readFileSync(`/proc/${rec.pid}/stat`, 'utf-8')
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)
      expect(rec.pid).toBe(child.pid)
      expect(fields[19]).toBe(rec.starttime) // starttime survived the exec
      expect(stat).toContain('(sleep)') // …and comm did NOT
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('opens a fresh boot-resume generation before the gateway is forked', () => {
    // The generation token is the whole #4641 mechanism, and its meaning
    // ("a gateway in THIS container generation already finished its boot
    // resume") rests entirely on WHERE start.sh clears it: once per container
    // boot, in the outer docker pass, BEFORE the supervised gateway sidecar is
    // forked. Clear it after the fork and a respawned gateway could wipe its
    // own generation; clear it in the inner pass and the token would never
    // outlive a boot at all.
    const src = readFileSync(TEMPLATE, 'utf-8')
    const outerPass = src.indexOf(
      'if [ "$SWITCHROOM_RUNTIME" = "docker" ] && [ -z "$SWITCHROOM_DOCKER_TMUX_INNER" ]; then',
    )
    expect(outerPass, 'outer docker pass guard not found').toBeGreaterThan(-1)
    const clear = src.indexOf('rm -f "$TELEGRAM_STATE_DIR/.boot-resume-done"')
    const fork = src.indexOf('_switchroom_supervise gateway')
    const tmuxReexec = src.indexOf('exec tmux -L')
    expect(clear, '.boot-resume-done is never cleared').toBeGreaterThan(-1)
    expect(fork, 'gateway sidecar fork not found').toBeGreaterThan(-1)
    expect(clear).toBeGreaterThan(outerPass)
    expect(clear).toBeLessThan(fork)
    expect(fork).toBeLessThan(tmuxReexec) // …and the whole thing is the outer pass
    // The stale agent record from the previous container generation goes with
    // it: a container restart resets the pid namespace, so its (pid,
    // starttime) pair could collide with an unrelated live process.
    expect(src.slice(clear, src.indexOf('\n', clear))).toContain('agent-process.json')
    // Exactly one clear, so no second site can re-open a generation mid-boot.
    expect(src.split('rm -f "$TELEGRAM_STATE_DIR/.boot-resume-done"').length - 1).toBe(1)
  })

  it('actually deletes both files when that outer-pass line runs', () => {
    // Executed, not pattern-matched: `rm -f` on a path that does not exist
    // must also be a no-op that cannot fail the boot.
    const stateDir = join(dir, 'telegram-clear')
    execFileSync('mkdir', ['-p', stateDir])
    const token = join(stateDir, '.boot-resume-done')
    const record = join(stateDir, 'agent-process.json')
    writeFileSync(token, '{"pid":1}')
    writeFileSync(record, '{"pid":1,"starttime":"5"}')
    const src = readFileSync(TEMPLATE, 'utf-8')
    const clear = src.indexOf('rm -f "$TELEGRAM_STATE_DIR/.boot-resume-done"')
    const line = src.slice(clear, src.indexOf('\n', clear))
    const p = join(dir, 'clear.sh')
    writeFileSync(p, `#!/bin/bash\nset -e\n${line}\n${line}\n`)
    execFileSync('bash', [p], { env: { ...process.env, TELEGRAM_STATE_DIR: stateDir } })
    expect(existsSync(token)).toBe(false)
    expect(existsSync(record)).toBe(false)
  })

  it('is written immediately before the exec, never after it', () => {
    const src = readFileSync(TEMPLATE, 'utf-8')
    const marker = src.indexOf(START_MARKER)
    expect(marker).toBeGreaterThan(-1)
    // The first EXECUTABLE `exec claude` (the earlier hits are prose in
    // comments), and every executable one, must follow the record block.
    const execLines = [...src.matchAll(/^[ \t]*exec claude /gm)].map((m) => m.index!)
    expect(execLines.length).toBeGreaterThan(0)
    for (const at of execLines) expect(at).toBeGreaterThan(marker)
    // Nothing else may sneak an `exec` in between the record and the first one.
    expect(src.slice(marker, execLines[0])).not.toMatch(/^[ \t]*exec\s/m)
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
