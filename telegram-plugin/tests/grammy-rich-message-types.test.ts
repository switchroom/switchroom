/**
 * Compile-time contract for the grammy 1.44.0 → 1.45.1 bump
 * (`@grammyjs/types` 3.28.0 → 4.0.0).
 *
 * Why this file exists
 * --------------------
 * 4.0.0 turned `InputRichMessage` from a plain interface into a GENERIC one:
 *
 *   3.28.0  `export interface InputRichMessage {`            (rich.d.ts:280)
 *   4.0.0   `export interface InputRichMessage<F> {`         (rich.d.ts:283)
 *
 * `F` is the file-payload type threaded through the new Bot API 10.2 `blocks`
 * / `media` fields. Switchroom never uses either — every outbound message is
 * the plain `{ markdown }` shape (`rich-send.ts:96`), and the plugin defines
 * its OWN local `InputRichMessageMarkdown` (`rich-send.ts:28`) rather than
 * importing grammy's. So the bump is only safe as long as a bare
 * `{ markdown: string }` literal still satisfies the generic parameter at
 * every call site.
 *
 * That invariant is invisible to the rest of the suite for two reasons, and
 * both are why this test spends ~1s on a real compile instead of asserting on
 * runtime values:
 *
 *   1. Every send in the regression suite is MOCKED — no mock can notice that
 *      a payload stopped typechecking.
 *   2. The repo's `tsc --noEmit` does NOT cover this directory. The root
 *      `tsconfig.json` `include` is `["src/**\/*.ts", "bin/**\/*.ts",
 *      "scripts/**\/*.ts"]` — `telegram-plugin/` is absent, so a type error
 *      here is invisible to `npm run lint` (verified empirically: a deliberate
 *      `const x: number = "s"` in `rich-send.ts` leaves `tsc --noEmit` at exit
 *      0). A plain `.ts` fixture would therefore be a NO-OP as a guard.
 *
 * So the check has to run the compiler itself. The negative controls below are
 * load-bearing: if the harness ever silently stopped compiling (bad fixture
 * path, unresolved `grammy`, swallowed diagnostics), the "must fail" cases
 * would go green and this file goes red — it cannot rot into a vacuous pass.
 */
import { describe, it, expect, afterAll } from 'vitest'
import ts from 'typescript'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Fixtures must live INSIDE the repo tree: they `import 'grammy'`, and module
// resolution walks up from the file to the hoisted root `node_modules`. A
// fixture in `os.tmpdir()` would fail to resolve grammy and every case would
// report a misleading "cannot find module" instead of the real answer.
const fixtureDir = mkdtempSync(join(here, 'grammy-types-fixture-'))
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }))

/** Mirrors the compiler settings the plugin is actually authored against. */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  // Matches the root tsconfig: we are asserting on OUR call shapes, not
  // auditing grammy's own .d.ts files.
  skipLibCheck: true,
  noEmit: true,
}

/**
 * Typecheck one fixture source and return its syntactic + semantic errors,
 * formatted `TSxxxx: message`. Empty array means "compiles clean".
 */
function typecheck(name: string, source: string): string[] {
  const file = resolve(fixtureDir, `${name}.ts`)
  writeFileSync(file, source)
  const program = ts.createProgram([file], COMPILER_OPTIONS)
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName === file.split('\\').join('/'))
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
}

describe('grammy rich-message input still accepts the plain { markdown } shape', () => {
  it('accepts a bare { markdown } literal on sendRichMessage and editMessageText', () => {
    expect(
      typecheck(
        'plain-literal',
        `
        import type { Bot } from 'grammy'
        declare const bot: Bot
        export async function send(): Promise<void> {
          await bot.api.sendRichMessage(1, { markdown: 'hi' })
          await bot.api.editMessageText(1, 2, { markdown: 'hi' })
        }
        `,
      ),
    ).toEqual([])
  })

  it("accepts the production helper's return type (rich-send.ts richMessage())", () => {
    // The real seam: `richMessage()` returns the plugin's OWN local
    // `InputRichMessageMarkdown`, which must stay structurally assignable to
    // grammy's generic parameter. This is the assertion that would break if a
    // future @grammyjs/types made `blocks`/`media` mandatory or constrained `F`.
    expect(
      typecheck(
        'production-helper',
        `
        import type { Bot } from 'grammy'
        import { richMessage } from '${join(here, '..', 'rich-send.js').split('\\').join('/')}'
        declare const bot: Bot
        export async function send(): Promise<void> {
          await bot.api.sendRichMessage(1, richMessage('hi'))
          await bot.api.editMessageText(1, 2, richMessage('hi'))
        }
        `,
      ),
    ).toEqual([])
  })

  it('still accepts a { markdown } payload through bot.api.raw', () => {
    // `installRichMarkdownGuard` (shared/bot-runtime.ts) inspects the RAW
    // payload `{ chat_id, rich_message: { markdown } }`, so pin that shape too.
    expect(
      typecheck(
        'raw-payload',
        `
        import type { Bot } from 'grammy'
        declare const bot: Bot
        export async function send(): Promise<void> {
          await bot.api.raw.sendRichMessage({ chat_id: 1, rich_message: { markdown: 'hi' } })
        }
        `,
      ),
    ).toEqual([])
  })

  // ── Negative controls: prove the harness has teeth ──────────────────────
  // Without these, every assertion above would pass just as happily against a
  // harness that had silently stopped compiling anything at all.

  it('NEGATIVE CONTROL: rejects a wrongly-typed markdown field', () => {
    const errors = typecheck(
      'wrong-type',
      `
      import type { Bot } from 'grammy'
      declare const bot: Bot
      export async function send(): Promise<void> {
        await bot.api.sendRichMessage(1, { markdown: 123 })
      }
      `,
    )
    expect(errors.join('\n')).toContain('TS2322')
  })

  it('NEGATIVE CONTROL: rejects an unknown field on the rich-message literal', () => {
    const errors = typecheck(
      'unknown-field',
      `
      import type { Bot } from 'grammy'
      declare const bot: Bot
      export async function send(): Promise<void> {
        await bot.api.sendRichMessage(1, { markdwon: 'typo' })
      }
      `,
    )
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('grammy supply-chain pin', () => {
  // Assert on `bun.lock` rather than the resolved package: grammy's `exports`
  // map deliberately hides `./package.json`, and the lockfile is the artifact
  // CI actually installs from (`bun install --frozen-lockfile`), so it is both
  // reachable and the more honest source of truth for what ships.
  const lock = readFileSync(resolve(here, '..', '..', 'bun.lock'), 'utf8')

  /** Pull the resolved version bun.lock pins for a package. */
  function lockedVersion(pkg: string): string {
    const escaped = pkg.replace('/', '\\/')
    const m = new RegExp(`"${escaped}": \\["${escaped}@(\\d+\\.\\d+\\.\\d+)"`).exec(lock)
    if (!m) throw new Error(`no bun.lock pin found for ${pkg}`)
    return m[1]
  }

  // These assert a FLOOR, not an exact version: a later 1.46/5.x bump is a
  // legitimate change and must not go red here for no substantive reason. What
  // must never happen silently is a slide BACK below the floor — that would
  // return @grammyjs/types to 3.28.0 and drop the Bot API 10.2 surface this
  // bump exists to unlock, while every assertion above stayed green (the plain
  // `{ markdown }` shape compiles under both).

  it('keeps grammy at or above 1.45 (the floor that ships @grammyjs/types 4.x)', () => {
    const [major, minor] = lockedVersion('grammy').split('.').map(Number)
    expect(major).toBe(1)
    expect(minor).toBeGreaterThanOrEqual(45)
  })

  it('keeps @grammyjs/types at or above the 4.x major grammy 1.45 depends on', () => {
    const [major] = lockedVersion('@grammyjs/types').split('.').map(Number)
    expect(major).toBeGreaterThanOrEqual(4)
  })
})
