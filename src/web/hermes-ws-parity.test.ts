/**
 * WS / JSON-RPC contract-parity fixture for the Hermes-Desktop adapter.
 *
 * The mirror image of upstream's own REST parity fixture
 * (`apps/desktop/src/hermes-parity.test.ts`, 140 ln): where that one pins the
 * REST paths/bodies the desktop sends, this one pins the JSON-RPC methods,
 * request params, and *result shapes* the real Hermes Desktop renderer
 * destructures — asserted against Switchroom's own WS dispatcher
 * (`onHermesOpen` / `onHermesMessage` / `onHermesClose` in `hermes-adapter.ts`).
 *
 * ─── UPSTREAM PIN ───────────────────────────────────────────────────────────
 *
 * Every row in CONTRACT below was derived by reading upstream source at the
 * SHA in `HERMES_UPSTREAM_PIN`. Bump the pin and re-derive whenever the
 * desktop is upgraded — that is the entire point of this file.
 *
 * Re-derive with (from a clone of github.com/NousResearch/hermes-agent):
 *
 *   git checkout <new-sha>
 *   # 1. the authoritative RPC surface (server-side @method decorators):
 *   grep -rho '@method("[^"]*"' tui_gateway/ | sed 's/@method("//;s/"//' | sort -u
 *   # 2. the methods the DESKTOP can actually send (client call sites):
 *   grep -rEoh "[A-Za-z_]*[Rr]equest[A-Za-z]*(<[^>]*>)?\(\s*'[a-z_.]+\.[a-z_.]+'" \
 *     --include=*.ts --include=*.tsx apps/desktop/src | grep -v '\.test\.'
 *   grep -rEoh "rpc\(\s*'[a-z_.]+'" --include=*.ts apps/desktop/src
 *   # 3. the event names the desktop's stream handler understands:
 *   sed -n '1,25p' apps/shared/src/json-rpc-gateway.ts
 *
 * ─── HOW GAPS ARE ENCODED ───────────────────────────────────────────────────
 *
 * Every case asserts the REAL Hermes contract, unconditionally. Cases the
 * adapter does not yet honour are marked `gap:` in the table and run through
 * vitest's `it.fails` instead of `it`. That keeps CI green today AND makes the
 * marker self-retiring: the moment the adapter is fixed the assertion starts
 * passing, `it.fails` goes RED, and whoever fixed it must delete the `gap:`
 * flag. `it.skip` / `it.todo` would rot silently instead — they never notice
 * the fix. (The repo has no pre-existing known-gap idiom; `it.skipIf` is used
 * for platform gating only, e.g. `src/vault/broker/server.test.ts:603`.)
 *
 * Fixing the adapter is deliberately OUT of scope for this file.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";

/** Upstream hermes-agent commit this contract table was derived from. */
export const HERMES_UPSTREAM_PIN = "9da6d455c9e1f2bf74bb9f47766ee9fc52e17bfb";

// ─── Test doubles for the filesystem/DB reads the adapter makes ──────────────

// The REPL lane of slash.exec shells out to tmux; stub only the send, keeping
// the real INJECT_ALLOWLIST/INJECT_BLOCKLIST routing table under test.
vi.mock("../agents/inject.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/inject.js")>();
  return {
    ...actual,
    injectSlashCommand: async () => ({ outcome: "ok" as const, output: "Hermes TUI Status" }),
  };
});

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    // parseHermesSessionId stays REAL — it is contract logic, not I/O.
    agentBridgeAlive: () => true,
    handleListThreadIds: () => [],
    handleGetTurns: () => ({ ok: true, turns: [] }),
    handleGetAgents: async () => [
      {
        name: "alpha",
        active: "yes",
        uptime: "1h",
        memory: null,
        extends: "_base",
        topic_name: "alpha",
        primaryAccount: "slot-a",
        auth: { authenticated: true, subscriptionType: "max" },
        memoryCollection: "alpha",
        lastTurnAt: 1_700_000_000_000,
        context: null,
      },
    ],
  };
});

const {
  onHermesOpen,
  onHermesClose,
  onHermesMessage,
} = await import("./hermes-adapter.js");
type HermesWsContext = import("./hermes-adapter.js").HermesWsContext;

const CONFIG = {
  agents: { alpha: {} },
  switchroom: { agents_dir: "/nonexistent-agents-dir" },
} as unknown as SwitchroomConfig;

const SESSION = "alpha";

interface Harness {
  ctx: HermesWsContext;
  sent: unknown[];
}

function harness(): Harness {
  const sent: unknown[] = [];
  const ctx: HermesWsContext = {
    config: CONFIG,
    send: (msg: string) => sent.push(JSON.parse(msg)),
  };
  return { ctx, sent };
}

interface RpcFrame {
  jsonrpc: "2.0";
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Drive one JSON-RPC request through the adapter and return its response frame. */
async function call(
  h: Harness,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcFrame> {
  const before = h.sent.length;
  await onHermesMessage(h.ctx, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const frames = h.sent.slice(before) as RpcFrame[];
  const response = frames.find((f) => "result" in f || "error" in f);
  if (!response) throw new Error(`no JSON-RPC response frame for ${method}`);
  return response;
}

// ─── The contract table ──────────────────────────────────────────────────────

type Gap =
  /** Adapter answers, but the result shape is not what the desktop reads. */
  | "shape"
  /** Adapter has no case — falls through to the generic -32601 default. */
  | "missing";

interface ContractCase {
  /** JSON-RPC method name as sent on the wire. */
  method: string;
  /** Upstream `@method(...)` decorator, path relative to the hermes repo root. */
  upstream: string;
  /**
   * Desktop call site (relative to `apps/desktop/src/`), or null when no
   * renderer code path sends it — those rows exist because the adapter
   * implements the method and upstream still serves it (TUI / ACP callers).
   */
  desktopCall: string | null;
  /** Request params a real desktop sends. */
  params: Record<string, unknown>;
  /**
   * Keys the client reads off the JSON-RPC `result` object. Empty means the
   * client only checks for a non-error response (fire-and-forget verbs).
   */
  resultKeys: string[];
  /** Where the client destructures `resultKeys`. */
  reader?: string;
  gap?: Gap;
  note?: string;
}

/**
 * Rows are grouped the way upstream groups its handler modules
 * (methods_session / methods_prompt / methods_config / methods_complete /
 * methods_tools + server.py) so a re-derivation diff reads cleanly.
 */
const CONTRACT: ContractCase[] = [
  // ── methods_session.py ─────────────────────────────────────────────────────
  {
    method: "session.create",
    upstream: "tui_gateway/methods_session.py:14",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:389",
    params: { cols: 80 },
    // methods_session.py:127-158 returns all five.
    resultKeys: ["session_id", "stored_session_id", "message_count", "messages", "info"],
    reader: "types/hermes.ts:456-462 (SessionCreateResponse)",
    gap: "shape",
    note: "adapter returns only {session_id, stored_session_id} (hermes-adapter.ts:981)",
  },
  {
    method: "session.resume",
    upstream: "tui_gateway/methods_session.py:306",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:913",
    params: { session_id: SESSION },
    // _live_session_payload, server.py:8195-8208.
    resultKeys: [
      "info",
      "message_count",
      "messages",
      "messages_omitted",
      "running",
      "session_id",
      "session_key",
      "started_at",
      "status",
    ],
    reader: "types/hermes.ts:595-615 (SessionResumeResponse)",
    gap: "shape",
    note: "adapter returns only {session_id, stored_session_id} (hermes-adapter.ts:981)",
  },
  {
    method: "session.activate",
    upstream: "tui_gateway/methods_session.py:947",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:735",
    params: { session_id: SESSION },
    // index.ts:765 synchronously destructures `activated.session_key`; :770-786
    // read info / messages / messages_omitted / running / inflight / queued.
    resultKeys: [
      "info",
      "message_count",
      "messages",
      "messages_omitted",
      "running",
      "session_id",
      "session_key",
      "started_at",
      "status",
    ],
    reader: "app/session/hooks/use-session-actions/index.ts:765-786",
    gap: "shape",
    note: "adapter returns only {session_id, stored_session_id} (hermes-adapter.ts:981)",
  },
  {
    method: "session.status",
    upstream: "tui_gateway/methods_session.py:2366",
    desktopCall: "lib/desktop-slash-commands.ts:304",
    params: { session_id: SESSION },
    // methods_session.py:2433 → {"output": "\n".join(lines)}
    resultKeys: ["output"],
    reader: "app/session/hooks/use-prompt-actions/utils.ts:423-425 (renderRpcResult)",
    gap: "shape",
    note: "adapter returns {session:{...}} (hermes-adapter.ts:947); renderRpcResult falls through to a JSON dump",
  },
  {
    method: "session.usage",
    upstream: "tui_gateway/methods_session.py:1357",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:748",
    params: { session_id: SESSION },
    // methods_session.py:1375 returns the usage snapshot verbatim.
    resultKeys: ["calls", "input", "output", "total"],
    reader: "types/hermes.ts:653-662 (UsageStats); utils.ts:428-440",
    gap: "shape",
    note: "adapter returns {session_id, quota} (hermes-adapter.ts:1027)",
  },
  {
    method: "session.history",
    upstream: "tui_gateway/methods_session.py:2442",
    desktopCall: null,
    params: { session_id: SESSION, limit: 50 },
    // methods_session.py:2456-2462 → {"count": ..., "messages": [...]}
    resultKeys: ["count", "messages"],
    note: "adapter also echoes session_id, which upstream omits — additive, harmless",
  },
  {
    method: "session.list",
    upstream: "tui_gateway/methods_session.py:162",
    desktopCall: null,
    params: {},
    resultKeys: ["sessions"],
  },
  {
    method: "session.most_recent",
    upstream: "tui_gateway/methods_session.py:214",
    desktopCall: null,
    params: {},
    resultKeys: ["session_id"],
    note:
      "upstream methods_session.py:214-235 returns {session_id}, null when no " +
      "eligible session — the adapter now matches (it returned {session} before)",
  },
  {
    method: "session.close",
    upstream: "tui_gateway/methods_session.py:2748",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:410",
    params: { session_id: SESSION },
    resultKeys: [],
  },
  {
    method: "session.interrupt",
    upstream: "tui_gateway/methods_session.py:2942",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:1395",
    params: { session_id: SESSION },
    resultKeys: [],
  },
  {
    method: "session.active_list",
    upstream: "tui_gateway/methods_session.py:909",
    desktopCall: "app/session/hooks/use-session-actions/index.ts (requestGateway)",
    params: { current_session_id: SESSION },
    resultKeys: ["sessions"],
    gap: "missing",
  },
  {
    method: "session.branch",
    upstream: "tui_gateway/methods_session.py:2760",
    desktopCall: "app/session/hooks/use-session-actions/index.ts:1200",
    params: { session_id: SESSION, message_index: 0 },
    resultKeys: ["session_id"],
    gap: "missing",
  },
  {
    method: "session.context_breakdown",
    upstream: "tui_gateway/methods_session.py:1381",
    desktopCall: "app/session/hooks (requestGateway)",
    params: { session_id: SESSION },
    resultKeys: ["categories", "context_max"],
    gap: "missing",
  },
  {
    method: "session.cwd.set",
    upstream: "tui_gateway/methods_session.py:810",
    desktopCall: "app/session/hooks (requestGateway)",
    params: { session_id: SESSION, cwd: "/tmp" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "session.redirect",
    upstream: "tui_gateway/methods_session.py:3252",
    desktopCall: "app/session/hooks/use-session-actions/index.ts (requestGateway)",
    params: { session_id: SESSION, text: "actually, do X" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "session.save",
    upstream: "tui_gateway/methods_session.py:2676",
    desktopCall: "lib/desktop-slash-commands.ts (rpc('session.save'))",
    params: { session_id: SESSION },
    resultKeys: ["file"],
    reader: "app/session/hooks/use-prompt-actions/utils.ts:418-420",
    gap: "missing",
  },
  {
    method: "session.title",
    upstream: "tui_gateway/methods_session.py:1022",
    desktopCall: "app/session/hooks/use-session-actions/index.ts (requestGateway)",
    params: { session_id: SESSION, title: "renamed" },
    resultKeys: ["title"],
    gap: "missing",
  },
  {
    method: "message.react",
    upstream: "tui_gateway/methods_session.py:1106",
    desktopCall: "store (gateway.request)",
    params: { session_id: SESSION, message_index: 0, reaction: "👍" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "llm.oneshot",
    upstream: "tui_gateway/methods_session.py:1159",
    desktopCall: "store (gatewayRequest)",
    params: { session_id: SESSION, prompt: "summarise" },
    resultKeys: ["text"],
    gap: "missing",
  },
  {
    method: "handoff.request",
    upstream: "tui_gateway/methods_session.py:1218",
    desktopCall: "app/session/hooks (requestGateway)",
    params: { session_id: SESSION },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "handoff.state",
    upstream: "tui_gateway/methods_session.py:1306",
    desktopCall: "app/session/hooks (requestGateway)",
    params: { session_id: SESSION },
    resultKeys: ["state"],
    gap: "missing",
  },
  {
    method: "handoff.fail",
    upstream: "tui_gateway/methods_session.py:1333",
    desktopCall: "app/session/hooks (requestGateway)",
    params: { session_id: SESSION, reason: "timeout" },
    // methods_session.py:1350-1355 → {"failed": bool, "state": str}
    resultKeys: ["failed", "state"],
    gap: "missing",
  },
  {
    method: "session.workspace.move",
    upstream: "tui_gateway/methods_session.py (session.workspace.move)",
    desktopCall: "store (gatewayRequest)",
    params: { session_id: SESSION, cwd: "/tmp" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "session.compress",
    upstream: "tui_gateway/methods_session.py (session.compress)",
    desktopCall: "app/session/hooks/use-prompt-actions/slash.ts:534",
    params: { session_id: SESSION },
    resultKeys: ["summary"],
    reader: "app/session/hooks/use-prompt-actions/utils.ts:385-398",
    gap: "missing",
  },

  // ── methods_prompt.py ──────────────────────────────────────────────────────
  {
    method: "prompt.submit",
    upstream: "tui_gateway/methods_prompt.py:67",
    desktopCall: "app/session/hooks/use-prompt-actions/submit.ts:650",
    // methods_prompt.py:71 reads params["text"] — NOT "content".
    params: { session_id: SESSION, text: "hello" },
    resultKeys: [],
    note:
      "adapter accepts params.content ?? params.text (hermes-adapter.ts:1039), so `text` is honoured. " +
      "Dispatch-only assertion: the success path needs a live agent gateway.sock, so the result " +
      "shape ({ok, prompt_key}) is covered by the integration path, not here.",
  },
  {
    method: "prompt.background",
    upstream: "tui_gateway/methods_prompt.py:783",
    desktopCall: null,
    params: { session_id: SESSION, text: "hello" },
    resultKeys: [],
  },
  {
    method: "clarify.respond",
    upstream: "tui_gateway/methods_prompt.py:942",
    desktopCall: "store/clarify.ts:137",
    params: { request_id: "req-1", answer: "" },
    resultKeys: [],
    gap: "missing",
    note: "blocking clarify card cannot be answered from the console at all",
  },
  {
    method: "terminal.read.respond",
    upstream: "tui_gateway/methods_prompt.py:951",
    desktopCall: "store (gateway.request)",
    params: { request_id: "req-1", text: "{}" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "preview.read.respond",
    upstream: "tui_gateway/methods_prompt.py:960",
    desktopCall: "store (gateway.request)",
    params: { request_id: "req-1", text: "{}" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "window.read.respond",
    upstream: "tui_gateway/methods_prompt.py:968",
    desktopCall: "store (gateway.request)",
    params: { request_id: "req-1", text: "{}" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "secret.respond",
    upstream: "tui_gateway/methods_prompt.py:982",
    desktopCall: "store (gateway.request)",
    params: { request_id: "req-1", value: "" },
    resultKeys: [],
    gap: "missing",
    note: "adapter's degrade list names secret.get/secret.set, which are NOT upstream methods",
  },
  {
    method: "image.attach",
    upstream: "tui_gateway/methods_prompt.py:439",
    desktopCall: "app/chat (requestGateway)",
    params: { session_id: SESSION, path: "/tmp/a.png" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "image.attach_bytes",
    upstream: "tui_gateway/methods_prompt.py:482",
    desktopCall: "app/chat (requestGateway)",
    params: { session_id: SESSION, data: "", mime: "image/png" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "image.detach",
    upstream: "tui_gateway/methods_prompt.py:716",
    desktopCall: "app/chat (requestGateway)",
    params: { session_id: SESSION },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "file.attach",
    upstream: "tui_gateway/methods_prompt.py:669",
    desktopCall: "app/chat (requestGateway)",
    params: { session_id: SESSION, path: "/tmp/a.txt" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "preview.restart",
    upstream: "tui_gateway/methods_prompt.py:829",
    desktopCall: "app/session (requestGateway)",
    params: { session_id: SESSION },
    resultKeys: [],
    gap: "missing",
  },

  // ── methods_config.py / server.py ──────────────────────────────────────────
  {
    method: "config.get",
    upstream: "tui_gateway/methods_config.py:161",
    desktopCall: "app/settings (requestGateway)",
    params: { key: "provider" },
    // methods_config.py:169-179
    resultKeys: ["model", "provider", "providers"],
    gap: "missing",
  },
  {
    method: "config.set",
    upstream: "tui_gateway/server.py:10847",
    desktopCall: "app/chat/composer (requestGateway)",
    params: { session_id: SESSION, key: "model", value: "sonnet --provider switchroom" },
    resultKeys: [],
  },
  {
    method: "setup.status",
    upstream: "tui_gateway/methods_config.py:344",
    desktopCall: "lib/runtime-readiness.ts:75",
    params: {},
    resultKeys: ["provider_configured"],
  },
  {
    method: "setup.runtime_check",
    upstream: "tui_gateway/methods_config.py:354",
    desktopCall: "lib/runtime-readiness.ts:76",
    params: {},
    resultKeys: [],
  },
  {
    method: "reload.env",
    upstream: "tui_gateway/server.py (reload.env)",
    desktopCall: "app/settings (requestGateway)",
    params: {},
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "wake.status",
    upstream: "tui_gateway/server.py:13744",
    desktopCall: "store/wake-word.ts (request)",
    params: {},
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "wake.feed",
    upstream: "tui_gateway/server.py:13814",
    desktopCall: "store/wake-word.ts (request)",
    params: { audio: "" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "wake.pause",
    upstream: "tui_gateway/server.py:13714",
    desktopCall: "store/wake-word.ts (request)",
    params: {},
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "wake.stop",
    upstream: "tui_gateway/server.py:13687",
    desktopCall: "store/wake-word.ts:251 (gatewayRequester)",
    params: {},
    resultKeys: [],
    gap: "missing",
  },

  // ── methods_complete.py ────────────────────────────────────────────────────
  {
    method: "model.options",
    upstream: "tui_gateway/methods_complete.py:357",
    desktopCall: "app/chat/composer (request)",
    params: { session_id: SESSION },
    resultKeys: ["model", "provider", "providers"],
  },
  {
    method: "complete.path",
    upstream: "tui_gateway/methods_complete.py:41",
    desktopCall: "app/session/hooks/use-context-suggestions.ts:37",
    params: { word: "sr", session_id: SESSION },
    resultKeys: ["items"],
    gap: "missing",
  },
  {
    method: "complete.slash",
    upstream: "tui_gateway/methods_complete.py:218",
    desktopCall: "app/chat/composer/hooks/use-slash-completions.ts:187",
    params: { text: "/mem" },
    resultKeys: ["items"],
    gap: "missing",
  },

  // ── methods_tools.py ───────────────────────────────────────────────────────
  {
    method: "commands.catalog",
    upstream: "tui_gateway/methods_tools.py:255",
    desktopCall: "app/chat/composer (requestGateway)",
    params: {},
    resultKeys: ["categories"],
  },
  {
    method: "slash.exec",
    upstream: "tui_gateway/methods_tools.py:1077",
    desktopCall: "app/session/hooks/use-prompt-actions/slash.ts",
    // `status` is in INJECT_ALLOWLIST, so this exercises the REPL lane that
    // actually captures output; the non-REPL lane needs a live gateway socket.
    params: { session_id: SESSION, command: "status" },
    resultKeys: ["output"],
  },
  {
    method: "command.dispatch",
    upstream: "tui_gateway/methods_tools.py:432",
    desktopCall: "app/chat/composer (requestGateway)",
    params: { session_id: SESSION, command: "/doctor" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "process.list",
    upstream: "tui_gateway/methods_tools.py:49",
    desktopCall: "store (gateway.request)",
    params: { session_id: SESSION },
    // methods_tools.py:56
    resultKeys: ["processes"],
    gap: "missing",
  },
  {
    method: "process.kill",
    upstream: "tui_gateway/methods_tools.py:61",
    desktopCall: "store (gateway.request)",
    params: { session_id: SESSION, process_id: "p1" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "reload.mcp",
    upstream: "tui_gateway/methods_tools.py:84",
    desktopCall: "store (gateway.request)",
    params: { session_id: SESSION, confirm: true },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "browser.manage",
    upstream: "tui_gateway/methods_tools.py:1352",
    desktopCall: "store (gatewayRequest)",
    params: { session_id: SESSION, action: "status" },
    resultKeys: [],
    gap: "missing",
  },
  {
    method: "plugins.manage",
    upstream: "tui_gateway/methods_tools.py (plugins.manage)",
    desktopCall: "app/settings (gateway.request)",
    params: { action: "list" },
    resultKeys: [],
    gap: "missing",
  },

  // ── Approval / sudo lane ───────────────────────────────────────────────────
  // Note the asymmetry: upstream serves the *.respond RPCs; `approval.request`
  // and `sudo.request` are GatewayEventName values (json-rpc-gateway.ts:16-17),
  // not RPC methods. Switchroom deliberately never implements these — approvals
  // stay a Telegram-only surface (hermes-adapter.ts:17) — so a -32601 here is
  // the CORRECT answer and these rows are asserted as intentional degrades.
  {
    method: "approval.respond",
    upstream: "tui_gateway/server.py (approval.respond)",
    desktopCall: "store (gateway.request)",
    params: { request_id: "req-1", decision: "allow" },
    resultKeys: [],
    note: "intentional degrade — approvals are Telegram-only by invariant",
  },
  {
    method: "sudo.respond",
    upstream: "tui_gateway/server.py (sudo.respond)",
    desktopCall: "store (gateway.request)",
    params: { request_id: "req-1", decision: "allow" },
    resultKeys: [],
    note: "intentional degrade — approvals are Telegram-only by invariant",
  },
];

/** Methods Switchroom deliberately refuses (see the note on the rows above). */
const INTENTIONAL_DEGRADES = new Set(["approval.respond", "sudo.respond"]);

// ─── 1. Dispatch parity: every real method must be routed ────────────────────

describe(`Hermes WS contract parity (upstream ${HERMES_UPSTREAM_PIN.slice(0, 7)})`, () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it("the table only names methods that exist upstream", () => {
    // Guards a typo'd row silently asserting nothing meaningful.
    for (const c of CONTRACT) {
      expect(c.upstream, `${c.method} has no upstream provenance`).toMatch(/^tui_gateway\//);
      expect(c.method).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
    expect(new Set(CONTRACT.map((c) => c.method)).size).toBe(CONTRACT.length);
  });

  for (const c of CONTRACT) {
    if (INTENTIONAL_DEGRADES.has(c.method)) continue;

    const pending = c.gap === "missing";
    const dispatched = pending ? it.fails : it;

    dispatched(
      `${pending ? "[GAP] " : ""}${c.method} is dispatched (not -32601) — upstream ${c.upstream}`,
      async () => {
        const r = await call(h, c.method, c.params);
        expect(r.error?.code, `${c.method}: ${c.note ?? ""}`).not.toBe(-32601);
      },
    );
  }

  for (const c of CONTRACT) {
    if (c.resultKeys.length === 0) continue;
    if (INTENTIONAL_DEGRADES.has(c.method)) continue;

    const shaped = c.gap ? it.fails : it;

    shaped(
      `${c.gap ? "[GAP] " : ""}${c.method} result carries ${c.resultKeys.join(", ")} — read at ${c.reader ?? c.desktopCall ?? "upstream"}`,
      async () => {
        const r = await call(h, c.method, c.params);
        expect(r.error, `${c.method} errored: ${JSON.stringify(r.error)}`).toBeUndefined();
        for (const key of c.resultKeys) {
          expect(r.result, `${c.method}.${key} missing — ${c.note ?? ""}`).toHaveProperty(key);
        }
      },
    );
  }

  for (const method of INTENTIONAL_DEGRADES) {
    it(`${method} degrades with -32601 by design (approvals are Telegram-only)`, async () => {
      const r = await call(h, method, { request_id: "x" });
      expect(r.error?.code).toBe(-32601);
    });
  }
});

// ─── 2. Adapter-only surface: methods with no upstream peer ──────────────────

describe("adapter-only RPC surface", () => {
  /**
   * `model.info` has no `@method("model.info")` upstream and no desktop call
   * site (verified by both greps in the re-derive recipe). It is dead weight
   * the adapter answers; kept as a documented row so a future re-derive that
   * finds it upstream flips this test.
   */
  const ADAPTER_ONLY = ["model.info"];

  /**
   * Names the adapter enumerates in its explicit -32601 degrade list
   * (hermes-adapter.ts:1265-1271) that are NOT upstream RPC methods at all:
   * `secret.get`/`secret.set` (real method is `secret.respond`,
   * methods_prompt.py:982) and `approval.request`/`sudo.request` (both are
   * GatewayEventName values, json-rpc-gateway.ts:16-17).
   */
  const BOGUS_DEGRADE_ENTRIES = [
    "secret.get",
    "secret.set",
    "approval.request",
    "sudo.request",
  ];

  it("adapter-only methods still answer (documented dead weight, harmless)", async () => {
    const h = harness();
    for (const m of ADAPTER_ONLY) {
      const r = await call(h, m, { session_id: SESSION });
      expect(r.error?.code, `${m} unexpectedly unrouted`).not.toBe(-32601);
    }
  });

  it.fails(
    "[GAP] the degrade list names only real upstream methods (see BOGUS_DEGRADE_ENTRIES)",
    async () => {
      const src = await import("node:fs").then((fs) =>
        fs.readFileSync(new URL("./hermes-adapter.ts", import.meta.url), "utf-8"),
      );
      for (const bogus of BOGUS_DEGRADE_ENTRIES) {
        expect(src, `${bogus} is not an upstream RPC method`).not.toContain(`case "${bogus}"`);
      }
    },
  );
});

// ─── 3. Event contract ───────────────────────────────────────────────────────

/**
 * `GatewayEventName`, verbatim from `apps/shared/src/json-rpc-gateway.ts:1-22`
 * at the pinned SHA (the union also has a `(string & {})` escape arm, which is
 * not a contract value). 21 named types.
 */
const GATEWAY_EVENT_NAMES = [
  "gateway.ready",
  "session.info",
  "message.start",
  "message.delta",
  "message.interim",
  "message.complete",
  "thinking.delta",
  "reasoning.delta",
  "reasoning.available",
  "status.update",
  "tool.start",
  "tool.progress",
  "tool.complete",
  "tool.generating",
  "clarify.request",
  "approval.request",
  "sudo.request",
  "secret.request",
  "background.complete",
  "error",
  "skin.changed",
] as const;

/**
 * Event names the adapter actually emits. Derived statically from the source
 * rather than by exercising every emitter: `message.complete` / `message.start`
 * are produced by `startHistoryPoll`, a private `bun:sqlite` poller that cannot
 * run under vitest (see vitest.config.ts's bun:sqlite excludes). The wire
 * contract being asserted is still the outcome — which `type` strings can ever
 * appear in a `{method:"event"}` frame.
 */
function emittedEventNames(src: string): Set<string> {
  return new Set(
    [...src.matchAll(/sendEvent\(\s*ctx\s*,\s*"([^"]+)"/g)].map((m) => m[1]),
  );
}

async function adapterSource(): Promise<string> {
  const fs = await import("node:fs");
  return fs.readFileSync(new URL("./hermes-adapter.ts", import.meta.url), "utf-8");
}

describe("Hermes event contract", () => {
  it("gateway.ready is the first frame on the wire", () => {
    const h = harness();
    onHermesOpen(h.ctx);
    onHermesClose(h.ctx);
    expect(h.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "gateway.ready", session_id: null },
    });
  });

  it("event frames use the {jsonrpc, method:'event', params:{type, session_id, payload}} envelope", () => {
    const h = harness();
    onHermesOpen(h.ctx);
    onHermesClose(h.ctx);
    const frame = h.sent[0] as { params: Record<string, unknown> };
    expect(Object.keys(frame.params).sort()).toEqual(["payload", "session_id", "type"]);
  });

  it("every emitted event name is a real GatewayEventName", async () => {
    const emitted = emittedEventNames(await adapterSource());
    expect(emitted.size).toBeGreaterThan(0);
    for (const name of emitted) {
      expect(GATEWAY_EVENT_NAMES as readonly string[], `${name} is not a GatewayEventName`).toContain(
        name,
      );
    }
  });

  /**
   * Streaming lane. Switchroom's history poller only ever emits a terminal
   * `message.complete`; the desktop's stream handler is built around
   * delta/interim frames for live typing and around `tool.*` for the tool
   * timeline (gateway-event.ts). Until those are emitted the console shows a
   * spinner then a wall of text, with no tool activity at all.
   */
  const REQUIRED_STREAM_EVENTS = [
    "message.delta",
    "message.interim",
    "tool.start",
    "tool.progress",
    "tool.complete",
  ];

  for (const name of REQUIRED_STREAM_EVENTS) {
    it.fails(`[GAP] emits ${name}`, async () => {
      expect([...emittedEventNames(await adapterSource())]).toContain(name);
    });
  }

  /**
   * `message.complete` payload. gateway-event.ts:751-825 reads:
   *   text, rendered            → coerceGatewayText(payload?.text) || ...rendered
   *   response_previewed        → completeAssistantMessage(..., payload.response_previewed, ...)
   *   status === 'error', error, partial → terminal failure frame
   *   billing                   → surfaceBillingBlock
   *   usage                     → per-session UsageStats merge
   * The adapter sends only {text, prompt_key} (hermes-adapter.ts:396-399).
   */
  const MESSAGE_COMPLETE_FIELDS = [
    "text",
    "rendered",
    "response_previewed",
    "status",
    "error",
    "partial",
    "billing",
    "usage",
  ];

  /** Extract the payload object literal of the message.complete emitter. */
  async function messageCompletePayloadSrc(): Promise<string> {
    const src = await adapterSource();
    const at = src.indexOf('sendEvent(ctx, "message.complete"');
    expect(at, "message.complete emitter not found").toBeGreaterThan(-1);
    return src.slice(at, src.indexOf("});", at));
  }

  it("message.complete carries the text the desktop renders", async () => {
    expect(await messageCompletePayloadSrc()).toContain("text:");
  });

  for (const field of MESSAGE_COMPLETE_FIELDS.filter((f) => f !== "text")) {
    it.fails(`[GAP] message.complete carries ${field} (gateway-event.ts:751-825)`, async () => {
      expect(await messageCompletePayloadSrc()).toContain(`${field}:`);
    });
  }
});
