/**
 * JTBD scenario — the real account SEES rendered rich formatting.
 *
 * Serves: `reference/jobs/know-what-my-agent-is-doing.md` — the trust
 * contract that what the agent posts renders correctly on the user's
 * phone. Phase 1 (PR #2741, `formatting-parse-regression.test.ts`) pins
 * this at the PARSE level (our emitted markdown parses to the intended
 * entity structure, checked by an independent oracle). This scenario is
 * the higher-fidelity RENDER-level layer: it drives a REAL agent turn
 * through a REAL bot into a REAL chat, then reads back — via the mtcute
 * MTProto driver — the entity structure Telegram ACTUALLY parsed and will
 * render. It closes the loop the unit suite can't: it proves Telegram's
 * own renderer agrees with our oracle, not just that our oracle agrees
 * with our formatter.
 *
 * ## Why this needs the mtcute upgrade (issue #2739)
 *
 * On the pinned mtcute (0.27.x) a Bot API 10.1 rich message
 * (`sendMessage` with `{ markdown }`) decoded as `messageMediaUnsupported`
 * with empty text — so the driver saw NEITHER text NOR entities and
 * substituted a `\x01` sentinel. With mtcute >=0.30 the message decodes to
 * real text + entities, and `toObserved()` now surfaces both
 * `ObservedMessage.entities` and the `t.me` permalink (`.link`). This test
 * asserts on that real, decoded structure. If the sentinel ever reappears
 * (`text === "\x01"`, `entities === []`) the assertions fail LOUDLY rather
 * than silently pass — it is the regression gate for the decode itself.
 *
 * ## What it asserts
 *
 * The agent is asked to reply with a small, unambiguous formatting sample
 * (bold / italic / inline code / a fenced code block / an inline link)
 * anchored by a stable marker token so the reply is findable in the stream.
 * We then assert, on the observed bot reply:
 *
 *   1. The body decoded to real text (NOT the `\x01` unsupported-media
 *      sentinel) — the core decode regression gate.
 *   2. Telegram parsed the expected entity KINDS (membership, not exact
 *      spans — a model reply is not byte-deterministic, so we mirror
 *      Phase 1's "these entities are PRESENT" philosophy rather than an
 *      exact-echo assertion).
 *   3. The link entity carries the right destination URL.
 *   4. A `t.me/c/<chat>/<msgid>` (or `t.me/<user>`) permalink is captured
 *      and logged for human eyeball reference (best-effort — private DMs
 *      don't support message links, so this is logged, not asserted).
 *
 * ## Self-skip
 *
 * Like every scenario in this dir, it needs the driver session
 * (`TELEGRAM_UAT_DRIVER_SESSION`, vault key `telegram-uat-driver-session`,
 * gated to the CI uat-host runner / test-harness agent). It self-skips
 * green when those creds are absent so a fork PR / un-wired host never
 * reds — the `uat/**` tree is excluded from gating CI anyway; the
 * `uat-gate` sentinel owns the real run.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";
import { richRenderEnabled } from "../../render/rich-render.js";

const AGENT = "test-harness";

// The rich-render wiring (parse -> IR -> renderSafe -> sendRichMessage) is
// ON BY DEFAULT, with `SWITCHROOM_RICH_RENDER=0` as the escape hatch. The
// expandable / collapsible round-trip proof below only runs when the driver
// creds are present AND the renderer hasn't been killed off — the same
// setting must hold in the gateway process under test for the renderer to
// actually shape the outbound message, so gating the scenario on the same
// check keeps it honest (no false green when the wiring isn't live). When
// the kill-switch is set, this scenario self-skips green exactly like the
// credential-less case.
const RICH_RENDER_ON = richRenderEnabled();

// The driver session is the load-bearing credential. Absent it, spinUp()
// throws in resolveConfig — so guard at describe level and self-skip green.
const HAS_DRIVER_CREDS =
  (process.env.TELEGRAM_UAT_DRIVER_SESSION ?? "").length > 0 &&
  (process.env.TELEGRAM_API_HASH ?? "").length > 0 &&
  Number.isFinite(Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10)) &&
  (process.env.TELEGRAM_TEST_BOT_USERNAME ?? "").length > 0;

// A stable marker so the reply is unambiguously findable in the observed
// stream (the agent is told to include it verbatim). Uppercase + digit so
// it survives any voice/dash scrub untouched.
const MARKER = "RICHFMT7";

// The formatting sample the agent is asked to reproduce. Kept small and
// unambiguous: one entity of each kind we care about, plus a link with a
// known destination.
const LINK_URL = "https://github.com/switchroom/switchroom";
const SAMPLE_LINES = [
  `Reply with EXACTLY this, including the marker ${MARKER} verbatim, and NOTHING else:`,
  "",
  `${MARKER}: here is **a bold phrase**, some *italic words*, an inline \`code_token\`, ` +
    `some ~~struck text~~, a ||hidden spoiler||, and a link to [the repo](${LINK_URL}).`,
  "",
  "## A heading line",
  "",
  "> a blockquoted line",
  "",
  "- first bullet",
  "- second bullet",
  "",
  "1. ordered one",
  "2. ordered two",
  "",
  "Then, on new lines, a fenced code block:",
  "```bash",
  'echo "hello from the torture set"',
  "```",
].join("\n");

/**
 * mtcute entity kinds we HARD-ASSERT Telegram parsed from the sample. Phase 2
 * extends the original bold/italic/code/pre/text_link set with strikethrough
 * and blockquote — both confirmed to survive the live send→IV→decode round
 * trip on the uat-host (PR #2745 first live run: present set was
 * `bold, italic, code, strikethrough, text_link, blockquote, pre`).
 *
 * `spoiler` is soft-observed HERE only because of THIS harness's decode path:
 * the `||…||` span did NOT reliably surface as a `spoiler`/`textMarked` entity
 * through the MTProto send→IV→decode round trip the UAT driver uses. This is a
 * harness-decoder limitation, NOT a wire failure: a 2026-07 direct probe of the
 * Bot API `sendRichMessage` endpoint (the actual production send path) confirmed
 * `||spoiler||` DOES parse to a `spoiler` entity and `==highlight==` to `marked`
 * on the live wire — see `reference/rfcs/telegram-native-formatting.md` §6a.
 * Spoiler ships default-on; it stays soft here purely so this MTProto-decode
 * gate doesn't red on its own decode gap. (Underline `__…__`, by contrast, is a
 * genuine wire exclusion — it parses as bold; see §6a.) The decoder's
 * `textMarked → spoiler` mapping is still pinned deterministically by the
 * hosted unit suite.
 *
 * Lists and dividers carry no first-class Bot API entity (they render as
 * bulleted/numbered/rule TEXT), so they are asserted on `reply.text` below.
 */
const EXPECTED_KINDS = [
  "bold",
  "italic",
  "code",
  "pre",
  "text_link",
  "strikethrough",
  "blockquote",
] as const;

/** Soft-observed only (see note above) — logged, never fails the gate. */
const SOFT_KINDS = ["spoiler"] as const;

function kindsPresent(msg: ObservedMessage): Set<string> {
  return new Set(msg.entities.map((e) => e.kind));
}

(HAS_DRIVER_CREDS ? describe : describe.skip)(
  "uat: real account sees rendered rich formatting (entities + permalink)",
  () => {
    it(
      "bot reply decodes to real text + expected entity kinds; permalink captured",
      async () => {
        const sc = await spinUp({ agent: AGENT });
        try {
          await sc.sendDM(SAMPLE_LINES);

          // Find the bot reply carrying our marker. The reply may be
          // streamed/split; we want the chunk that actually holds the
          // formatting sample (the one with the marker token).
          const reply = await sc.expectMessage(
            (m: ObservedMessage) =>
              m.text.includes(MARKER) || m.text === "\x01",
            { from: "bot", timeout: 90_000 },
          );

          // (1) Decode regression gate: the body must be REAL text, not the
          // unsupported-media sentinel. If this fails, mtcute is not
          // decoding the rich message — the whole point of the upgrade.
          expect(
            reply.text,
            "bot reply decoded as the \\x01 unsupported-media sentinel — " +
              "mtcute is NOT decoding the Bot API rich message (issue #2739 regression)",
          ).not.toBe("\x01");
          expect(reply.text).toContain(MARKER);

          // (2) Telegram must have parsed at least SOME entities — a reply
          // that carries the marker but zero entities means formatting was
          // stripped on the wire (or decode silently dropped entities).
          const present = kindsPresent(reply);
          expect(
            reply.entities.length,
            `observed reply had zero entities (kinds=${[...present].join(",")}) — ` +
              "formatting did not survive the render round-trip",
          ).toBeGreaterThan(0);

          // (3) Entity-kind membership. We assert PRESENCE of each expected
          // kind, not exact spans (model replies aren't byte-deterministic,
          // and streaming may split the sample across chunks — this mirrors
          // Phase 1's membership philosophy). A missing kind is a real
          // render-fidelity regression for that construct.
          const missing = EXPECTED_KINDS.filter((k) => !present.has(k));
          expect(
            missing,
            `expected entity kinds missing from the rendered reply: ${missing.join(", ")} ` +
              `(present: ${[...present].join(", ")})`,
          ).toEqual([]);

          // Soft-observed constructs (e.g. spoiler) — logged, never fail the
          // gate. See EXPECTED_KINDS note for why spoiler is soft.
          for (const k of SOFT_KINDS) {
            console.info(
              `[uat] soft-observed construct '${k}': ` +
                (present.has(k) ? "PRESENT on the wire" : "absent (expected — not gated)"),
            );
          }

          // (4) The link entity must carry the right destination.
          const link = reply.entities.find((e) => e.kind === "text_link");
          expect(link, "no text_link entity found in the reply").toBeDefined();
          expect(link?.url).toBe(LINK_URL);

          // (5) Lists and dividers have NO first-class Bot API entity — the
          // decoder renders them into TEXT (bulleted "• ", numbered "N. ").
          // Assert the decoded body carries a bullet and an ordinal marker so
          // a regression that drops list structure (back to bare inline text)
          // reds here. Model replies aren't byte-deterministic, so we check
          // for the STRUCTURE markers, not exact list wording.
          expect(
            reply.text,
            "decoded reply carried no bullet marker — pageBlockList decode " +
              "regressed to flat text",
          ).toContain("• ");
          expect(
            reply.text,
            "decoded reply carried no ordinal marker — pageBlockOrderedList " +
              "decode regressed to flat text",
          ).toMatch(/\b1\.\s/);

          // Permalink capture — best-effort human-eyeball reference. Private
          // DMs don't support message links (mtcute's .link getter throws
          // there; toObserved swallows it), so we LOG rather than assert.
          if (reply.link) {
            console.info(
              `[uat] rich-formatting reply permalink: ${reply.link} ` +
                `(chat=${reply.chatId} msg=${reply.messageId})`,
            );
          } else {
            console.info(
              `[uat] rich-formatting reply had no permalink ` +
                `(expected for a private DM) — chat=${reply.chatId} msg=${reply.messageId}`,
            );
          }

          // Forensic dump of the exact entity structure Telegram returned —
          // this is the render-fidelity evidence the parse-level suite can't
          // produce (it's what Telegram PARSED, not what we EMITTED).
          console.info(
            "[uat] rendered entity structure: " +
              JSON.stringify(
                reply.entities.map((e) => ({
                  kind: e.kind,
                  text: e.text,
                  ...(e.url ? { url: e.url } : {}),
                  ...(e.language ? { language: e.language } : {}),
                })),
              ),
          );
        } finally {
          await sc.tearDown();
        }
      },
      120_000,
    );
  },
);

// ---------------------------------------------------------------------------
// Rich-render wiring proof — legacy `**> ` quote repair round-trip.
//
// This is the piece the unit suite CANNOT prove: that a REAL markdown reply
// carrying the LEGACY switchroom expandable-quote marker (`**> `) flows
// through the live send path — parse.ts (marker -> IR `expandable: true`) ->
// render.ts (IR -> plain `> ` markdown; `**>` is MarkdownV2-only and renders
// as literal text on the rich path, wire-proved 2026-08-13, so the renderer
// no longer emits it) -> renderSafe -> sendRichMessage — and that Telegram
// parses the repaired output back to a blockquote entity with NO literal
// `**>` glyphs reaching the reader.
//
// Runs ONLY when the rich-render flag is on in this process (see
// RICH_RENDER_ON) AND the driver creds are present; self-skips green
// otherwise, so default CI (flag off) never reds on it.
// ---------------------------------------------------------------------------

const EXP_MARKER = "COLLAPSE9";
const EXPANDABLE_SAMPLE = [
  `Reply with EXACTLY this and NOTHING else, keeping ${EXP_MARKER} verbatim:`,
  "",
  `${EXP_MARKER}: here is a collapsible section.`,
  "",
  "**> first hidden line of the expandable quote",
  "> second hidden line",
  "> third hidden line",
].join("\n");

(HAS_DRIVER_CREDS && RICH_RENDER_ON ? describe : describe.skip)(
  "uat: expandable/collapsible content round-trips through the live renderer",
  () => {
    it(
      "a legacy `**>` reply is repaired to a plain quote and decodes as a blockquote entity",
      async () => {
        const sc = await spinUp({ agent: AGENT });
        try {
          await sc.sendDM(EXPANDABLE_SAMPLE);

          const reply = await sc.expectMessage(
            (m: ObservedMessage) =>
              m.text.includes(EXP_MARKER) || m.text === "\x01",
            { from: "bot", timeout: 90_000 },
          );

          // Decode regression gate (same as the primary scenario).
          expect(
            reply.text,
            "expandable reply decoded as the \\x01 unsupported-media sentinel",
          ).not.toBe("\x01");
          expect(reply.text).toContain(EXP_MARKER);

          // The legacy quote must survive as a real blockquote entity on the
          // wire — proof the parse->render->send path repaired the `**>` line
          // into the quote instead of shipping stray literal text.
          const present = kindsPresent(reply);
          expect(
            [...present],
            `expandable quote did not decode as a blockquote entity ` +
              `(present kinds: ${[...present].join(", ")})`,
          ).toContain("blockquote");

          // The quoted body text must round-trip (content never lost).
          expect(reply.text).toContain("first hidden line");

          // And the retired marker must never reach the reader as literal
          // glyphs — the exact failure mode of the pre-repair renderer
          // (Telegram rendered the `**> ` opener as a literal `**>` paragraph
          // while the `> ` continuation lines formed a detached quote).
          expect(reply.text).not.toContain("**>");

          console.info(
            "[uat] expandable round-trip entity structure: " +
              JSON.stringify(
                reply.entities.map((e) => ({ kind: e.kind, text: e.text })),
              ),
          );
        } finally {
          await sc.tearDown();
        }
      },
      120_000,
    );
  },
);
