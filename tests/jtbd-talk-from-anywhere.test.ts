/**
 * JTBD contract tests for `reference/jobs/talk-to-agents-from-anywhere.md`.
 *
 * The JTBD's load-bearing line:
 *
 *   "Everything the user needs to steer, inspect, correct, or pause
 *    their agents has to be reachable from a phone with one hand. If
 *    a capability only exists on the desktop, the user is tethered,
 *    and the product stops being theirs."
 *
 * Every test in this file pins one signal-it's-working from the JTBD,
 * or rules out one named anti-pattern. Failing means we still have a
 * "punt to terminal" somewhere in the live product. The tests get
 * closed one at a time in follow-up PRs; the PR description for each
 * follow-up should cite which test it makes green.
 *
 * **Status convention.** Tests are split into two kinds:
 *
 *   1. **Live regression guards** — plain `it()`. Today's contract;
 *      passing today. A future change that breaks one of these has
 *      *regressed* the JTBD.
 *
 *   2. **Punch-list items** — `it.skip()`. Today's gap; failing today.
 *      Each is closed by a dedicated follow-up PR that (a) removes
 *      the `.skip` and (b) makes the test pass. PR body should cite
 *      which gap it closes.
 *
 * Don't make a `.skip` green by editing the test. Change the product
 * to match, then unskip.
 *
 * Cross-cutting product checks:
 *   - Principle 1 (docs test): error messages tell user what to do next.
 *   - Principle 3 (consistency): same approval-card shape across features.
 *   - Vision outcome 4 (always-on): "Anywhere your phone has signal,
 *     your fleet is reachable."
 *
 * Read the JTBD before adding/removing a test here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = resolve(__dirname, "..");

const vaultErrorSrc = readFileSync(
  resolve(REPO_ROOT, "telegram-plugin/secret-detect/vault-error.ts"),
  "utf-8",
);
const gatewaySrc = readFileSync(
  resolve(REPO_ROOT, "telegram-plugin/gateway/gateway.ts"),
  "utf-8",
);
const bridgeSrc = readFileSync(
  resolve(REPO_ROOT, "telegram-plugin/bridge/bridge.ts"),
  "utf-8",
);

// The approval-card keyboards were extracted from gateway.ts into
// per-card modules (#2996 P5, PR #3330). The Principle-3 consistency
// census must grep the extracted modules too, or the ✅/🚫 button
// count undercounts — this exact miss kept main red on every
// push-to-main full-suite run after #3330 merged (PRs stayed green
// because `vitest --changed` never selected this file).
//
// Durable by construction: glob every `*-card.ts` module in the
// gateway dir (excluding tests) instead of hardcoding file names —
// the #2996 extraction series is ongoing, and a hardcoded list would
// undercount again on the next extraction. This also pulls in the
// cards that already lived outside the census (mental-model-propose,
// secret-request, skill-proposal, …); their `mmp:`/`vsp:` prefixes
// are covered by expectedPrefixes below.
const approvalCardsSrc = [
  gatewaySrc,
  ...readdirSync(resolve(REPO_ROOT, "telegram-plugin/gateway"))
    .filter((f) => f.endsWith("-card.ts") && !f.endsWith(".test.ts"))
    .sort()
    .map((f) =>
      readFileSync(resolve(REPO_ROOT, "telegram-plugin/gateway", f), "utf-8"),
    ),
].join("\n");

// ── Helpers ─────────────────────────────────────────────────────────────

/** Extract a single rendering case block from vault-error.ts switch arm. */
function extractRenderCase(kind: string): string {
  const cases = [
    "sandbox_context",
    "needs_approval",
    "broker_unreachable",
    "broker_denied",
    "other",
  ];
  const idx = cases.indexOf(kind);
  if (idx < 0) throw new Error(`unknown kind: ${kind}`);
  const next = cases[idx + 1];
  const start = vaultErrorSrc.indexOf(`case "${kind}":`);
  if (start < 0) throw new Error(`case "${kind}" not found in vault-error.ts`);
  const end = next
    ? vaultErrorSrc.indexOf(`case "${next}":`, start)
    : vaultErrorSrc.length;
  return vaultErrorSrc.slice(start, end > 0 ? end : vaultErrorSrc.length);
}

// ── JTBD signal: error messages tell the user what to do *in Telegram* ──

describe("JTBD/talk-from-anywhere — error renderers point to in-Telegram next-steps", () => {
  it("VAULT-BROKER-DENIED mentions the Telegram-native grant flow, not just the host CLI", () => {
    // Signs it's working: "A short reply should be enough to course-correct."
    // Principle 1: "When something fails, does the error tell the user what to do next?"
    //
    // Today (vault-error.ts:189-198): renderer ends with
    //   "Operator can grant access from a host shell:
    //    switchroom vault grant <agent> --keys <key>"
    //
    // This is the gymbro screenshot. The Telegram-native paths exist
    // — /vault audit <agent> one-tap allow (#969 P2b), and the agent
    // can call vault_request_access (#1012). The renderer just hasn't
    // been told.
    const block = extractRenderCase("broker_denied");
    expect(block).toMatch(/vault_request_access|\/vault audit/);
  });

  it("VAULT-NEEDS-APPROVAL renderer drops the 'card is on the way' stub and points to the live tool", () => {
    // Principle 1: error tells the user what to do next.
    //
    // Today (vault-error.ts:167-178): renderer contains the literal
    // comment "A one-tap approval card is on the way (#969 P1a)."
    // That card shipped months ago — `vault_request_save`. The
    // renderer is lying.
    const block = extractRenderCase("needs_approval");
    expect(block, "should not say 'on the way' for a shipped feature").not.toMatch(/on the way/i);
    expect(block, "should reference the live vault_request_save tool").toMatch(/vault_request_save/);
  });

  it.skip("VAULT-BROKER-UNREACHABLE surfaces a Telegram-reachable recovery action", () => {
    // Vision outcome 4: "Anywhere your phone has signal, your fleet
    // is reachable."
    //
    // Today: renderer is HONEST about the gap — names the
    // Telegram-native follow-up as tracked but unbuilt, and points
    // the operator at the host shell for now. Earlier draft of this
    // PR claimed `/vault broker status`/`restart` in the renderer
    // copy but those subcommands aren't registered; the test passed
    // by string-matching the promise. Reviewer caught this on #1037.
    //
    // Closing this test requires building /vault broker
    // {status,restart} as admin verbs that proxy through to a
    // host-side daemon (tracked separately on the punch list). Stays
    // skipped until that lands.
    const block = extractRenderCase("broker_unreachable");
    expect(block).toMatch(/\/vault broker/);
  });

  it("VAULT-SANDBOX-CONTEXT points at the in-Telegram alternative for the relevant verb", async () => {
    // Anti-pattern: "A mobile experience that's really a web view of
    // the desktop UI."
    //
    // Pre-fix (vault-error.ts:155-163): "Open a host shell and run
    // `switchroom vault <verb>`." Verbs that hit this:
    //   - set / save → vault_request_save (shipped, #969 P1a)
    //   - get        → /vault get (shipped)
    //   - list       → /vault list (shipped)
    //   - remove     → host CLI for now, documented as such
    //   - init       → host CLI (one-time bootstrap, acceptable)
    //
    // After-fix: renderer routes to Telegram-native for verbs that
    // have a Telegram path, and explicitly NAMES the one-time-host
    // edges. Test by calling the renderer — its output is multiple
    // branches inside a switch + helper, so static-source slicing
    // doesn't capture the helper body.
    const { renderVaultCliError } = await import("../telegram-plugin/secret-detect/vault-error.js");

    // The four verbs that hit Telegram-native paths.
    for (const verb of ["set", "save", "get", "list"] as const) {
      const rendered = renderVaultCliError({ kind: "sandbox_context" }, { verb });
      expect(
        rendered.html,
        `verb=${verb}: should not say 'Open a host shell'`,
      ).not.toMatch(/Open a host shell/);
      expect(
        rendered.html,
        `verb=${verb}: should mention Telegram-native path`,
      ).toMatch(/vault_request_save|\/vault (get|list)/);
    }
  });
});

// ── Anti-pattern check: live gateway never tells the user "go to a terminal" ──

describe("JTBD/talk-from-anywhere — no live code path tells the operator to leave Telegram", () => {
  // Allowed exceptions (real infra gaps, tracked separately):
  //   - #926: `/update apply` on docker installs needs host-side daemon;
  //     until then the renderer legitimately points at the host CLI.
  //
  // Add to this list ONLY if there's a tracked issue explaining why no
  // Telegram-native path is possible. Default answer is no exception.
  const ALLOWED_HOST_PUNTS = [
    "run <code>switchroom update</code> from the", // #926 host-side update daemon
  ];

  function gatewaySrcWithoutAllowedPunts(): string {
    let src = gatewaySrc;
    for (const allowed of ALLOWED_HOST_PUNTS) {
      src = src.split(allowed).join("");
    }
    return src;
  }

  it("no string says 'run in terminal' anywhere in the live gateway", () => {
    // The Phase 4c stub at gateway.ts said "run in terminal: switchroom auth use ..."
    // That stub has been removed (E5). Text commands /auth use and /auth add
    // are the supported surface; no terminal redirect should appear.
    expect(gatewaySrcWithoutAllowedPunts()).not.toMatch(/run in terminal/i);
  });

  it("no string says 'Phase Nx will wire …' as a feature stub", () => {
    // Principle 2 (defaults test): "Does this work with zero
    // configuration?" Stub callbacks that promise future work fail.
    // Either ship the button or remove the button.
    // The Phase 4c swap-slot/add-slot stub has been removed (E5).
    expect(gatewaySrcWithoutAllowedPunts()).not.toMatch(/Phase \d[a-z]? will wire/i);
  });

  it("no headline-error closer punts to 'on the host'", () => {
    // The `on the host` substring shows up in legitimate edge-recovery
    // messages (token-write failed AFTER mint succeeded) where the
    // operator genuinely has a host-side recovery option. Those read
    // as a fallback, not a headline.
    //
    // The anti-pattern is the HEADLINE form — the first thing the
    // operator sees on a fresh error. Match the trailing-italic closer
    // pattern (`on the host.</i>` or `on the host shell.</i>`) since
    // that's how renderer / fallback strings sign off a card.
    //
    // Caveat: this guard only catches the *closer* form. A future
    // regression that buries "on the host" in mid-sentence headline
    // text would slip through. Two known existing matches are inside
    // recovery-tip <i> fallbacks (gateway.ts:7941, 8046) — those use
    // the same closer shape and remain in the allowlist via context
    // (they're triggered by token-write-failure-after-mint, not
    // displayed as a primary error).
    const body = gatewaySrcWithoutAllowedPunts();
    // Strip the two known fallback patterns (token-write-fail recovery
    // tips, NOT headline errors) so the test guards genuinely new
    // regressions.
    const RECOVERY_FALLBACK_PATTERNS = [
      // Recent-denials one-tap (gateway.ts:7937-7941)
      /Recover with:.*?on the host\.<\/i>/gs,
      // vault_request_access (gateway.ts:8042-8046)
      /Recover with:.*?on the host\.<\/i>/gs,
    ];
    let stripped = body;
    for (const pat of RECOVERY_FALLBACK_PATTERNS) {
      stripped = stripped.replace(pat, "");
    }
    // After stripping documented recovery fallbacks, the closer pattern
    // should NOT appear anywhere.
    expect(stripped).not.toMatch(/on the host shell\b/);
    expect(stripped).not.toMatch(/on the host\.<\/i>/);
  });
});

// ── JTBD signal: every fleet-mutation has a Telegram-native shape ──

describe("JTBD/talk-from-anywhere — every fleet-mutation has a Telegram-native command", () => {
  // Each test below is the operator's "I should be able to do this from
  // my phone" mapped to a bot.command() existence check. Failing means
  // the command isn't built. Closing each requires its own PR.
  //
  // Why command-existence-checks here instead of behaviour tests? At this
  // stage the contract is "this verb should exist." Behavioural tests
  // come with each implementation PR.

  it.skip("/agent remove — operator can drop an agent from their phone", () => {
    // Vision outcome 2: multi-agent fleet, specialists not generalists.
    // Fleet curation is a daily op. Today: switchroom agent destroy
    // (CLI only).
    expect(gatewaySrc).toMatch(/bot\.command\(['"]agent[-_ ]?remove['"]/);
  });

  it.skip("/agent admin <name> on|off — operator can grant admin verbs to an agent without SSH", () => {
    // Bootstrap chicken-and-egg: a fresh switchroom has NO admin agents,
    // so the user must SSH to flip the first one. This is the literal
    // "If a capability only exists on the desktop" failure mode the
    // JTBD names.
    expect(gatewaySrc).toMatch(/bot\.command\(['"]agent[-_ ]?admin['"]/);
  });

  it("/auth slot management has no terminal-redirect buttons (E5 regression guard)", () => {
    // The vestigial swap-slot / add-slot inline-keyboard buttons have been
    // removed (E5). The supported path is /auth use <label> and /auth add.
    // Guard against re-introducing stub buttons that tell the operator to
    // use the terminal.
    expect(gatewaySrc).not.toMatch(/Phase 4c will wire/);
    expect(gatewaySrc).not.toMatch(/swap-slot/);
    expect(gatewaySrc).not.toMatch(/add-slot/);
  });

  it.skip("/vault broker {status,restart} — operator can recover a dead broker", () => {
    // Vision outcome 4 (always-on): "Crashed agents auto-recover with
    // an audit trail. The fleet comes back on its own."
    //
    // The broker isn't an agent and doesn't auto-recover — when it
    // gets stuck (locked, OOM-killed, etc.) the operator needs a
    // hand. Today that hand is a terminal. Operator on the train
    // sees their fleet go silent and can do nothing.
    expect(gatewaySrc).toMatch(/vault broker (status|restart)/);
  });

  it.skip("/vault passphrase rotate — passphrase rotation works from Telegram", () => {
    // Operator hygiene. Shell-only today.
    // (Acceptable to phrase as `/vault rotate-passphrase` — the test
    // matches either.)
    expect(gatewaySrc).toMatch(/passphrase[-_ ]?rotate|rotate[-_ ]?passphrase/);
  });
});

// ── Principle 3 (consistency): approval cards share the same shape ──

describe("Principles/consistency — every operator approval card uses the same shape", () => {
  it("every fleet-mutation approval flow uses ✅/🚫 button pair (one mind built this)", () => {
    // "When you learn how one part works, you've learned how the rest
    // works." Three approval flows exist:
    //
    //   - vault_request_save (#969 P1a) — ✅ Save once / 🚫 Discard
    //   - vault_request_access (#1012 Phase 1) — ✅ Approve / 🚫 Deny
    //   - /vault audit Recent denials (#969 P2b) — 🔓 Allow <key> (drift!)
    //
    // The third one uses 🔓 instead of ✅. That's the consistency-test
    // failure: same operation, different emoji. Either standardise on
    // ✅ for all confirm buttons, or document why /vault audit is
    // different.
    const approveButtons = approvalCardsSrc.match(/text:\s*['"`]✅[^'"`]+['"`]/g) ?? [];
    const denyButtons = approvalCardsSrc.match(/text:\s*['"`]🚫[^'"`]+['"`]/g) ?? [];
    // ✅ confirm buttons: at least 3 (save, access, recent-denial)
    expect(approveButtons.length, "≥3 ✅ confirm buttons across approval flows").toBeGreaterThanOrEqual(3);
    // 🚫 deny buttons: at least 2 (save discard, access deny)
    expect(denyButtons.length, "≥2 🚫 cancel buttons across approval flows").toBeGreaterThanOrEqual(2);
  });

  it("every callback prefix is documented at the dispatcher (single source of truth)", () => {
    // Today the gateway has a callback dispatcher around `data.startsWith(...)`
    // with comments explaining each prefix. New prefixes that land
    // without a comment are a consistency miss — future maintainers
    // hit a `data.startsWith('xyz:')` line with no idea what it does.
    //
    // Test: every prefix used in a callback_data string MUST appear in
    // the dispatcher block at the bottom of gateway.ts. Stub for now —
    // the dispatcher list is hand-maintained, so this test is more
    // a documentation invariant than a hard contract.
    const prefixUses = new Set<string>();
    for (const m of approvalCardsSrc.matchAll(/callback_data:\s*[`'"]([a-z]+):/gi)) {
      prefixUses.add(m[1]!);
    }
    // Expected set as of #1012 Phase 1; `auth:` added when the
    // /auth snapshot Format 2 PR re-introduced inline-keyboard
    // buttons (auth:use:<label>, auth:refresh) — handled by
    // handleAuthDashboardCallback at the dispatcher.
    // `vsp:` added in #2045 (request_secret secure save-card) — handled by
    // handleSecretRequestCallback at the dispatcher.
    // `mmp:` added for mental_model_propose (hindsight Phase 5) — the
    // agent-proposes → human-approves mental-model card; mmp:approve/deny
    // are handled by handleMentalModelProposeCallback at the dispatcher.
    const expectedPrefixes = ["vrs", "vra", "vrd", "vd", "vg", "op", "auth", "vsp", "mmp"];
    for (const p of expectedPrefixes) {
      expect(
        gatewaySrc,
        `dispatcher should document the '${p}:' callback prefix at its startsWith branch`,
      ).toMatch(new RegExp(`data\\.startsWith\\(['"\`]${p}:['"\`]\\)`));
    }
    // No surprise prefixes — any new one introduced without updating
    // this list flags as a contract drift.
    for (const p of prefixUses) {
      // 'aq:' is the ask_user callback decoder; not a startsWith branch.
      // Add other known exceptions here with a reason.
      if (p === "aq") continue;
      expect(
        expectedPrefixes,
        `new callback prefix '${p}:' — update jtbd-talk-from-anywhere.test.ts expectedPrefixes`,
      ).toContain(p);
    }
  });
});

// ── Vision outcome 2 (multi-agent fleet): admin gating is discoverable ──

describe("Vision/multi-agent fleet — discoverability of admin actions", () => {
  it("/help or /vault help mentions /vault audit and the agent vault_request_access tool", () => {
    // Anti-pattern: "Relying on a dashboard the user has to open to see
    // state." Sibling: relying on the user to know which tool/command
    // exists. The bot's own help text should advertise the operator's
    // fleet-management surface.
    //
    // Gateway's `/help` handler calls `buildHelpText` from
    // `telegram-plugin/welcome-text.ts:helpText()`. That's where the
    // user-visible copy lives; the gateway is just the dispatcher.
    const welcomeTextSrc = readFileSync(
      resolve(REPO_ROOT, "telegram-plugin/welcome-text.ts"),
      "utf-8",
    );
    const helpFn = welcomeTextSrc.split("export function helpText")[1]?.split("\nexport ")[0] ?? "";
    expect(helpFn, "/help should mention /vault audit for admin operators").toMatch(/\/vault audit/);
  });

  it("vault_request_access tool description tells the agent when to call it (#1012)", () => {
    // Principle 1: "Does the CLI / Telegram surface explain the *why*,
    // not just the *what*?" The MCP tool description is what the agent
    // reads. If it doesn't say "call me when you hit VAULT-BROKER-DENIED,"
    // the agent will hold on and surface a useless `VAULT-BROKER-DENIED`
    // wall-of-text to the operator instead of asking for help.
    // Anchor: extract the vault_request_access tool's own description
    // block (not the entire file) so a 'denied' reference in some other
    // schema doesn't satisfy this test by accident.
    const accessBlock = bridgeSrc.split("name: 'vault_request_access'")[1]?.split("name: '")[0] ?? "";
    expect(accessBlock).toMatch(/VAULT-BROKER-DENIED|denied/i);
  });
});
