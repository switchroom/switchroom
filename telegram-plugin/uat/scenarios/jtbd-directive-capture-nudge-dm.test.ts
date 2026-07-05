/**
 * JTBD scenario — a correction lands as a directive and survives `/reset`.
 *
 * Serves: `reference/jobs/remember-across-sessions.md` — the job's headline
 * criterion is "a rule set once stays respected / a correction sticks."
 *
 * ## Why this exists (issue #2848 Stage B)
 *
 * Directive capture was guidance-only: the model is *told* to call
 * `create_directive` on a durable correction, and a Stage A audit measured a
 * **~55% miss rate** — the same broadcast correction captured by one agent,
 * silently dropped by two others. Stage B adds a DETERMINISTIC regex nudge in
 * the vendored recall hook (`vendor/hindsight-memory/scripts/recall.py`): on a
 * correction-shaped inbound it appends a terse advisory telling the model to
 * persist the rule with `create_directive` before answering. Detection is pure
 * regex — the judgment happens IN the interactive session (claude-native
 * invariant: no model callsite, no silent hook-side write).
 *
 * ## Contract this asserts
 *
 * 1. **Capture**: after a correction-shaped DM ("from now on, always end every
 *    reply with <MARKER>"), an ACTIVE directive referencing the rule exists in
 *    the agent's hindsight bank (queried via the REST API, the same surface
 *    Stage A used).
 * 2. **Survival across `/reset`**: after `/reset` clears the session, a fresh
 *    neutral follow-up is still answered honoring the rule (the MARKER appears
 *    in the reply) — proving the directive was re-injected from the bank, not
 *    merely held in the wiped session context.
 *
 * ## Self-skip
 *
 * Self-skips GREEN when the mtcute driver isn't wired (no
 * TELEGRAM_UAT_DRIVER_SESSION etc.), so it never reds an unwired host. The
 * whole uat/** tree is excluded from gating CI regardless; run live with
 * `bun run --cwd telegram-plugin test:uat jtbd-directive-capture-nudge-dm`.
 */

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage, isWorkerFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";

// Match the first non-empty bot reply that is neither the worker-activity
// feed nor the tool-activity feed (same guard as jtbd-memory-survives).
const isReply = (m: ObservedMessage): boolean =>
  /\S/.test(m.text) && !isWorkerFeedMessage(m) && !isActivityFeedMessage(m);

const CORRECTION_REPLY_BUDGET_MS = 60_000;
const DIRECTIVE_SETTLE_MS = 12_000;
const RESET_SETTLE_MS = 45_000;
const POSTRESET_REPLY_BUDGET_MS = 120_000;

// Unique per-run marker so directive-content matching and the honored-rule
// check can't latch onto stale state from a prior run.
const MARKER = `SR_UAT_DIRECTIVE_${randomBytes(6).toString("hex").toUpperCase()}`;

// Hindsight REST base. Bank id == agent name (Stage A + CLAUDE.md). Override
// via HINDSIGHT_UAT_API_URL if the host runs it elsewhere.
const HINDSIGHT_BASE =
  process.env.HINDSIGHT_UAT_API_URL ??
  process.env.HINDSIGHT_API_URL ??
  "http://127.0.0.1:18888";

interface Directive {
  content?: string;
  name?: string;
}

async function fetchActiveDirectives(bank: string): Promise<Directive[]> {
  const url = `${HINDSIGHT_BASE}/v1/default/banks/${encodeURIComponent(bank)}/directives?active_only=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) {
    throw new Error(`hindsight directives HTTP ${res.status} for bank ${bank} (${url})`);
  }
  const body = (await res.json()) as { items?: Directive[] };
  return Array.isArray(body.items) ? body.items : [];
}

const uatWired = Boolean(
  process.env.TELEGRAM_API_ID &&
    process.env.TELEGRAM_API_HASH &&
    process.env.TELEGRAM_UAT_DRIVER_SESSION &&
    (process.env.TELEGRAM_TEST_BOT_USERNAME || false),
);

(uatWired ? describe : describe.skip)(
  "uat: correction lands as a directive and survives /reset (remember-across-sessions JTBD)",
  () => {
    it(
      "a standing-rule correction is persisted as a directive and honored after /reset",
      async () => {
        // --- Phase 1: give the agent a durable, correction-shaped rule ---
        const sc1 = await spinUp({ agent: AGENT });
        try {
          await sc1.sendDM(
            `From now on, always end every reply you send me with this exact ` +
              `marker on its own final line: ${MARKER}. This is a standing ` +
              `rule for how you should behave going forward — please persist ` +
              `it so it sticks across sessions. Confirm you've noted it.`,
          );

          const reply = await sc1.expectMessage(isReply, {
            from: "bot",
            timeout: CORRECTION_REPLY_BUDGET_MS,
          });
          expect(reply.text.length).toBeGreaterThan(0);

          // Give the in-turn create_directive call (nudged by the hook) time
          // to land in the bank before we query it.
          await new Promise((r) => setTimeout(r, DIRECTIVE_SETTLE_MS));

          // --- Phase 2: CAPTURE — an active directive references the rule ---
          const directives = await fetchActiveDirectives(AGENT);
          const matched = directives.some((d) => {
            const hay = `${d.content ?? ""} ${d.name ?? ""}`;
            return (
              hay.includes(MARKER) ||
              /end (?:every|each|your) repl/i.test(hay) ||
              /marker/i.test(hay)
            );
          });
          if (!matched) {
            throw new Error(
              `[directive-capture] CONTRACT FAILED (capture): no active directive ` +
                `references the standing rule. The correction was correction-shaped ` +
                `(the recall hook should have nudged create_directive) but nothing ` +
                `persisted. Directives seen: ` +
                `${JSON.stringify(directives.map((d) => d.content ?? d.name).slice(0, 8))}`,
            );
          }
          expect(matched).toBe(true);
        } finally {
          await sc1.tearDown();
        }

        // --- Phase 3: /reset clears the session ---
        const scReset = await spinUp({ agent: AGENT });
        try {
          await scReset.sendDM("/reset");
        } finally {
          await scReset.tearDown();
        }
        // Let the reset complete + the bridge reattach before probing.
        await new Promise((r) => setTimeout(r, RESET_SETTLE_MS));

        // --- Phase 4: SURVIVAL — a fresh neutral turn still honors the rule ---
        const sc2 = await spinUp({ agent: AGENT });
        try {
          await sc2.sendDM(
            `What is 2 + 2? Answer normally — nothing special about this message.`,
          );
          const reply = await sc2.expectMessage(isReply, {
            from: "bot",
            timeout: POSTRESET_REPLY_BUDGET_MS,
          });
          expect(reply.text.length).toBeGreaterThan(0);

          // The rule was NOT in this session's context (it was wiped by
          // /reset). If the marker appears, the directive was re-injected from
          // the bank on recall — the correction stuck.
          const honored = reply.text.includes(MARKER);
          if (!honored) {
            throw new Error(
              `[directive-capture] CONTRACT FAILED (survival): after /reset the ` +
                `agent did not honor the standing rule — marker ${MARKER} absent ` +
                `from the reply, so the directive did not survive/re-inject. Reply: ` +
                `${JSON.stringify(reply.text.slice(0, 400))}`,
            );
          }
          expect(honored).toBe(true);
        } finally {
          await sc2.tearDown();
        }
      },
      CORRECTION_REPLY_BUDGET_MS +
        DIRECTIVE_SETTLE_MS +
        RESET_SETTLE_MS +
        POSTRESET_REPLY_BUDGET_MS +
        30_000,
    );
  },
);
