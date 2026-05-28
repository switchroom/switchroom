/**
 * JTBD scenario — the agent fetches the web via webkite, transparently.
 *
 * Validates the v0.13.62/63 webkite rollout end-to-end through real
 * Telegram: the user sends a URL and asks about its content WITHOUT
 * ever naming "webkite". The agent must:
 *
 *   1. Reach for webkite on its own (the native WebFetch/WebSearch
 *      tools are denied fleet-wide — see scaffold.ts
 *      WEBKITE_FLEET_DENY_TOOLS — so the ONLY way the agent can answer
 *      a "read this URL" prompt is via the webkite_* MCP tools). If the
 *      agent returns the page's content, webkite did the work by
 *      construction — there is no other web-fetch tool available.
 *
 *   2. Render JavaScript. The target is `quotes.toscrape.com/js/`, a
 *      purpose-built scraping-practice SPA whose quotes are injected by
 *      JS at runtime. A raw HTTP fetch (what the old WebFetch did) sees
 *      an empty page — `curl` returns zero `class="quote"` nodes. Only
 *      a JS-executing renderer (webkite → cloakbrowser headless
 *      Chromium) produces the visible quote text. So a correct quote in
 *      the reply is positive proof that JS rendering happened.
 *
 * The first quote on that page is Einstein's "The world as we have
 * created it is a process of our thinking…". We assert the reply names
 * Einstein AND carries a recognizable fragment of that quote.
 *
 * ## What this catches that other UATs don't
 *
 * - `jtbd-fast-trivial-dm` proves the agent replies fast, but never
 *   touches a tool. This is the first UAT that forces a real web fetch.
 * - The in-container `webkite read` smoke proves the binary works, but
 *   not that the *model* chooses webkite unprompted over a denied
 *   WebFetch, nor that the full inbound→claude→MCP→outbound path works.
 *
 * ## Failure modes this guards against
 *
 * - A regression that re-enables WebFetch (the model might fetch raw
 *   HTML and miss the JS-rendered quotes → wrong/empty answer).
 * - webkite MCP not wired / not trusted (agent says it can't browse).
 * - cloakbrowser broken (agent returns the empty static page → no
 *   quote, or a "page had no content" apology).
 * - The glibc regression that the v0.13.62 canary caught (webkite
 *   dead-on-arrival → agent can't browse at all).
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

// JS-rendered scraping-practice page. Quotes exist ONLY after JS runs;
// a raw fetch sees none. Stable, purpose-built, no auth.
const JS_URL = "https://quotes.toscrape.com/js/";

// Deliberately does NOT mention webkite, fetch, browser, or any tool —
// a natural "read this for me" ask. The agent must pick the tool.
const PROMPT =
  `Open ${JS_URL} and tell me the exact text of the very first quote ` +
  `on the page and who said it. Just the quote and the author.`;

// The first quote's author + a distinctive fragment of its text.
const EXPECTED_AUTHOR = /einstein/i;
const EXPECTED_FRAGMENT =
  /world as we have created it|process of our thinking|changing our thinking/i;

// Phrases that would indicate the agent FAILED to browse (fell back to
// "I can't access the web" or got the empty static page).
const CANT_BROWSE = [
  /can.?t (access|browse|open|reach|fetch)/i,
  /unable to (access|browse|open|reach|fetch)/i,
  /no content|empty page|couldn.?t (find|load)/i,
  /don.?t have (web|internet|browsing)/i,
];

describe("uat: agent fetches the web via webkite (JS page, unprompted)", () => {
  it(
    "URL prompt → agent returns JS-rendered content (proves webkite + cloakbrowser)",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM(PROMPT);

        // Generous budget: a real cloakbrowser render of an SPA is
        // slower than a trivial reply (Chromium spawn + JS execution).
        const reply = await sc.expectMessage(EXPECTED_FRAGMENT, {
          from: "bot",
          timeout: 90_000,
        });

        // Positive proof: the JS-gated quote text came back.
        expect(reply.text).toMatch(EXPECTED_FRAGMENT);
        // And the author — confirms it parsed the actual quote, not noise.
        expect(reply.text).toMatch(EXPECTED_AUTHOR);

        // Negative proof: no "I can't browse" fallback. (WebFetch is
        // denied, so a failure to use webkite surfaces as an apology,
        // not a wrong fetch.)
        const failedToBrowse = CANT_BROWSE.some((re) => re.test(reply.text));
        expect(
          failedToBrowse,
          `agent reply looks like a can't-browse fallback: ${JSON.stringify(reply.text.slice(0, 300))}`,
        ).toBe(false);

        console.log(
          `[webkite-read] agent returned JS-rendered quote via webkite — ` +
          `WebFetch denied, cloakbrowser rendered the SPA. ` +
          `reply: ${JSON.stringify(reply.text.slice(0, 200))}`,
        );
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );
});
