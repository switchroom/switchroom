export type Audience = 'user' | 'internal'

export const AUDIENCE_USER: 'user'
export const AUDIENCE_INTERNAL: 'internal'

export function decideCaptureAudience(signals: {
  replyToolThrewThisTurn?: boolean
  openInboundObligation?: true | false | 'unknown'
}): Audience

export function resolveOpenObligation(args: {
  snapshotRaw?: string | null
  chatId?: string | null
}): true | false | 'unknown'

export function resolveRecordAudience(value: unknown): Audience

export function shouldSuppressForAudience(
  record: { audience?: unknown },
  opts?: { gateEnabled?: boolean },
): boolean

export function formatInternalSuppression(s: {
  turnNonce: string
  turnId?: string | null
  chatId?: string | null
  textSha256?: string
  ageMs?: number
  source?: string
  pastWindow?: boolean
}): string
