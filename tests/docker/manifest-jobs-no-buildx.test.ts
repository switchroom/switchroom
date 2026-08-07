/**
 * Guard: a manifest-only workflow job must never set up buildx.
 *
 * `docker buildx imagetools inspect|create` are pure registry
 * operations. `docker/setup-buildx-action` defaults to the
 * `docker-container` driver, which boots BuildKit by pulling
 * `moby/buildkit:buildx-stable-1` from **Docker Hub** — a hard,
 * unauthenticated, rate-limited docker.io dependency for a capability
 * those jobs never use.
 *
 * It reddened main twice: run 30138853707 (2026-07-25, `retag-unchanged`)
 * and run 29977369227 (2026-07-23, `promote-to-dev`), both with
 * `ERROR: ... Get "https://registry-1.docker.io/v2/": ... Client.Timeout
 * exceeded while awaiting headers` under `> [internal] booting buildkit`.
 *
 * Why this test has to exist: every one of these jobs is gated off
 * `pull_request` (or is `workflow_dispatch`-only), so NONE of them run on
 * a PR. A future edit re-adding `setup-buildx-action` to a manifest-only
 * job is invisible until main goes red again. This test is the only
 * deterministic thing standing between that edit and a post-merge red.
 *
 * The rule is derived from the job's own content, not a hardcoded job
 * list, so a NEW manifest-only job is covered the day it is added.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

const REPO = resolve(import.meta.dirname, '../..')
const WORKFLOWS = ['docker-images.yml', 'promote.yml']

const BUILDX_ACTION = 'docker/setup-buildx-action'
const BUILD_ACTION = 'docker/build-push-action'
// Real build jobs now reach setup-buildx-action THROUGH this composite,
// which warms the BuildKit image with a bounded retry first (#3815). For
// this file's purposes it is the same thing: a job that sets up a builder.
const LOCAL_BUILDX_ACTION = './.github/actions/setup-buildx'

interface Step {
  uses?: string
  run?: string
  name?: string
}
interface Job {
  steps?: Step[]
}

function loadJobs(file: string): Array<[string, Job]> {
  const raw = readFileSync(join(REPO, '.github/workflows', file), 'utf8')
  const doc = parse(raw) as { jobs?: Record<string, Job> }
  return Object.entries(doc.jobs ?? {})
}

function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? job.steps : []
}

/** A job is "manifest-only" if it runs imagetools and never builds. */
function isManifestOnly(job: Job): boolean {
  const steps = stepsOf(job)
  const usesImagetools = steps.some((s) => (s.run ?? '').includes('imagetools'))
  const buildsImages = steps.some((s) => (s.uses ?? '').includes(BUILD_ACTION))
  return usesImagetools && !buildsImages
}

/** Direct reference — what a manifest-only job must never do. */
function usesBuildx(job: Job): boolean {
  return stepsOf(job).some((s) => (s.uses ?? '').includes(BUILDX_ACTION))
}

/** Direct OR via the warm-pull composite — "this job sets up a builder". */
function setsUpBuilder(job: Job): boolean {
  return stepsOf(job).some(
    (s) => (s.uses ?? '').includes(BUILDX_ACTION) || (s.uses ?? '') === LOCAL_BUILDX_ACTION,
  )
}

describe('manifest-only workflow jobs never set up buildx (no docker.io dependency)', () => {
  const all = WORKFLOWS.flatMap((f) =>
    loadJobs(f).map(([name, job]) => ({ file: f, name, job })),
  )

  it('finds the manifest-only jobs it is meant to guard (the rule matches reality)', () => {
    // Sanity floor: if a refactor renames or restructures these jobs so
    // the heuristic stops matching anything, the assertions below would
    // pass vacuously. Pin the known set so that regression is loud.
    const found = all.filter((j) => isManifestOnly(j.job)).map((j) => `${j.file}:${j.name}`)
    expect(found.sort()).toEqual([
      'docker-images.yml:merge-base',
      'docker-images.yml:merge-dependents',
      'docker-images.yml:merge-hindsight',
      'docker-images.yml:promote-to-dev',
      'docker-images.yml:retag-unchanged',
      'promote.yml:promote',
    ])
  })

  it.each(WORKFLOWS)('%s — no manifest-only job references setup-buildx-action', (file) => {
    const offenders = loadJobs(file)
      .filter(([, job]) => isManifestOnly(job) && usesBuildx(job))
      .map(([name]) => name)

    expect(
      offenders,
      `${file}: job(s) [${offenders.join(', ')}] only run \`imagetools\` but set up ` +
        `${BUILDX_ACTION}. Its default docker-container driver pulls ` +
        `moby/buildkit from Docker Hub — a docker.io dependency these jobs ` +
        `never use, and a post-merge-only red when Docker Hub is slow ` +
        `(runs 30138853707, 29977369227). Drop the step; imagetools needs no builder.`,
    ).toEqual([])
  })

  it('real BUILD jobs still set up buildx (the guard is not over-broad)', () => {
    // The rule must NOT push anyone to strip buildx from jobs that
    // genuinely need the docker-container driver for multi-platform
    // builds and cache export.
    const builders = all
      .filter((j) => stepsOf(j.job).some((s) => (s.uses ?? '').includes(BUILD_ACTION)))
      .map((j) => j.name)
    expect(builders.length).toBeGreaterThan(0)
    for (const name of builders) {
      const job = all.find((j) => j.name === name)!.job
      expect(
        setsUpBuilder(job),
        `build job ${name} must still set up buildx (directly or via ${LOCAL_BUILDX_ACTION})`,
      ).toBe(true)
    }
  })
})
