export type Audience = 'user' | 'internal'

export const AUDIENCE_USER: 'user'
export const AUDIENCE_INTERNAL: 'internal'

/** Mirror of `REVIEW_SOURCE` in `src/self-improve/review-prompt.ts`. */
export const REVIEW_SOURCE: 'self_improve_review'

export function isReviewOriginatedSource(source: string | null | undefined): boolean

export function decideCaptureAudience(signals: {
  replyToolThrewThisTurn?: boolean
  openInboundObligation?: true | false | 'unknown'
  reviewOriginated?: boolean
  reviewTextIsCard?: boolean
}): Audience

export function resolveOpenObligation(args: {
  snapshotRaw?: string | null
  chatId?: string | null
  /** #4146: `false` ⇒ persistence is off, so the file proves nothing. */
  snapshotTrusted?: boolean
}): true | false | 'unknown'

export function resolveRecordAudience(value: unknown): Audience

export function shouldSuppressForAudience(
  record: { audience?: unknown },
  opts?: { gateEnabled?: boolean },
): boolean

export const REPLY_THROW_PROVENANCE_NOTICE: string

export function shouldFrameReplyThrow(
  record: { replyToolThrewThisTurn?: unknown },
  opts?: { frameEnabled?: boolean },
): boolean

export function applyReplyThrowFraming(text: string): string

export function formatReplyThrowFraming(s: {
  turnNonce: string
  turnId?: string | null
  chatId?: string | null
  textSha256?: string
  source?: string
}): string

export const SELF_IMPROVEMENT_TITLE: string

export function isSelfImprovementCard(text: string | null | undefined): boolean

export function shouldFrameSelfImprovement(
  record: { reviewOriginated?: unknown },
  opts?: { frameEnabled?: boolean },
): boolean

export function applySelfImprovementFraming(text: string): string

export function formatSelfImprovementFraming(s: {
  turnNonce: string
  turnId?: string | null
  chatId?: string | null
  textSha256?: string
  source?: string
}): string

export function formatInternalSuppression(s: {
  turnNonce: string
  turnId?: string | null
  chatId?: string | null
  textSha256?: string
  ageMs?: number
  source?: string
  pastWindow?: boolean
}): string
