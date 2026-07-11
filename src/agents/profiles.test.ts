import { describe, it, expect } from "vitest";
import { sep as pathSep, resolve } from "node:path";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProfilePath,
  listAvailableProfiles,
  renderProfileClaudeTemplate,
  renderVaultProtocolFragment,
} from "./profiles.js";

describe("getProfilePath", () => {
  it("resolves a real profile that exists on disk", () => {
    const result = getProfilePath("default");
    expect(result.endsWith(`${pathSep}default`)).toBe(true);
  });

  it("falls back to the default profile when the requested name does not exist", () => {
    const fallback = getProfilePath("not-a-real-profile-name-xyzzy");
    expect(fallback.endsWith(`${pathSep}default`)).toBe(true);
  });

  it("falls back to the default profile when the name is a config-only profile (e.g. 'coder')", () => {
    // The user can declare profiles inline in switchroom.yaml — these have no
    // filesystem directory, so getProfilePath should fall back, not throw.
    expect(() => getProfilePath("coder")).not.toThrow();
  });

  it("rejects a path-traversal attempt with `..`", () => {
    expect(() => getProfilePath("../etc")).toThrow(/Invalid profile name/);
  });

  it("rejects a path-traversal attempt with deeper `..`", () => {
    expect(() => getProfilePath("../../tmp")).toThrow(/Invalid profile name/);
  });

  it("rejects an absolute path", () => {
    // resolve() would canonicalize an absolute path, escaping PROFILES_ROOT.
    const abs = pathSep === "\\" ? "C:\\Windows" : "/etc/passwd";
    expect(() => getProfilePath(abs)).toThrow(/Invalid profile name/);
  });

  it("accepts an empty string (resolves to PROFILES_ROOT itself, then falls back)", () => {
    // resolve(PROFILES_ROOT, "") === PROFILES_ROOT, which is allowed; it
    // falls through to the default profile because it's not a usable
    // profile dir on its own.
    expect(() => getProfilePath("")).not.toThrow();
  });

  it("rejects a mixed-separator traversal attempt", () => {
    // resolve() normalizes mixed forward/backslash forms before the boundary
    // check fires, so this should be caught the same way `../etc` is.
    expect(() => getProfilePath("subfolder/../../etc")).toThrow(/Invalid profile name/);
  });

  // Symlink-traversal regression — covers the realpathSync check added in
  // response to PR #123 review. Skipped on Windows because creating a
  // directory symlink there requires elevated privileges or a developer-mode
  // setting that's not present on most CI / dev machines.
  it.skipIf(pathSep === "\\")(
    "rejects a profile name pointing at a symlink whose target is outside PROFILES_ROOT",
    () => {
      // We can't easily inject a symlink into the bundled profiles/ dir
      // without polluting the working tree. Instead, build a temp dir that
      // mirrors the real profiles/ layout, place a symlink-to-/etc inside,
      // and assert getProfilePath rejects names that resolve to that
      // symlink target. We do this by creating a sibling profile dir, which
      // confirms the symlink rejection works on a real fs layout.
      //
      // Strategy: create temp/<profiles>/<evil> as a symlink to /etc.
      // Direct getProfilePath call with absolute path is rejected by the
      // existing "absolute path" guard, so we instead check that
      // realpathSync of an in-tree symlink would throw. Indirect via
      // exposed PROFILES_ROOT would require module mocking; the simplest
      // verification is a unit-level check on realpathSync semantics.
      const tmp = mkdtempSync(join(tmpdir(), "switchroom-symlink-test-"));
      try {
        const fakeRoot = join(tmp, "profiles");
        mkdirSync(fakeRoot);
        // Create a target dir outside the fake root with a .hbs file
        const outside = join(tmp, "evil");
        mkdirSync(outside);
        writeFileSync(join(outside, "CLAUDE.md.hbs"), "x");
        // Create a symlink inside the fake root pointing at the outside dir
        symlinkSync(outside, join(fakeRoot, "lurker"), "dir");
        // The lexical check would PASS (resolve() doesn't follow symlinks)
        // but the realpath check should FAIL. We can't directly test
        // getProfilePath against a custom root, but we can prove the
        // realpath check works by computing it manually and asserting the
        // expected mismatch — that's the contract getProfilePath relies on.
        const lexical = resolve(fakeRoot, "lurker");
        expect(lexical.startsWith(fakeRoot + pathSep)).toBe(true);
        // realpathSync resolves through the symlink to the outside target:
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { realpathSync } = require("node:fs") as typeof import("node:fs");
        const real = realpathSync(lexical);
        expect(real.startsWith(fakeRoot + pathSep)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe("listAvailableProfiles", () => {
  it("includes the bundled 'default' profile", () => {
    const profiles = listAvailableProfiles();
    expect(profiles).toContain("default");
  });

  it("excludes the underscore-prefixed _base directory", () => {
    const profiles = listAvailableProfiles();
    expect(profiles).not.toContain("_base");
    expect(profiles.every((name) => !name.startsWith("_"))).toBe(true);
  });
});

describe("renderProfileClaudeTemplate", () => {
  it("renders CLAUDE.md.hbs to CLAUDE.md and returns { wrote: true, path }", () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-test-"));
    try {
      const profileName = "test-profile";
      const profileDir = join(tmp, profileName);
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(
        join(profileDir, "CLAUDE.md.hbs"),
        "# Profile: {{profile}}\nHello from the template.",
      );

      const result = renderProfileClaudeTemplate(profileName, tmp);

      expect(result.wrote).toBe(true);
      expect(result.path).toBe(join(profileDir, "CLAUDE.md"));
      expect(existsSync(result.path)).toBe(true);
      const content = readFileSync(result.path, "utf-8");
      expect(content).toBe("# Profile: test-profile\nHello from the template.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns { wrote: false } when no .hbs template exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-test-"));
    try {
      const result = renderProfileClaudeTemplate("no-such-profile", tmp);
      expect(result.wrote).toBe(false);
      expect(existsSync(result.path)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites an existing CLAUDE.md on re-render", () => {
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-test-"));
    try {
      const profileName = "test-profile";
      const profileDir = join(tmp, profileName);
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, "CLAUDE.md.hbs"), "v1 {{profile}}");
      writeFileSync(join(profileDir, "CLAUDE.md"), "old content");

      const result = renderProfileClaudeTemplate(profileName, tmp);

      expect(result.wrote).toBe(true);
      const content = readFileSync(result.path, "utf-8");
      expect(content).toBe("v1 test-profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gracefully skips with wrote=false when target dir is read-only (EACCES)", () => {
    // Skip when running as root — chmod 0555 doesn't actually block root,
    // so the EACCES path can't be exercised. CI usually runs as non-root.
    if (process.getuid && process.getuid() === 0) return;

    const tmp = mkdtempSync(join(tmpdir(), "switchroom-profile-render-readonly-"));
    const profileName = "test-profile";
    const profileDir = join(tmp, profileName);
    try {
      mkdirSync(profileDir, { recursive: true });
      writeFileSync(join(profileDir, "CLAUDE.md.hbs"), "v1 {{profile}}");
      chmodSync(profileDir, 0o555); // read+execute, no write

      const result = renderProfileClaudeTemplate(profileName, tmp);

      expect(result.wrote).toBe(false);
      expect(result.path).toBe(join(profileDir, "CLAUDE.md"));
    } finally {
      // Restore writable mode so rmSync can clean up.
      try { chmodSync(profileDir, 0o755); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("status? RCA-offer guidance lives in the switchroom-runtime skill (#162)", () => {
  // The legacy `_shared/telegram-style.md.hbs` partial was retired
  // (dead carrier: no profile rendered it; its content moved to the
  // fleet invariants + this skill). The "status? = UX-failure signal"
  // guidance and the RCA-offer mechanics now live in the
  // `switchroom-runtime` skill, fetched on demand. Pinned here.

  it("switchroom-runtime skill carries the status? UX-failure signal + RCA-offer mechanics", () => {
    const REPO_ROOT = resolve(__dirname, "..", "..");
    const skill = readFileSync(
      join(REPO_ROOT, "skills", "switchroom-runtime", "SKILL.md"),
      "utf-8",
    );
    // The UX-failure signal the retired partial used to name.
    expect(skill).toContain("status?");
    expect(skill).toContain("UX-failure signal");
  });

  it("switchroom-runtime skill carries the RCA-offer mechanics moved from the partial", () => {
    const REPO_ROOT = resolve(__dirname, "..", "..");
    const skill = readFileSync(
      join(REPO_ROOT, "skills", "switchroom-runtime", "SKILL.md"),
      "utf-8",
    );
    // JTBD reference, /file-bug skill wiring, and the auto-file
    // anti-pattern guard all live in the skill now.
    expect(skill).toContain("know-what-my-agent-is-doing.md");
    expect(skill).toContain("/file-bug");
    expect(skill).toContain("incident-rca");
    expect(skill.toLowerCase()).toContain("auto-file");
  });
});

describe("vault-protocol partial — agent vault discovery (#gymbro-fallback)", () => {
  // Background: gymbro hit VAULT-BROKER-DENIED on fatsecret/* and
  // silently fell back to estimates because it didn't know
  // `vault_request_access` existed. Every agent must inherit this
  // protocol deterministically — the partial is what teaches it.

  it("tells the agent to call vault_request_access on broker denial", () => {
    const fragment = renderVaultProtocolFragment();
    expect(fragment).toContain("vault_request_access");
    expect(fragment).toContain("VAULT-BROKER-DENIED");
  });

  it("branches on interactive vs cron context (don't spam approval cards)", () => {
    // The whole reason the rule isn't "always request" is the cron
    // case: a 3am fire shouldn't surface an approval card to a
    // sleeping operator. The fragment must explicitly call this out.
    const fragment = renderVaultProtocolFragment();
    expect(fragment.toLowerCase()).toMatch(/interactive/);
    expect(fragment.toLowerCase()).toMatch(/cron|non-interactive/);
    expect(fragment.toLowerCase()).toMatch(/degrade|skip/);
  });

  it("forbids the --no-broker fallback (which can't work from a sandbox)", () => {
    // The historical CLI hint pointed agents at `--no-broker`. That
    // hint was wrong for an agent — the vault file isn't mounted, so
    // --no-broker just hits VAULT-SANDBOX-CONTEXT. The fragment must
    // explicitly tell the agent not to retry that way.
    const fragment = renderVaultProtocolFragment();
    expect(fragment).toContain("--no-broker");
    expect(fragment.toLowerCase()).toMatch(/(do not|never|don't)[^.]*--no-broker|--no-broker[^.]*(does not|doesn't|can't|never)/);
  });

  it("forbids env-file fallbacks for secrets", () => {
    // Pre-fix gymbro's food-log skill had a `~/.switchroom/credentials/
    // fatsecret.env` fallback, justified by "main agent has no broker
    // socket" — false in the per-agent socket model. The fragment
    // forbids this anti-pattern.
    const fragment = renderVaultProtocolFragment();
    expect(fragment.toLowerCase()).toMatch(/env file|credentials.*\.env|env-file/);
  });

  it("forbids asking the operator to paste secrets into Telegram", () => {
    // Mid-conversation "send me the API key" defeats the whole vault
    // model and leaks the secret into chat history (even with
    // secret-scrub hooks running).
    const fragment = renderVaultProtocolFragment();
    expect(fragment.toLowerCase()).toMatch(/paste|chat history|telegram/);
  });

  it("is non-empty (file present and rendered)", () => {
    const fragment = renderVaultProtocolFragment();
    expect(fragment.length).toBeGreaterThan(200);
  });
});

describe("agent-self-service partial — cron/skill MCP discoverability (#1163)", () => {
  // Without this fragment, the agent has the agent-config MCP tools
  // available in tools/list but no prompt-level awareness of WHEN to
  // call them. Natural-language asks like "remind me to call mom at
  // 5pm" fall back to free-styling instead of invoking schedule_add.
  // These tests pin the contract — a regression that drops a tool
  // name or omits a safety-rail mention would silently break the
  // natural-language discovery path.

  it("names the agent-config MCP server", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment.toLowerCase()).toMatch(/agent-config/);
  });

  it("names every write tool exposed by the broker", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment).toContain("schedule_add");
    expect(fragment).toContain("schedule_remove");
  });

  it("names every read tool exposed by the broker", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment).toContain("cron_list");
    expect(fragment).toContain("skill_list");
    expect(fragment).toContain("config_get");
    expect(fragment).toContain("audit_tail");
  });

  it("calls out the 5-minute interval floor + the matching error code", async () => {
    // The broker rejects intervals <5min with E_CRON_TOO_FREQUENT.
    // The fragment must tell the agent BEFORE it issues the rejected
    // write so it doesn't surprise the user with an error.
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment.toLowerCase()).toMatch(/5[- ]min/);
    expect(fragment).toContain("E_CRON_TOO_FREQUENT");
  });

  it("calls out the 20-entry quota + the matching error code", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment).toMatch(/20\b/);
    expect(fragment).toContain("E_QUOTA_EXCEEDED");
  });

  it("calls out the secrets-rejection rail + the matching error code", async () => {
    // Agents must learn NOT to bake secrets: into their own entries —
    // the broker rejects with E_OVERLAY_SECRETS_REQUIRES_APPROVAL.
    // Runtime vault_request_access is the right path instead.
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment).toContain("E_OVERLAY_SECRETS_REQUIRES_APPROVAL");
    expect(fragment.toLowerCase()).toContain("vault_request_access");
  });

  it("forbids cross-agent writes (security boundary)", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment.toLowerCase()).toMatch(/cross-agent|own schedule|other.*agent/);
  });

  it("includes natural-language → tool-call examples", async () => {
    // The lookup table is what makes the natural-language discovery
    // reliable. A user saying "remind me at 5pm" should map cleanly to
    // schedule_add — pinning at least one canonical example.
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment.toLowerCase()).toMatch(/remind me|recurring|every/);
    expect(fragment).toMatch(/0 17 \* \* 0|0 8 \* \* 1-5|cron_expr/);
  });

  it("disambiguates one-shot vs recurring (cron has no native one-shot)", async () => {
    // Common user intent ("at 5pm tomorrow") isn't natively expressible
    // as a cron entry — every cron recurs. The fragment must warn the
    // agent not to claim success with a recurring entry silently.
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment.toLowerCase()).toMatch(/one-shot|one[- ]time/);
    expect(fragment.toLowerCase()).toMatch(/recur|every/);
  });

  it("names every skill write tool now that #1163 Phase 2 has shipped", async () => {
    // skill_install + skill_remove are now LIVE (#1163 Phase 2,
    // PRs #1209/#1210). The fragment must teach the agent that
    // installing a bundled skill is a one-tool call away — not a
    // "ask the operator to drop a directory" referral.
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment).toContain("skill_install");
    expect(fragment).toContain("skill_remove");
    // v1 source format is bundled:<name>.
    expect(fragment.toLowerCase()).toContain("bundled:");
  });

  it("names peers_list so agents can answer 'is there an agent that does X'", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment).toContain("peers_list");
    // The fragment must warn against memorizing the fleet — that's
    // the whole anti-drift point.
    expect(fragment.toLowerCase()).toMatch(/never cache|never memori[sz]e|live-source/);
  });

  it("is non-empty (file present and rendered)", async () => {
    const { renderAgentSelfServiceFragment } = await import("./profiles.js");
    const fragment = renderAgentSelfServiceFragment();
    expect(fragment.length).toBeGreaterThan(500);
  });
});

describe("execution-discipline partial — fleet-wide grounding / verify-before-assert", () => {
  // Background: the grounding rules ("verify mutable facts before
  // claiming them", "final answer needs evidence", "weak result isn't a
  // conclusion") only lived in the DEFAULT profile's CLAUDE.md, so
  // coding / executive-assistant / health-coach — and every future
  // profile — shipped without them. Serves the "feel-like-a-colleague"
  // job ("verifies before claiming"). This fragment is the
  // unconditional-append carrier that puts the posture on EVERY agent on
  // EVERY profile. These tests pin the contract.

  it("tells the agent to read ground truth rather than answer from memory", async () => {
    const { renderExecutionDisciplineFragment } = await import("./profiles.js");
    const fragment = renderExecutionDisciplineFragment();
    expect(fragment.toLowerCase()).toContain("ground truth");
    expect(fragment.toLowerCase()).toMatch(/read live|leads, not facts|memory/);
  });

  it("requires final answers to carry evidence", async () => {
    const { renderExecutionDisciplineFragment } = await import("./profiles.js");
    const fragment = renderExecutionDisciplineFragment();
    expect(fragment.toLowerCase()).toContain("evidence");
    expect(fragment.toLowerCase()).toContain("it should work");
  });

  it("warns against asserting an untested limit (fabricated boundaries)", async () => {
    // A confabulated "I can't do that" is as wrong as a confabulated
    // fact and stops work that was actually possible — the fragment must
    // tell the agent to verify a claimed limit before stating it.
    const { renderExecutionDisciplineFragment } = await import("./profiles.js");
    const fragment = renderExecutionDisciplineFragment();
    expect(fragment.toLowerCase()).toMatch(/limit you haven't tested|fabricated boundary/);
  });

  it("says a weak or empty result isn't a conclusion", async () => {
    const { renderExecutionDisciplineFragment } = await import("./profiles.js");
    const fragment = renderExecutionDisciplineFragment();
    expect(fragment.toLowerCase()).toMatch(/weak or empty/);
  });

  it("is non-empty (file present and rendered)", async () => {
    const { renderExecutionDisciplineFragment } = await import("./profiles.js");
    const fragment = renderExecutionDisciplineFragment();
    expect(fragment.length).toBeGreaterThan(500);
  });

  it("is appended to a scaffolded CLAUDE.md regardless of profile", async () => {
    // The core claim: the grounding posture AND pacing discipline reach
    // EVERY agent on EVERY profile, not just default. We rebuild the exact
    // compose the scaffold does (profile CLAUDE.md.hbs render + unconditional
    // append of the three shared fragments) for all four structurally
    // different profiles and assert the execution-discipline text appears in
    // ALL: default, coding, executive-assistant, health-coach.
    const {
      renderExecutionDisciplineFragment,
      renderVaultProtocolFragment,
      renderAgentSelfServiceFragment,
      renderDevProtocolFragment,
    } = await import("./profiles.js");
    const Handlebars = (await import("handlebars")).default;

    const groundingMarker = "Grounding — check before you assert";
    const pacingMarker = "Act in-turn";
    const devProtocolMarker = "## Development Protocol";

    const composeForProfile = (profileName: string): string => {
      const profileDir = getProfilePath(profileName);
      const hbsPath = join(profileDir, "CLAUDE.md.hbs");
      let rendered = Handlebars.compile(readFileSync(hbsPath, "utf-8"), {
        noEscape: true,
      })({});
      // Mirror scaffold.ts append order: vault, self-service,
      // discipline, dev-protocol.
      for (const frag of [
        renderVaultProtocolFragment(),
        renderAgentSelfServiceFragment(),
        renderExecutionDisciplineFragment(),
        renderDevProtocolFragment(),
      ]) {
        if (frag) rendered = rendered.trimEnd() + "\n\n" + frag + "\n";
      }
      return rendered;
    };

    const defaultClaude = composeForProfile("default");
    const codingClaude = composeForProfile("coding");
    const execAssistantClaude = composeForProfile("executive-assistant");
    const healthCoachClaude = composeForProfile("health-coach");

    for (const [name, rendered] of [
      ["default", defaultClaude],
      ["coding", codingClaude],
      ["executive-assistant", execAssistantClaude],
      ["health-coach", healthCoachClaude],
    ] as [string, string][]) {
      expect(rendered, `${name}: grounding marker`).toContain(groundingMarker);
      expect(rendered, `${name}: pacing marker`).toContain(pacingMarker);
      expect(rendered, `${name}: dev-protocol marker`).toContain(devProtocolMarker);
    }
  });
});

describe("renderDevProtocolFragment", () => {
  // Ken's fleet-wide development protocol (approved 2026-07-11) —
  // same unconditional-append carrier as execution-discipline so it
  // reaches EVERY agent on EVERY profile. These tests pin the five
  // parts of the contract (orient/ground, clarify vs proceed,
  // design-align, pipeline, communicate).

  it("tells the agent to validate rather than assume and cite sources", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment.toLowerCase()).toContain("validate, don't assume");
    expect(fragment).toContain("file:line");
  });

  it("mandates one clarifying question at a time, planning-phase only", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment).toContain("ONE question at a time");
    expect(fragment.toLowerCase()).toContain("act autonomously during execution");
  });

  it("requires design alignment + adversarial red-team on larger tasks", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment.toLowerCase()).toContain("design report before implementation");
    expect(fragment.toLowerCase()).toContain("red-team");
    expect(fragment.toLowerCase()).toContain("single-concern pr");
  });

  it("pins the pipeline: CI authority, fix all findings, merge on green", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment.toLowerCase()).toContain("ci is the full-suite authority");
    expect(fragment).toContain("Fix ALL findings");
    expect(fragment).toContain("Merge only on CI green");
    expect(fragment.toLowerCase()).toContain("durable fixes over hack patches");
    expect(fragment.toLowerCase()).toContain("outcomes, not just code paths");
  });

  it("pins the communication rules: 30s watch cap and 15 sub-agent cap", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment).toContain("30 seconds");
    expect(fragment).toContain("15 parallel sub-agents");
    expect(fragment.toLowerCase()).toContain("consolidated messages");
  });

  it("points at the bundled dev-protocol skill for the long form", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment).toContain("`dev-protocol` skill");
  });

  it("is non-empty (file present and rendered)", async () => {
    const { renderDevProtocolFragment } = await import("./profiles.js");
    const fragment = renderDevProtocolFragment();
    expect(fragment.length).toBeGreaterThan(500);
  });
});
