/**
 * Update-check drift notifier (KEN-129 — stage 1 of the KEN-128
 * auto-reconcile plan).
 *
 * When the release watcher (`release-watcher.ts`) detects that the
 * fleet is behind the published release but `apply_on_detect` is
 * false, this module posts ONE operator approval card ("fleet is
 * behind — tap to apply") through the existing hostd approval-card
 * surface (`approval-gateway.ts`, the same request_config_approval
 * IPC used by config_propose_edit). On Approve it starts the exact
 * same `update_apply` path the hostd verb uses — fleet-mutation
 * lock, apply-asset preflight, durable status rows and all.
 *
 * Invariants (the KEN-129 acceptance criteria):
 *   - ONE card per release id. The last-notified release id is
 *     persisted to `statePath` so a hostd restart cannot re-card the
 *     same release. A card that *reached* the operator (approve,
 *     operator deny, or timeout) marks the release notified; a
 *     dispatch failure (gateway unreachable / send failed) does NOT,
 *     so the next tick retries.
 *   - Restart-loop storm guard: a `pending` marker is persisted just
 *     BEFORE the card posts and cleared when the card resolves. If
 *     hostd dies while the card is outstanding (crash loop, operator
 *     restart), the next boot suppresses a re-post of the same
 *     release until the original card's timeout window has elapsed —
 *     so a restart loop cannot storm the operator with duplicate
 *     cards. A resolved dispatch failure clears the marker so the
 *     next tick retries promptly.
 *   - Respect the fleet-mutation lock: while an update_apply / apply
 *     / rollout is in flight we post nothing (the tick is skipped and
 *     retried on the next interval — the running mutation likely IS
 *     the catch-up). Re-checked after the (slow) plan probe so a
 *     mutation that started during the probe also suppresses the card.
 *   - No card when current: the watcher only calls us when a release
 *     is actually available, and dedup covers the steady "behind but
 *     already asked" state.
 *
 * Dependency-injection-shaped like the watcher: production wiring
 * lives in `main.ts`; tests drive the state machine with stubs.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { ApprovalResult } from "./approval-gateway.js";

/** Minimal slice of HostdResponse the notifier needs from the apply hook. */
export interface StartApplyResult {
  /** "started" when the fleet mutation was accepted; anything else
   *  ("denied", "error") means it did not start. */
  result: string;
  /** Operator-facing refusal/error detail when result !== "started". */
  error?: string;
}

/** Terminal outcome of one notify attempt — asserted by tests and logged. */
export type NotifyOutcome =
  | "deduped" // already notified for this release id
  | "pending_recent" // a card for this release was posted before a restart and may still be live
  | "skipped_no_version" // watcher passed an empty release id — nothing to card
  | "locked" // fleet mutation in flight — skipped, retry next tick
  | "dispatch_failed" // card never reached the operator — retry next tick
  | "denied" // operator tapped Deny
  | "timed_out" // card expired unanswered
  | "apply_started" // operator approved; update_apply started
  | "apply_refused"; // operator approved but the apply hook refused

/**
 * The gateway's `request_config_finalize` validator rejects `detail`
 * over 500 chars (ipc-server.ts) — an over-long detail would silently
 * drop the finalize and leave the card's buttons live forever. Clip
 * with headroom.
 */
const FINALIZE_DETAIL_MAX = 450;

export interface UpdateNotifierOptions {
  /** JSON file persisting notify/pending state across restarts. */
  statePath: string;
  /** Post the approval card; resolves with the operator's verdict.
   *  Production wiring iterates admin agents' gateway sockets. */
  requestApproval: (args: {
    requestId: string;
    version: string;
    plan: string;
  }) => Promise<ApprovalResult>;
  /** Start the hostd update_apply path (fleet-lock + preflight +
   *  status rows included). Refusals come back as
   *  `result !== "started"`; a throw is treated as a refusal. */
  startApply: (requestId: string) => StartApplyResult;
  /** True while hostd's fleet-mutation lock is held. */
  isFleetMutationInFlight: () => boolean;
  /** Best-effort `switchroom update --check` plan text for the card
   *  body. Failures resolve to "" — the card still posts. */
  planFn?: () => Promise<string>;
  /** How long a pre-restart pending card suppresses a re-post of the
   *  same release (should match the card's timeoutMs). Default 1h. */
  repostSuppressMs?: number;
  log?: (m: string) => void;
  /** Test seam — request-id mint. */
  mintRequestId?: () => string;
  /** Test seam — wall clock. */
  now?: () => number;
}

interface NotifierState {
  last_notified_version?: string;
  notified_at?: number;
  /** Release id of a card posted but not yet resolved (crash guard). */
  pending_version?: string;
  pending_posted_at?: number;
}

const DEFAULT_REPOST_SUPPRESS_MS = 60 * 60_000;

export class UpdateNotifier {
  constructor(private readonly opts: UpdateNotifierOptions) {}

  /**
   * Called by the release watcher with the detected remote release id
   * (digest). Never throws — every failure path logs and returns an
   * outcome so the watcher's tick can't be broken by notify errors.
   */
  async notifyIfNew(version: string): Promise<NotifyOutcome> {
    try {
      return await this.run(version);
    } catch (err) {
      this.log(`notify failed: ${errMsg(err)}`);
      return "dispatch_failed";
    }
  }

  private async run(version: string): Promise<NotifyOutcome> {
    if (version === "") {
      // The watcher's checkFn contract makes version optional; an
      // empty id would render a blank card and dedup on "" forever.
      this.log(
        "release detected but no release id was provided — skipping card",
      );
      return "skipped_no_version";
    }
    const state = this.readState();
    if (state?.last_notified_version === version) {
      return "deduped";
    }
    const suppressMs = this.opts.repostSuppressMs ?? DEFAULT_REPOST_SUPPRESS_MS;
    if (
      state?.pending_version === version &&
      typeof state.pending_posted_at === "number" &&
      this.now() - state.pending_posted_at < suppressMs
    ) {
      // A card for this release was posted before a restart and may
      // still be live in the operator's chat — do not double-card.
      this.log(
        `release ${short(version)} has a possibly-live card from before a restart — suppressing re-post`,
      );
      return "pending_recent";
    }
    if (this.opts.isFleetMutationInFlight()) {
      this.log(
        `release ${short(version)} detected but a fleet mutation is in flight — not posting a card this tick`,
      );
      return "locked";
    }

    let plan = "";
    if (this.opts.planFn) {
      try {
        plan = await this.opts.planFn();
      } catch (err) {
        this.log(`update --check plan probe failed: ${errMsg(err)}`);
      }
    }
    // The plan probe shells out (up to minutes) — a mutation may have
    // started meanwhile. Re-check so we never card mid-mutation.
    if (this.opts.isFleetMutationInFlight()) {
      this.log(
        `fleet mutation started during the plan probe for ${short(version)} — not posting a card this tick`,
      );
      return "locked";
    }

    const requestId = this.opts.mintRequestId
      ? this.opts.mintRequestId()
      : `relnotify-${randomBytes(4).toString("hex")}`;
    this.log(
      `posting update approval card for release ${short(version)} (requestId=${requestId})`,
    );
    // Crash guard: mark the card pending BEFORE posting so a hostd
    // restart while the card is outstanding cannot re-card this
    // release inside the suppress window.
    this.writeState({
      ...this.carryNotified(state),
      pending_version: version,
      pending_posted_at: this.now(),
    });

    let res: ApprovalResult;
    try {
      res = await this.opts.requestApproval({ requestId, version, plan });
    } catch (err) {
      res = {
        verdict: "deny",
        reason: `requestApproval threw: ${errMsg(err)}`,
        denySource: "dispatch_failure",
        finalize: async () => {},
      };
    }

    if (res.verdict === "deny" && res.denySource === "dispatch_failure") {
      // The card never reached the operator — do NOT mark notified;
      // clear the pending marker so the next watcher tick retries.
      this.log(
        `update approval card dispatch failed (${res.reason ?? "unknown"}) — will retry next tick`,
      );
      this.writeState(this.carryNotified(state));
      return "dispatch_failed";
    }

    // The card reached the operator: whatever the verdict, this
    // release id is now "asked" — one card per release. (Also clears
    // the pending marker.)
    this.writeState({
      last_notified_version: version,
      notified_at: this.now(),
    });

    if (res.verdict === "deny") {
      this.log(`operator denied update for release ${short(version)}`);
      return "denied";
    }
    if (res.verdict === "timeout") {
      this.log(`update approval card expired for release ${short(version)}`);
      return "timed_out";
    }

    // Approved — start the real update_apply path.
    let start: StartApplyResult;
    try {
      start = this.opts.startApply(requestId);
    } catch (err) {
      start = { result: "error", error: errMsg(err) };
    }
    if (start.result === "started") {
      this.log(`update_apply started (requestId=${requestId})`);
      await res.finalize({
        outcome: "applied",
        detail: clipDetail(
          `switchroom update started (request_id ${requestId}) — track progress via get_status / the rollout narration message.`,
        ),
      });
      return "apply_started";
    }
    const why = start.error ?? `unexpected result "${start.result}"`;
    this.log(`update_apply refused after approval: ${why}`);
    // Closest available terminal card state — `reconcile_failed_rolled_back`
    // is reused because old gateways reject unknown outcomes (mixed-version
    // safety); the detail carries the honest reason (nothing was rolled
    // back; the apply never started).
    await res.finalize({
      outcome: "reconcile_failed_rolled_back",
      detail: clipDetail(`update did not start: ${why}`),
    });
    return "apply_refused";
  }

  /** Preserve any prior last-notified fields when rewriting state. */
  private carryNotified(state: NotifierState | null): NotifierState {
    return state?.last_notified_version !== undefined
      ? {
          last_notified_version: state.last_notified_version,
          notified_at: state.notified_at ?? 0,
        }
      : {};
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private readState(): NotifierState | null {
    try {
      const raw = readFileSync(this.opts.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<NotifierState> | null;
      if (parsed === null || typeof parsed !== "object") return null;
      const out: NotifierState = {};
      if (typeof parsed.last_notified_version === "string") {
        out.last_notified_version = parsed.last_notified_version;
        out.notified_at =
          typeof parsed.notified_at === "number" ? parsed.notified_at : 0;
      }
      if (typeof parsed.pending_version === "string") {
        out.pending_version = parsed.pending_version;
        out.pending_posted_at =
          typeof parsed.pending_posted_at === "number"
            ? parsed.pending_posted_at
            : 0;
      }
      return Object.keys(out).length > 0 ? out : null;
    } catch {
      // Missing or corrupt state → treat as never-notified. Worst case
      // is one duplicate card after a corrupt file, never a crash.
      return null;
    }
  }

  private writeState(state: NotifierState): void {
    try {
      mkdirSync(dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state) + "\n", "utf8");
      renameSync(tmp, this.opts.statePath);
    } catch (err) {
      // Non-fatal: dedup degrades to in-process only until the next
      // successful write (a restart could re-card once).
      this.log(`failed to persist notify state: ${errMsg(err)}`);
    }
  }

  private log(m: string): void {
    if (this.opts.log) this.opts.log(`update-notifier: ${m}`);
  }
}

/** Clip a finalize detail line under the gateway's 500-char validator cap. */
function clipDetail(detail: string): string {
  return detail.length > FINALIZE_DETAIL_MAX
    ? detail.slice(0, FINALIZE_DETAIL_MAX - 1) + "…"
    : detail;
}

/** Abbreviate a sha256 digest for logs/cards. */
export function short(version: string): string {
  const hex = version.startsWith("sha256:") ? version.slice(7) : version;
  return hex.length > 12 ? hex.slice(0, 12) : hex;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
