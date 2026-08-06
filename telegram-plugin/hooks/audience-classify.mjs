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
 * The `meta.source` a self-improvement review turn's synthesized inbound
 * carries. MUST stay byte-identical to `REVIEW_SOURCE` in
 * `src/self-improve/review-prompt.ts` — this unbundled `.mjs` cannot import the
 * TS module, so the constant is mirrored here (same discipline as `MAX_RETRIES`
 * / `isTurnFlushSafetyEnabledEnv`). `tests/self-improve-review-audience.test.ts`
 * pins the equality so a rename on either side reds CI.
 *
 * WHY IT LIVES IN THE AUDIENCE MODULE. A self-improvement review turn is
 * injected with an explicit contract (`buildReviewPrompt`): "act SILENTLY, do
 * NOT reply to the operator, end the turn when done." Its trailing transcript
 * prose is therefore the agent reasoning to ITSELF — an `internal` audience by
 * construction, exactly the vocabulary this module owns. Ken hit the leak this
 * closes: a silent review turn's mid-turn reasoning ("I own personal-garmin,
 * but the script I hand-rolled…") was captured by the outbox backstop and
 * delivered into his DM as a raw, unlabelled message.
 */
export const REVIEW_SOURCE = 'self_improve_review'

/**
 * Did the turn that produced this capture originate from a self-improvement
 * review inbound? Deterministic: it keys ONLY on the enqueue envelope's
 * `source="…"` attribute (parsed upstream by `parseChannelEnvelope`), never on
 * prose shape or a wording heuristic — the same source tag the rest of the
 * self-improve machinery already routes on.
 *
 * @param {string | null | undefined} source The capture/record `source` field.
 * @returns {boolean}
 */
export function isReviewOriginatedSource(source) {
  return source === REVIEW_SOURCE
}

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
 * `reviewOriginated` is the ONE other positive signal, and it is deterministic
 * rather than heuristic. A self-improvement review turn is injected with a
 * SYNTHESIZED inbound (`source="self_improve_review"`); no operator is waiting on
 * an answer to it. Its contract (`buildReviewPrompt`) gives it exactly ONE
 * operator-facing output: a well-formed self-improvement CARD (leading
 * `SELF_IMPROVEMENT_TITLE` line) when — and only when — it surfaces a real
 * outcome; otherwise it stays silent. So the review branch is checked FIRST and
 * routes on card-shape:
 *
 *   - review + text IS a card (`reviewTextIsCard === true`) ⇒ `user`. The card
 *     is the sanctioned surfacing message; deliver it. It is self-labelled by
 *     construction (it opens with the title), so it can never appear as raw,
 *     unlabelled reasoning.
 *   - review + text is NOT a card ⇒ `internal`. This is the leak Ken hit — a
 *     review turn's mid-turn reasoning captured by the backstop — and it is
 *     SUPPRESSED. Deterministic: the gate is an EXACT title-line prefix, not a
 *     fuzzy prose-shape guess, and the failure direction is SAFE (a mis-typed
 *     card is withheld, never a real answer swallowed — a review inbound has no
 *     waiting question to swallow, so this never manufactures the severity-3
 *     silent no-op the asymmetry above guards against).
 *
 * `reviewTextIsCard` is scoped to review turns ONLY; it can never affect a
 * normal user turn's classification, so the "no prose-shape heuristic on user
 * text" rule above is intact.
 *
 * @param {{
 *   replyToolThrewThisTurn?: boolean,
 *   openInboundObligation?: true | false | 'unknown',
 *   reviewOriginated?: boolean,
 *   reviewTextIsCard?: boolean,
 * }} signals
 * @returns {'user' | 'internal'}
 */
export function decideCaptureAudience(signals) {
  // Self-improvement review turns (see the header note): the sanctioned card
  // delivers (`user`); any other trailing prose is the leak and is suppressed
  // (`internal`). Deterministic, independent of the reply-throw path below.
  if (signals?.reviewOriginated === true) {
    return signals?.reviewTextIsCard === true ? AUDIENCE_USER : AUDIENCE_INTERNAL
  }
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
 * ── Self-improvement review labelling (Ken, 2026-08-07) ──────────────────────
 *
 * TWO layers, both in this one shared module so the hook (which classifies +
 * stamps) and the sweep (which delivers) run identical rules:
 *
 *   1. CARD GATE (primary, `decideCaptureAudience` above). A review turn's
 *      trailing backstop text is delivered to the operator ONLY IF it is a
 *      well-formed self-improvement card — `isSelfImprovementCard`, an EXACT
 *      leading-`SELF_IMPROVEMENT_TITLE` prefix. Non-card review prose (the raw
 *      reasoning Ken saw leak) classifies `internal` and is suppressed. This is
 *      the deterministic "never leak raw reasoning; the card is the only
 *      operator-facing output" guarantee.
 *
 *   2. TITLE FRAMING (residual). The card gate delivers only text that is
 *      ALREADY self-titled, so in the default config the delivered body needs no
 *      relabelling. This block is the belt-and-braces for the degraded config:
 *      if the audience gate is turned OFF (`SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE=0`)
 *      so a NON-card review record reaches delivery, the title is prepended so it
 *      can still never appear as raw, unlabelled reasoning. Idempotent: text that
 *      already opens with the title is left untouched (no double title on a real
 *      card). Mirrors the reply-throw framing above — pure predicate + pure body
 *      transform + telemetry — and is additive only, so it can never manufacture
 *      silence.
 */

/**
 * The title line every self-improvement card opens with, and the label the
 * residual framing prepends. `🔧 **Self-improvement**` — a leading glyph + bold
 * so the operator sees at a glance this is a review note, not a normal reply.
 * The card contract (`buildReviewPrompt`) continues the same line with
 * ` — <one-line outcome>`, so this is a PREFIX of a real card, which is exactly
 * what `isSelfImprovementCard` keys on.
 */
export const SELF_IMPROVEMENT_TITLE = '🔧 **Self-improvement**'

/**
 * Is `text` a well-formed self-improvement card — i.e. does it open with the
 * `SELF_IMPROVEMENT_TITLE` line? This is the deterministic gate that separates
 * the sanctioned surfacing card (deliver) from raw review reasoning (suppress).
 *
 * EXACT structural prefix, not a fuzzy prose-shape match: the model is
 * instructed to emit the title verbatim as the first line of its one surfacing
 * message, and the failure direction is SAFE — a mis-formatted card is withheld
 * (silence), never a real answer delivered. Leading whitespace is tolerated so a
 * stray newline before the title does not defeat the gate.
 *
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isSelfImprovementCard(text) {
  if (typeof text !== 'string') return false
  return text.trimStart().startsWith(SELF_IMPROVEMENT_TITLE)
}

/**
 * Should this record's delivered text carry the residual title header?
 *
 * POSITIVE evidence only: an exact `true` on the record's persisted
 * `reviewOriginated`. Missing / `undefined` / `'true'` / `1` — anything that is
 * not the boolean — changes nothing, so a non-review record (every normal turn)
 * delivers byte-for-byte as it does today. Text that is already a card is a
 * no-op at `applySelfImprovementFraming` (idempotent), so this predicate stays
 * simple: "is this a review record".
 *
 * `frameEnabled === false` is the kill switch, and it is the seam a revert-check
 * flips.
 *
 * @param {{ reviewOriginated?: unknown }} record
 * @param {{ frameEnabled?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldFrameSelfImprovement(record, opts) {
  if (opts?.frameEnabled === false) return false
  return record?.reviewOriginated === true
}

/**
 * Compose the title header onto the delivered body. Pure; the caller owns the
 * `(delayed) ` / `(from background task) ` delivery prefixes, which stay OUTSIDE
 * (they describe the delivery, this describes the text). The title is the
 * OUTERMOST content line so it always reads first, even when the reply-throw
 * banner is also present.
 *
 * IDEMPOTENT: text that already opens with the title (a real card) is returned
 * unchanged, so a delivered card never carries a duplicated title.
 *
 * @param {string} text
 * @returns {string}
 */
export function applySelfImprovementFraming(text) {
  const body = typeof text === 'string' ? text : ''
  // Empty body: the sweep's send adapter early-returns on empty text, and a
  // title over nothing would be a message about nothing. Leave it.
  if (body.trim().length === 0) return body
  // Already a card — do not prepend a second title.
  if (isSelfImprovementCard(body)) return body
  return `${SELF_IMPROVEMENT_TITLE}\n\n${body}`
}

/**
 * Structured telemetry for a self-improvement-framed delivery — the
 * observability half of the rule, mirroring {@link formatReplyThrowFraming}.
 * Framing changes what a human sees, so it must never be inferable only from the
 * absence of a log line. Worded to match NONE of `GATEWAY_SIGNATURES` in
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
export function formatSelfImprovementFraming(s) {
  return (
    `telegram gateway: outbox self-improvement framing nonce=${s.turnNonce} ` +
    `turnId=${s.turnId ?? 'unknown'} chatId=${s.chatId ?? 'unresolved'} ` +
    `sha=${(s.textSha256 ?? '').slice(0, 12)} source=${s.source ?? 'unknown'} ` +
    `reviewOriginated=true — review-turn prose delivered with its self-improvement ` +
    `title, never as raw unlabelled reasoning\n`
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
