/**
 * JTBD scenario — narration-quality: a plain-language intent line before
 * a silent tool stretch.
 *
 * Serves "know what my agent is actually doing"
 * (`reference/jobs/know-what-my-agent-is-doing.md`) beat 3, and the
 * thinking-visibility work (Option 2). With extended-thinking text
 * server-redacted for the current flagship models (they emit
 * `thinking` → `tool_use` → `reply` with no interstitial prose, see the
 * PIVOT in `reference/rfcs/draft-mirror-preview.md`), the model's OWN
 * plain-language intent narration is the only compliant carrier for
 * "what am I doing / why" during a silent tool burst. The pacing prompt
 * (scaffold.ts `TELEGRAM_GUIDANCE` beat 2 + the per-turn `<turn-pacing>`
 * directive) now instructs the model to drop ONE intent line as ordinary
 * working text before a tool stretch. This scenario pins the CARRIER: a
 * leading `text` block surfaces as working narration (not suppressed as a
 * draft-of-reply, not sent as a chat message) BEFORE the silent tool
 * stretch, and the Bash `description` is the visible activity label.
 *
 * Why a projection-kernel scenario, not a live mtcute harness: the
 * intent line lives in the ephemeral compose-area draft, and mtcute
 * "CANNOT observe drafts or reactions" (CLAUDE.md, UAT caveat) — a live
 * harness structurally cannot see this surface. The same reasoning made
 * `jtbd-reflective-status-reaction-dm` a controller-level scenario. The
 * deterministic assertion here (over the exact JSONL the model emits) is
 * strictly more powerful than a flaky "did the model narrate this run"
 * live check. The prompt that MAKES the model narrate is pinned by
 * `tests/scaffold.test.ts` ("intent-narration carrier").
 */

import { describe, it, expect } from "vitest";
import { projectTranscriptLine } from "../../session-tail.js";
import { isDraftOfReply } from "../../narrative-dedup.js";
import { toolLabel } from "../../tool-labels.js";

/** The plain-language intent the pacing prompt asks for before a burst. */
const INTENT =
  "Now checking the gateway logs to find why the turn stalled.";

/** A multi-tool assistant message: intent line, then a SILENT tool burst
 *  (no reply among the tools). This is the exact shape beat 2 describes —
 *  one intent line, then heads-down work. */
function multiToolTurnLine(): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: INTENT },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Bash",
          input: {
            command: "grep -n stall /var/log/switchroom/gateway.log | tail",
            description: "Search the gateway log for the stall",
          },
        },
        {
          type: "tool_use",
          id: "toolu_02",
          name: "Read",
          input: { file_path: "/state/agent/home/gateway.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_03",
          name: "Grep",
          input: { pattern: "activeTurnStartedAt", path: "src/" },
        },
      ],
    },
  });
}

describe("uat-jtbd: narration intent before a silent tool stretch", () => {
  it("a multi-tool turn surfaces at least one plain-language intent line before the burst", () => {
    const events = projectTranscriptLine(multiToolTurnLine());

    // The intent narration is projected as a `text` event.
    const textEvents = events.filter((e) => e.kind === "text");
    expect(textEvents.length).toBeGreaterThanOrEqual(1);
    const intentEv = textEvents[0];
    expect(intentEv.kind === "text" && intentEv.text).toBe(INTENT);

    // It is PLAIN LANGUAGE, not a raw tool name / debug dump. (Bad-list:
    // "calling Bash", "Read(x)", raw commands must never be the carrier.)
    const t = (intentEv as { text: string }).text;
    expect(t).not.toMatch(/calling \w+|Read\(|Bash\(|grep -n|\bnull\b/);
    expect(t.length).toBeLessThan(160); // one line, phone-readable

    // The intent line comes BEFORE the silent stretch: its projected
    // position precedes every tool_use event in source order.
    const firstToolIdx = events.findIndex((e) => e.kind === "tool_use");
    const intentIdx = events.findIndex((e) => e.kind === "text");
    expect(intentIdx).toBeGreaterThanOrEqual(0);
    expect(firstToolIdx).toBeGreaterThan(intentIdx);

    // And it really is a SILENT stretch — a burst of >1 tool with no reply
    // tool interleaved. The narration is the ONLY signal the user gets.
    const toolCount = events.filter((e) => e.kind === "tool_use").length;
    expect(toolCount).toBeGreaterThan(1);
    const replyToolFired = events.some(
      (e) => e.kind === "tool_use" && /^reply$/.test(e.toolName),
    );
    expect(replyToolFired).toBe(false);
  });

  it("the intent line is working-narration (surfaced), not a draft-of-reply (suppressed)", () => {
    // The reducer-side dedup gate SUPPRESSES a text block only when it is
    // the model composing its answer just before `reply`. An intent line
    // that names what it's about to DO shares no prefix with the eventual
    // answer, so the gate SHOWS it. Pin both sides.
    const laterAnswer =
      "The turn stalled because the typing loop was never cleared on error.";
    expect(isDraftOfReply(INTENT, laterAnswer)).toBe(false);

    // Control: a genuine draft-then-send IS suppressed, so we know the gate
    // is live and the assertion above isn't vacuously true.
    const draft = laterAnswer + " (composing…)";
    expect(isDraftOfReply(draft, laterAnswer)).toBe(true);
  });

  it("the Bash description — not the raw command — is the visible activity label", () => {
    // The compose-area draft renders `input.description` for Bash (never
    // the raw `command`). This is why the prompt tells the model to always
    // give Bash a plain-English description: it IS the visible carrier.
    const label = toolLabel("Bash", {
      command: "grep -n stall /var/log/switchroom/gateway.log | tail",
      description: "Search the gateway log for the stall",
    });
    expect(label).toBe("Search the gateway log for the stall");
    expect(label).not.toContain("grep");
  });
});
