/**
 * JTBD — worker-pin lifecycle + the restart rule (#3001, DM).
 *
 * The job spec (`reference/jobs/know-what-my-agent-is-doing.md`) sanctions
 * exactly one pin: silently pinning the already-rendered status message while
 * its work is in flight, auto-unpinned when the work completes. #3001's
 * operator report was the failure mode: worker (`wk:`) pins with no
 * mid-session reaper and a forfeit-on-failure boot sweep left a long tail of
 * stale pinned `🛠 Worker` messages. The restart rule this scenario pins:
 * **agent restart = reset any pinned message whose work didn't finish.**
 *
 * Two acceptance criteria, shared setup (a long background dispatch):
 *
 *   AC-1 — lifecycle: the `🛠 Worker` feed message is PINNED while the
 *          background worker runs, and UNPINNED after it completes (the
 *          normal completion unpin — no restart involved).
 *   AC-2 — restart rule: with a SECOND dispatch pinned mid-flight, a forced
 *          gateway restart orphans the pin; the next boot's sweep
 *          (statusPinBootCleanup, reading status-pins.json) unpins it. The
 *          restart half self-skips green without NOPASSWD sudo, mirroring
 *          jtbd-message-during-restart-dm.
 *
 * Observation shape: pins/unpins are SERVICE events, not message sends or
 * edits — the worker card EDITS in place the whole time it is pinned, so a
 * message-observer predicate would fire on edits and prove nothing. We
 * assert via `driver.observePins` (raw `updatePinnedMessages`), keyed to the
 * exact pinned messageId, and explicitly ignore `m.edited` traffic.
 *
 * Env note: requires the harness agent's default
 * `pin_status_while_working` (ON) and the worker activity feed enabled —
 * same env as bg-sub-agent-dispatch-dm (SETUP.md §6).
 */

import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import { spinUp } from "../harness.js";
import type { ObservedPin } from "../driver.js";
import { WORKER_FEED_RE } from "../assertions.js";

const AGENT = "test-harness";

// Same deterministic Option-1 dispatch prompt shape as
// bg-sub-agent-dispatch-dm: this scenario verifies the PIN infra, not the
// model's delegation judgment. ~60s of paced background work — long enough
// for the feed to paint (8s first-paint floor) and the wk: pin to land.
function bgDispatchPrompt(steps: number): string {
  return (
    `Use the Agent tool with subagent_type "general-purpose" and ` +
    `run_in_background: true to dispatch a worker with this exact task: ` +
    `"Do ${steps} steps, ONE AT A TIME, k = 1 through ${steps}. Before each ` +
    `step write a brief one-sentence narration, then run \`sleep 2\` via the ` +
    `Bash tool, then run \`echo step-k\` via the Bash tool (substitute the ` +
    `real number for k). Run every sleep and every echo as its OWN separate ` +
    `Bash call — never batch or chain them with && — and narrate before ` +
    `each. Do not stop early; complete all ${steps} steps." After ` +
    `dispatching, send a brief reply saying you've kicked off the worker.`
  );
}

/** Wait for the next pin/unpin event matching `pred`. observePins yields
 *  service-level pin transitions only — message EDITS never surface here,
 *  which is exactly why this scenario observes pins, not messages. */
async function nextPinEvent(
  iter: AsyncIterator<ObservedPin>,
  pred: (p: ObservedPin) => boolean,
  timeoutMs: number,
  what: string,
): Promise<ObservedPin> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const race = await Promise.race([
      iter.next(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
    ]);
    if (race === "timeout") break;
    if (race.done === true) break;
    if (pred(race.value)) return race.value;
  }
  throw new Error(`nextPinEvent: no ${what} within ${timeoutMs}ms`);
}

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** Kick a marker-safe restart and return immediately (detached) — same shape
 *  as jtbd-message-during-restart-dm. */
function kickRestartDetached(name: string): void {
  const child = spawn(
    "sudo",
    ["-n", "env", `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`,
      "switchroom", "agent", "restart", name, "--force"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const sudoOk = canShellSudo();

describe("uat: worker-pin lifecycle + restart rule (#3001, DM)", () => {
  it(
    "AC-1: the worker feed message is pinned while the bg dispatch runs and unpinned after completion",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      const pinIter = sc.driver
        .observePins(sc.botUserId)
        [Symbol.asyncIterator]();
      try {
        await sc.sendDM(bgDispatchPrompt(10));

        // Parent ack — the dispatch happened.
        await sc.expectMessage(/.+/, { from: "bot", timeout: 45_000 });

        // The wk: pin lands once the worker feed paints (~8s first-paint) —
        // a PIN service event, not a send/edit.
        const pinned = await nextPinEvent(
          pinIter,
          (p) => p.pinned,
          90_000,
          "worker pin",
        );
        expect(pinned.messageId).toBeGreaterThan(0);

        // Sanity: what got pinned is the 🛠 Worker feed message (fetch by id
        // — the card keeps EDITING in place; we never assert on edits).
        const msg = await sc.driver.getMessage(sc.botUserId, pinned.messageId);
        expect(msg, "pinned message vanished").not.toBeNull();
        expect(msg!.text).toMatch(WORKER_FEED_RE);

        // Completion unpins it. Budget mirrors bg-sub-agent-dispatch-dm's
        // done-window: worker (~60s) + watcher stall detection (60s) + slack.
        const unpinned = await nextPinEvent(
          pinIter,
          (p) => !p.pinned && p.messageId === pinned.messageId,
          240_000,
          `unpin of worker pin msg=${pinned.messageId}`,
        );
        expect(unpinned.pinned).toBe(false);
      } finally {
        await pinIter.return?.();
        await sc.tearDown();
      }
    },
    // 45s ack + 90s pin + 240s unpin + spinUp/teardown slack.
    420_000,
  );

  (sudoOk ? it : it.skip)(
    "AC-2 (restart rule): a worker pin orphaned by a forced gateway restart is unpinned by the next boot's sweep",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      const pinIter = sc.driver
        .observePins(sc.botUserId)
        [Symbol.asyncIterator]();
      try {
        // Longer dispatch (~2min of steps) so the restart reliably lands
        // while the worker — and its pin — are still in flight.
        await sc.sendDM(bgDispatchPrompt(30));
        await sc.expectMessage(/.+/, { from: "bot", timeout: 45_000 });

        const pinned = await nextPinEvent(
          pinIter,
          (p) => p.pinned,
          90_000,
          "worker pin",
        );

        // Force the restart MID-dispatch: the wk: claim is persisted in
        // status-pins.json; the dying session never runs its completion
        // unpin. The next boot's statusPinBootCleanup must unpin it.
        kickRestartDetached(AGENT);

        const unpinned = await nextPinEvent(
          pinIter,
          (p) => !p.pinned && p.messageId === pinned.messageId,
          // Restart (docker recreate + gateway boot + startup mutex + boot
          // sweep) comfortably inside this window.
          240_000,
          `boot-sweep unpin of orphaned worker pin msg=${pinned.messageId}`,
        );
        expect(unpinned.pinned).toBe(false);
      } finally {
        await pinIter.return?.();
        await sc.tearDown();
      }
    },
    420_000,
  );
});
