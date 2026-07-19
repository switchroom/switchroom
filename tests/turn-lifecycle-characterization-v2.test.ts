/**
 * P8 PR-E — the SAME turn-lifecycle characterization harness with
 * SWITCHROOM_TURN_END_FUNNEL_V2=1 (the endTurn(reason) dispatcher branch).
 *
 * Env flags are module-load consts (P7 F2), so the flag must be set BEFORE the
 * gateway import — hence a separate vitest worker file whose only job is to
 * pre-set the env and then load the base harness. Every case (1-9) must pass
 * IDENTICALLY under both flag settings: the shadowEmit turnEnd-sequence spy in
 * the base harness is the parity oracle (design §2 PR-E — v1 == v2 effects).
 */
process.env.SWITCHROOM_TURN_END_FUNNEL_V2 = '1'
await import('./turn-lifecycle-characterization.test.js')
