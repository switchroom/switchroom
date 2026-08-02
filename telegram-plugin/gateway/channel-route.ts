/**
 * Buzz co-channel — Phase 2a pure routing core.
 *
 * Two pure, side-effect-free (bar one fail-safe stderr breadcrumb) functions
 * plus a flag reader. NO network sends, NO gateway state: this module is
 * unit-testable without booting the gateway, mirroring the `chat-id-fallback.ts`
 * pure-module precedent.
 *
 *   1. `parseChannelOrigin(rawContent)` — decides whether a turn originated on
 *      Telegram or Buzz, purely from the turn constructor's view of the inbound
 *      (`ev.rawContent`), and lifts the Buzz coordinates when it did.
 *
 *   2. `resolveRoute(originChannel, mode, buzzEnabled)` — the exhaustive 12-row
 *      routing table: given a turn's origin, the configured mirror mode, and
 *      whether Buzz is enabled at all, returns the primary channel plus any
 *      mirror channels an answer should also be copied to. Pure lookup — Phase
 *      2a wires no senders to it (that is Phase 2b).
 *
 *   3. `isBuzzTurnRoutingEnabled(env)` — the feature flag reader.
 *
 * ── Why `parseChannelOrigin` reads the OUTER opening tag's LAST `source=` ──
 *
 * GATE-0 (see `buzz-phase2-design.md` §2.1) established the live transport
 * shape. The Buzz sidecar's `mapBuzzEvent` (`src/buzz-gateway/inbound-map.ts`)
 * pre-renders a FULL `<channel source="buzz" buzz_channel_id=… buzz_event_id=…
 * buzz_thread_root=… …>body</channel>` envelope into the inbound's `text`, AND
 * mirrors those same fields into the inbound's `meta`. The native Claude Code
 * channel renderer then wraps that inbound again: it emits an OUTER
 * `<channel source="switchroom-telegram" … source="buzz" buzz_channel_id=…
 * buzz_event_id=… buzz_thread_root=… …>` opening tag — hoisting every `meta`
 * key onto the outer tag as an attribute (so `meta.source="buzz"` appears as a
 * SECOND `source=` after the renderer's own `source="switchroom-telegram"`) —
 * and renders the sidecar's pre-rendered envelope VERBATIM in the body (the
 * "double-wrap": a nested `<channel>` inside the body).
 *
 * The authoritative provenance signal is therefore the OUTER opening tag, and
 * within it the LAST `source=` (the meta-hoisted one). This is exactly how
 * `deriveTurnRole` (`telegram-plugin/turn-liveness-floor.ts`) already
 * classifies the loop role in production for cron / synthetic inbounds — it
 * matches the first `<channel …>` opening tag and reads the LAST `source=`
 * within it via the greedy `/<channel[^>]*\bsource="([^"]+)"/`. We deliberately
 * mirror that regex byte-for-byte so Buzz turns classify identically. Reading
 * the FIRST `source=` (the renderer's `switchroom-telegram`) — or reading the
 * inner nested envelope — would silently misclassify every Buzz turn as
 * Telegram. The Buzz coordinates are likewise lifted from that same outer
 * meta-hoisted opening tag, never the inner nested envelope.
 *
 * Every failure path is fail-safe to Telegram: a non-string input, no channel
 * tag, a non-buzz last source, or any missing/empty coordinate all yield
 * `{ originChannel: 'telegram' }`. A Buzz origin is only ever returned with a
 * complete, non-empty coordinate triple.
 */

export type Channel = 'telegram' | 'buzz'

/**
 * Configured mirror mode for the fleet's Buzz co-channel:
 *   - `both`   — answer on the origin channel AND mirror a copy to the other.
 *   - `origin` — answer only on the channel the turn came in on.
 *   - `off`    — Buzz routing is dormant; everything resolves to Telegram.
 */
export type MirrorMode = 'both' | 'origin' | 'off'

export interface BuzzCoords {
  channelId: string
  eventId: string
  threadRoot: string
}

export interface ChannelOrigin {
  originChannel: Channel
  buzzCoords?: BuzzCoords
}

export interface Route {
  primary: Channel
  mirrors: Channel[]
}

// Frozen shared fail-safe result. `parseChannelOrigin` never attaches
// `buzzCoords` to a Telegram origin, so a single immutable instance is safe to
// return from every fail-safe path.
const TELEGRAM_ONLY: ChannelOrigin = Object.freeze({ originChannel: 'telegram' })

/**
 * Greedy match of the FIRST `<channel …>` opening tag's LAST `source=`.
 *
 * Byte-for-byte identical to `deriveTurnRole`'s regex in
 * `turn-liveness-floor.ts`: `[^>]*` cannot cross the tag's closing `>`, so the
 * match is confined to the first opening tag, and its greediness backtracks to
 * the LAST `source="…"` within it — the meta-hoisted `source="buzz"` on a Buzz
 * turn, or the renderer's own `source="switchroom-telegram"` on a Telegram one.
 */
const OUTER_LAST_SOURCE = /<channel[^>]*\bsource="([^"]+)"/

// Isolates the first opening tag (up to its closing `>`), matching the same
// `[^>]*` boundary the source regex uses. Coordinates are read from this
// substring so the inner nested (double-wrapped) envelope can never be mistaken
// for the outer meta-hoisted tag.
const OUTER_OPEN_TAG = /<channel[^>]*>/

/**
 * Reverse of the sidecar/renderer XML-attribute escaping (`&amp; &quot; &lt;
 * &gt;`). Buzz coordinates are hex/uuid in practice (no special chars, so this
 * is usually a pass-through), but the native renderer's exact escaping of
 * hoisted `meta` values is not contractually guaranteed, so we unescape
 * defensively. `&amp;` is applied LAST so a literal `&amp;lt;` in the source
 * decodes to `&lt;`, not `<`.
 */
function unescapeXmlAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Reads a named attribute's value from a single opening-tag substring.
 * Returns the unescaped value, or `null` when the attribute is absent or its
 * value is empty (an empty coordinate is treated as missing → fail-safe).
 */
function readAttr(openTag: string, name: string): string | null {
  const m = openTag.match(new RegExp(`\\b${name}="([^"]*)"`))
  if (m == null) return null
  const value = unescapeXmlAttr(m[1])
  return value.length > 0 ? value : null
}

/**
 * Classify a turn's origin channel purely from the turn constructor's view of
 * the inbound (`ev.rawContent`). Fail-safe to Telegram on every deviation. See
 * the module header for why this reads the outer opening tag's LAST `source=`.
 */
export function parseChannelOrigin(rawContent: string | null | undefined): ChannelOrigin {
  if (typeof rawContent !== 'string') return TELEGRAM_ONLY

  const sourceMatch = rawContent.match(OUTER_LAST_SOURCE)
  if (sourceMatch == null || sourceMatch[1] !== 'buzz') return TELEGRAM_ONLY

  // Coordinates live on the SAME outer, meta-hoisted opening tag. Isolate it so
  // the inner nested envelope (which carries its own buzz_* attrs) can never be
  // read by mistake.
  const openMatch = rawContent.match(OUTER_OPEN_TAG)
  if (openMatch == null) return TELEGRAM_ONLY
  const openTag = openMatch[0]

  const channelId = readAttr(openTag, 'buzz_channel_id')
  const eventId = readAttr(openTag, 'buzz_event_id')
  const threadRoot = readAttr(openTag, 'buzz_thread_root')

  if (channelId == null || eventId == null || threadRoot == null) {
    // A turn whose outer tag says source="buzz" but is missing a coordinate is
    // structurally malformed. Degrade to Telegram rather than emit a Buzz
    // origin we cannot address — a breadcrumb so the gap is diagnosable.
    process.stderr.write(
      'telegram gateway: buzz-origin turn missing coordinate ' +
        `(channel_id=${channelId != null} event_id=${eventId != null} ` +
        `thread_root=${threadRoot != null}) — routing as telegram\n`,
    )
    return TELEGRAM_ONLY
  }

  return { originChannel: 'buzz', buzzCoords: { channelId, eventId, threadRoot } }
}

/**
 * The exhaustive 12-row routing table (origin × mode × enabled). Pure lookup.
 *
 * Semantics (Finding 6):
 *   - `primary` is Buzz  IFF the turn ORIGINATED on Buzz and Buzz is live
 *     (enabled AND mode ≠ off); otherwise Telegram.
 *   - a MIRROR is emitted only under `mode === 'both'` while Buzz is live:
 *       · Telegram-origin → mirror to Buzz  (reach Buzz readers with the answer)
 *       · Buzz-origin     → mirror to Telegram (the guaranteed Telegram copy)
 *   - under `origin`, `off`, or Buzz-disabled, there are no mirrors and the
 *     primary collapses to Telegram unless the turn genuinely originated on a
 *     live Buzz channel.
 *
 * "Buzz is live" = `buzzEnabled && mode !== 'off'`. When Buzz is not live, a
 * Buzz-origin turn still resolves to a Telegram primary (fail-safe: we never
 * route to a channel that is switched off).
 */
export function resolveRoute(
  originChannel: Channel,
  mode: MirrorMode,
  buzzEnabled: boolean,
): Route {
  const buzzLive = buzzEnabled && mode !== 'off'

  const primary: Channel = originChannel === 'buzz' && buzzLive ? 'buzz' : 'telegram'

  let mirrors: Channel[] = []
  if (buzzLive && mode === 'both') {
    mirrors = originChannel === 'telegram' ? ['buzz'] : ['telegram']
  }

  return { primary, mirrors }
}

/**
 * Phase 2a feature flag. Default ON (escape-hatch convention, mirroring the
 * fleet's other `SWITCHROOM_*` module flags): only an explicit `'0'` disables.
 * Reads from an injected env map so the flag is unit-testable without mutating
 * `process.env`.
 */
export function isBuzzTurnRoutingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SWITCHROOM_BUZZ_TURN_ROUTING !== '0'
}
