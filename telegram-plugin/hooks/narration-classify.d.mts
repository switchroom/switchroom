/**
 * Type declarations for the shared trailing-text narration classifier
 * (switchroom#3513) so the bundled TypeScript surfaces — `turn-flush-safety.ts`,
 * `shown-ledger.ts`, `narrative-flush.ts` — can import the ONE classifier from
 * `narration-classify.mjs` without tsc resolution errors. The runtime module is
 * plain ESM (it is also imported by the unbundled Stop-hook `.mjs`, which can
 * only import sibling `.mjs` + node builtins), so it cannot be authored in TS.
 */
export const SUBSTANTIVE_MIN_CHARS: number
export const NARRATION_OPENER: RegExp
export const NARRATION_TRAILER: RegExp
export function isTrailingNarrationLine(block: string): boolean
export function isNarrationBlock(block: string): boolean
export function isStructuralNarration(
  text: string,
  followedByToolUse: boolean | undefined,
): boolean
export const EPHEMERAL_TOOLS: Set<string>
export function isEphemeralTool(name: string | null | undefined): boolean
export function selectBackstopDelivery(
  blocks: ReadonlyArray<{ text: string; followedByToolUse?: boolean }>,
): { text: string } | null
export function ledgerHashHex(text: string): string
