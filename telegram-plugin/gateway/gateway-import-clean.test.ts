import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * #2996 P0e — gateway.ts import-cleanliness.
 *
 * Prior phases (P0a/P0b/P0c) could only pin import-cleanliness with AST/source
 * checks because importing gateway.ts under vitest was *impossible*: the
 * module-scope `createIpcServer(...)` calls `Bun.listen` at construction, and
 * `Bun` is undefined under Node/vitest, so a bare `import('./gateway.js')`
 * threw `ReferenceError: Bun is not defined` before any assertion could run.
 *
 * P0e removes the last import-time side effects. This test therefore uses the
 * thing prior phases could not: an ACTUAL runtime import of gateway.ts as the
 * oracle for the import-clean half, and deterministic source-pins for the
 * boot-fires-under-`isGatewayMain` half (which cannot be runtime-exercised
 * under vitest — the prod boot path needs Bun, a real Bot token, and the
 * vault, none of which exist here).
 */

const here = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(join(here, 'gateway.ts'), 'utf8')

// The process-signal / lifecycle events gateway.ts wires on the prod boot path.
// Under a vitest import (isGatewayMain === false) it must register NONE of them.
const GATEWAY_SIGNALS = ['SIGTERM', 'SIGINT', 'beforeExit'] as const

function signalListenerCounts(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const sig of GATEWAY_SIGNALS) out[sig] = process.listenerCount(sig)
  return out
}

describe('gateway.ts import-cleanliness (#2996 P0e)', () => {
  it('runtime-imports with zero side effects: resolves, no process.exit, no gateway signal handlers', async () => {
    const before = signalListenerCounts()

    // Any reachable process.exit during import is a hard failure ("no exit
    // reachable on import"). Throw instead of exiting so the harness survives
    // and the assertion is legible.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) was reached during import()`)
      }) as never)

    // Positive oracle that no UDS server is bound at import: if the gate
    // regressed and `createIpcServer` ran, it would call this Bun.listen fake.
    // With the gate intact it is never invoked. (Also proves the import no
    // longer depends on a real Bun global — it resolves whether or not one
    // exists.)
    //
    // Dual-runner note: this file runs under BOTH vitest (Node) and `bun test`
    // (the plugin bun suite globs every *.test.ts). Under Node `globalThis.Bun`
    // is undefined and the fake installs cleanly — that run holds the no-bind
    // oracle. Under the Bun runtime the `Bun` global is READONLY (assignment
    // throws "Attempted to assign to readonly property"), so the swap is
    // best-effort there; the bind oracle is then carried by the vitest run and
    // the source pins below, while the remaining outcome assertions (resolve /
    // no exit / no listeners) still run in both runtimes.
    const listenSpy = vi.fn(() => {
      throw new Error('Bun.listen was called during import() — an IPC server was bound')
    })
    const priorBun = (globalThis as { Bun?: unknown }).Bun
    let bunSwapped = false
    try {
      ;(globalThis as { Bun?: unknown }).Bun = { listen: listenSpy }
      bunSwapped = true
    } catch {
      // Bun runtime — readonly global; see dual-runner note above.
    }

    let mod: Record<string, unknown>
    try {
      mod = (await import('./gateway.js')) as Record<string, unknown>
    } finally {
      if (bunSwapped) {
        if (priorBun === undefined) delete (globalThis as { Bun?: unknown }).Bun
        else (globalThis as { Bun?: unknown }).Bun = priorBun
      }
      exitSpy.mockRestore()
    }

    // Import resolved (did not throw). Under P0c-and-earlier this line was
    // unreachable — the import rejected with `Bun is not defined`.
    expect(mod).toBeTruthy()

    // No IPC server bound (Node run; under Bun the swap is best-effort and the
    // spy simply stays uninstalled + uncalled).
    expect(listenSpy).not.toHaveBeenCalled()

    // No exit reachable on import.
    expect(exitSpy).not.toHaveBeenCalled()

    // No gateway-owned SIGTERM / SIGINT / beforeExit handlers registered.
    // (vitest owns a baseline uncaughtException/unhandledRejection listener of
    // its own, so those two are asserted via the delta only.)
    const after = signalListenerCounts()
    for (const sig of GATEWAY_SIGNALS) {
      // Runner-agnostic single-arg expect (bun's expect has no message arg):
      // encode the signal name in the compared value so a failure is legible.
      expect(`${sig}:+${after[sig] - before[sig]}`).toBe(`${sig}:+0`)
    }
  }, 60_000)

  it('does not add uncaughtException / unhandledRejection handlers on import', async () => {
    // Distinct from the signal test: gateway.ts registers TWO families of these
    // (installGlobalErrorHandlers @ ~910 and its own shutdown-routing handlers
    // @ ~29926/29935). Both call process.exit, both are gated on P0e. Assert the
    // delta the import contributed is zero (vitest's own baseline is subtracted).
    const before = {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    }
    const mod = await import('./gateway.js')
    expect(mod).toBeTruthy()
    const after = {
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    }
    expect(after.uncaughtException - before.uncaughtException).toBe(0)
    expect(after.unhandledRejection - before.unhandledRejection).toBe(0)
  }, 60_000)

  describe('boot wiring is gated on isGatewayMain (source pins — the prod path still fires)', () => {
    // These pin, deterministically, that each side-effecting construct remains
    // (a) gated so the import stays clean, and (b) present so the prod boot path
    // (isGatewayMain === true) still constructs it. They guard against a future
    // edit silently ungating one of them (re-inflating the import surface) OR
    // deleting the construction (breaking boot).

    it('IPC server construction is deferred behind isGatewayMain', () => {
      expect(GATEWAY_SRC).toMatch(/let ipcServer!: IpcServer/)
      expect(GATEWAY_SRC).toMatch(/if \(isGatewayMain\) ipcServer = createIpcServer\(\{/)
      // No ungated `const ipcServer = createIpcServer` remains.
      expect(GATEWAY_SRC).not.toMatch(/const ipcServer[^\n]*= createIpcServer/)
    })

    it('inbound spool construction is deferred behind isGatewayMain', () => {
      expect(GATEWAY_SRC).toMatch(
        /let inboundSpool: ReturnType<typeof createInboundSpool> \| undefined/,
      )
      expect(GATEWAY_SRC).toMatch(/if \(isGatewayMain\) inboundSpool = STATIC/)
      expect(GATEWAY_SRC).not.toMatch(/const inboundSpool = STATIC/)
    })

    it('global error handlers + beforeExit are gated on isGatewayMain', () => {
      // installPosthogErrorHandlers must not sit ungated at module scope.
      expect(GATEWAY_SRC).not.toMatch(/^installPosthogErrorHandlers\(\)/m)
      expect(GATEWAY_SRC).toMatch(
        /if \(isGatewayMain\) \{\n {2}installPosthogErrorHandlers\(\)/,
      )
    })

    it('signal + crash handlers are gated on isGatewayMain', () => {
      // No ungated (column-0) process.on wiring survives.
      expect(GATEWAY_SRC).not.toMatch(/^process\.on\('SIGTERM'/m)
      expect(GATEWAY_SRC).not.toMatch(/^process\.on\('SIGINT'/m)
      expect(GATEWAY_SRC).not.toMatch(/^process\.on\('unhandledRejection'/m)
      expect(GATEWAY_SRC).not.toMatch(/^process\.on\('uncaughtException'/m)
      // The gateway's beforeExit analytics flush is likewise not at column 0.
      expect(GATEWAY_SRC).not.toMatch(/^process\.on\('beforeExit'/m)
    })

    it('startup reaction sweep (module-load IO) is gated on isGatewayMain', () => {
      expect(GATEWAY_SRC).toMatch(
        /if \(isGatewayMain\) \{\n {2}const startupAgentDir = resolveAgentDirFromEnv\(\)/,
      )
    })

    it('preserves prod construction order: inboundSpool before pendingInboundBuffer before ipcServer', () => {
      const iSpool = GATEWAY_SRC.indexOf('if (isGatewayMain) inboundSpool = STATIC')
      const iPending = GATEWAY_SRC.indexOf('const pendingInboundBuffer = createPendingInboundBuffer(')
      const iIpc = GATEWAY_SRC.indexOf('if (isGatewayMain) ipcServer = createIpcServer({')
      expect(iSpool).toBeGreaterThan(0)
      expect(iPending).toBeGreaterThan(0)
      expect(iIpc).toBeGreaterThan(0)
      expect(iSpool).toBeLessThan(iPending)
      expect(iPending).toBeLessThan(iIpc)
    })

    it('startGateway() remains the single guarded boot invocation', () => {
      expect(GATEWAY_SRC).toMatch(/if \(isGatewayMain\) void startGateway\(\)/)
    })
  })
})
