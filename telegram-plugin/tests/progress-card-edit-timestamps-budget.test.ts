/**
 * PR-C2 — `editTimestamps` sliding-window cleanup must keep the array
 * bounded under sustained burst.
 *
 * The driver maintains a per-turn array of recent emit timestamps and
 * uses its length within the trailing 60s to flip "hot" mode (longer
 * coalesce window). The cleanup is `while (arr[0] < cutoff) arr.shift()`,
 * which only fires when `recordEdit` or `isBudgetHot` is called. If
 * that cleanup ever regresses, the array would grow unbounded across a
 * long-running turn.
 *
 * fails when: the `arr.shift()` cleanup is removed from `recordEdit` or
 * `isBudgetHot`, OR the cutoff window is widened beyond 60s without a
 * matching upper bound.
 */
import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'

describe('PR-C2: editTimestamps stays bounded under sustained emit burst', () => {
  it('after 100 emits spread across 5 minutes, the per-turn array holds <= ~window-worth', () => {
    // Use very low coalesce so each ingest can drive an emit. Keep the
    // turn open for the whole burst.
    const { driver, advance } = makeHarness({
      minIntervalMs: 0,
      coalesceMs: 0,
      heartbeatMs: 999_999, // never auto-fire heartbeat
      promoteAfterMs: 999_999,
    })
    const maps = driver._debugGetMaps!()

    driver.ingest(enqueue('cA'), null)

    // Drive 100 events spaced 3s apart — so the trailing 60s only ever
    // contains ~21 timestamps. With a working sliding-window cleanup the
    // array should stay bounded near that figure.
    for (let i = 0; i < 100; i++) {
      driver.ingest(
        {
          kind: 'tool_use',
          toolName: 'Read',
          toolUseId: `tu${i}`,
          input: { file_path: `/tmp/${i}.txt` },
        },
        'cA',
      )
      advance(3000)
    }

    // Find the per-turn timestamp array. The key is the active turnKey;
    // there's only one turn so we can pick it.
    const sizes = [...maps.editTimestamps.values()].map((a) => a.length)
    expect(sizes.length).toBeGreaterThan(0)
    const max = Math.max(...sizes)
    // 60s window / 3s spacing = 20 entries. Allow tight slack (<= 22)
    // for one or two boundary timestamps recorded by the harness's
    // setup (initial enqueue, etc.) — anything looser fails to catch
    // off-by-N regressions in the sliding-window cleanup.
    expect(max).toBeLessThanOrEqual(22)
    // And critically, NOT 100+ — that would mean cleanup never ran.
    expect(max).toBeLessThan(100)
  })
})
