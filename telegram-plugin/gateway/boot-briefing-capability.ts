/**
 * Capability sentinel for the start.sh ↔ gateway-bundle version handshake
 * (#4245). This is a DEPENDENCY-FREE leaf module on purpose: it is imported
 * both by the gateway (`boot-briefing-wiring.ts`, which references it so the
 * un-minified bundle carries the literal) AND by `src/agents/scaffold.ts`
 * (which templates the value into the generated start.sh). Keeping it free of
 * `bun:sqlite` / history imports lets the node-side scaffold import it without
 * pulling in bun-only runtime deps.
 *
 * ## The skew it closes
 *
 * A freshly-scaffolded start.sh sets `SWITCHROOM_SESSION_BRIEFING=gateway` AND
 * skips the legacy shell handoff-briefing assembler for that mode. If the
 * deployed `/opt/switchroom/telegram-plugin/dist/gateway/gateway.js` bundle
 * PREDATES the boot-briefing builder, the gateway path is dead too — the agent
 * gets a SILENT no-briefing until the image is updated. The stale bundle cannot
 * self-report a feature it doesn't contain, so the FRESH component (start.sh)
 * performs the handshake: it greps the deployed bundle for this literal before
 * trusting the flag. On a miss it warns loudly and drops a marker so the inner
 * pass runs the legacy handoff assembler as a fallback (see
 * `profiles/_base/start.sh.hbs`), rather than leaving the boot with nothing.
 *
 * The gateway bundle is built UN-minified (`telegram-plugin/scripts/build.mjs`:
 * `bun build --target node`, no `--minify`), so this string literal survives
 * verbatim into `gateway.js`.
 *
 * Bump the version suffix ONLY on a breaking change to the boot-briefing
 * capability contract that an older start.sh must not treat as present. Both
 * sides of the handshake read this single constant, so a bump stays in sync.
 */
export const GATEWAY_BOOT_BRIEFING_CAPABILITY = 'switchroom-cap:boot-briefing:v1'
