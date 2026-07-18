/**
 * Inbound routing seam (switchroom#2996 P7).
 *
 * `routeInbound` is the single entry point the gateway's coalesced inbound
 * surfaces (`bot.on('message:text')` and the terminal
 * `installUnhandledMessageCatchAll`) delegate through. TODAY it is a pure
 * indirection: it forwards straight to the existing `handleInboundCoalesced`
 * via an injected `InboundRouterDeps` — behaviour-identical, zero control-flow
 * change. It exists so the later P7 stages can (a) move the intercept gauntlet
 * into `inbound-interceptors.ts` behind this same Deps boundary and (b) put the
 * eventual v2 consolidated control flow behind a deterministic kill switch at
 * one chokepoint, mirroring the P6 `MediaEnvelopeDeps` injection idiom.
 *
 * The Deps object holds LIVE references to the gateway's collaborators (never
 * value snapshots), bound once in gateway.ts alongside `mediaEnvelopeDeps`.
 */

import type { Context } from 'grammy'
import type { AttachmentMeta } from './gateway.js'

/**
 * Collaborators `routeInbound` needs, injected from gateway.ts module scope so
 * this module stays importable + unit-testable without gateway's boot side
 * effects. Extended by later P7 stages as intercepts move across the boundary;
 * every field is a live reference (function / Map / object), not a snapshot.
 */
export interface InboundRouterDeps {
  handleInboundCoalesced: (
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ) => Promise<void>
}

/**
 * Route a coalesced inbound message. Pure indirection in P7 PR-1 — forwards to
 * `deps.handleInboundCoalesced` unchanged.
 */
export async function routeInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment: AttachmentMeta | undefined,
  deps: InboundRouterDeps,
): Promise<void> {
  return deps.handleInboundCoalesced(ctx, text, downloadImage, attachment)
}
