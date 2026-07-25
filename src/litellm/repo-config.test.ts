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
  FORWARD_HEADERS_FLAG,
  detectHeaderMisconfig,
  detectRetryFallbackGaps,
  isClaudeAllowlistedGroup,
  parseLitellmConfig,
} from "./header-passthrough-guard.js";

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
      litellm_params: { api_key?: string };
    }>;
    for (const m of modelList) {
      const key = m.litellm_params.api_key ?? "";
      const ok = key.startsWith("os.environ/") || key === "no-key-oauth-forwarded";
      expect(ok, `suspicious api_key value: ${key}`).toBe(true);
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

  it("declares the proxy image on exactly one non-comment line shaped <image>:<tag>", () => {
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
  // placeholder tag this file ships with is shape-valid but names no existing
  // image. So the two states are coupled here — a placeholder pin MUST carry
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
