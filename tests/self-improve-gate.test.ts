import { describe, it, expect } from "vitest";

import { runGate } from "../src/self-improve/gate.js";
import type { TurnMessage } from "../src/self-improve/types.js";

const cfg = { repetitionThreshold: 2, t1MaxChangedLines: 30, t1MaxGrowthBytes: 4096, maxAutoAppliesPerDay: 3, maxOutstandingPending: 5 };

function user(text: string): TurnMessage {
  return { role: "user", text };
}
function assistant(text: string): TurnMessage {
  return { role: "assistant", text };
}

describe("self-improve gate — cost guarantee (no signal → no trip)", () => {
  it("returns tripped:false on an empty transcript", () => {
    const r = runGate([], cfg);
    expect(r.tripped).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it("does NOT fire on a clean, productive turn", () => {
    const r = runGate(
      [
        user("Can you summarise the latest deploy logs?"),
        assistant("Sure. Read(/var/log/deploy.log) — here's the summary: all green."),
        user("Great, thanks!"),
      ],
      cfg,
    );
    expect(r.tripped).toBe(false);
    expect(r.signals).toEqual([]);
  });

  it("does NOT fire on a SINGLE correction (correct-once: 2nd occurrence trips)", () => {
    const r = runGate(
      [
        user("Format the date as ISO."),
        assistant("Done."),
        user("No, that's wrong — I wanted DD/MM."),
      ],
      cfg,
    );
    // One correction < threshold of 2.
    expect(r.tripped).toBe(false);
  });

  it("does NOT fire on a single non-repeated directive", () => {
    const r = runGate(
      [user("Always use British spelling going forward."), assistant("Understood.")],
      cfg,
    );
    expect(r.tripped).toBe(false);
  });
});

describe("self-improve gate — fires on a real learning signal", () => {
  it("trips operator-correction on the SECOND correction", () => {
    const r = runGate(
      [
        user("Send the digest."),
        assistant("Sent."),
        user("No, that's wrong — you included drafts again."),
        assistant("Fixed."),
        user("That's not what I asked, I told you to exclude drafts."),
      ],
      cfg,
    );
    expect(r.tripped).toBe(true);
    const kinds = r.signals.map((s) => s.kind);
    expect(kinds).toContain("operator-correction");
    const sig = r.signals.find((s) => s.kind === "operator-correction")!;
    expect(sig.occurrences).toBeGreaterThanOrEqual(2);
    expect(sig.evidence.length).toBeGreaterThan(0);
  });

  it("trips directive-not-bound when the SAME rule is restated", () => {
    const r = runGate(
      [
        user("Always dedupe the email recipients before sending."),
        assistant("Will do."),
        user("You sent dupes — remember to always dedupe the recipients before sending."),
      ],
      cfg,
    );
    expect(r.tripped).toBe(true);
    expect(r.signals.map((s) => s.kind)).toContain("directive-not-bound");
  });

  it("trips repeated-manual-fix on an identical Edit fingerprint", () => {
    const r = runGate(
      [
        user("Fix the config."),
        assistant("Edit(/etc/app/config.yaml) — patched the timeout."),
        user("It broke again."),
        assistant("Edit(/etc/app/config.yaml) — patched the timeout once more."),
      ],
      cfg,
    );
    expect(r.tripped).toBe(true);
    expect(r.signals.map((s) => s.kind)).toContain("repeated-manual-fix");
  });

  it("does NOT trip repeated-manual-fix for DIFFERENT files edited once each", () => {
    const r = runGate(
      [
        assistant("Edit(/a.txt) — change A."),
        assistant("Edit(/b.txt) — change B."),
      ],
      cfg,
    );
    expect(r.tripped).toBe(false);
  });

  it("honours a higher threshold (3) without tripping at 2", () => {
    const cfg3 = { ...cfg, repetitionThreshold: 3 };
    const two = runGate(
      [user("No, that's wrong."), user("No, that's wrong again.")],
      cfg3,
    );
    expect(two.tripped).toBe(false);
    const three = runGate(
      [
        user("No, that's wrong."),
        user("No, that's wrong again."),
        user("No, that's incorrect a third time."),
      ],
      cfg3,
    );
    expect(three.tripped).toBe(true);
  });
});
