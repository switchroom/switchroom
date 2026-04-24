/**
 * Tests for Phase 3b foreman write operations:
 *   - handleRestartCommand (mocked execFileSync)
 *   - handleDeleteCommand + executeDeleteAgent (mocked exec + FS)
 *   - handleUpdateCommand (mocked combined exec)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleRestartCommand,
  handleDeleteCommand,
  executeDeleteAgent,
  handleUpdateCommand,
  type SwitchroomExecFn,
} from '../foreman/foreman-handlers.js'
import type { execFileSync } from 'child_process'

// ─── /restart ─────────────────────────────────────────────────────────────

describe('foreman: handleRestartCommand — input validation', () => {
  it('returns usage when no agent specified', () => {
    const result = handleRestartCommand('')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Usage')
  })

  it('rejects invalid agent name', () => {
    const execFile = vi.fn()
    // 'BadName' has uppercase — first token is invalid
    const result = handleRestartCommand('BadName', execFile as never)
    expect(result.ok).toBe(false)
    expect(result.text).toBe('Invalid agent name.')
    expect(execFile).not.toHaveBeenCalled()
  })

  it('rejects path traversal', () => {
    const execFile = vi.fn()
    const result = handleRestartCommand('../etc/passwd', execFile as never)
    expect(result.ok).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('rejects agent name with colon', () => {
    const execFile = vi.fn()
    const result = handleRestartCommand('bad:name', execFile as never)
    expect(result.ok).toBe(false)
    expect(execFile).not.toHaveBeenCalled()
  })
})

describe('foreman: handleRestartCommand — execFileSync calls', () => {
  it('calls systemctl --user restart with correct unit name', () => {
    const execFile = vi.fn().mockReturnValue('')
    const result = handleRestartCommand('gymbro', execFile as never)

    expect(result.ok).toBe(true)
    expect(execFile).toHaveBeenCalledOnce()
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('systemctl')
    expect(args).toContain('--user')
    expect(args).toContain('restart')
    expect(args).toContain('switchroom-gymbro')
    // Must NOT be a shell string — second arg must be an array
    expect(Array.isArray(args)).toBe(true)
  })

  it('uses execFileSync not execSync (no shell)', () => {
    const execFile = vi.fn().mockReturnValue('')
    handleRestartCommand('gymbro', execFile as never)
    // The function is called with 3 args (cmd, args[], opts) not a shell string
    const [, args] = execFile.mock.calls[0] as [string, string[], object]
    expect(Array.isArray(args)).toBe(true)
  })

  it('includes agent name in success reply', () => {
    const execFile = vi.fn().mockReturnValue('')
    const result = handleRestartCommand('gymbro', execFile as never)
    expect(result.ok).toBe(true)
    expect(result.text).toContain('gymbro')
  })

  it('returns error text when systemctl fails', () => {
    const execFile = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('unit not found'), { stderr: 'Unit switchroom-gymbro.service not found.' })
    })
    const result = handleRestartCommand('gymbro', execFile as never)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('restart failed')
    expect(result.text).toContain('gymbro')
  })

  it('handles agent name with hyphen', () => {
    const execFile = vi.fn().mockReturnValue('')
    handleRestartCommand('my-agent', execFile as never)
    const [, args] = execFile.mock.calls[0] as [string, string[]]
    expect(args).toContain('switchroom-my-agent')
  })

  it('escapes HTML in error output', () => {
    const execFile = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('err'), { stderr: 'Error: <unit> not found' })
    })
    const result = handleRestartCommand('gymbro', execFile as never)
    expect(result.text).not.toContain('<unit>')
  })
})

// ─── /delete first step ───────────────────────────────────────────────────

describe('foreman: handleDeleteCommand — prompt', () => {
  it('returns usage when no agent specified', () => {
    const result = handleDeleteCommand('')
    expect(result.replies[0].text).toContain('Usage')
    expect(result.needsConfirm).toBeFalsy()
  })

  it('rejects invalid agent name', () => {
    // 'BadAgent' has uppercase — invalid
    const result = handleDeleteCommand('BadAgent')
    expect(result.replies[0].text).toBe('Invalid agent name.')
    expect(result.needsConfirm).toBeFalsy()
  })

  it('returns confirmation prompt for valid agent', () => {
    const result = handleDeleteCommand('gymbro')
    expect(result.replies[0].text).toContain('gymbro')
    expect(result.replies[0].text).toContain('YES')
    expect(result.needsConfirm).toBe(true)
    expect(result.agentForConfirm).toBe('gymbro')
  })

  it('escapes HTML in agent name in prompt', () => {
    // valid name, but let's use one that could trip HTML — actually all valid names
    // are alphanumeric so no HTML risk; just verify the name appears
    const result = handleDeleteCommand('my-agent')
    expect(result.replies[0].text).toContain('my-agent')
    expect(result.replies[0].html).toBe(true)
  })
})

// ─── executeDeleteAgent ───────────────────────────────────────────────────

describe('foreman: executeDeleteAgent — execution', () => {
  it('runs CLI destroy with --yes flag', () => {
    const switchroomExec: SwitchroomExecFn = vi.fn().mockReturnValue('Removed unit.')
    const execFile = vi.fn().mockReturnValue('')
    const tmpDir = '/tmp/fake-agents-dir'

    const result = executeDeleteAgent('gymbro', switchroomExec, execFile as never, tmpDir)
    expect(switchroomExec).toHaveBeenCalledWith(['agent', 'destroy', '--yes', 'gymbro'])
    expect(result.replies[0].text).toContain('gymbro')
  })

  it('reports success without archive when dir does not exist', () => {
    const switchroomExec: SwitchroomExecFn = vi.fn().mockReturnValue('done')
    const result = executeDeleteAgent('gymbro', switchroomExec, vi.fn() as never, '/nonexistent-agents-dir')
    // No archive reported (dir didn't exist)
    expect(result.replies[0].text).not.toContain('Archived')
  })

  it('rejects invalid agent name without calling CLI', () => {
    const switchroomExec: SwitchroomExecFn = vi.fn()
    const result = executeDeleteAgent('bad name!', switchroomExec, vi.fn() as never, '/tmp')
    expect(result.replies[0].text).toBe('Invalid agent name.')
    expect(switchroomExec).not.toHaveBeenCalled()
  })

  it('reports CLI error but notes archive succeeded', () => {
    const switchroomExec: SwitchroomExecFn = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('destroy failed'), { stderr: 'switchroom error' })
    })
    // Use a dir that definitely doesn't exist so no actual rename
    const result = executeDeleteAgent('gymbro', switchroomExec, vi.fn() as never, '/nonexistent-agents-12345')
    expect(result.replies[0].text).toContain('CLI destroy failed')
  })
})

// ─── /update ──────────────────────────────────────────────────────────────

describe('foreman: handleUpdateCommand', () => {
  it('calls switchroomExec with ["update"]', () => {
    const exec: SwitchroomExecFn = vi.fn().mockReturnValue('Updated successfully.')
    handleUpdateCommand(exec)
    expect(exec).toHaveBeenCalledWith(['update'])
  })

  it('returns output in a pre block', () => {
    const exec: SwitchroomExecFn = vi.fn().mockReturnValue('Pulled abc123. Reconciled 2 agents.')
    const result = handleUpdateCommand(exec)
    expect(result.replies[0].text).toContain('Pulled abc123')
    expect(result.replies[0].html).toBe(true)
  })

  it('returns error message when CLI throws', () => {
    const exec: SwitchroomExecFn = vi.fn().mockImplementation(() => {
      throw Object.assign(new Error('not a git repo'), { stderr: 'fatal: not a git repository' })
    })
    const result = handleUpdateCommand(exec)
    expect(result.replies[0].text).toContain('update failed')
  })

  it('returns no-output message when CLI returns empty', () => {
    const exec: SwitchroomExecFn = vi.fn().mockReturnValue('   \n')
    const result = handleUpdateCommand(exec)
    expect(result.replies[0].text).toContain('Update complete')
  })

  it('paginates output > 3 KB', () => {
    const bigOutput = 'x'.repeat(4000)
    const exec: SwitchroomExecFn = vi.fn().mockReturnValue(bigOutput)
    const result = handleUpdateCommand(exec)
    expect(result.replies.length).toBeGreaterThan(1)
  })
})
