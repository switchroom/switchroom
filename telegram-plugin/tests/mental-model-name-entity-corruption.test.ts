/**
 * Regression coverage for #2976 — HTML-entity corruption in mental-model names.
 *
 * A model copies HTML-escaped entities out of its own (Telegram-HTML-rendered)
 * context into a `create_mental_model` / propose call, and nothing decoded them
 * before they persisted — so banks ended up with models literally named
 * `Nutrition Protocol &amp; Deficit Status` and reflection queries steering on
 * `R&amp;D` instead of `R&D` (observed live, klanker 2026-07-06).
 *
 * These tests pin the switchroom-owned WRITE-BOUNDARY normalization: the
 * proposed name + source_query are decoded to their literal characters BEFORE
 * they are synthesized into the config diff, so an escaped value can never land
 * in `memory.mental_models[]`. Each assertion below FAILS against the pre-fix
 * code (which serialized `spec.name` / `spec.source_query` verbatim) and passes
 * after.
 */

import { describe, it, expect } from "vitest";
import { parseDocument } from "yaml";
import {
  buildMentalModelAppendDiff,
  readDeclaredMentalModelNames,
  decodeCanonicalEntities,
} from "../gateway/mental-model-propose-diff.js";

const BASE_CONFIG = `agents:
  klanker:
    memory:
      backend: hindsight
`;

/** Pull the appended model node out of the synthesized `after` config. */
function appendedModel(after: string, agent = "klanker"): { name?: unknown; source_query?: unknown } {
  const js = parseDocument(after).toJS() as {
    agents: Record<string, { memory: { mental_models: Array<Record<string, unknown>> } }>;
  };
  const models = js.agents[agent]!.memory.mental_models;
  return models[models.length - 1]!;
}

describe("decodeCanonicalEntities — single-pass, canonical six only", () => {
  it("decodes each canonical entity to its literal character", () => {
    expect(decodeCanonicalEntities("R&amp;D")).toBe("R&D");
    expect(decodeCanonicalEntities("a&lt;b&gt;c")).toBe("a<b>c");
    expect(decodeCanonicalEntities("say &quot;hi&quot;")).toBe('say "hi"');
    expect(decodeCanonicalEntities("Ken&apos;s")).toBe("Ken's");
    expect(decodeCanonicalEntities("Ken&#39;s")).toBe("Ken's");
  });

  it("undoes exactly ONE layer of escaping (double-escaped → single-escaped)", () => {
    // We only reverse the escaping switchroom applied when rendering the model's
    // own prior output — never the user's literal intent.
    expect(decodeCanonicalEntities("R&amp;amp;D")).toBe("R&amp;D");
    expect(decodeCanonicalEntities("&amp;lt;")).toBe("&lt;");
  });

  it("leaves entity-free text untouched (idempotent on clean input)", () => {
    expect(decodeCanonicalEntities("Nutrition Protocol & Deficit")).toBe("Nutrition Protocol & Deficit");
  });
});

describe("#2976 — propose write-boundary normalizes the mental-model name", () => {
  it("stores the LITERAL '&' name, not the escaped '&amp;' the model emitted", () => {
    const built = buildMentalModelAppendDiff({
      configText: BASE_CONFIG,
      agentName: "klanker",
      spec: { name: "Nutrition Protocol &amp; Deficit Status", source_query: "how is the deficit?" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(appendedModel(built.after).name).toBe("Nutrition Protocol & Deficit Status");
    // And there is no residual entity anywhere in the persisted config.
    expect(built.after).not.toContain("&amp;");
    // Reading the declared names back yields the decoded literal.
    expect(readDeclaredMentalModelNames(built.after, "klanker")).toContain(
      "Nutrition Protocol & Deficit Status",
    );
  });

  it("normalizes the recall-steering source_query too (not just the name)", () => {
    const built = buildMentalModelAppendDiff({
      configText: BASE_CONFIG,
      agentName: "klanker",
      spec: { name: "rd-budget", source_query: "what is the user&apos;s R&amp;D budget?" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(appendedModel(built.after).source_query).toBe("what is the user's R&D budget?");
  });

  it("rejects an entity-escaped re-propose of an already-declared literal name (dup guard on decoded name)", () => {
    const configWithModel = `agents:
  klanker:
    memory:
      backend: hindsight
      mental_models:
        - name: Q3 R&D Plan
          source_query: what is the plan?
`;
    const built = buildMentalModelAppendDiff({
      configText: configWithModel,
      agentName: "klanker",
      // Escaped variant of the same logical name — must collide, not create a twin.
      spec: { name: "Q3 R&amp;D Plan", source_query: "different query" },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toBe("duplicate");
  });
});
