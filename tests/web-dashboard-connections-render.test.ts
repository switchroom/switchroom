import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Regression coverage for the live "Connections tab shows nothing" incident.
 *
 * Two failure modes produced (or could reproduce) a blank Connections tab, and
 * each needs a different kind of test:
 *
 *  1. RENDER PIPELINE — `renderConnections` fails to turn account data into
 *     card markup (wrong branch, throw, dropped provider). Caught here by
 *     running the REAL inline render against mock data and asserting the cards
 *     land in the DOM with their identifiers.
 *
 *  2. CSS VISIBILITY — a `@media (min-width: …)` rule hides the card container
 *     on desktop (the actual incident: an unscoped
 *     `.accounts-grid { display: none }` meant for the Accounts tab blanked the
 *     Connections cards). A DOM/jsdom test CANNOT catch this — jsdom has no
 *     layout engine and ignores `@media` in getComputedStyle. So it is guarded
 *     structurally against the CSS source below.
 *
 * The render test executes the actual `<script>` from index.html in a Node `vm`
 * with a minimal DOM stub (the render functions build HTML strings and only
 * touch the DOM at the final `innerHTML =`), so it exercises the shipped code
 * with no browser and no new dependency.
 */

const HTML = readFileSync(
  new URL("../src/web/ui/index.html", import.meta.url),
  "utf8",
);

/** Load index.html's app script into a vm and return a render(data) helper. */
function loadConnectionsRenderer(): (data: unknown) => string {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  const appScript = scripts.find((s) => s.includes("function renderConnections"));
  if (!appScript) throw new Error("could not find the renderConnections script");

  const noop = () => {};
  const mkEl = (id: string): Record<string, unknown> => ({
    id,
    style: {},
    _html: "",
    classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
    set innerHTML(v: string) {
      (this as { _html: string })._html = v;
    },
    get innerHTML() {
      return (this as { _html: string })._html;
    },
    appendChild: noop,
    addEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const els = new Map<string, Record<string, unknown>>();
  const document = {
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, mkEl(id));
      return els.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => mkEl("x"),
  };
  const ctx: Record<string, unknown> = {
    document,
    console,
    location: {
      pathname: "/connections",
      protocol: "https:",
      host: "h",
      origin: "https://h",
      href: "https://h/connections",
      search: "",
    },
    history: { replaceState: noop, pushState: noop },
    navigator: {},
    fetch: () => new Promise(() => {}), // never resolves — Init's calls are inert
    WebSocket: function () {
      return { close: noop, send: noop };
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: noop,
    clearTimeout: noop,
    matchMedia: () => ({
      matches: false,
      addEventListener: noop,
      removeEventListener: noop,
      addListener: noop,
    }),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: noop,
    removeEventListener: noop,
    URLSearchParams,
    URL,
    TextEncoder,
    TextDecoder,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  // Init (fetch/WS calls) is inert via the stubs above; defining the functions
  // is what we need. A throw here would leave later `let`s in TDZ and surface
  // as a clear failure, which is the point.
  vm.runInContext(appScript, ctx, { timeout: 5000 });

  return (data: unknown) => {
    (ctx.renderConnections as (d: unknown) => void)(data);
    return (
      document.getElementById("connections") as unknown as { innerHTML: string }
    ).innerHTML;
  };
}

const MOCK = {
  google: [
    {
      account: "pixsoul@gmail.com",
      expiresAt: 1,
      scope: "https://www.googleapis.com/auth/drive.file",
      clientId: "cid-123456789012",
      enabledFor: ["carrie", "clerk"],
      brokerKnown: true,
    },
  ],
  microsoft: [
    {
      account: "ken@outlook.com",
      expiresAt: 1,
      scope: "Mail.ReadWrite",
      clientId: "mid-123456789012",
      enabledFor: ["clerk"],
      accountType: "personal",
      brokerKnown: true,
    },
  ],
  notion: { configured: false, databases: [] },
  linear: {
    configured: true,
    agents: [
      {
        agent: "carrie",
        workspaceId: "ws-zzz",
        defaultTeamId: "team-zzz",
        tokenVaultKey: "vault:linear/carrie/token",
      },
    ],
  },
  agentNames: ["carrie", "clerk"],
  googleFailed: false,
  microsoftFailed: false,
  linearFailed: false,
  fetchFailed: false,
};

describe("Connections tab renders provider cards from data (real inline renderConnections)", () => {
  const render = loadConnectionsRenderer();

  it("renders Google + Microsoft + Linear cards with their identifiers", () => {
    const out = render(MOCK);
    expect(out).toContain("pixsoul@gmail.com");
    expect(out).toContain("ken@outlook.com");
    expect(out).toContain("carrie");
    // Linear is shown as an OAuth app actor, not a personal token.
    expect(out).toContain("OAuth agent");
  });

  it("wraps the account cards in .accounts-grid (the element the CSS bug hid)", () => {
    const out = render(MOCK);
    expect(out).toContain('class="accounts-grid"');
    // The Google account must appear INSIDE an accounts-grid block, not just
    // somewhere in the document — that grid is what an over-broad
    // `display:none` blanked on desktop.
    const gridStart = out.indexOf('class="accounts-grid"');
    expect(gridStart).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("pixsoul@gmail.com")).toBeGreaterThan(gridStart);
  });

  it("never leaks an account expiry as a scary 'expired' for a broker-known slot", () => {
    // A past expiry on a broker-known account renders 'auto-refreshes', not a
    // red 'expired' — the original "connections look broken" complaint.
    const out = render(MOCK);
    expect(out).toContain("auto-refreshes");
  });

  it("shows honest empty/loading states, not silent blanks", () => {
    const out = render({
      ...MOCK,
      google: [],
      microsoft: [],
      linear: { configured: false, agents: [] },
    });
    expect(out).toContain("No Google accounts");
    expect(out).toContain("No Linear agents");
  });

  it("distinguishes a load FAILURE from genuine emptiness", () => {
    const out = render({
      ...MOCK,
      google: [],
      googleFailed: true,
      fetchFailed: true,
    });
    expect(out).toContain("Couldn't load Google accounts");
  });
});

describe("Connections CSS — card containers are never hidden unscoped on desktop", () => {
  // Structural guard for the exact incident class: a desktop `@media` rule that
  // hides `.accounts-grid` / `.account-card` GLOBALLY (no `#`-id scope) blanks
  // the Connections tab, which has no table fallback. The Accounts tab's
  // desktop table/grid swap is allowed ONLY because it is id-scoped to
  // `#accounts`. jsdom can't evaluate `@media`, so this is checked against the
  // CSS source.

  /** Pull `@media (...) { ... }` blocks (brace-matched) from the page CSS. */
  function mediaBlocks(css: string): Array<{ prelude: string; body: string }> {
    const blocks: Array<{ prelude: string; body: string }> = [];
    const re = /@media([^{]*)\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      const prelude = m[1];
      let depth = 1;
      let i = re.lastIndex;
      const start = i;
      for (; i < css.length && depth > 0; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
      }
      blocks.push({ prelude, body: css.slice(start, i - 1) });
      re.lastIndex = i;
    }
    return blocks;
  }

  const css = (() => {
    const styles = [...HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
      (s) => s[1],
    );
    // Drop CSS comments so prose mentioning the classes can't trip the guard.
    return styles.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  })();

  it("has at least one min-width media block (sanity — CSS was parsed)", () => {
    const desktop = mediaBlocks(css).filter((b) => /min-width/.test(b.prelude));
    expect(desktop.length).toBeGreaterThan(0);
  });

  it("never hides .accounts-grid / .account-card unscoped inside a desktop @media", () => {
    const desktop = mediaBlocks(css).filter((b) => {
      const mm = b.prelude.match(/min-width:\s*(\d+)px/);
      return mm != null && Number(mm[1]) >= 601;
    });
    const offenders: string[] = [];
    for (const block of desktop) {
      // Split the block into `selector { decls }` rules.
      for (const rule of block.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = rule[1];
        const decls = rule[2];
        const hides =
          /display\s*:\s*none/.test(decls) ||
          /visibility\s*:\s*hidden/.test(decls);
        if (!hides) continue;
        // Each comma-separated selector that targets a card container must be
        // id-scoped (contain a `#`), else it hides Connections cards too.
        for (const sel of selector.split(",")) {
          const targetsCard =
            /\.accounts-grid\b/.test(sel) || /\.account-card\b/.test(sel);
          if (targetsCard && !sel.includes("#")) {
            offenders.push(sel.trim());
          }
        }
      }
    }
    expect(
      offenders,
      `Unscoped desktop hide of card container(s): ${offenders.join(
        " | ",
      )} — this blanks the Connections tab (no table fallback). Scope to #accounts.`,
    ).toEqual([]);
  });

  it("keeps the Accounts-tab desktop grid-hide present but scoped to #accounts", () => {
    // The legitimate swap must survive — if someone deletes it, the Accounts
    // tab would show BOTH a table and a grid on desktop.
    expect(css).toMatch(/#accounts\s+\.accounts-grid\s*\{\s*display:\s*none/);
  });
});
