/**
 * Buzz co-channel — compile-time type-identity guards (2a MINOR-3).
 *
 * `gateway.ts` INLINES the `CurrentTurn.buzzCoords` shape
 * (`{ channelId; eventId; threadRoot }`) rather than importing the canonical
 * `BuzzCoords` from `channel-route.ts`, purely to hold gateway.ts at its
 * zero-headroom line-ratchet (switchroom#2996). That inlining is a drift hazard:
 * nothing structurally ties the two shapes together, so an edit to one could
 * silently diverge from the other.
 *
 * This file closes that hazard with a strict, invariant type-equality assertion
 * that makes `tsc --noEmit` (the lint gate) FAIL the moment the shapes differ.
 * Both imports are `import type` — fully erased at runtime, so this introduces
 * NO runtime dependency and NO module-load side effect (in particular it does
 * NOT load gateway.ts, which binds a UDS listener at import under prod). The
 * file is imported by nothing; it exists only to be type-checked.
 */

import type { CurrentTurn } from "./gateway.js";
import type { BuzzCoords } from "./channel-route.js";

/**
 * Invariant type equality: `true` IFF `A` and `B` are mutually assignable with
 * identical `readonly`/optional modifiers (the `(<T>() => …)` wrapper defeats
 * the bivariant/structural leniency a plain `extends` pair would allow).
 */
type TypeEq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// `buzzCoords` is optional on CurrentTurn; compare its PRESENT shape to the
// canonical BuzzCoords. If these ever drift, `TypeEq<…>` becomes `false` and the
// `= true` initializer is a hard `tsc` error — the intended build break.
const _buzzCoordsIdentity: TypeEq<NonNullable<CurrentTurn["buzzCoords"]>, BuzzCoords> = true;
void _buzzCoordsIdentity;
