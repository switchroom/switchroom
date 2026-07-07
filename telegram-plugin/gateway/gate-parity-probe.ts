/**
 * Gate-parity drift probe — scaffolding for the inbound-delivery
 * state-machine cutover (#2794, RFC PR3b→PR4).
 *
 * ## Why this exists
 *
 * The inbound-delivery pipeline is mid-migration and TRIPLE-maintained:
 *
 *   1. the pure state machine (`inbound-delivery-machine.ts`) — the model,
 *   2. the shadow (`inbound-delivery-machine-shadow.ts`) — module-scope
 *      machine state advanced by `shadowEmit`, now AUTHORITATIVE for the
 *      turn-in-flight gate via `isMachineInTurn()`,
 *   3. the legacy imperative `claudeBusyKeys` set — still fully maintained
 *      in parallel and read as the kill-switch fallback.
 *
 * Per #2794 the standing risk is DRIFT: because the same turn-lifecycle
 * fact ("is a turn in flight?") is tracked in two live places, a fix in
 * one can silently diverge from the other. The machine is authoritative
 * today, but `claudeBusyKeys` is still wired and still read on the
 * kill-switch path — so the two MUST NOT drift in the dangerous direction.
 *
 * ## What "agree" means (and the ONE intended divergence)
 *
 * The machine and `claudeBusyKeys` are designed to agree on every
 * WELL-FORMED schedule (every turnStart has a matching turnEnd). They are
 * deliberately allowed to diverge in exactly ONE direction on a MALFORMED
 * schedule — an orphaned turnStart (turn B opens before turn A's turnEnd
 * ever lands, the gymbro/clerk 5-min dangle of 2026-05-28):
 *
 *   - `busykeys_dangle`  — machine reads idle (self-healed via TTL tick or
 *                          single-activeTurn reopen) while `claudeBusyKeys`
 *                          still holds an orphan key. This is EXPECTED and
 *                          GOOD: it is precisely the wedge the machine was
 *                          made authoritative to kill. Not a drift alarm.
 *
 *   - `machine_over_holds` — machine reads in-flight while `claudeBusyKeys`
 *                            is empty. This is the DANGEROUS direction: the
 *                            now-authoritative gate would hold closed while
 *                            the imperative view says idle — a NEW wedge
 *                            class the cutover must never introduce. This
 *                            is the drift #2794 warns about; surface it.
 *
 * This module is a pure classifier plus a log-only runtime probe. It
 * performs NO I/O of its own beyond an optional injected log sink and
 * changes NO delivery behaviour — it only observes. Deleting it once the
 * `claudeBusyKeys` shadow is removed in PR4 is a no-op for behaviour.
 */

export type GateParityDivergence = 'none' | 'busykeys_dangle' | 'machine_over_holds'

/**
 * Classify the relationship between the machine's authoritative
 * turn-in-flight read and the legacy imperative `claudeBusyKeys` size.
 * Pure — no side effects.
 */
export function gateParityDivergence(
  machineInTurn: boolean,
  busyKeysSize: number,
): GateParityDivergence {
  const busy = busyKeysSize > 0
  if (machineInTurn === busy) return 'none'
  // machine idle, busyKeys non-empty → the orphan dangle the machine heals.
  if (!machineInTurn && busy) return 'busykeys_dangle'
  // machine in-flight, busyKeys empty → the dangerous over-hold.
  return 'machine_over_holds'
}

/**
 * True only for divergences that indicate a real cutover regression
 * (the machine holding a gate the imperative shadow believes is open).
 * The benign `busykeys_dangle` — the very wedge the machine fixes — is
 * NOT flagged, so this probe has zero false positives on the known-good
 * self-heal path.
 */
export function isDangerousGateDivergence(d: GateParityDivergence): boolean {
  return d === 'machine_over_holds'
}

/**
 * Log-only runtime drift canary. Call at the authoritative gate read.
 * Emits a single grep-friendly `gw-trace gate-drift` line ONLY on the
 * dangerous over-hold direction. Returns the machine value UNCHANGED so
 * it can wrap the gate read without altering behaviour:
 *
 *   return probeGateParity(isMachineInTurn(), claudeBusyKeys.size)
 *
 * @param log  optional sink (default stderr) — test hook.
 */
export function probeGateParity(
  machineInTurn: boolean,
  busyKeysSize: number,
  log: (line: string) => void = (line) => process.stderr.write(line),
): boolean {
  const d = gateParityDivergence(machineInTurn, busyKeysSize)
  if (isDangerousGateDivergence(d)) {
    log(
      `gw-trace gate-drift kind=${d} machineInTurn=${machineInTurn} ` +
        `busyKeys=${busyKeysSize} note=machine-authoritative-gate-holds-while-imperative-idle\n`,
    )
  }
  return machineInTurn
}
