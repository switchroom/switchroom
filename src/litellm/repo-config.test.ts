/**
 * KEN-125 — the repo-managed LiteLLM proxy config
 * (docker/litellm-proxy/litellm-config.yaml) must always satisfy the fleet
 * invariants. These tests read the ACTUAL shipped file, so a bad edit to the
 * yaml fails CI here (and in the lint guard) before it can reach the host.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  BARE_ANTHROPIC_FAMILY_ALIASES,
  FORWARD_HEADERS_FLAG,
  detectHeaderMisconfig,
  detectRetryFallbackGaps,
  isClaudeAllowlistedGroup,
  parseLitellmConfig,
} from "./header-passthrough-guard.js";
import {
  LITELLM_ROUTER_MARGIN_S,
  LITELLM_TIMEOUT_TIERS,
  detectLitellmTimeoutDrift,
  extractGroupTimeouts,
} from "./timeout-budget.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = join(repoRoot, "docker", "litellm-proxy", "litellm-config.yaml");
const imagePinPath = join(repoRoot, "docker", "litellm-proxy", "litellm-image.txt");

const text = readFileSync(configPath, "utf-8");
const parsed = parseLitellmConfig(text) as Record<string, unknown>;

/** The stand-in tag the file ships with until the operator reconciles it. */
const PLACEHOLDER_TAG = "REPLACE-WITH-LIVE-PINNED-TAG";
const imagePinText = readFileSync(imagePinPath, "utf-8");
const imagePinLines = imagePinText
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"));

describe("repo-managed litellm-config.yaml (KEN-125)", () => {
  it("parses as a non-empty YAML object", () => {
    expect(parsed).toBeTruthy();
    expect(typeof parsed).toBe("object");
    expect(Object.keys(parsed).length).toBeGreaterThan(0);
  });

  it("has ZERO I2 header-passthrough violations (OAuth-leak scoping)", () => {
    expect(detectHeaderMisconfig(parsed)).toEqual([]);
  });

  it("has ZERO G8 retry/fallback advisory warnings on Claude groups", () => {
    expect(detectRetryFallbackGaps(parsed)).toEqual([]);
  });

  it("scopes the forward flag: ON for every Claude group, ABSENT on every non-Claude group", () => {
    const mgs = parsed.model_group_settings as Record<
      string,
      Record<string, unknown>
    >;
    expect(mgs).toBeTruthy();
    expect(typeof mgs).toBe("object");
    const groups = Object.entries(mgs);
    expect(groups.length).toBeGreaterThan(0);
    let claudeGroups = 0;
    for (const [name, settings] of groups) {
      if (isClaudeAllowlistedGroup(name)) {
        claudeGroups++;
        expect(settings[FORWARD_HEADERS_FLAG], `Claude group ${name}`).toBe(true);
      } else {
        expect(
          FORWARD_HEADERS_FLAG in settings,
          `non-Claude group ${name} must not carry ${FORWARD_HEADERS_FLAG}`,
        ).toBe(false);
      }
    }
    expect(claudeGroups).toBeGreaterThan(0);
  });

  it("never sets the forward flag globally under litellm_settings", () => {
    const ls = parsed.litellm_settings as Record<string, unknown>;
    expect(FORWARD_HEADERS_FLAG in ls).toBe(false);
  });

  it("registers Hindsight's gpt-oss-20b via OpenRouter with an env-ref key (no literal secret)", () => {
    const modelList = parsed.model_list as Array<{
      model_name: string;
      litellm_params: { model: string; api_key?: string };
    }>;
    const gptOss = modelList.filter((m) =>
      m.litellm_params.model === "openrouter/openai/gpt-oss-20b",
    );
    expect(gptOss.length).toBeGreaterThan(0);
    for (const m of gptOss) {
      expect(m.litellm_params.api_key).toBe("os.environ/OPENROUTER_API_KEY");
    }
  });

  it("holds no literal secrets anywhere in model_list (env refs or placeholders only)", () => {
    const modelList = parsed.model_list as Array<{
      model_name: string;
      litellm_params: { model: string; api_key?: string };
    }>;
    for (const m of modelList) {
      const key = m.litellm_params.api_key;
      if (key === undefined) {
        // An ABSENT api_key is legal for exactly one case: the Anthropic
        // subscription passthrough, where auth is the forwarded client OAuth
        // Authorization header and the proxy holds no key of its own (I1/I2).
        // Anywhere else a missing key is a misconfiguration, not a secret-free
        // win, so it must not slip through this check.
        expect(
          m.litellm_params.model.startsWith("anthropic/"),
          `${m.model_name} omits api_key but is not an anthropic/* OAuth-passthrough entry`,
        ).toBe(true);
        continue;
      }
      const ok = key.startsWith("os.environ/") || key === "no-key-oauth-forwarded";
      expect(ok, `suspicious api_key value on ${m.model_name}: ${key}`).toBe(true);
    }
  });

  // I2, stated as an outcome rather than a name check: it is not enough that
  // the forwarding groups LOOK Claude-ish — every group carrying the flag must
  // actually resolve, through model_list, to an Anthropic upstream. A group
  // named `opus` pointed at openrouter/* would pass the allowlist and still
  // leak the subscription OAuth token to a third party.
  it("routes EVERY forward-flagged model group to an anthropic/* upstream", () => {
    const mgs = parsed.model_group_settings as Record<string, Record<string, unknown>>;
    const modelList = parsed.model_list as Array<{
      model_name: string;
      litellm_params: { model: string };
    }>;
    const flagged = Object.entries(mgs)
      .filter(([, s]) => s[FORWARD_HEADERS_FLAG] === true)
      .map(([name]) => name);
    expect(flagged.length).toBeGreaterThan(0);
    for (const group of flagged) {
      const deployments = modelList.filter((m) => m.model_name === group);
      expect(deployments.length, `group ${group} has no model_list deployment`).toBeGreaterThan(0);
      for (const d of deployments) {
        expect(
          d.litellm_params.model.startsWith("anthropic/"),
          `forward-flagged group ${group} routes to ${d.litellm_params.model}`,
        ).toBe(true);
      }
    }
  });

  // A bare family alias (no `claude-` prefix) is only allowlisted by the I2
  // guard if it is a member of BARE_ANTHROPIC_FAMILY_ALIASES. Registering one
  // in this file without adding it there makes lint + the on-host fleet-health
  // sensor report a false OAuth-leak violation (which is exactly what the live
  // `opus` group did on 2026-07-25, #3537).
  it("registers every bare (non claude-*) forwarding alias in BARE_ANTHROPIC_FAMILY_ALIASES", () => {
    const mgs = parsed.model_group_settings as Record<string, Record<string, unknown>>;
    const bare = Object.entries(mgs)
      .filter(([name, s]) => s[FORWARD_HEADERS_FLAG] === true && !name.startsWith("claude-"))
      .map(([name]) => name);
    expect(bare.length).toBeGreaterThan(0);
    for (const alias of bare) {
      expect(
        BARE_ANTHROPIC_FAMILY_ALIASES.has(alias),
        `bare alias '${alias}' is in the config but not in BARE_ANTHROPIC_FAMILY_ALIASES`,
      ).toBe(true);
    }
  });

  // Regression guard for the 2026-07-25 reconciliation: this file had drifted
  // to a hand-written subset missing the entire Opus family the live proxy
  // serves, so syncing it to the host would have deleted routing in active use.
  // Assert the families that must never silently vanish again.
  it("registers the Claude families the live proxy actually serves", () => {
    const names = new Set(
      (parsed.model_list as Array<{ model_name: string }>).map((m) => m.model_name),
    );
    for (const required of [
      "opus",
      "claude-opus-5",
      "sonnet",
      "claude-sonnet-5",
      "fable",
      "claude-fable-5",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(names.has(required), `model_list must register ${required}`).toBe(true);
    }
  });

  it("gives every retrying (num_retries > 1) non-Claude group a fallbacks chain", () => {
    const mgs = parsed.model_group_settings as Record<
      string,
      Record<string, unknown>
    >;
    const rs = parsed.router_settings as { fallbacks?: Array<Record<string, string[]>> };
    const covered = new Set<string>();
    for (const entry of rs.fallbacks ?? []) {
      for (const src of Object.keys(entry)) covered.add(src);
    }
    for (const [name, settings] of Object.entries(mgs)) {
      if (isClaudeAllowlistedGroup(name)) continue;
      const nr = Number(settings.num_retries);
      if (Number.isFinite(nr) && nr > 1) {
        // The terminal model of each chain is exempt (nothing left to fall to).
        if (name === "openrouter/google/gemini-3.1-flash-lite") continue;
        expect(covered.has(name), `retrying group ${name} needs a fallbacks chain`).toBe(true);
      }
    }
  });

  it("does NOT capture the Anthropic /anthropic pass-through (no pass_through_endpoints, no wildcard model)", () => {
    // 2026-07-05 incident: agent Claude traffic must stay on the URL-based
    // raw-byte pass-through, never the model-mapped route. The config must not
    // define pass_through_endpoints (behaviour is client-side via
    // ANTHROPIC_BASE_URL) nor a catch-all model entry that could shadow it.
    expect("pass_through_endpoints" in parsed).toBe(false);
    const modelList = parsed.model_list as Array<{ model_name: string }>;
    expect(modelList.some((m) => m.model_name === "*")).toBe(false);
  });

  // KEN-125 scrub: these files are public. The Coolify service dir is named by
  // a deployment-specific service id; it must appear only as a placeholder.
  it("leaks no host identifier — service ids appear only as <litellm-service-id>", () => {
    for (const [label, body] of [
      ["litellm-config.yaml", text],
      ["litellm-image.txt", imagePinText],
    ] as const) {
      const hostPaths = body.match(/\/data\/coolify\/services\/[^/\s]+/g) ?? [];
      for (const p of hostPaths) {
        expect(p, `${label} must placeholder the service id, got: ${p}`).toContain(
          "<litellm-service-id>",
        );
      }
    }
  });

  it("declares the proxy image on exactly one non-comment line shaped <image>:<tag>[@sha256:<digest>]", () => {
    expect(imagePinLines).toHaveLength(1);
    // The shape permits `@sha256:<64 hex>` because a digest is the STRONGEST
    // pin, and the coupling test below explicitly blesses one. Three forms are
    // legal: `<image>:<tag>`, `<image>@sha256:<digest>`, and the belt-and-braces
    // `<image>:<tag>@sha256:<digest>` this repo ships (the tag matches the host
    // compose line verbatim; the digest makes it immutable). A bare `<image>`
    // with neither tag nor digest stays rejected.
    expect(imagePinLines[0]).toMatch(
      /^[\w.\-/]+(?::[\w.\-]+(?:@sha256:[0-9a-f]{64})?|@sha256:[0-9a-f]{64})$/,
    );
    // Floating tags defeat the pin — checked against the TAG portion, so a
    // floating tag is still caught when digest-qualified (`:latest@sha256:…`).
    const tagPart = imagePinLines[0].split("@")[0];
    expect(tagPart.endsWith(":latest")).toBe(false);
    expect(tagPart.endsWith(":main-latest")).toBe(false);
    expect(tagPart.endsWith(":main-stable")).toBe(false);
  });

  // The shape check above deliberately does NOT prove the pin is real: the
  // placeholder tag (which this file shipped with before the live pin landed,
  // and could regress to) is shape-valid but names no existing image. So the
  // two states are coupled here — a placeholder pin MUST carry
  // the UNVERIFIED marker, and a pin without the marker MUST be a real tag.
  // Without this, dropping the marker (or "fixing" the tag to a floating one)
  // silently leaves a green test claiming a pin that would fail to pull.
  it("couples the placeholder tag to its UNVERIFIED-AGAINST-LIVE marker", () => {
    const isPlaceholder = imagePinLines[0].includes(PLACEHOLDER_TAG);
    const hasMarker = imagePinText.includes("UNVERIFIED-AGAINST-LIVE");
    if (isPlaceholder) {
      expect(
        hasMarker,
        `${imagePinPath} still carries the ${PLACEHOLDER_TAG} placeholder, so it MUST keep ` +
          `the UNVERIFIED-AGAINST-LIVE notice telling the operator to substitute the live tag`,
      ).toBe(true);
    } else {
      expect(
        hasMarker,
        `${imagePinPath} names a real tag now — drop the UNVERIFIED-AGAINST-LIVE notice`,
      ).toBe(false);
      // A real pin must be immutable-ish: a digest, or a tag with a version.
      expect(imagePinLines[0]).toMatch(/(@sha256:[0-9a-f]{64}|:\S*\d)/);
    }
  });
});

describe("repo-managed litellm-config.yaml — paired timeout budgets (Fix B)", () => {
  const actual = extractGroupTimeouts(parsed);

  it("declares a per-deployment timeout on every group switchroom budgets for", () => {
    // A group with no `timeout` inherits litellm_settings.request_timeout
    // (600s here) — 4x the interactive lane's whole client budget, so the
    // client always hangs up mid-fallback and the failover path does not
    // exist. `gpt-oss-20b-openrouter` shipped in exactly that state until
    // 2026-07-26; this test is what stops it recurring.
    for (const tier of Object.values(LITELLM_TIMEOUT_TIERS)) {
      for (const group of [tier.group, tier.fallbackGroup]) {
        if (group === null || !actual.has(group)) continue; // absent lane: #3407's signal
        expect(actual.get(group), `${configPath}: group '${group}' has no per-model timeout`).not.toBeNull();
      }
    }
  });

  it("matches the tiers switchroom derives its client budgets from", () => {
    // The shipped config and src/litellm/timeout-budget.ts are two halves of
    // one number. If this fails, one half was edited alone — which is the
    // 2026-07-25/26 defect class, caught here at review time instead of by an
    // operator noticing a lane has silently produced nothing for a week.
    const drifts = detectLitellmTimeoutDrift(actual);
    expect(
      drifts.map((d) => `${d.group}: config ${d.actualS ?? "none"}s vs declared ${d.declaredS}s`),
    ).toEqual([]);
  });

  it("keeps every router fallback edge represented in the declared tiers", () => {
    // A fallback edge switchroom does not know about is an unbudgeted hop: the
    // chain arithmetic silently omits it and the client budget is too small.
    const fallbacks = (parsed.router_settings as Record<string, unknown> | undefined)?.fallbacks;
    const declared = new Map(
      Object.values(LITELLM_TIMEOUT_TIERS).map(
        (t) => [t.group, t.fallbackGroup] as [string, string | null],
      ),
    );
    for (const edge of Array.isArray(fallbacks) ? fallbacks : []) {
      if (!edge || typeof edge !== "object") continue;
      for (const [from, to] of Object.entries(edge as Record<string, unknown>)) {
        if (!declared.has(from)) continue; // a lane switchroom does not budget
        const targets = Array.isArray(to) ? to : [to];
        expect(
          targets,
          `${configPath}: '${from}' falls back to ${JSON.stringify(targets)}, but ` +
            `LITELLM_TIMEOUT_TIERS declares '${declared.get(from)}'`,
        ).toContain(declared.get(from));
      }
    }
  });

  it("keeps every budgeted group OUT of the fleet pacer's allowlist", () => {
    // LITELLM_ROUTER_MARGIN_S (10s) covers only litellm's own in-request work.
    // It does NOT cover a pacer hold, and it could not: PACE_MAX_WAIT_S alone
    // defaults to 20s and the hard backstop is clamped as high as 280s. The
    // margin is sound today ONLY because no group these tiers budget matches
    // PACE_MODEL_GROUPS. Adding e.g. `gpt-oss-*` to that allowlist would make
    // every derived client budget too small again — silently, and in exactly
    // the paired-drift shape this module exists to prevent. So it is checked
    // rather than commented.
    const pacerPath = join(repoRoot, "docker", "litellm-pacer", "custom_pacing.py");
    const src = readFileSync(pacerPath, "utf8");

    const read = (name: string): string[] => {
      const m = new RegExp(`${name}\\s*=\\s*_csv_env\\(\\s*"${name}"\\s*,\\s*"([^"]*)"`).exec(src);
      // An unreadable guard is not a guard. If the pacer's declaration shape
      // changes, fail here instead of silently asserting over an empty list.
      expect(m, `${pacerPath}: could not read the ${name} default`).not.toBeNull();
      return m![1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    };

    const globMatches = (pattern: string, value: string): boolean =>
      new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")}$`,
      ).test(value);

    const paced = read("PACE_MODEL_GROUPS");
    const excluded = read("PACE_MODEL_GROUPS_EXCLUDE");
    expect(paced.length).toBeGreaterThan(0);

    for (const tier of Object.values(LITELLM_TIMEOUT_TIERS)) {
      for (const group of [tier.group, tier.fallbackGroup]) {
        if (group === null) continue;
        // Same precedence as _group_is_paced(): exclusion wins.
        const isPaced =
          !excluded.some((p) => globMatches(p, group)) && paced.some((p) => globMatches(p, group));
        expect(
          isPaced,
          `${pacerPath}: PACE_MODEL_GROUPS ${JSON.stringify(paced)} paces '${group}', which ` +
            `LITELLM_TIMEOUT_TIERS budgets with only a ${LITELLM_ROUTER_MARGIN_S}s margin. A ` +
            `pacer hold (PACE_MAX_WAIT_S defaults to 20s) does not fit in that margin — raise ` +
            `the tier's timeouts to cover it, or keep the group unpaced.`,
        ).toBe(false);
      }
    }
  });
});
