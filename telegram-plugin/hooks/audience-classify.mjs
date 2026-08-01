/**
 * Audience classification — "who is this text FOR?" (W1-d, issue #3865).
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * Nothing in the capture → journal → sweep pipeline recorded who a piece of
 * text was addressed to. Capture selects the terminal assistant-prose run
 * STRUCTURALLY (`narration-classify.mjs` `selectBackstopDelivery`, substance
 * floor at `silent-end-scan.mjs`), so when the reply tool throws (#3861) the
 * agent's trailing working notes are the terminal prose run — they get
 * journaled as if they were the answer, and the outbox sweep faithfully
 * delivers internal orchestration prose into the operator's DM hours later.
 * That is a private-data leak, not a cosmetic one.
 *
 * SHARED-PURE-MODULE, ON PURPOSE
 * ------------------------------
 * This is a plain `.mjs` with a sibling `.d.mts` (the same shape as
 * `narration-classify.mjs`) because BOTH halves of the pipeline must run the
 * IDENTICAL predicate and there is no build step between them:
 *   - the Stop hooks (`silent-end-scan.mjs`, `silent-end-interrupt-stop.mjs`)
 *     run unbundled under node and can only import sibling `.mjs`;
 *   - the gateway (`outbox.ts`, `gateway/outbox-sweep.ts`) is bundled TS.
 * A second hand-synced copy would drift, and a drift here is a leak.
 *
 * EVERYTHING HERE IS PURE. No fs, no env, no clock. The callers own their IO.
 */

/** Audience: the text is for the human on the other end of the chat. */
export const AUDIENCE_USER = 'user'

/**
 * Audience: the text is the agent talking to itself (working notes,
 * orchestration prose). It may be journaled and inspected, but it must never
 * be delivered to a chat.
 */
export const AUDIENCE_INTERNAL = 'internal'

/**
 * Obligation state for the resolved chat, as seen at capture time.
 *
 * `'unknown'` is a first-class value and is NOT the same as `false`: an
 * unreadable / malformed `obligations.json` means we could not establish that
 * the user is NOT waiting on an answer, and the fail-safe direction is to
 * assume they ARE (see `decideCaptureAudience`).
 */
/** @typedef {true | false | 'unknown'} OpenObligationState */

/**
 * THE classifier. Conservative by construction, and deliberately asymmetric.
 *
 * We mark `internal` ONLY on positive evidence:
 *
 *     replyToolThrewThisTurn === true  AND  openInboundObligation === false
 *
 * Both halves are load-bearing:
 *   - "the reply tool threw" is what makes the trailing prose suspect at all.
 *     Without a throw, terminal prose after a bypassed reply tool is the
 *     ordinary #3513 backstop case and IS the answer.
 *   - "no open inbound obligation" is what says nobody is waiting. If the user
 *     asked something and we still owe them a reply, the least-bad move is to
 *     deliver the prose we have; suppressing it would leave them with silence.
 *
 * The asymmetry is the whole safety argument. Getting it wrong in the
 * `internal` direction produces a SILENT NO-OP (severity 3: the user asked and
 * got nothing, with no signal). Getting it wrong in the `user` direction
 * reproduces today's status quo, which is bad but is not a NEW failure class.
 * So every uncertain input resolves to `user`.
 *
 * The narration classifier is deliberately NOT an input here. It is a VETO
 * only: it already decides, upstream in `selectBackstopDelivery`, whether a
 * prose run is capturable at all. Promoting it to a positive `internal` signal
 * would let a heuristic prose-shape match silently swallow a real answer —
 * exactly the severity-3 error this function is built to avoid.
 *
 * @param {{
 *   replyToolThrewThisTurn?: boolean,
 *   openInboundObligation?: true | false | 'unknown',
 * }} signals
 * @returns {'user' | 'internal'}
 */
export function decideCaptureAudience(signals) {
  const threw = signals?.replyToolThrewThisTurn === true
  if (!threw) return AUDIENCE_USER
  // Only a POSITIVE, known-empty obligation state clears the second gate.
  // `'unknown'`, `true`, and `undefined` all mean "someone may be waiting".
  if (signals?.openInboundObligation !== false) return AUDIENCE_USER
  return AUDIENCE_INTERNAL
}

/**
 * Resolve the open-inbound-obligation state for a chat from the RAW text of the
 * gateway's durable obligation snapshot (`<STATE_DIR>/obligations.json`, written
 * by `persistObligations` on every ledger mutation — open AND close, see
 * `obligation-ledger.ts:156`). Pure: the caller does the `readFileSync` and
 * passes `null` when the file is absent or unreadable.
 *
 * The three-valued result is the point:
 *
 *   - `snapshotTrusted === false` → `'unknown'`, WITHOUT reading the bytes. See
 *                                  the stale-snapshot note below (#4146).
 *   - `null` snapshot            → `'unknown'`. An absent file is NOT proof that
 *                                  nobody is waiting: it is equally the shape of
 *                                  an agent running with `SWITCHROOM_OBLIGATION_
 *                                  LEDGER=0`, or a STATIC gateway, where
 *                                  obligations exist but are never persisted.
 *                                  Reading it as "empty" would let us suppress on
 *                                  an agent that simply doesn't track waiting
 *                                  users — a manufactured silent no-op.
 *
 * ## The stale-snapshot hole (#4146) and why `snapshotTrusted` exists
 *
 * The bullet above used to be the WHOLE argument, and it was wrong: a leftover
 * file is not an absent file. Turn the ledger off (or run STATIC) on an agent
 * that previously ran with it on, and persistence stops while the old
 * `obligations.json` lingers — so an empty (or merely out-of-date) snapshot
 * reads as positive proof that nobody is waiting, while obligations are in fact
 * going untracked. That is the one configuration where the asymmetric default
 * inverts, and it is a direct path to swallowing a real answer.
 *
 * It is closed on BOTH sides, deterministically, with no freshness heuristic:
 *
 *   1. THE FILE IS REMOVED when it cannot be maintained. The gateway unlinks
 *      the snapshot at boot whenever it is STATIC or the ledger is disabled
 *      (`gateway.ts`, next to the hydrate branch) — the exact site that already
 *      knows the condition. After that, "absent" genuinely does mean what the
 *      bullet above claims.
 *   2. THE READER DOES NOT TRUST IT ANYWAY when it knows persistence is off.
 *      The hook passes `snapshotTrusted: SWITCHROOM_OBLIGATION_LEDGER !== '0'`,
 *      which covers the window before that gateway boots, an older gateway
 *      build that never cleaned up, and a gateway that is not running at all.
 *
 * Note the case that ISN'T staleness: with the ledger ON, the snapshot only
 * ever mutates through the gateway, so a gateway that is merely stopped leaves
 * a snapshot that is exactly correct rather than stale. That is why an mtime
 * bound is the wrong instrument here — it would fail an idle-but-accurate
 * snapshot (weakening #4140 for quiet agents) while still not proving liveness.
 *   - unparseable / wrong shape  → `'unknown'` (same reasoning; a torn or
 *                                  forward-incompatible snapshot proves nothing).
 *   - `chatId == null` (the chat
 *     could not be resolved) and
 *     the open set is non-empty  → `'unknown'`. Someone is waiting and we cannot
 *                                  rule out that it is this record's reader.
 *   - `chatId == null` and the
 *     open set is empty          → `false`. Nobody anywhere is waiting, so the
 *                                  scoping question is moot.
 *   - otherwise                  → `true` iff some open obligation names this chat.
 *
 * @param {{ snapshotRaw?: string | null, chatId?: string | null, snapshotTrusted?: boolean }} args
 * @returns {true | false | 'unknown'}
 */
export function resolveOpenObligation(args) {
  // #4146: an explicit "persistence is off" beats anything on disk. Only an
  // exact `false` distrusts — absent/undefined keeps the pre-#4146 behaviour,
  // so a caller that does not know cannot accidentally weaken the gate.
  if (args?.snapshotTrusted === false) return 'unknown'
  const raw = args?.snapshotRaw
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown'
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'unknown'
  }
  if (parsed == null || typeof parsed !== 'object') return 'unknown'
  const rows = parsed.obligations
  if (!Array.isArray(rows)) return 'unknown'
  const open = rows.filter(
    (r) => r != null && typeof r === 'object' && typeof r.chatId === 'string',
  )
  const chatId = args?.chatId == null ? null : String(args.chatId)
  if (chatId == null) return open.length === 0 ? false : 'unknown'
  return open.some((r) => r.chatId === chatId)
}

/**
 * Read the audience off a persisted record or journal entry.
 *
 * LEGACY-ROW POLICY (decided in this PR, documented here because this function
 * IS the policy): a record with no `audience` field — every record written
 * before this change, plus any record written by a hook that predates it during
 * a rolling upgrade — resolves to `'user'` and delivers exactly as it does
 * today.
 *
 * Rationale: a legacy record carries no evidence either way, and the
 * fail-safe direction for no-evidence is the one whose error mode is the
 * status quo rather than a new silent no-op (see `decideCaptureAudience`). A
 * legacy record's window is at most `OUTBOX_MAX_AGE_MS` wide, so the legacy
 * population is bounded and drains within 30 minutes of deploy.
 *
 * Any value that is not the exact `'internal'` literal (unknown strings,
 * numbers, objects, `null`) is also `'user'` — suppression requires an
 * affirmative, exact tag.
 *
 * @param {unknown} value
 * @returns {'user' | 'internal'}
 */
export function resolveRecordAudience(value) {
  return value === AUDIENCE_INTERNAL ? AUDIENCE_INTERNAL : AUDIENCE_USER
}

/**
 * Entry-selection predicate for the sweep. Placed here, shared, and pure so the
 * gate is a property of the RECORD rather than of whatever send adapter happens
 * to be wired underneath it — W1-b swaps that adapter out, and this gate must
 * survive the swap untouched.
 *
 * `gateEnabled` is the kill-switch seam (the sweep reads
 * `SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE !== '0'`). It exists so the revert-check
 * can run: with the gate off, the leak reproduces and the zero-send assertion
 * must fail. A test that still passes with the gate off is not testing the gate.
 *
 * @param {{ audience?: unknown }} record
 * @param {{ gateEnabled?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldSuppressForAudience(record, opts) {
  if (opts?.gateEnabled === false) return false
  return resolveRecordAudience(record?.audience) === AUDIENCE_INTERNAL
}

/**
 * ── W1-d follow-up (#4141): the FOREGROUND reply-throw case ──────────────────
 *
 * `decideCaptureAudience` can only mark `internal` when the reply tool threw
 * AND nobody is waiting. On a FOREGROUND Telegram turn the inbound obligation
 * is still OPEN at capture time (it only closes on a substantive DELIVERED
 * reply — `gateway/obligation-ledger.ts:153-157`), so the record classifies
 * `user` and the trailing prose still delivers, presented as if it were the
 * answer. That is the residual leak #4141 tracks.
 *
 * WHY THIS IS FRAMING AND NOT SUPPRESSION
 * ---------------------------------------
 * There is no deterministic discriminator here. When the reply tool throws, a
 * model that has been told "every turn MUST end with a reply tool call" very
 * plausibly re-writes its ANSWER as plain prose — and that prose is selected by
 * exactly the same structural rule as working notes are. Position does not
 * separate them (both follow the errored `tool_result`), and wording heuristics
 * are provably incomplete (`narration-classify.mjs` says so in its own header).
 *
 * So suppressing here would trade a VISIBLE wrong-content failure for an
 * INVISIBLE no-answer failure, against a human who is provably still waiting.
 * That is strictly worse and it is the exact severity-3 class #3865/#4140 exist
 * to avoid. Replacing the prose with a fixed notice has the same defect in
 * milder form: it destroys content that may be the answer.
 *
 * What we CAN assert deterministically is the provenance: the reply tool threw
 * this turn, so this text was never delivered as an answer by the agent — the
 * safety net scraped it off the end of the turn. Stating that, verbatim, in
 * front of the text restores exactly the context that #3865 says late delivery
 * strips ("delivery hours later strips the context that would have made the
 * difference obvious"). The reader can then tell notes from an answer, which is
 * something no classifier in this pipeline can do.
 *
 * Properties, deliberately:
 *   - it can NEVER produce silence (something is always delivered);
 *   - it triggers on a hard structural fact (`is_error: true` on a reply-tool
 *     `tool_result`), never on prose shape or model discipline;
 *   - a missing / non-`true` signal changes nothing at all.
 */

/**
 * The fixed provenance banner. Plain text in the established sweep-prefix
 * idiom (`(delayed) `, `(from background task) `) — no markdown specials, so
 * it cannot parse-reject a rich send, and no emoji.
 */
export const REPLY_THROW_PROVENANCE_NOTICE =
  '(my reply tool errored this turn, so this was never sent as an answer — ' +
  'the safety net captured the last thing I wrote, which may be working notes)'

/**
 * Should this record's delivered text carry the provenance banner?
 *
 * POSITIVE evidence only: an exact `true` on the record's persisted
 * `replyToolThrewThisTurn`. Missing, `undefined`, `'true'`, `1` — anything that
 * is not the boolean — changes nothing, so a legacy record (written before the
 * field existed) delivers byte-for-byte as it does today.
 *
 * `frameEnabled === false` is the kill switch, and it is the seam the
 * revert-check flips.
 *
 * @param {{ replyToolThrewThisTurn?: unknown }} record
 * @param {{ frameEnabled?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldFrameReplyThrow(record, opts) {
  if (opts?.frameEnabled === false) return false
  return record?.replyToolThrewThisTurn === true
}

/**
 * Compose the banner onto the delivered body. Pure; the caller owns the
 * `(delayed) ` / `(from background task) ` prefixes, which stay OUTSIDE (they
 * describe the delivery, this describes the text).
 *
 * @param {string} text
 * @returns {string}
 */
export function applyReplyThrowFraming(text) {
  const body = typeof text === 'string' ? text : ''
  // Empty body: the sweep's send adapter early-returns on empty text, and a
  // banner with nothing under it would be a message about nothing. Leave it.
  if (body.trim().length === 0) return body
  return `${REPLY_THROW_PROVENANCE_NOTICE}\n\n${body}`
}

/**
 * Structured telemetry for a framed delivery — the observability half of the
 * rule, mirroring {@link formatInternalSuppression}. Framing changes what a
 * human sees, so it must never be inferable only from the absence of a log
 * line. Worded to match NONE of `GATEWAY_SIGNATURES` in
 * `src/fleet-health/detect.ts`: a framed delivery IS a delivery, and must not
 * page anyone.
 *
 * @param {{
 *   turnNonce: string,
 *   turnId?: string | null,
 *   chatId?: string | null,
 *   textSha256?: string,
 *   source?: string,
 * }} s
 * @returns {string}
 */
export function formatReplyThrowFraming(s) {
  return (
    `telegram gateway: outbox provenance framing nonce=${s.turnNonce} ` +
    `turnId=${s.turnId ?? 'unknown'} chatId=${s.chatId ?? 'unresolved'} ` +
    `sha=${(s.textSha256 ?? '').slice(0, 12)} source=${s.source ?? 'unknown'} ` +
    `audience=user replyToolThrew=true — captured prose delivered with its ` +
    `provenance stated, not suppressed\n`
  )
}

/**
 * The structured telemetry line emitted when the sweep suppresses an
 * `internal` record. Mirrors `formatOrphanEscalation` (#4104): an exported pure
 * formatter plus an injected `writeLog`, so the line is greppable, unit-
 * assertable, and CANNOT accidentally become a chat send.
 *
 * It carries `turnId=` in the gateway's `<chat>:<thread>#<message>` shape so
 * `extractTurnId` in `src/fleet-health/detect.ts` can join it back to the turn,
 * and it is worded so it matches NONE of that file's `GATEWAY_SIGNATURES`:
 * suppression-by-design is telemetry, not a delivery failure, and must not page
 * anyone.
 *
 * @param {{
 *   turnNonce: string,
 *   turnId?: string | null,
 *   chatId?: string | null,
 *   textSha256?: string,
 *   ageMs?: number,
 *   source?: string,
 *   pastWindow?: boolean,
 * }} s
 * @returns {string}
 */
export function formatInternalSuppression(s) {
  return (
    `telegram gateway: outbox audience suppression nonce=${s.turnNonce} ` +
    `turnId=${s.turnId ?? 'unknown'} chatId=${s.chatId ?? 'unresolved'} ` +
    `sha=${(s.textSha256 ?? '').slice(0, 12)} ageMs=${s.ageMs ?? 0} ` +
    `source=${s.source ?? 'unknown'} pastWindow=${s.pastWindow === true} ` +
    `audience=internal — internal prose withheld from chat, journaled terminally\n`
  )
}
