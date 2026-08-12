/**
 * The watchdog tick: probe → append to the rolling window → evaluate →
 * apply hysteresis → notify → persist.
 *
 * Everything with a side effect is injected (`notify`, `nowFn`, the probe
 * deps), so the state machine — which is the part that decides whether a
 * human's phone buzzes — is tested without a socket, a container, or a
 * clock. See `run.test.ts`.
 */

import { ProbeError, probeOnce, type ProbeOptions } from "./probe.js";
import { foldBaseline } from "./baseline.js";
import { evaluateAll } from "./evaluate.js";
import { loadState, pushSample, saveState } from "./state.js";
import {
  BREACHES_TO_FIRE_EDGE,
  BREACHES_TO_FIRE_LEVEL,
  CLEARS_TO_RESOLVE,
  RENOTIFY_MS,
} from "./thresholds.js";
import {
  emptyState,
  type SignalId,
  type SignalState,
  type Verdict,
  type WatchState,
} from "./types.js";

/**
 * Signals that fire on the FIRST breach because they are edges, not levels:
 * a new memory loss and a container restart are discrete events that already
 * happened — waiting for a second observation would just delay the news, and
 * they cannot flap the way a rate can.
 */
const EDGE_SIGNALS = new Set<SignalId>([
  "retain-loss",
  "container",
  // Both of these carry their own debounce INSIDE the measurement, so the
  // two-tick level debounce would only delay the news by one cadence:
  //
  //  - `consolidation-failure-streak` fires at ≥3 CONSECUTIVE terminal
  //    failures with no completion in between. Three of those is not a flake;
  //    requiring a second tick would put detection of the 2026-07-29 incident
  //    at ~30 min instead of ~15.
  //  - `vector-index-corruption` is an error RAISED by an index scan. A
  //    corrupt HNSW index does not intermittently become valid.
  "consolidation-failure-streak",
  "vector-index-corruption",
]);

function breachesToFire(signal: SignalId): number {
  return EDGE_SIGNALS.has(signal) ? BREACHES_TO_FIRE_EDGE : BREACHES_TO_FIRE_LEVEL;
}

/** What the tick decided to do about one signal. */
export type Transition = "fired" | "renotified" | "resolved" | "none";

export interface SignalOutcome {
  verdict: Verdict;
  transition: Transition;
  /** Post-tick hysteresis state (persisted). */
  state: SignalState;
}

export interface TickResult {
  /** Non-null when the watchdog could not see hindsight at all. */
  probeError: string | null;
  outcomes: SignalOutcome[];
  /** Messages handed to `notify` this tick, in order. */
  notified: string[];
  /**
   * Process exit code:
   *   0  — the check ran and nothing is firing
   *  10  — the check ran and at least one signal is firing
   *   1  — the check could not complete: probe failure, state-write failure,
   *        or an alert/all-clear that reached no gateway
   */
  exitCode: 0 | 1 | 10;
}

export interface TickOptions extends ProbeOptions {
  statePath: string;
  /**
   * Deliver ONE operator DM. Returns true when it reached a gateway. A
   * failed delivery does NOT mark the signal notified, so the next tick
   * retries instead of going quiet about a live incident.
   */
  notify: (text: string) => Promise<boolean>;
  /** Skip both the DM and the state write; print-only mode for `--dry-run`. */
  dryRun?: boolean;
  nowFn?: () => number;
  log?: (msg: string) => void;
}

function initial(state: WatchState, signal: SignalId): SignalState {
  return state.signals[signal] ?? { status: "ok", breaches: 0, clears: 0 };
}

/**
 * Apply hysteresis to one verdict. Pure, so the anti-spam contract is
 * asserted directly in tests rather than inferred from a live run.
 *
 * `no-data` is deliberately inert: it neither advances breaches nor clears.
 * An idle hindsight (no retains in the window) must not silently resolve a
 * firing alert, and a single quiet interval must not reset an accumulating
 * breach count.
 */
export function applyHysteresis(
  prev: SignalState,
  verdict: Verdict,
  now: number,
): { next: SignalState; transition: Transition } {
  const next: SignalState = { ...prev };
  if (verdict.state === "no-data") {
    return { next, transition: "none" };
  }
  if (verdict.state === "breach") {
    next.breaches = prev.breaches + 1;
    next.clears = 0;
    if (prev.status === "ok") {
      if (next.breaches >= breachesToFire(verdict.signal)) {
        next.status = "firing";
        next.firedAt = now;
        next.lastNotifiedAt = now;
        return { next, transition: "fired" };
      }
      return { next, transition: "none" };
    }
    // Already firing — re-notify only after the quiet period.
    const last = prev.lastNotifiedAt ?? 0;
    if (now - last >= RENOTIFY_MS) {
      next.lastNotifiedAt = now;
      return { next, transition: "renotified" };
    }
    return { next, transition: "none" };
  }
  // verdict.state === "ok"
  next.clears = prev.clears + 1;
  next.breaches = 0;
  if (prev.status === "firing" && next.clears >= CLEARS_TO_RESOLVE) {
    next.status = "ok";
    next.clears = 0;
    delete next.firedAt;
    delete next.lastNotifiedAt;
    return { next, transition: "resolved" };
  }
  return { next, transition: "none" };
}

/**
 * Alert header. A `warn`-severity breach gets an orange dot and the word
 * "degraded", so an operator can triage from the notification shade without
 * opening a terminal. Anything else keeps the original red — including every
 * pre-existing signal, none of which sets a severity.
 */
function firingHeader(v: Verdict): string {
  return v.severity === "warn"
    ? `🟠 hindsight: ${v.signal} degraded`
    : `🔴 hindsight: ${v.signal}`;
}

/** Operator DM for a signal going (or staying) firing. */
export function formatFiring(v: Verdict, repeat: boolean): string {
  const still = repeat ? " (still firing)" : "";
  return (
    `${firingHeader(v)}${still}\n` +
    `${v.detail}\n` +
    `Check: switchroom hindsight-watch --dry-run`
  );
}

/** Operator DM for a signal clearing. */
export function formatResolved(v: Verdict): string {
  return `🟢 hindsight: ${v.signal} resolved — ${v.detail}`;
}

/** Operator DM for the watchdog being unable to see hindsight at all. */
export function formatProbeFailure(reason: string, repeat: boolean): string {
  const still = repeat ? " (still failing)" : "";
  return (
    `🔴 hindsight: watchdog cannot see hindsight${still}\n` +
    `${reason}\n` +
    `This is an alert, not a skipped check — memory writes may be failing unobserved.`
  );
}

/**
 * Run one watchdog tick. Never throws: every failure path becomes an exit
 * code and (where a human should know) a DM.
 */
export async function tick(opts: TickOptions): Promise<TickResult> {
  const now = (opts.nowFn ?? Date.now)();
  const log = opts.log ?? (() => {});
  const notified: string[] = [];
  /**
   * Set when an alert (or all-clear) could not be handed to any gateway.
   * The tick then exits 1 — "the check could not complete" — rather than 0.
   * Exiting 0 after detecting a breach nobody was told about is the exact
   * silent-failure mode this watchdog exists to eliminate.
   */
  let deliveryFailed = false;

  let state: WatchState;
  try {
    state = loadState(opts.statePath);
  } catch {
    state = emptyState();
  }

  // ── probe ────────────────────────────────────────────────────────────
  let probeErr: string | null = null;
  let sample: Awaited<ReturnType<typeof probeOnce>>["sample"] | null = null;
  try {
    // Thread the tick's clock into the probe so the sample timestamp and the
    // hysteresis timestamps come from ONE source. Otherwise the persisted
    // window would carry wall-clock timestamps while the state machine used
    // an injected clock, and the two would disagree about window width.
    sample = (await probeOnce({ ...opts, now: () => now })).sample;
  } catch (e) {
    probeErr =
      e instanceof ProbeError ? `${e.probe} probe: ${e.message}` : `probe: ${(e as Error).message}`;
  }

  const probeVerdict: Verdict = {
    signal: "probe",
    state: probeErr === null ? "ok" : "breach",
    detail: probeErr ?? "all three probes (metrics, docker, spool) succeeded",
  };
  const probePrev = initial(state, "probe");
  const probeStep = applyHysteresis(probePrev, probeVerdict, now);
  const outcomes: SignalOutcome[] = [];

  if (probeErr !== null) {
    // A blind watchdog reports nothing else — a stale window would produce
    // confidently wrong verdicts. Notify (subject to hysteresis) and stop.
    let t = probeStep.transition;
    if (!opts.dryRun && (t === "fired" || t === "renotified")) {
      const text = formatProbeFailure(probeErr, t === "renotified");
      const ok = await opts.notify(text);
      if (ok) notified.push(text);
      else {
        // Undelivered ⇒ do not record it as notified, so the next tick
        // retries rather than assuming the operator was told.
        probeStep.next.lastNotifiedAt = probePrev.lastNotifiedAt;
        t = "none";
        log(`hindsight-watch: probe alert not delivered — will retry next tick`);
      }
    } else if (opts.dryRun && (t === "fired" || t === "renotified")) {
      notified.push(formatProbeFailure(probeErr, t === "renotified"));
    }
    outcomes.push({ verdict: probeVerdict, transition: t, state: probeStep.next });
    const nextState: WatchState = { ...state, signals: { ...state.signals, probe: probeStep.next } };
    if (!opts.dryRun) {
      try {
        saveState(opts.statePath, nextState);
      } catch (e) {
        log(`hindsight-watch: could not persist state: ${(e as Error).message}`);
      }
    }
    return { probeError: probeErr, outcomes, notified, exitCode: 1 };
  }

  let probeTransition = probeStep.transition;
  if (probeTransition === "resolved") {
    const text = formatResolved(probeVerdict);
    if (opts.dryRun) notified.push(text);
    else if (await opts.notify(text)) notified.push(text);
    else {
      // Roll the resolution back: the operator is still holding a red alert
      // for this signal, so the state must stay firing until the all-clear
      // actually lands.
      probeStep.next = probePrev;
      probeTransition = "none";
      deliveryFailed = true;
      log("hindsight-watch: probe all-clear not delivered — will retry next tick");
    }
  }
  outcomes.push({ verdict: probeVerdict, transition: probeTransition, state: probeStep.next });

  // ── evaluate ─────────────────────────────────────────────────────────
  const withSample = pushSample(state, sample!);
  // Fold THIS tick into the trailing baseline before evaluating. Ordering is
  // safe because `baselineFor` scores against COMPLETED days only, so a tick
  // can never contaminate its own reference; folding first is what lets the
  // baseline start accumulating on the very first run rather than needing a
  // warm-up tick it would never announce.
  const baseline = foldBaseline(state.baseline, sample!.recall ?? null, now);
  const signals: Partial<Record<SignalId, SignalState>> = { probe: probeStep.next };
  let anyFiring = false;

  for (const verdict of evaluateAll(withSample.ring, baseline, now)) {
    const prev = initial(state, verdict.signal);
    const step = applyHysteresis(prev, verdict, now);
    let transition = step.transition;
    if (transition === "fired" || transition === "renotified") {
      const text = formatFiring(verdict, transition === "renotified");
      if (opts.dryRun) {
        notified.push(text);
      } else if (await opts.notify(text)) {
        notified.push(text);
      } else {
        step.next.lastNotifiedAt = prev.lastNotifiedAt;
        if (transition === "fired") {
          // Roll the fire back so the NEXT tick re-attempts the first DM
          // instead of leaving a firing signal the operator never heard of.
          step.next.status = prev.status;
          delete step.next.firedAt;
        }
        transition = "none";
        deliveryFailed = true;
        log(`hindsight-watch: ${verdict.signal} alert not delivered — will retry next tick`);
      }
    } else if (transition === "resolved") {
      const text = formatResolved(verdict);
      if (opts.dryRun) notified.push(text);
      else if (await opts.notify(text)) notified.push(text);
      else {
        // Undelivered all-clear ⇒ stay firing, so the resolution is retried
        // instead of the operator being left holding a stale red alert.
        step.next = prev;
        transition = "none";
        deliveryFailed = true;
        log(`hindsight-watch: ${verdict.signal} all-clear not delivered — will retry next tick`);
      }
    }
    if (step.next.status === "firing") anyFiring = true;
    signals[verdict.signal] = step.next;
    outcomes.push({ verdict, transition, state: step.next });
  }

  // ── persist ──────────────────────────────────────────────────────────
  if (!opts.dryRun) {
    try {
      saveState(opts.statePath, { ...withSample, signals, baseline });
    } catch (e) {
      // Fail loudly: without a persisted window the next tick starts blind,
      // and hysteresis counters never accumulate.
      log(`hindsight-watch: could not persist state to ${opts.statePath}: ${(e as Error).message}`);
      return { probeError: null, outcomes, notified, exitCode: 1 };
    }
  }

  if (deliveryFailed) {
    // Loud: something needed to reach a human and did not.
    return { probeError: null, outcomes, notified, exitCode: 1 };
  }
  return { probeError: null, outcomes, notified, exitCode: anyFiring ? 10 : 0 };
}
