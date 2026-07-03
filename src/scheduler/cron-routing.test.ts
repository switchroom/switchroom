import { describe, expect, it } from "vitest";
import {
  DEFAULT_CRON_MODEL,
  isCheapCronEnabled,
  isKnownCheapModel,
  resolveCronRouting,
  resolveEscalationRouting,
  type CronRoutingInput,
} from "./cron-routing.js";

// ── Total enumeration of the reachable input space ──────────────────────
// operator standard feedback_prove_finite_fsm_not_sample: prove the finite
// decision by walking EVERY input, not a random sample.
const KINDS: Array<CronRoutingInput["kind"]> = ["poll", "prompt", "action", undefined];
const MODELS: Array<{ label: string; value: string | undefined }> = [
  { label: "cheap-sonnet", value: "claude-sonnet-5" },
  { label: "cheap-haiku", value: "haiku" },
  { label: "opus", value: "claude-opus-4-8" },
  { label: "custom", value: "research-v1" },
  { label: "unset", value: undefined },
];
const CONTEXTS: Array<CronRoutingInput["context"]> = ["fresh", "agent", undefined];
const FLAGS = [false, true];

describe("resolveCronRouting — total enumeration", () => {
  it("covers the whole reachable space with no throw and a coherent verdict", () => {
    let n = 0;
    for (const cheapCronEnabled of FLAGS) {
      for (const kind of KINDS) {
        for (const model of MODELS) {
          for (const context of CONTEXTS) {
            n++;
            const r = resolveCronRouting(
              { kind, model: model.value, context },
              { cheapCronEnabled },
            );

            // INV-0: kind=action is FLAG-INDEPENDENT — model-free, no session,
            // regardless of the kill-switch (an action has no Tier-2 fallback,
            // so gating it on the flag would silently drop the cron).
            if (kind === "action") {
              expect(r).toEqual({ tier: "action", session: null, customModelDowngrade: false });
              continue;
            }

            // INV-1: flag off ⟹ pre-RFC behaviour, every field inert.
            if (!cheapCronEnabled) {
              expect(r).toEqual({ tier: "main", session: "main", customModelDowngrade: false });
              continue;
            }

            // INV-2: tier↔session coherence.
            if (r.tier === "poll") expect(r.session).toBeNull();
            if (r.tier === "action") expect(r.session).toBeNull();
            if (r.tier === "cheap") expect(r.session).toBe("cron");
            if (r.tier === "main") expect(r.session).toBe("main");

            // INV-3: cronModel present iff Tier 1, and always a known-cheap id.
            if (r.tier === "cheap") {
              expect(r.cronModel).toBeDefined();
              expect(isKnownCheapModel(r.cronModel)).toBe(true);
            } else {
              expect(r.cronModel).toBeUndefined();
            }

            // INV-4: customModelDowngrade only when context unset + custom id.
            if (r.customModelDowngrade) {
              expect(context).toBeUndefined();
              expect(model.label).toBe("custom");
            }
          }
        }
      }
    }
    expect(n).toBe(FLAGS.length * KINDS.length * MODELS.length * CONTEXTS.length); // 2*4*5*3 = 120
  });
});

describe("resolveCronRouting — the load-bearing cases", () => {
  const on = { cheapCronEnabled: true };

  it("kind=poll → Tier 0 regardless of model/context", () => {
    expect(resolveCronRouting({ kind: "poll", model: "opus" }, on).tier).toBe("poll");
    expect(resolveCronRouting({ kind: "poll", context: "fresh" }, on).tier).toBe("poll");
  });

  it("kind=action → tier:action, model-free, FLAG-INDEPENDENT (never a session)", () => {
    expect(resolveCronRouting({ kind: "action", model: "opus" }, on)).toEqual({
      tier: "action",
      session: null,
      customModelDowngrade: false,
    });
    // even with the kill-switch OFF an action still runs model-free.
    expect(resolveCronRouting({ kind: "action" }, { cheapCronEnabled: false }).tier).toBe("action");
  });

  it("explicit context wins over model inference", () => {
    expect(resolveCronRouting({ model: "opus", context: "fresh" }, on).tier).toBe("cheap");
    expect(resolveCronRouting({ model: "sonnet", context: "agent" }, on).tier).toBe("main");
  });

  it("cheap model + no context → Tier 1 fresh", () => {
    const r = resolveCronRouting({ model: "claude-sonnet-5" }, on);
    expect(r).toMatchObject({ tier: "cheap", session: "cron", cronModel: "claude-sonnet-5" });
  });

  it("opus / custom / unset model + no context → Tier 2 agent (preserves pre-v0.8)", () => {
    expect(resolveCronRouting({ model: "claude-opus-4-8" }, on).tier).toBe("main");
    expect(resolveCronRouting({ model: "research-v1" }, on).tier).toBe("main");
    expect(resolveCronRouting({}, on).tier).toBe("main");
  });

  it("ONLY a custom id (not opus/unset) flags customModelDowngrade", () => {
    expect(resolveCronRouting({ model: "research-v1" }, on).customModelDowngrade).toBe(true);
    expect(resolveCronRouting({ model: "claude-opus-4-8" }, on).customModelDowngrade).toBe(false);
    expect(resolveCronRouting({}, on).customModelDowngrade).toBe(false);
  });

  it("fresh+opus downgrades the cron-session model to sonnet (opus-on-throwaway is nonsensical)", () => {
    expect(resolveCronRouting({ model: "claude-opus-4-8", context: "fresh" }, on).cronModel).toBe(
      DEFAULT_CRON_MODEL,
    );
  });

  it("a poll's escalation reuses the (model,context) decision as a prompt", () => {
    expect(resolveEscalationRouting({ kind: "poll", model: "sonnet" }, on)).toMatchObject({
      tier: "cheap",
      session: "cron",
    });
    expect(resolveEscalationRouting({ kind: "poll" }, on).tier).toBe("main");
  });
});

describe("isKnownCheapModel", () => {
  it.each([
    ["claude-sonnet-5", true],
    ["sonnet", true],
    ["claude-haiku-4-5", true],
    ["haiku", true],
    ["claude-opus-4-8", false],
    ["research-v1", false],
    ["", false],
  ])("%s → %s", (model, expected) => {
    expect(isKnownCheapModel(model)).toBe(expected);
  });

  it("undefined → false", () => {
    expect(isKnownCheapModel(undefined)).toBe(false);
  });
});

describe("isCheapCronEnabled — default ON; only 0/false/off disables (kill-switch)", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["on", true],
    ["ON", true],
    // unset / empty / anything else → ON (cheap-cron is the default).
    ["", true],
    [undefined, true],
    ["anything", true],
    // the kill-switch values.
    ["0", false],
    ["false", false],
    ["off", false],
    ["OFF", false],
  ])("SWITCHROOM_CHEAP_CRON=%s → %s", (val, expected) => {
    expect(isCheapCronEnabled({ SWITCHROOM_CHEAP_CRON: val } as NodeJS.ProcessEnv)).toBe(expected);
  });
});
