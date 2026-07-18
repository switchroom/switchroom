# P7 inbound-router extraction — working notes

Persistent scratch for the P7 (inbound routing extraction, #2996) staged work.
Branch base: fresh `main` (clone via `gh repo clone switchroom/switchroom`).

## PR-0 — characterization harness (this task) — DONE

- Test: `telegram-plugin/tests/inbound-router-characterization.test.ts` (18 cases, all green).
- Production change (F1): exported `handleInbound`, `handleInboundCoalesced`,
  and a `__inboundRouterTestSeam` accessor from `telegram-plugin/gateway/gateway.ts`.
  Additive only — no behaviour change. `npm run lint` clean (tsc + bot-api-wrapping
  + gateway-line-ratchet all pass; ratchet at 27164 vs 27134, slack 50).
- Spy boundary (red-team requirement met): real intercept code executes; only the
  Deps-boundary collaborators are mocked — `inbound-delivery-machine-dispatch.js`
  (dispatchEffects = deliver-vs-buffer oracle), `src/agents/tmux.js`
  (sendAgentInterrupt), `secret-detect/pipeline.js` (runPipeline, fail-closed),
  `gateway/auth-add-flow.js` (submitAccountAuthCode stub, keeps the REAL
  pendingAuthAddFlows Map). The delivery state machine (shadow/gate/machine)
  is NOT mocked — it drives real deliver/buffer routing (F4 exercised e2e).

### Findings that sharpen the design (folded into DESIGN.md §6 dated note 2026-07-19)

1. **F1 undercounts the seam.** A *functional* harness needs more than the two
   function exports: it must (a) seed gateway-local intercept stores
   (`pendingReauthFlows`, `pendingPermissions`, `secretStaging`,
   `vaultPassphraseCache`, `activeStatusReactions`, `activeTurnStartedAt`),
   (b) inject a fake `ipcServer` (it's `let ipcServer!: IpcServer`, assigned only
   under `isGatewayMain`, so `undefined` under a test import — the
   permission-verdict path `dispatchPermissionVerdict` and the legacy deliver
   body both deref it), and (c) set `currentTurn`. All exposed via one added
   `__inboundRouterTestSeam` object. Still one export block, zero behaviour change.
2. **Not all "module-global" intercept state is gateway-local.** §1's coupling list
   lumps `pendingAuthAddFlows` / `pendingLoopbackFlows` with the gateway globals,
   but they actually live in `auth-add-flow.js` / the loopback module and are
   *imported* into gateway.ts. Only `pendingReauthFlows` is gateway-local. Minor,
   but relevant to PR-5/PR-6/PR-7 (those intercepts already own their state module).
3. **Machine defaults to `bridge_dead` on a fresh import.** A functional deliver
   assertion must `shadowEmit({kind:'bridgeUp'})` first; otherwise everything routes
   to the legacy imperative body (which dereferences the unset ipcServer). Operational,
   not a design error.
4. **Raw `bot.api` egress in the auth-code redact path throws under test import**
   (`redactAuthCodeMessage` → `bot.api.deleteMessage`, module-global `bot` unbound).
   It fires AFTER the intercept decision is recorded, so the harness tolerates it
   (`.catch(()=>{})`) — a presentation-only egress, not a routing concern.

### F-findings coverage map (all mandatory amendments honoured)
- F1 export seam — done (see above).
- F2 flags const-captured at import — the file sets env BEFORE the dynamic import and
  pins the default-ON `AUTOCLASSIFY_MIDTURN_SHADOW` behaviour; a flag *flip* would need
  a separate worker/file (documented in the test header, not exercised here).
- F3 status-KPI + AUTOCLASSIFY_MIDTURN_SHADOW pinned as NON-intercepting.
- F4 at-receipt snapshot: fresh-turn-delivers-despite-self-emit AND mid-turn-buffers
  both pinned.
- F6 harness named as the PR-11 parity oracle (test header + PR body).
- Fail-closed secret drop + auth-code TTL-expiry cases included (red-team blocker).

## PR-1.. — not started. Next: define InboundRouterDeps + pure indirection seam.
