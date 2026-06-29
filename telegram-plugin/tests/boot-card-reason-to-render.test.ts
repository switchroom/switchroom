/**
 * Integration unit test — couples `determineRestartReason` to
 * `renderBootCard` so the user-visible output is pinned across the
 * decision boundary.
 *
 * Cause class CC-8 from `docs/status-ask-cause-classes.md`:
 *
 *   Boot card silenced on operator update vs. silent on a real crash.
 *
 *   Clean-shutdown marker (#1139/#1141/#1142) silences the boot card
 *   on operator-driven restarts. If the marker is stamped erroneously
 *   (or the 5-min freshness window is too generous on a slow boot),
 *   the card stays silent after a real crash → user sees the agent
 *   come back with no acknowledgement → asks "did you crash?".
 *
 * `boot-card-reason.test.ts` covers the decision in isolation. This
 * file pins the next link: given the decision, what string lands in
 * the user's chat? Specifically, on `'crash'` the card MUST surface
 * the ⚠️ row + journalctl `nextStep` hint; on `'graceful'` /
 * `'planned'` it MUST NOT (no crash row, just the ack).
 *
 * Together: a refactor that subtly drops the crash row, swaps the
 * emoji on `'crash'`, or accidentally renders the crash row on
 * `'graceful'`, fails one of these snapshots at test time.
 */

import { describe, it, expect } from 'bun:test'
import { determineRestartReason } from '../gateway/boot-reason.js'
import { renderBootCard } from '../gateway/boot-card.js'

const NOW = 1_700_000_000_000
const VERSION = 'v0.8.0+106'
const AGENT = 'test-harness'

// The crash row's tail-logs command is runtime-aware: in-container agents
// (SWITCHROOM_RUNTIME=docker) get `docker logs …`, everything else gets
// `journalctl …`. The bun-native test set inherits the live container env,
// while vitest scrubs it — so assert against whichever branch the renderer
// actually selected rather than pinning one shape (#2669).
const TAIL_CMD = (slug: string): string =>
  process.env.SWITCHROOM_RUNTIME === 'docker'
    ? `\`docker logs --tail 100 switchroom-${slug}\``
    : `\`journalctl --user -u switchroom-${slug} -n 100\``

function rec(offsetMs: number) {
  return { ts: NOW - offsetMs }
}

function clean(offsetMs: number, reason?: string) {
  return { ts: NOW - offsetMs, signal: 'SIGTERM', reason }
}

const session = { pid: 1234 }

describe('boot-card: reason → user-visible render (CC-8)', () => {
  // ─── happy path: clean operator restart, recently stamped ──────
  it('clean operator restart within 5min window renders ack only (no crash row)', () => {
    const reason = determineRestartReason({
      marker: null,
      cleanMarker: clean(97_000, 'operator: switchroom update'),
      sessionMarker: session,
      now: NOW,
    })
    expect(reason).toBe('graceful')
    const card = renderBootCard({
      agentName: AGENT,
      version: VERSION,
      restartReason: reason,
    })
    expect(card).toMatchInlineSnapshot(`"✅ **test-harness** back up · v0.8.0+106"`)
    // Negative assertions on the failure surface CC-8 worries about:
    expect(card).not.toContain('crash recovery')
    expect(card).not.toContain('journalctl')
    expect(card).not.toContain('⚠️')
  })

  // ─── the worry case: marker erroneously stamped, real crash later ──
  it('operator marker stale beyond 5min + session marker → crash card with hint', () => {
    // 6 min after stamping — operator-extended window has expired,
    // so even a planned-looking marker reads as a crash. This is
    // EXACTLY CC-8's failure shape: if we'd left this case silent,
    // the user would never see the crash recovery row.
    const reason = determineRestartReason({
      marker: null,
      cleanMarker: clean(6 * 60_000, 'operator: switchroom update'),
      sessionMarker: session,
      now: NOW,
    })
    expect(reason).toBe('crash')
    const card = renderBootCard({
      agentName: AGENT,
      version: VERSION,
      restartReason: reason,
      restartAgeMs: 3_400,
    })
    expect(card).toContain('⚠️ **test-harness** back up')
    expect(card).toContain('⚠️ **Restart**  crash recovery · 3.4s ago')
    expect(card).toContain('Tail logs:')
    expect(card).toContain(TAIL_CMD('test-harness'))
  })

  // ─── canonical crash: no marker at all ─────────────────────────
  it('no markers + session marker → crash card with hint', () => {
    const reason = determineRestartReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: session,
      now: NOW,
    })
    expect(reason).toBe('crash')
    const card = renderBootCard({
      agentName: AGENT,
      version: VERSION,
      restartReason: reason,
      restartAgeMs: 12_000,
    })
    expect(card).toContain('⚠️ **test-harness** back up')
    expect(card).toContain('crash recovery · 12.0s ago')
    expect(card).toContain('Tail logs:')
  })

  // ─── user /restart (non-operator): tight 60s window applies ────
  it('user: /restart marker stale beyond 60s → crash card (tight window not extended)', () => {
    // A /restart from chat that takes >60s before its gateway boots
    // is a real crash; the catalog's CC-8 worry includes this path.
    const reason = determineRestartReason({
      marker: null,
      cleanMarker: clean(90_000, 'user: /restart from chat'),
      sessionMarker: session,
      now: NOW,
    })
    expect(reason).toBe('crash')
    const card = renderBootCard({
      agentName: AGENT,
      version: VERSION,
      restartReason: reason,
      restartAgeMs: 1_500,
    })
    expect(card).toContain('crash recovery · 1.5s ago')
  })

  // ─── planned restart via switchroom: ack only ──────────────────
  it('planned restart (marker present, fresh) → ack only', () => {
    const reason = determineRestartReason({
      marker: rec(10_000),
      cleanMarker: null,
      sessionMarker: session,
      now: NOW,
    })
    expect(reason).toBe('planned')
    const card = renderBootCard({
      agentName: AGENT,
      version: VERSION,
      restartReason: reason,
    })
    expect(card).toMatchInlineSnapshot(`"✅ **test-harness** back up · v0.8.0+106"`)
    expect(card).not.toContain('crash recovery')
  })

  // ─── fresh first start: distinct emoji, ack only ───────────────
  it('fresh first start (no markers, no session) → 🆕 ack', () => {
    const reason = determineRestartReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: null,
      now: NOW,
    })
    expect(reason).toBe('fresh')
    const card = renderBootCard({
      agentName: AGENT,
      version: VERSION,
      restartReason: reason,
    })
    expect(card).toMatchInlineSnapshot(`"🆕 **test-harness** back up · v0.8.0+106"`)
    expect(card).not.toContain('crash recovery')
  })

  // ─── slug override path: agentSlug used in tail-logs cmd, not agentName ───
  it('crash card uses agentSlug (not agentName) in the tail-logs command', () => {
    // The tail-logs row is the user's actionable next step — if the
    // slug ever drifts (capitalization, special chars), the copy-paste
    // command stops working. Pin the slug pathway explicitly. The command
    // shape (docker vs journalctl) is runtime-determined; the slug must be
    // the lowercase systemd slug regardless.
    const card = renderBootCard({
      agentName: 'Test Harness Display',
      agentSlug: 'test-harness',
      version: VERSION,
      restartReason: 'crash',
      restartAgeMs: 800,
    })
    expect(card).toContain(TAIL_CMD('test-harness'))
    // And never the display name in the unit target.
    expect(card).not.toContain('Test Harness Display -n')
    expect(card).not.toContain('switchroom-Test Harness Display')
  })
})
