/**
 * Guard: the RELEASE-TAG retag short-circuit in docker-images.yml.
 *
 * Background. At a release tag `changes` (dorny/paths-filter) cannot run
 * — a tag push has no diff base — so every image was rebuilt from
 * scratch at every release, including images whose build inputs had not
 * moved since the previous release. `tag-retag-plan` supplies the
 * missing diff base (the previous release tag) and `retag-release`
 * re-points the previous release's manifest at `:vX.Y.Z` for any image
 * proven identical.
 *
 * Why these tests exist. NONE of this runs on a pull request: the plan,
 * the retag, and the tag branch of the build gates are all reachable
 * only from `refs/tags/v*`. A polarity slip in a build gate is therefore
 * invisible until a release silently ships the PREVIOUS release's image
 * under a new version tag — an unrecoverable, unnoticeable failure. A
 * test is the only deterministic thing standing between an edit and that
 * outcome.
 *
 * These assert OUTCOMES, not shapes: the job `if:` expressions are
 * parsed and EVALUATED against simulated GitHub contexts, so a test
 * fails when the *decision* changes, not merely when the text does.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const REPO = resolve(import.meta.dirname, '../..')
const WORKFLOW = '.github/workflows/docker-images.yml'

interface Step {
  uses?: string
  with?: Record<string, unknown>
  run?: string
  name?: string
}
interface Job {
  if?: string | boolean
  needs?: string | string[]
  steps?: Step[]
}

const raw = readFileSync(join(REPO, WORKFLOW), 'utf8')
const doc = parse(raw) as { jobs: Record<string, Job> }
const jobs = doc.jobs

function job(name: string): Job {
  const j = jobs[name]
  expect(j, `${WORKFLOW} has no job \`${name}\``).toBeDefined()
  return j
}

function needsOf(name: string): string[] {
  const n = job(name).needs
  if (!n) return []
  return Array.isArray(n) ? n : [n]
}

function stepsOf(name: string): Step[] {
  const s = job(name).steps
  return Array.isArray(s) ? s : []
}

// ───────────────────────── GitHub expression evaluator ────────────────
// A deliberately small recursive-descent evaluator for the subset of the
// GitHub expression language these gates use: string/boolean literals,
// `!`, `&&`, `||`, `==`, `!=`, parentheses, dotted context lookups, and
// the `cancelled()` / `always()` / `success()` / `failure()` /
// `startsWith()` / `contains()` functions. An unknown token throws
// rather than silently evaluating to something convenient — a test that
// cannot parse the gate must fail loudly, not pass vacuously.

type Ctx = {
  event_name: string
  ref: string
  needs: Record<string, { result?: string; outputs?: Record<string, string> }>
  cancelled?: boolean
}

type Tok = { t: 'op' | 'str' | 'id'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'"
          j += 2
          continue
        }
        if (src[j] === "'") break
        s += src[j++]
      }
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '==' || two === '!=') {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('()!,'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.\-]*/.exec(src.slice(i))
    if (m) {
      out.push({ t: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    throw new Error(`unexpected character '${c}' at ${i} in: ${src}`)
  }
  return out
}

function lookup(path: string, ctx: Ctx): unknown {
  const parts = path.split('.')
  if (parts[0] === 'github') {
    if (parts[1] === 'event_name') return ctx.event_name
    if (parts[1] === 'ref') return ctx.ref
    throw new Error(`unsupported github context: ${path}`)
  }
  if (parts[0] === 'needs') {
    // Missing job / missing output is '' — exactly what GitHub hands a
    // consumer when the producing job skipped or failed. The fail-safe
    // tests below depend on this being modelled, not special-cased.
    const n = ctx.needs[parts[1]]
    if (!n) return ''
    if (parts[2] === 'result') return n.result ?? ''
    if (parts[2] === 'outputs') return n.outputs?.[parts[3]] ?? ''
    throw new Error(`unsupported needs context: ${path}`)
  }
  throw new Error(`unsupported context: ${path}`)
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v !== ''
  return Boolean(v)
}

function evaluate(expr: string, ctx: Ctx): boolean {
  const toks = tokenize(expr)
  let p = 0
  const peek = () => toks[p]
  const eat = (v: string) => {
    if (!toks[p] || toks[p].v !== v) {
      throw new Error(`expected '${v}' at token ${p} in: ${expr}`)
    }
    p++
  }

  function primary(): unknown {
    const tk = toks[p]
    if (!tk) throw new Error(`unexpected end of expression: ${expr}`)
    if (tk.v === '!') {
      p++
      return !truthy(primary())
    }
    if (tk.v === '(') {
      p++
      const v = or()
      eat(')')
      return v
    }
    if (tk.t === 'str') {
      p++
      return tk.v
    }
    if (tk.t === 'id') {
      p++
      // Function call?
      if (peek() && peek()!.v === '(') {
        p++
        const args: unknown[] = []
        while (peek() && peek()!.v !== ')') {
          args.push(or())
          if (peek() && peek()!.v === ',') p++
        }
        eat(')')
        switch (tk.v) {
          case 'cancelled':
            return ctx.cancelled === true
          case 'always':
            return true
          case 'success':
            return Object.values(ctx.needs).every((n) => (n.result ?? 'success') === 'success')
          case 'failure':
            return Object.values(ctx.needs).some((n) => n.result === 'failure')
          case 'startsWith':
            return String(args[0]).startsWith(String(args[1]))
          case 'contains':
            return String(args[0]).includes(String(args[1]))
          default:
            throw new Error(`unsupported function ${tk.v}() in: ${expr}`)
        }
      }
      if (tk.v === 'true') return true
      if (tk.v === 'false') return false
      return lookup(tk.v, ctx)
    }
    throw new Error(`unexpected token '${tk.v}' in: ${expr}`)
  }

  function cmp(): unknown {
    let l = primary()
    while (peek() && (peek()!.v === '==' || peek()!.v === '!=')) {
      const op = toks[p++].v
      const r = primary()
      l = op === '==' ? l === r : l !== r
    }
    return l
  }

  function and(): unknown {
    let l = cmp()
    while (peek() && peek()!.v === '&&') {
      p++
      const r = cmp()
      l = truthy(l) ? r : l
    }
    return l
  }

  function or(): unknown {
    let l = and()
    while (peek() && peek()!.v === '||') {
      p++
      const r = and()
      l = truthy(l) ? l : r
    }
    return l
  }

  const v = or()
  if (p !== toks.length) throw new Error(`trailing tokens at ${p} in: ${expr}`)
  return truthy(v)
}

/** Evaluate a job's `if:` under a simulated context. */
function jobRuns(name: string, ctx: Ctx): boolean {
  const cond = job(name).if
  if (cond === undefined) return true
  if (typeof cond === 'boolean') return cond
  const expr = cond.trim().replace(/^\$\{\{/, '').replace(/\}\}$/, '').trim()
  return evaluate(expr, ctx)
}

// ── Context builders ──────────────────────────────────────────────────

/** A release-tag push. `plan` is what tag-retag-plan reported. */
function tagCtx(opts: {
  hindsight?: string
  voice?: string
  planResult?: string
  buildHindsight?: string
  buildVoice?: string
  /** omit tag-retag-plan from `needs` entirely (job never ran/defined) */
  noPlan?: boolean
}): Ctx {
  const needs: Ctx['needs'] = {
    changes: { result: 'skipped', outputs: {} },
    'build-hindsight': { result: opts.buildHindsight ?? 'success' },
    'build-voice': { result: opts.buildVoice ?? 'success' },
  }
  if (!opts.noPlan) {
    needs['tag-retag-plan'] = {
      result: opts.planResult ?? 'success',
      outputs: {
        prev_tag: 'v0.20.19',
        ...(opts.hindsight !== undefined ? { hindsight: opts.hindsight } : {}),
        ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
      },
    }
  }
  return { event_name: 'push', ref: 'refs/tags/v0.20.20', needs }
}

function mainPushCtx(changed: Record<string, string>): Ctx {
  return {
    event_name: 'push',
    ref: 'refs/heads/main',
    needs: {
      changes: { result: 'success', outputs: changed },
      'tag-retag-plan': { result: 'skipped', outputs: {} },
      'build-hindsight': { result: 'success' },
      'build-voice': { result: 'success' },
    },
  }
}

// ──────────────────────────────── Tests ──────────────────────────────

describe('docker-images.yml — release-tag retag short-circuit', () => {
  describe('the tag branch of each build gate is conjoined with the plan verdict', () => {
    it.each([
      ['build-hindsight', 'hindsight'],
      ['build-voice', 'voice'],
    ])('%s does NOT build at a tag when the plan proved the image unchanged', (jobName, key) => {
      expect(
        jobRuns(jobName, tagCtx({ [key]: 'unchanged' })),
        `${jobName} still builds on a release tag even though tag-retag-plan reported ` +
          `${key}=unchanged. The tag branch of its \`if:\` must be CONJOINED with ` +
          `needs.tag-retag-plan.outputs.${key} != 'unchanged'; an unconditional ` +
          `startsWith(github.ref, 'refs/tags/') disjunct makes retag-release dead code and ` +
          `rebuilds a byte-identical image on every release.`,
      ).toBe(false)
    })

    it.each([
      ['build-hindsight', 'hindsight'],
      ['build-voice', 'voice'],
    ])('%s DOES build at a tag when the plan says the image changed', (jobName, key) => {
      expect(jobRuns(jobName, tagCtx({ [key]: 'changed' })), `${jobName} must build`).toBe(true)
    })
  })

  describe('fail-safe: anything short of a proven `unchanged` verdict BUILDS', () => {
    // The polarity here is the highest-risk line in the workflow. The
    // gate must read `!= 'unchanged'`, never `== 'changed'`: every one
    // of the states below yields an empty string, and only `!=` treats
    // that as "build".
    const degraded: Array<[string, Partial<Parameters<typeof tagCtx>[0]>]> = [
      ['tag-retag-plan produced no output at all', { hindsight: undefined, voice: undefined }],
      ['tag-retag-plan output is the empty string', { hindsight: '', voice: '' }],
      ['tag-retag-plan FAILED', { planResult: 'failure' }],
      ['tag-retag-plan was SKIPPED', { planResult: 'skipped' }],
      ['tag-retag-plan is absent from needs', { noPlan: true }],
      ['verdict is an unrecognised string', { hindsight: 'maybe', voice: 'maybe' }],
    ]

    it.each(degraded)('build-hindsight builds when %s', (_label, opts) => {
      expect(
        jobRuns('build-hindsight', tagCtx(opts)),
        'build-hindsight SKIPPED on a degraded plan. Fail-safe is violated: the release ' +
          'would publish the previous release\'s hindsight image under a new version tag.',
      ).toBe(true)
    })

    it.each(degraded)('build-voice builds when %s', (_label, opts) => {
      expect(
        jobRuns('build-voice', tagCtx(opts)),
        'build-voice SKIPPED on a degraded plan. Fail-safe is violated.',
      ).toBe(true)
    })

    it('retag-release does NOT run on a degraded plan', () => {
      for (const [label, opts] of degraded) {
        expect(jobRuns('retag-release', tagCtx(opts)), `retag-release ran when ${label}`).toBe(
          false,
        )
      }
    })
  })

  describe('the main-push and dispatch paths are unchanged', () => {
    it('build-hindsight/build-voice still follow the `changes` filter on a main push', () => {
      expect(jobRuns('build-hindsight', mainPushCtx({ hindsight: 'true' }))).toBe(true)
      expect(jobRuns('build-hindsight', mainPushCtx({ hindsight: 'false' }))).toBe(false)
      expect(jobRuns('build-voice', mainPushCtx({ voice: 'true' }))).toBe(true)
      expect(jobRuns('build-voice', mainPushCtx({ voice: 'false' }))).toBe(false)
    })

    it('workflow_dispatch still forces a build regardless of any plan verdict', () => {
      const ctx: Ctx = {
        event_name: 'workflow_dispatch',
        ref: 'refs/heads/main',
        needs: {
          changes: { result: 'skipped', outputs: {} },
          'tag-retag-plan': { result: 'skipped', outputs: { hindsight: 'unchanged', voice: 'unchanged' } },
        },
      }
      expect(jobRuns('build-hindsight', ctx)).toBe(true)
      expect(jobRuns('build-voice', ctx)).toBe(true)
    })

    it('retag-release never runs outside a release tag', () => {
      expect(jobRuns('retag-release', mainPushCtx({ hindsight: 'false', voice: 'false' }))).toBe(
        false,
      )
      expect(
        jobRuns('retag-release', {
          event_name: 'pull_request',
          ref: 'refs/pull/1/merge',
          needs: {},
        }),
      ).toBe(false)
    })
  })

  describe('retag-release only retags what was genuinely short-circuited', () => {
    it('runs when the plan proved an image unchanged and its build skipped', () => {
      expect(
        jobRuns(
          'retag-release',
          tagCtx({ hindsight: 'unchanged', voice: 'changed', buildHindsight: 'skipped' }),
        ),
      ).toBe(true)
      expect(
        jobRuns(
          'retag-release',
          tagCtx({ hindsight: 'changed', voice: 'unchanged', buildVoice: 'skipped' }),
        ),
      ).toBe(true)
    })

    it('does NOT run when every image was built', () => {
      expect(jobRuns('retag-release', tagCtx({ hindsight: 'changed', voice: 'changed' }))).toBe(
        false,
      )
    })

    it('does NOT run when a build actually ran despite an `unchanged` verdict', () => {
      // If build-hindsight ran it owns :vX.Y.Z. Retagging the previous
      // release over it would REGRESS the release.
      expect(
        jobRuns(
          'retag-release',
          tagCtx({ hindsight: 'unchanged', voice: 'changed', buildHindsight: 'success' }),
        ),
      ).toBe(false)
    })

    it('re-checks both conditions per image inside the step, not just in the job `if:`', () => {
      // The job-level `if:` is an OR across images, so a job that ran
      // for voice must not blindly retag hindsight.
      const body = stepsOf('retag-release')
        .map((s) => s.run ?? '')
        .join('\n')
      expect(body).toContain('imagetools create')
      expect(body).toMatch(/!=\s*"unchanged"/)
      expect(body).toMatch(/!=\s*"skipped"/)
    })
  })

  describe('the new jobs are manifest-only (no Docker Hub buildkit pull)', () => {
    it.each(['retag-release', 'tag-retag-plan'])('%s sets up no buildx and builds nothing', (name) => {
      const steps = stepsOf(name)
      const offenders = steps
        .map((s) => s.uses ?? '')
        .filter(
          (u) =>
            u.includes('docker/setup-buildx-action') ||
            u === './.github/actions/setup-buildx' ||
            u.includes('docker/build-push-action'),
        )
      expect(
        offenders,
        `${name} is manifest-only (imagetools inspect/create are pure registry ops). ` +
          `setup-buildx-action's docker-container driver pulls moby/buildkit from Docker Hub — ` +
          `an unauthenticated, rate-limited docker.io dependency this job never uses.`,
      ).toEqual([])
    })
  })

  describe('tag-retag-plan', () => {
    it('only runs on a release tag', () => {
      expect(jobRuns('tag-retag-plan', tagCtx({}))).toBe(true)
      expect(jobRuns('tag-retag-plan', mainPushCtx({}))).toBe(false)
      expect(
        jobRuns('tag-retag-plan', {
          event_name: 'pull_request',
          ref: 'refs/pull/1/merge',
          needs: {},
        }),
      ).toBe(false)
    })

    it('checks out full history — a shallow clone cannot resolve the previous release tag', () => {
      const checkout = stepsOf('tag-retag-plan').find((s) => (s.uses ?? '').includes('actions/checkout'))
      expect(checkout, 'tag-retag-plan must check out the repo to diff two releases').toBeDefined()
      expect(
        checkout!.with?.['fetch-depth'],
        'tag-retag-plan needs `fetch-depth: 0`: the default single-commit checkout has ' +
          'neither the tags nor the ancestry to diff against the previous release, so every ' +
          'verdict degrades to `changed` and the optimisation silently never fires.',
      ).toBe(0)
    })

    it('defaults both verdicts to `changed` before any probe can promote them', () => {
      const body = stepsOf('tag-retag-plan')
        .map((s) => s.run ?? '')
        .join('\n')
      expect(body).toMatch(/HINDSIGHT_VERDICT=changed/)
      expect(body).toMatch(/VOICE_VERDICT=changed/)
      // The verdict may only be promoted, never assigned from a probe's
      // raw output — `=unchanged` must appear exactly where a proof
      // succeeded.
      const promotions = body.match(/_VERDICT=unchanged/g) ?? []
      expect(promotions.length).toBe(2)
    })

    it('anchors the filter list it trusts, so a path-filters refactor degrades to `changed`', () => {
      const body = stepsOf('tag-retag-plan')
        .map((s) => s.run ?? '')
        .join('\n')
      expect(body).toContain('docker/Dockerfile.hindsight')
      expect(body).toContain('docker/Dockerfile.voice')
      expect(body).toContain('.github/path-filters.yml')
    })
  })

  describe('images-ok cannot mask a failure in the new jobs', () => {
    it('needs both tag-retag-plan and retag-release', () => {
      const needs = needsOf('images-ok')
      for (const n of ['tag-retag-plan', 'retag-release']) {
        expect(
          needs,
          `images-ok must \`needs: ${n}\`. It is the single required context for this ` +
            `workflow; a job missing from the list can fail a release with nobody noticing.`,
        ).toContain(n)
      }
    })

    it('aggregates both results in its verdict loop', () => {
      // Being in `needs` alone is not enough — images-ok's verdict is a
      // hand-written loop over `needs.<job>.result` pairs, and a job in
      // `needs` but absent from the loop is still masked.
      const body = stepsOf('images-ok')
        .map((s) => s.run ?? '')
        .join('\n')
      for (const n of ['tag-retag-plan', 'retag-release']) {
        expect(
          body,
          `images-ok's verdict loop must inspect needs.${n}.result, not just list it in needs.`,
        ).toContain(`needs.${n}.result`)
      }
    })
  })

  describe('pre-existing invariants this rework must not break', () => {
    it('promote-to-dev still gates on build-hindsight (its hindsight leg retags :sha-<short>)', () => {
      expect(needsOf('promote-to-dev')).toContain('build-hindsight')
    })

    it('retag-unchanged is still the main-push-only path', () => {
      expect(jobRuns('retag-unchanged', mainPushCtx({ hindsight: 'false', voice: 'true' }))).toBe(
        true,
      )
      expect(jobRuns('retag-unchanged', tagCtx({ hindsight: 'unchanged' }))).toBe(false)
    })
  })

  describe('the workflow header describes reality', () => {
    it('no longer claims the workflow is staged at docs/proposed/', () => {
      // The file IS at .github/workflows/docker-images.yml; the staging
      // instructions were completed long ago and misdirect any reader
      // trying to work out where to edit it.
      expect(raw).not.toContain('docs/proposed/docker-images.yml')
    })
  })
})
