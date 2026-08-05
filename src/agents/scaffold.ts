import {
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  renameSync,
  chmodSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import chalk from "chalk";
import type { AgentConfig, QuotaConfig, SwitchroomConfig, TelegramConfig } from "../config/schema.js";
import { CRON_SCRIPT_BASENAME_RE, LEGACY_CRON_SCRIPT_BASENAME_RE } from "./cron-unit-name.js";
import { expandModelAlias } from "./model-aliases.js";
import { atomicWriteFileSync } from "../util/atomic.js";
import {
  HINDSIGHT_VENDOR_ASSET,
  describeShippedAssetSearch,
  resolveShippedAsset,
  type ShippedAssetResolution,
} from "../util/shipped-assets.js";
import {
  alignAgentTreeOwnershipIfRoot,
  findAgentUnreadablePaths,
  scopedAssertCandidates,
} from "./agent-owned-tree.js";
import {
  CLAUDE_MD_YOURS_MARKER,
  computeConfigHash,
  computeStampFilesFromDisk,
  writeGenerationStamp,
} from "./generation-stamp.js";
import { VERSION as SWITCHROOM_VERSION } from "../build-info.js";

// (There is deliberately no REPO_ROOT here any more. It was
// `resolve(import.meta.dirname, "../..")` feeding a `repoRoot` template
// variable used by exactly one line of start.sh.hbs — a HOST path baked into a
// script that only ever runs INSIDE the agent container, so it never resolved
// to anything real; under the compiled binary it rendered as `//`. Scripts the
// container needs come from DOCKER_BIN_PATH; assets the host CLI needs come
// from resolveShippedAsset(). #4163.)

// Switchroom #3757 / #3760 — mirrors of the hindsight plugin's own DEFAULTS
// (`vendor/hindsight-memory/scripts/lib/config.py`). These exist because the
// corresponding env vars must be exported UNCONDITIONALLY: an unexported (or
// empty) knob lets a stale `~/.hindsight/claude-code.json` silently shadow the
// shipped default. `tests/scaffold.test.ts` reads the Python DEFAULTS and
// fails if either value drifts from it.
export const HINDSIGHT_RECALL_QUERY_MAX_TOKENS_DEFAULT = 24;
// Re-export rather than re-declare. #3757 and #3759 each introduced a literal
// for this one key and briefly disagreed (12 vs 8); because start.sh exports it
// unconditionally and env outranks the vendored value, the losing literal would
// have silently overridden the shipped default on every host. One declaration,
// pinned against lib/config.py by hindsight-reranker-budget.test.ts.
export { DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS as HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS_DEFAULT } from "../setup/hindsight-recall-tunables.js";

/**
 * Primer the agent reads on every session boot so it knows it's running
 * in a switchroom container with `read_only: true` rootfs and a fixed
 * set of writable mounts. When the agent later hits an EROFS or
 * "Read-only file system" error, this primer is what lets it produce a
 * clear "I tried X, that's read-only because of <reason>; operator
 * action needed" reply instead of either silently retrying or echoing
 * the raw kernel error to the user.
 *
 * One of three fleet invariant blocks shipped by Switchroom. They
 * reach the agent via the fleet directory
 * (`~/.switchroom/fleet/switchroom-invariants.md`), loaded by Claude
 * Code's native CLAUDE.md auto-discovery when `--add-dir` extends the
 * discovery roots to the fleet dir (see start.sh.hbs and the
 * `renderFleetInvariants` helper below).
 *
 * Hoisted to top-level constants alongside TELEGRAM_GUIDANCE and
 * MEMORY_GUIDANCE to prevent the drift that previously affected those
 * two (which used to live as inline strings duplicated across
 * scaffold and reconcile paths).
 *
 * Why TypeScript constants and not `.hbs` files:
 *   - The `.hbs` files are per-agent and operator-editable; these
 *     blocks are fleet-wide and release-controlled.
 *   - Single canonical source in TypeScript; the rendered file on
 *     disk (~/.switchroom/fleet/switchroom-invariants.md) is the
 *     visible artifact so operators can READ what the agent is told,
 *     but operator edits get reset on `switchroom apply`
 *     (checksum-enforced).
 */
const SANDBOX_GUIDANCE = `## Sandbox: you're running in a switchroom container

Your container has \`read_only: true\` rootfs. Most paths are read-only.

**Root-tier exception.** If you run as uid 0 with the host docker socket
and \`/host\` / \`/host-home\` mounted (your CLAUDE.md's "Root-tier host
access" section spells this out), this sandbox framing does NOT describe
you — you are not read-only and not un-privileged. TEST a capability from
your root shell before claiming a limit; never cite "read-only", "I'm not
root", or "operator action" at yourself.

### Writable
- \`/tmp\` — 256 MB tmpfs, ephemeral (gone on restart).
- \`$HOME\` (\`/state/agent/home\`) — persistent across restarts. \`npm\`,
  \`pip\`, \`git config --global\`, shell history, ssh keys all already
  configured to write here (\`NPM_CONFIG_PREFIX\`, \`PIP_USER=1\`, etc).
- \`/state/agent/**\` — your persistent agent dir.
- \`/var/log/switchroom\` — your log dir.

### Read-only (and why)
- \`/\`, \`/opt\`, \`/usr\`, \`/etc\`, \`/bin\`, \`/lib\` — rootfs hardening.
- \`~/.switchroom/skills/**\` — shared skill files; operator-owned.
- \`~/.switchroom/credentials/**\` — secrets; immutable from your view.
- \`/state/config/switchroom.yaml\` — fleet config; operator-owned.

### When you hit "read-only file system" / EROFS

This is **the sandbox working as intended**, not a bug. Don't retry the
same write. Don't apologise vaguely. Instead:

1. Recognise the signal: \`EROFS\`, "Read-only file system", "permission
   denied" on a path under \`/opt\`, \`/usr\`, \`/etc\`, or
   \`~/.switchroom/{skills,credentials}\`.
2. Tell the user in plain language what you tried and why the sandbox
   blocked it.
3. Suggest the right path: a writable alternative if your goal is
   reachable that way, or explicit operator action otherwise.

Example response shapes:

- "I tried to edit \`~/.switchroom/skills/foo/script.sh\` — that's
  mounted read-only from my view. **Operator action**: edit it on the
  host, then \`switchroom apply\` to re-scaffold."
- "I wanted to \`apt install <pkg>\`. My container's rootfs is read-only
  and I'm not root. **Operator action**: add the package to
  \`docker/Dockerfile.agent\` and rebuild the agent image."
- "I tried to clone into \`/workspace\` — that path doesn't exist in my
  sandbox. Cloning into \`$HOME/workspace\` instead."`;

/**
 * File delivery. One of the fleet invariant blocks (sibling to
 * SANDBOX_GUIDANCE — that one covers where files live INSIDE the
 * container; this one covers how to get a file OUT to the user).
 *
 * The recurring failure this fixes: an agent writes a file and hands
 * back its local container path (\`/state/agent/...\`, \`/tmp/...\`).
 * The user is not on the box and cannot open it. See SANDBOX_GUIDANCE
 * above for the constant-vs-\`.hbs\` rationale.
 */
const DELIVERY_GUIDANCE = `## Delivering a file to the user

You run in a container. A local path like \`/state/agent/...\` or
\`/tmp/...\` means **nothing** to the user — they are not on your box and
cannot open it. When you produce a file the user should have, **deliver
it**, don't print its path.

### Send it in Telegram (default for most files)
The \`reply\` tool attaches files: pass \`files: ["/abs/path"]\` (images
send as photos, everything else as documents; 50 MB max each). This is
the right channel for almost anything — a report, a CSV, a chart, a
generated doc — the user gets it straight in the chat. Prefer this.

### Put it in their Drive (for files they'll keep or edit, or > 50 MB)
Run \`switchroom deliver-file <path>\`. It uploads the file into the user's
\`Switchroom/<your-agent-name>\` folder on their connected drive (creating
the folder if needed) and prints a share link. Reply with that link — not
a path. This is the reliable way: switchroom owns the destination and the
upload, so you don't guess folder names or hit a per-file approval. (If you
prefer the raw \`gdrive\` / \`ms-365\` MCP tools, still target that same
\`Switchroom/<your-agent-name>\` folder — never scatter files loose in the
user's drive.)

### If you can't deliver
No Drive connected and the file is too big for Telegram? Say so plainly
and offer the fix ("connect a Drive from the dashboard and I'll put it
there"). Don't fall back to handing over a local path that leads nowhere.

The rule: the user must be able to **reach** what you made. A path on your
container is not delivery.`;

/**
 * The Telegram pacing contract. One of three fleet invariant blocks.
 * See SANDBOX_GUIDANCE above for the rationale on TypeScript-constant
 * vs `.hbs` file.
 *
 * Companion: the per-turn `<turn-pacing>` UserPromptSubmit hook (PR
 * #1646) reasserts the contract adjacent to each user message. That
 * hook is load-bearing and lives elsewhere in this file; do NOT
 * remove it when modifying this constant.
 */
const TELEGRAM_GUIDANCE = `## Talking to a human on Telegram

There is a real person on the other end. Every turn should feel like
messaging a capable colleague — not a tool emitting output. Five beats:

1. **Acknowledge first.** Unless your whole reply is a single short
   sentence you can send right now, your FIRST action this turn is a
   brief \`reply\` in your own voice — "on it", "good question, one
   sec", "let me dig in" — before any tool call and before you
   compose the full answer. This holds even for a pure-thinking
   answer: if it will run to a paragraph, ack first. It is the line
   between a colleague and a black box.
2. **Then go quiet and work — but label what you are doing.** Heads-down
   is correct: do NOT narrate every tool call, and a typing indicator
   runs automatically (you do not maintain it). What you SHOULD do is
   make the work legible through the tool calls themselves: always give a
   \`Bash\` (or any tool) call a plain-English \`description\` naming the
   goal — "Checking the gateway logs to find why the turn stalled". That
   description, not the raw command, is what the user sees in the live
   preview. Before a long silent stretch, put one short status line there
   too, saying what you are starting. One line per stretch, plain words,
   never raw tool names ("calling Bash") or debug dumps. It is the
   difference between the user seeing "checking the logs to find the
   stall" and seeing a black box. Keep it in the tool call — loose
   transcript prose is not delivered and can be flushed late (see beat 5).
3. **Surface meaningful progress** at genuine inflection points — a
   hard step finished, a blocker, a pivot, dispatching a sub-agent, a
   notably slow wait, a finding worth knowing now. One short \`reply\`,
   \`disable_notification: true\`.
4. **Hand back delegations with synthesis.** When a sub-agent / worker
   returns, re-enter in YOUR voice — what it found, and what you are
   doing next. Never let its raw report stand as your reply. A
   *background* worker finishes after your turn ends; its result
   arrives as a fresh \`<channel source="subagent_handback">\` turn —
   treat that turn as the cue to do exactly this.
5. **Deliver the answer** as a final \`reply\`.

The one thing to avoid is *spam*: a reply on every tool call, on a
timer, or repeating what you already said. Responsive and human, never
a flood. Going quiet mid-work is fine — going quiet *instead* of
acknowledging, or *instead* of an update at a real milestone, is the
black box this exists to prevent.

### Secrets — never ask for a chat paste

Never ask the user to paste a secret — an API key, token, password, or
private key — as a normal chat message. It would persist in plaintext
before anything can scrub it. Instead:

- Need a credential that isn't in the vault? Call
  \`request_secret(key, reason)\`. The operator gets a secure card, provides
  the value once, and it goes straight to the vault — you only ever see
  \`vault:<key>\`. After calling it, end your turn and wait for the reply.
- The user *handed* you a value to keep? Use \`vault_request_save\`.
- The key exists but you hit \`VAULT-BROKER-DENIED\`? Use \`vault_request_access\`.

Reference stored secrets only as \`vault:<key>\` — never echo a raw secret
value back into chat.

### Formatting — make it scannable

\`reply\` renders rich Markdown (Bot API 10.1) for you, so
\`**bold**\` becomes bold and backtick-wrapped text becomes monospace. Your full
formatting floor card — the toolkit and when to reach for each — is injected
into your system prompt every session; this is the conversational summary.

- **A one- or two-line conversational reply needs almost no markup.** Keep
  bold for the single fact that matters, never for decoration. "on it, pulling
  the logs now" is already perfect.
- **A multi-section message needs visual hierarchy or it reads as a flat
  wall.** When you group several blocks — a status update, a "where things
  stand", a summary with distinct buckets, or **the message you post before
  kicking off a sub-agent or worker** — give each section a **bold label on
  its own line** and separate sections with **one blank line**. A row of
  emoji and bullets at equal weight with no spacing is the plain-text dump to
  avoid; bold labels + blank lines are what let the eye find the structure.
  Example shape:

  **Dispatching**
  Kicking off a worker to crawl the changelog.

  **What it'll do**
  - pull every entry since v0.14
  - flag anything user-facing

  **Back in** ~2 min with a synthesized summary.
- Use backtick-wrapped \`inline code\` for filenames, commands, and
  identifiers. Keep lines short; long unwrapped lines are hard to read on a
  phone.

### Turn-ends — decision first, short by default

The message that ends your turn is the one the user actually reads, on a
phone. Optimise it for a thumb scroll, not a terminal dump:

- **Lead with the single decision or answer.** First line = the one thing
  the user has to know. Everything else is supporting detail, and most of it
  can be cut.
- **A routine turn-end is a few short lines**, not a multi-section status
  report. If you are stacking three labelled sections or running past ~6
  lines for an ordinary turn, you are dumping — trim to the decision.
- **One idea per message.** When you genuinely touched separate topics, send
  separate replies rather than piling sections into one bubble. A reply the
  user has to re-read to find the one fact that matters has already failed.
- **Progressive disclosure beats pre-emptive dumping.** Don't paste logs,
  full file contents, or a section per thread by default. Give the headline
  and offer "want the detail?" — let the user pull depth rather than pushing
  it.
- **Reserve the long, multi-section structured message for when the operator
  explicitly asked to go deep** ("full breakdown", "walk me through it",
  "show everything"). Then the structure earns its length. Absent that, short
  wins.

Every turn that answers a user message ends with a user-visible
\`reply\` — Telegram is all the user
sees; your terminal output never reaches them.`;

/**
 * The Hindsight memory protocol. One of three fleet invariant blocks.
 * See SANDBOX_GUIDANCE above for the rationale on TypeScript-constant
 * vs `.hbs` file.
 */
const MEMORY_GUIDANCE = `## Memory — proactive, conversational

You have Hindsight tools: \`mcp__hindsight__sync_retain\`, \`mcp__hindsight__delete_document\`, \`mcp__hindsight__recall\`, \`mcp__hindsight__reflect\`. Use them without being asked.

### Retain proactively
When the user shares a fact, preference, decision, or plan worth keeping across sessions, call \`sync_retain\` in the same turn. Briefly acknowledge in your reply ("got it, April 2nd anniversary"). Don't narrate the tool call. Skip small talk and transient tool output, the auto-retain hook handles conversation-level signal.

### Correct proactively
When the user corrects you or contradicts a prior memory, call \`delete_document\` on the wrong entry, then \`sync_retain\` the correction. Acknowledge the correction in one line ("noted, Alice not Bob").

### Forget proactively
When the user asks you to forget something ("forget that", "delete X", "drop what I said about Y"), call \`delete_document\` for matching entries and confirm what was removed.

### Inspect proactively
When the user asks "what do you know about X / me", "what do you remember about Y", or any memory audit, use \`reflect\` to synthesize an answer across the bank. Return it as honest prose, not a raw dump. If the bank has little on the topic, say so.

Don't wait for a slash command. Don't ask permission. Memory work is table stakes, like a colleague who takes notes and remembers.`;

/**
 * The web-fetch contract. One of the fleet invariant blocks. The
 * native WebFetch / WebSearch tools are disabled at the cascade
 * level (`scaffold.ts:WEBKITE_FLEET_DENY_TOOLS`); webkite is wired
 * in via `.mcp.json` and runs as a stdio MCP server with 12 tools.
 *
 * Cloudflare / Firecrawl credentials are pre-fetched from the vault
 * by start.sh.hbs at boot — webkite picks them up via env and uses
 * cloud render as a fallback when local cloakbrowser can't fetch a
 * bot-gated site. No agent setup required.
 */
const WEB_FETCH_GUIDANCE = `## Fetching from the web

The native \`WebFetch\` and \`WebSearch\` tools are disabled in this
fleet. Use the \`webkite_*\` MCP tools instead — they're already
wired up and authenticated.

The 12 tools webkite exposes cover what you actually need:

- \`webkite_read\` — fetch a URL and get clean article text or
  markdown. The everyday "read this page" tool. Pass several URLs
  to read them in one call.
- \`webkite_search\` — web search; returns URLs + snippets. Use
  before \`webkite_read\` when you don't already have the URL.
- \`webkite_extract\` — pull specific fields from one page via a
  JSON Schema you supply. Use when you want structured data, not
  prose.
- \`webkite_crawl\` — walk a site from a seed URL. Higher-cost than
  \`read\` or \`map\` — reserve for "harvest everything under this
  section."
- \`webkite_map\` — list a site's URLs from its sitemap, no page
  content. Cheap. Use when you only need URLs.
- \`webkite_clip\` — save a page snapshot (Obsidian, file, or
  screenshot).
- session / cookie / diagnostics helpers.

**Why this exists:** the fleet ships with a stealth Chromium
(cloakbrowser) baked in for bot-gated sites the native fetcher can't
touch, plus Cloudflare/Firecrawl fallback when local render fails.
\`webkite_*\` Just Works — don't try to shell out to \`curl\` or
\`wget\` as a fallback; if webkite can't fetch a URL, neither can
they.

If you genuinely need WebFetch back for one agent (e.g. a workflow
that depends on its specific output shape), set \`mcp_servers.webkite:
false\` in that agent's switchroom.yaml block — webkite goes away
and the native tools come back together.`;

/**
 * Library/framework documentation lookup. One of the fleet invariant
 * blocks. The failure mode it targets is the model answering an API
 * question from training memory — confidently, and wrong for anything
 * that moved since the cutoff. That is indistinguishable from a
 * correct answer at read time, which is why it needs a rule rather
 * than a judgement call.
 *
 * SCOPE — deliberately narrow. The context7 server ships its own MCP
 * `instructions` field, and it already states the trigger condition
 * ("even when you think you know the answer"), the negative scope
 * (refactoring / business logic / code review / general concepts) and
 * the prefer-over-web-search rule. Claude Code delivers a server's
 * `instructions` even when its TOOLS are tool-search-deferred —
 * verified in-fleet on 2026-07-26: `webkite` and `perplexity` carry no
 * `alwaysLoad` in `.mcp.json` under `ENABLE_TOOL_SEARCH=true`, yet
 * both servers' `instructions` appear verbatim in the running agent's
 * system prompt. So restating the trigger here would be pure
 * duplication of text the model already has. This block carries only
 * what the server CANNOT know:
 *   - the opt-out, and that the block is void for an opted-out agent
 *     (see the renderFleetInvariants note below);
 *   - the failure signal — a lookup that returns nothing OR errors
 *     (the anonymous free tier is per-IP rate-limited and the whole
 *     fleet shares one host IP, so 429s are expected) must be
 *     declared, never silently swallowed into a memory answer;
 *   - which fleet tool to fall back to (`webkite_read`);
 *   - query hygiene — this is a public third-party endpoint and the
 *     query text leaves the host.
 *
 * NOTE — `renderFleetInvariants()` renders ONE fleet-wide file
 * (`~/.switchroom/fleet/switchroom-invariants.md`) read by every
 * agent via `--add-dir`; there is no per-agent variant to
 * parameterise. So the opted-out case is handled by CONDITIONAL
 * PHRASING inside the block, not by a render argument.
 *
 * context7 is wired by `resolveContext7McpEntry` (fleet-default,
 * per-agent `mcp_servers.context7: false` opt-out) and pre-approved
 * via CONTEXT7_MCP_TOOLS.
 */
const LIBRARY_DOCS_GUIDANCE = `## Library and framework docs — look them up, don't recall them

Your training data has a cutoff. Library APIs do not. When you answer
a question about a library, framework, SDK, CLI, or cloud service from
memory, you cannot tell from the inside whether that memory is current
or two major versions stale — and a confidently wrong API answer costs
more than the lookup.

So: **before you write or review code against a third-party library,
look its docs up with \`context7\`** — \`mcp__context7__resolve-library-id\`
to turn a package name ("next.js", "prisma", "boto3") into a Context7
library ID, then \`mcp__context7__query-docs\` to fetch the docs for
that ID. The server states its own rules on when to reach for it and
when not to bother; those arrive with its tool schemas. What follows is
only what the server cannot know about this fleet.

**If you have no \`context7\` tools, this block does not apply to
you.** context7 is a fleet default, but an agent can be opted
out with \`mcp_servers.context7: false\` in its switchroom.yaml block —
check your actual tool list rather than assuming. Without it, use
\`webkite_read\` against the library's own docs site and name that
source in your answer.

Its tools are tool-search-deferred, like most of your MCP surface, so
the first context7 call in a session pays one extra round-trip to load
the schema. That is normal, not an error, and not a reason to skip the
lookup.

**A lookup that fails is a fact you must state — never a licence to
answer from memory.** Two distinct failures, one rule:
- **No entry.** context7 has nothing for the library (common for
  private or very new packages).
- **The call errors.** A transport failure, a timeout, or a rate-limit
  / HTTP 429. The free tier is anonymous and rate-limited per IP, and
  every agent on this host shares one IP — so 429s are an expected
  condition here, not an exotic one.

In either case: say the lookup failed and why, fall back to
\`webkite_read\` against the project's own docs site, and name the
source your answer actually came from. If you end up relying on
training memory anyway, say so explicitly and mark it unverified. A
silent fallback to memory after a failed lookup is precisely the
failure this block exists to prevent.

**Query hygiene:** context7 is a public third-party endpoint. Your
query text leaves this host. Send the library name and the API
question — never private identifiers, internal repo or service names,
customer data, or a paste of proprietary source.`;

/**
 * Vault key discovery. One of the fleet invariant blocks. Stops the
 * single most common vault failure: an agent GUESSING a secret's key
 * name (\`postiz/api-key\`) when it already holds the real one
 * (\`marko/postiz-api-key\`), then burning an operator approval on a
 * \`vault_request_access\` for a key that doesn't exist.
 * See SANDBOX_GUIDANCE above for the constant-vs-\`.hbs\` rationale.
 */
const VAULT_GUIDANCE = `## Secrets in the vault — discover, don't guess

Your API keys and credentials live in the Switchroom vault. For normal
MCP-tool work they're injected by the launchers and you never touch the
raw values. When a task needs a secret directly (a direct API call an
MCP tool has no verb for), read it with \`switchroom vault get <key>\`.

**Never guess a key name.** Run \`switchroom vault list\` to see the
exact keys you already hold — they're usually namespaced \`<you>/...\`
(e.g. \`marko/postiz-api-key\`, not \`postiz/api-key\`). Use the real
name from that list.

Only call the \`vault_request_access\` MCP tool — which pings the
operator for a Telegram approval — for a key you've **confirmed via
\`vault list\` you don't already have.** Requesting access to a guessed
or already-held key wastes the operator's tap and fails.

**Never put a secret's value — or a \`vault:<key>\` placeholder — in a
tool call.** Tool arguments are sent to the underlying API verbatim;
nothing resolves a \`vault:\` reference for them. A real secret never
needs to appear in a tool call — the launcher injects it into the
tool's environment for you. A value you genuinely must pass literally
(an account or customer ID) is a public identifier, not a secret, and
belongs in plain config, not the vault. If a tool call is **blocked for
containing a vaulted secret**, report that exact block message to the
operator and stop — don't theorise about auth or tokens; it just means
a stored value reached a tool argument.`;

/**
 * The Telegram formatting FLOOR CARD — boot-injected into EVERY agent's
 * `claude` session via `--append-system-prompt` (model-independent, present
 * in every session, see `systemPromptAppendShellQuoted` below). This is the
 * deterministic floor: every bot knows the rich-Markdown toolkit and the craft
 * of formatting for a phone screen, with no model in the loop deciding whether
 * to load it.
 *
 * SINGLE SOURCE OF TRUTH. The depth reference doc
 * `reference/telegram-formatting-guide.md` quotes this text VERBATIM in its
 * "FLOOR CARD (boot-injected)" section (Ken approved this wording). The doc
 * is a `reference/*.md` file NOT shipped into the agent image, so it cannot
 * be imported at runtime — keep the two in sync by hand, and update both
 * together. The guide's comment points back here.
 *
 * Keep it COMPACT — it is cached in every agent's prompt prefix.
 */
const TELEGRAM_FORMATTING_FLOOR_CARD = `## Formatting for Telegram

You're writing for a phone screen in Telegram. Every reply renders as rich Markdown
(Bot API 10.1). One shared spec, three tiers:

- **Short answers (a line or two): plain prose, no formatting.** "on it, pulling the
  logs now" is already perfect. No bold, no bullets, no headings.
- **Default: light structure.** Bold ONLY the one key fact or answer, never more.
  *Italic* for a light aside or a term of art — rarer than bold; if everything is
  emphasised, nothing is. ~~Strikethrough~~ only for a genuine retraction or a
  "was X, now Y" — never decoration. A
  list only for 3+ genuinely parallel items the reader will scan or compare; two items
  or a flowing thought stay prose. A numbered list ONLY when order carries meaning
  (steps to follow, a ranking); a nested sub-list only for a real hierarchy, one level
  deep. \`code spans\` for identifiers: filenames, commands,
  config keys, error codes (tap-to-copy). Wrap dynamic identifiers in backticks:
  code-span content is literal, so it never needs escaping. Links as \`[label](url)\`,
  never bare pasted URLs mid-prose.
- **Long answers may add the rich constructs, but only when they cut the reader's
  effort:** a GFM pipe table for real 2-D data (rows x columns); headings only in a
  multi-section answer; a \`---\` divider only between genuinely separate sections of a
  long answer (a heading usually does the job alone); \`>\` for quoted text; a spoiler
  \`||text||\` ONLY when the reader should opt in before seeing it (a punchline, a plot
  detail, a shock number) — never for emphasis; \`==highlight==\` to marker-pen the one
  decisive phrase inside a longer passage — rarer than bold, never stacked with it;
  fenced code blocks ALWAYS with a language
  hint (\`\`\`diff, \`\`\`json, \`\`\`bash — bare fence only for non-code fixed-width output);
  and the flagship — the **expandable blockquote** \`**> first line\` + \`> continuation\`
  for a long quote, stack trace, or detailed aside the reader can collapse. The \`**>\`
  opener must be at the line start (column 0) — never indented — or it won't parse. Use it
  whenever a bulky supporting block would otherwise dominate the message.

Renders wrong on this path — never emit: underline (\`__x__\` renders as bold),
\`^sup^\`/\`~sub~\`, \`$math$\`, \`<details>\`, footnotes \`[^1]\`. Write "squared", not \`x^2^\`.

The framework normalizes mechanics in code on every outbound message: block spacing,
em/en dashes, and \`\u2022\` bullet markers are
rewritten deterministically; unsupported tokens (the CARET \`^highlight^\` form —
\`==highlight==\` renders fine — plus \`$math$\`, \`<details>\`, footnotes) are repaired;
long messages are chunked safely at 32768 chars (fences and
table rows never bisected); over-bolded messages get their bold stripped. Don't
hand-tune spacing or fight it — write the content, the gateway makes typography
consistent. Long before the cap, ask whether a wall of text is the right answer at all.

Structure exists for the reader, not the writer: a two-item bullet list is worse than
a sentence, a heading on a three-line reply is noise. When in doubt, shorter and
plainer wins.

Every turn that answers a user message ends with a user-visible \`reply\`
— Telegram is all the user sees; your terminal output
never reaches them.`;

/**
 * Canonical rendering of the fleet invariants file written to
 * `~/.switchroom/fleet/switchroom-invariants.md`. Apply checksums
 * this against the on-disk file and restores on drift. Operators
 * read the file to see what every agent is told; edits are
 * non-durable (release-controlled).
 *
 * Header is a literal string the operator sees first when they open
 * the file — it MUST teach the file's nature without requiring docs.
 */
/**
 * Prepend the reply-discipline fragment near the TOP of a rendered
 * CLAUDE.md — right after the leading `# Agent: <name>` title line, so
 * the "your plain text is invisible, only the `reply` tool reaches
 * Telegram" contract is one of the first things the model reads. Unlike
 * the vault / self-service / execution-discipline fragments (which ride
 * the tail), this contract is turn-critical and must be prominent.
 *
 * Applied identically on BOTH the first-scaffold and reconcile paths so
 * the two produce byte-identical CLAUDE.md (the reconcile diff-abort
 * trips otherwise). No-op if the fragment source file is absent.
 */
function prependReplyDiscipline(
  rendered: string,
  context: Record<string, unknown>,
): string {
  const replyDiscipline = renderReplyDisciplineFragment(context);
  if (!replyDiscipline) return rendered;
  const newlineIdx = rendered.indexOf("\n");
  if (newlineIdx === -1) {
    // Degenerate single-line template — put the title first, then block.
    return rendered.trimEnd() + "\n\n" + replyDiscipline + "\n";
  }
  const title = rendered.slice(0, newlineIdx);
  const body = rendered.slice(newlineIdx + 1).replace(/^\n+/, "");
  return title + "\n\n" + replyDiscipline + "\n\n" + body;
}

export function renderFleetInvariants(): string {
  return [
    "<!--",
    "  ~/.switchroom/fleet/switchroom-invariants.md",
    "",
    "  Release-controlled fleet invariants. Every Switchroom agent reads",
    "  this via Claude Code native CLAUDE.md discovery, since the agent's",
    "  `claude` process boots with `--add-dir ~/.switchroom/fleet`.",
    "",
    "  DO NOT EDIT. `switchroom apply` regenerates this file on every run",
    "  and restores it if it drifts from the release canonical. To extend",
    "  the agent's behaviour fleet-wide, edit ~/.switchroom/fleet/CLAUDE.md",
    "  instead (operator-owned, additive, preserved across applies).",
    "-->",
    "",
    "# Switchroom fleet invariants",
    "",
    SANDBOX_GUIDANCE,
    "",
    DELIVERY_GUIDANCE,
    "",
    TELEGRAM_GUIDANCE,
    "",
    MEMORY_GUIDANCE,
    "",
    WEB_FETCH_GUIDANCE,
    "",
    LIBRARY_DOCS_GUIDANCE,
    "",
    VAULT_GUIDANCE,
    "",
  ].join("\n");
}

import { DEFAULT_PROFILE, resolveMemoryProfile } from "../config/schema.js";
import { DEFAULT_CRON_MODEL, scheduleNeedsCronSession } from "../scheduler/cron-routing.js";
import { applyDefaultTier } from "../scheduler/tier-selector.js";

/**
 * Cheap-cron (L4) start.sh context. `cronSessionEnabled` is purely
 * config-derived — true iff the agent has a schedule entry that routes to the
 * Tier-1 cron session: an explicit `context: fresh`, OR a cheap (sonnet/haiku)
 * `model:` with no `context` (which `resolveCronRouting` infers to fresh), OR a
 * `kind: poll` whose escalation does either. None of those fields exist on any
 * current fleet config, so the start.sh fork block renders EMPTY for every
 * current agent, keeping their boot byte-identical. The runtime
 * SWITCHROOM_CHEAP_CRON flag self-gates again inside cron-session.sh.
 */
function buildCronSessionContext(agentConfig: AgentConfig): {
  cronSessionEnabled: boolean;
  cronModelQ: string;
} {
  // Apply the cheap-by-default tier (value-gate) so a frequent, hint-less
  // cron — which routes to a Tier-1 cron session at runtime — also gets the
  // cron-session.sh rendered here. Without this, the scaffold and the fire
  // path would disagree and the session would be missing at fire time.
  const entries = (agentConfig.schedule ?? []).map((e) =>
    applyDefaultTier({ cron: e.cron, kind: e.kind, model: e.model, context: e.context }),
  );
  return {
    cronSessionEnabled: scheduleNeedsCronSession(entries, { cheapCronEnabled: true }),
    cronModelQ: shellSingleQuote(DEFAULT_CRON_MODEL),
  };
}

/**
 * Cheap-cron Tier-1 (#2307): write the cron session's .mcp.json at
 * <agentDir>/.claude-cron/.mcp.json. The cron session loads it via
 * `--mcp-config … --strict-mcp-config`.
 *
 * Tier-1 is "a fresh conversation that STILL has the agent's memory + tools, on
 * a cheaper model" — so this renders the agent's FULL filtered MCP set (the
 * same map written to the main .mcp.json), NOT a trimmed one. Crucially:
 *   - Stateful MCPs (hindsight) baked their bank id from the BASE agent name at
 *     build time, so the cron session shares the SAME memory bank — zero
 *     fragmentation (the cron identity `<name>-cron` only affects the telegram
 *     bridge, which reads it from the process env, not the .mcp.json).
 *   - The cron session runs with ENABLE_TOOL_SEARCH (cron-session.sh), so the
 *     full schema set DEFERS — it keeps the low-context cost while having the
 *     tools available on demand. switchroom-telegram + hindsight stay
 *     `alwaysLoad`.
 *   - The switchroom-telegram entry is cloned with one override:
 *     SWITCHROOM_BRIDGE_ALIVE_PATH points its liveness file at a DISTINCT path
 *     so a live <name>-cron bridge can't mask a dead main bridge in the
 *     dashboard/doctor probe (RISK #2). Everything else — TELEGRAM_STATE_DIR
 *     (access.json/history), the gateway socket — stays SHARED, so the cron
 *     bridge authorises replies through the same gateway as the main bridge.
 *
 * The caller's `mcpServers` map is never mutated (the main .mcp.json source).
 * No-op unless the agent has a cron session AND a switchroom-telegram bridge.
 * Returns the cron config path or null.
 */
export function maybeWriteCronMcp(
  agentDir: string,
  mcpServers: Record<string, McpServerConfig>,
  cronSessionEnabled: boolean,
): string | null {
  if (!cronSessionEnabled) return null;
  const telegram = mcpServers["switchroom-telegram"];
  if (!telegram) return null;

  // Clone the telegram entry with a distinct liveness-file path (RISK #2),
  // keeping TELEGRAM_STATE_DIR (and thus access.json / history / gateway.sock)
  // shared with the main bridge.
  const baseStateDir = telegram.env?.TELEGRAM_STATE_DIR;
  const cronTelegram: McpServerConfig = {
    ...telegram,
    env: {
      ...telegram.env,
      ...(baseStateDir
        ? { SWITCHROOM_BRIDGE_ALIVE_PATH: `${baseStateDir}/.bridge-alive-cron` }
        : {}),
    },
  };
  const cronServers: Record<string, McpServerConfig> = {
    ...mcpServers,
    "switchroom-telegram": cronTelegram,
  };

  const cronDir = join(agentDir, ".claude-cron");
  mkdirSync(cronDir, { recursive: true });
  const path = join(cronDir, ".mcp.json");
  const content = JSON.stringify({ mcpServers: cronServers }, null, 2) + "\n";
  if (!existsSync(path) || readFileSync(path, "utf-8") !== content) {
    writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
  }
  // #2307 Tier-1: seed .claude-cron/.claude.json with onboarding + trust state
  // for the FULL cron server set, or the cron `claude` wedges on the first-run
  // wizard (autoaccept-poll watches only the MAIN tmux session) and the
  // <agent>-cron bridge never registers. Idempotent; runs on both scaffold and
  // reconcile so the in-container reconcile writes the container-path project
  // key that matches the cron claude's cwd.
  seedCronConfigDir(agentDir, Object.keys(cronServers));
  return path;
}
import { resolveUsers, resolvePersonEntries } from "../config/users.js";
import { isClaudeModel } from "../../telegram-plugin/gateway/model-command.js";
import { GATEWAY_BOOT_BRIEFING_CAPABILITY } from "../../telegram-plugin/gateway/boot-briefing-capability.js";
import {
  resolveAgentConfig,
  translateHooksToClaudeShape,
  usesSwitchroomTelegramPlugin,
  deepMergeJson,
} from "../config/merge.js";
import { resolveTimezone } from "../config/timezone.js";
import { isContainerContext } from "../cli/agent-config.js";
import {
  getProfilePath,
  getBaseProfilePath,
  renderTemplate,
  copyProfileSkills,
  renderProfileClaudeTemplate,
  renderVaultProtocolFragment,
  renderAgentSelfServiceFragment,
  renderExecutionDisciplineFragment,
  renderDevProtocolFragment,
  renderDelegationGoldenRuleFragment,
  renderReplyDisciplineFragment,
} from "./profiles.js";
import {
  getHindsightSettingsEntry,
  getBuiltinDefaultMcpEntries,
  getGdriveMcpSettingsEntry,
  getMs365McpSettingsEntry,
  getNotionMcpSettingsEntry,
} from "../memory/scaffold-integration.js";
import { shouldEmitGdriveMcp } from "../config/google-workspace-acl.js";
import {
  shouldEmitMs365Mcp,
  bindingsForAgent,
  ms365McpKeyForBinding,
  microsoftAccountSlug,
  normalizeMicrosoftBindings,
} from "../config/microsoft-workspace-acl.js";
import { shouldEmitNotionMcp } from "../config/notion-workspace-acl.js";
import { reconcileAgentDefaultSkills } from "./reconcile-default-skills.js";
import { applyTelegramProgressGuidance, applySubAgentLocalTimeGuidance } from "./sub-agent-telegram-prompt.js";
import type { McpServerConfig } from "../memory/hindsight.js";
import { RETAIN_TAGS_DEFAULT } from "../memory/hindsight-retain-provenance.js";
import { createBank, updateBankMissions, ensureDeclaredMentalModels, DEFAULT_RETAIN_MISSION, resolveBankMissionExtras, isHindsightEnabled, fetchBankRetainMission, decideRetainMissionUpgrade, PROFILE_MEMORY_DEFAULTS, fetchBankObservationsMission, decideObservationsMissionUpgrade, fetchBankDisposition, decideDispositionPush, fleetOnlyDispositionTraits } from "../memory/hindsight.js";
import type { BankDisposition } from "../memory/hindsight.js";
import { ensureAntiConfabulationDirective } from "../memory/hindsight-seed-directives.js";
import { loadTopicState } from "../telegram/state.js";
import { resolveDualPath } from "../config/paths.js";
import { resolvePath } from "../config/loader.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import { openVault, VaultError } from "../vault/vault.js";
import {
  findExistingClaudeJson,
  copyOnboardingState,
  preTrustWorkspace,
  ensureMcpServersTrusted,
  createMinimalClaudeConfig,
  seedCronConfigDir,
  loadUserConfig,
} from "../setup/onboarding.js";
import { HINDSIGHT_DEFAULT_MCP_URL, HINDSIGHT_DEFAULT_API_BASE_URL } from "../setup/hindsight.js";
import {
  resolveHindsightRecallTunables,
  renderHindsightHooksOverrides,
  type HindsightRecallTunables,
  type RecallTunableInput,
} from "../setup/hindsight-recall-tunables.js";
import {
  resolveHindsightRecallPassthrough,
  recallPassthroughTemplateFields,
  HINDSIGHT_RECALL_TAG_WEIGHT_SEED,
  type HindsightRecallPassthrough,
  type RecallPassthroughInput,
} from "../setup/hindsight-recall-passthrough.js";
import { ensureBareClone } from "../repos/bare-clone.js";
import {
  ensureAgentWorktree,
  agentWorktreePath,
} from "../repos/agent-worktree.js";

export interface ScaffoldResult {
  agentDir: string;
  created: string[];
  skipped: string[];
}

/**
 * Align ownership of an agent's per-agent state directories with the
 * deterministic container UID assigned by compose.ts.
 *
 * Why this is required: in Docker mode the agent container runs as
 * `user: <uid>` (a hash-derived value in 10001–10999). The container
 * bind-mounts the host's `~/.switchroom/agents/<name>` etc. into
 * `/state/agent`. If those host directories are still owned by the
 * operator (uid 1000), the container UID (10001+) cannot write to
 * them and the agent silently fails to write logs / state / Claude
 * settings on first boot. The fix is to chown the dirs once at
 * scaffold time so the bind-mount lands writable.
 *
 * Implementation note: the chown target is well outside the operator's
 * uid space, so `chownSync` typically needs CAP_CHOWN — i.e. sudo.
 * We try the unprivileged chown first (works if the agent already
 * exists from a prior run); on EPERM we shell out to `sudo chown -R`
 * which prompts the operator's password. Set `confirm` to false to
 * skip the inline prompt (apply --non-interactive path).
 *
 * Returns the list of paths chown'd. Throws only when sudo itself
 * exits non-zero — that's an operator-actionable failure (wrong
 * password, no sudoers entry).
 */
export interface AlignAgentUidOptions {
  /** Suppress the y/n prompt; assume yes. Used by `--non-interactive`. */
  confirm?: boolean;
  /** Stdout writer for status lines; defaults to console.log. */
  writeOut?: (s: string) => void;
  /** Skip the chown entirely (dry-run / tests). */
  dryRun?: boolean;
}

export function alignAgentUid(
  name: string,
  agentDir: string,
  uid: number,
  opts: AlignAgentUidOptions = {},
): { chowned: boolean; paths: string[] } {
  const writeOut = opts.writeOut ?? ((s: string) => process.stdout.write(s));

  // The agent state dir is the primary target. We also align the per-agent
  // log dir (~/.switchroom/logs/<name>) — Dockerfile.agent creates
  // /var/log/switchroom as root:root 0755, the compose volume mount
  // inherits that ownership, and start.sh's docker-mode supervisor forks
  // gateway and autoaccept-poll sidecars whose `>> /var/log/switchroom/*.log`
  // redirects fail silently as the in-container agent UID. Without the
  // log dir chowned to the agent UID, the sidecars exit immediately at
  // boot and the agent comes up without autoaccept or the gateway daemon.
  // See #880.
  const logsDir = join(homedir(), ".switchroom", "logs", name);
  // ~/.switchroom/audit/<name>/ holds the agent-config audit JSONL
  // (appendAudit in src/cli/agent-config.ts). Compose generator pre-
  // creates the dir at compose.ts:~1750; under `apply`'s sudo self-
  // elevation that mkdir runs as root → root-owned dir → agent UID
  // can't appendFileSync → every audit row silently swallowed (#1831).
  // Include here so the chown sweep aligns ownership.
  const auditDir = join(homedir(), ".switchroom", "audit", name);
  // ~/.switchroom-config/agents/<name>/personal-skills/ holds the
  // git-tracked mirror of the agent's personal-skill bundles (#1844).
  // Compose generator pre-creates the dir + bind-mounts it into the
  // container (#1846); the in-container CLI writes through the mount.
  // Without this chown, `apply`'s sudo self-elevation leaves the dir
  // root-owned and the agent UID can't write — identical failure
  // shape to the audit dir (#1831). Gated on existence so non-opted-
  // in operators don't get a phantom chown target.
  const configMirrorDir = join(
    homedir(),
    ".switchroom-config",
    "agents",
    name,
    "personal-skills",
  );
  const paths: string[] = [];
  if (existsSync(agentDir)) paths.push(agentDir);
  if (existsSync(logsDir)) paths.push(logsDir);
  if (existsSync(auditDir)) paths.push(auditDir);
  if (existsSync(configMirrorDir)) paths.push(configMirrorDir);
  if (paths.length === 0) return { chowned: false, paths: [] };

  // No fast-path: a previous `apply` may have aligned the top-level dirs
  // while leaving stale uid 1000 entries deep in the subtree (e.g. the
  // operator dropped files in via sudo, or a v0.6 → v0.7 migration
  // chowned the root but skipped a child). `chown -R` is idempotent and
  // cheap, so we always run it. Pre-`chown` we record the prior owner of
  // each top-level path to ~/.switchroom/.uid-alignment.log so rollback
  // can restore precise ownership without guessing.
  const priors: Array<{ path: string; uid: number; gid: number } | { path: string; uid: undefined; gid: undefined }> = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      priors.push({ path: p, uid: st.uid, gid: st.gid });
    } catch {
      priors.push({ path: p, uid: undefined, gid: undefined });
    }
  }

  if (opts.dryRun) return { chowned: false, paths };

  try {
    const logPath = join(homedir(), ".switchroom", ".uid-alignment.log");
    mkdirSync(join(homedir(), ".switchroom"), { recursive: true });
    const ts = new Date().toISOString();
    for (const prior of priors) {
      if (prior.uid !== undefined && prior.gid !== undefined && (prior.uid !== uid || prior.gid !== uid)) {
        appendFileSync(
          logPath,
          `${ts} ${prior.path} ${prior.uid}:${prior.gid} -> ${uid}:${uid}\n`,
        );
      }
    }
  } catch { /* best-effort audit; never block alignment */ }

  if (opts.confirm !== false && process.stdin.isTTY) {
    // Interactive prompt: explain why we're shelling sudo. We use
    // execFileSync below with stdio inherited so the password prompt
    // appears on the operator's terminal.
    writeOut(
      chalk.gray(
        `  · aligning ${name} state + log dir ownership to uid ${uid} (sudo chown)\n`,
      ),
    );
  }

  // Try unprivileged chown first; sudo only if EPERM.
  try {
    // Recursive chown via shell — node's fs.chownSync isn't recursive
    // and rolling our own walk just to fall back to sudo is wasted code.
    // `-h` (--no-dereference) is load-bearing on busybox hosts: busybox
    // chown has no -H/-L/-P and without -h it dereferences every visited
    // symlink, so a planted link inside the agent tree could re-own an
    // arbitrary host file. No-op on GNU's -R traversal (defaults to -P).
    // Same flag as agent-owned-tree.ts's chownTree — see its "Symlink
    // safety" doc for the full rationale (#3168 review F2).
    execFileSync("chown", ["-h", "-R", `${uid}:${uid}`, ...paths], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { chowned: true, paths };
  } catch {
    // chown failed — most commonly EPERM because the operator's uid
    // doesn't have CAP_CHOWN. Fall through to sudo. We don't try to
    // discriminate on errno here because execFileSync's error shape
    // is messy across node versions; the sudo path is the
    // operator-actionable fix regardless.
  }

  try {
    execFileSync("sudo", ["chown", "-h", "-R", `${uid}:${uid}`, ...paths], {
      stdio: "inherit",
    });
    return { chowned: true, paths };
  } catch {
    throw new Error(
      `alignAgentUid: sudo chown failed for ${paths.join(", ")} (target uid ${uid}). Run manually: sudo chown -h -R ${uid}:${uid} ${paths.join(" ")}`,
    );
  }
}

/**
 * Placeholder written to `telegram/.env` when this agent's bot token cannot
 * be resolved at scaffold time (e.g. an as-yet-ungranted `vault:` reference).
 * Deliberately carries NO active `TELEGRAM_BOT_TOKEN=` assignment — only the
 * commented hint — so `isTelegramEnvPlaceholder` can tell it apart from a real
 * operator-set token and `refreshTelegramBotTokenEnv` may safely overwrite it
 * once a later reconcile resolves the vault grant.
 */
const TELEGRAM_ENV_PLACEHOLDER = `# Set your bot token: TELEGRAM_BOT_TOKEN=your-token-here\n`;

/**
 * True when a `telegram/.env` body still holds only the placeholder — i.e. it
 * has no active (uncommented, non-empty) `TELEGRAM_BOT_TOKEN=` line. A real
 * operator- or vault-set token has such a line and must never be clobbered.
 * The optional `export ` prefix is tolerated so a hand-edited
 * `export TELEGRAM_BOT_TOKEN=<real>` is never mistaken for the placeholder
 * and overwritten.
 */
function isTelegramEnvPlaceholder(content: string): boolean {
  return !/^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN=\S/m.test(content);
}

/**
 * Resolve a bot token value. If it's a vault reference, resolve it ONLY via
 * the vault (SWITCHROOM_VAULT_PASSPHRASE). Returns the resolved token, or
 * undefined if it cannot be resolved for THIS agent.
 *
 * IMPORTANT — no ambient env fallback for vault references (M2, review
 * 2026-07-11): a `vault:` bot-token that can't be resolved must NOT fall back
 * to `$TELEGRAM_BOT_TOKEN`. On a multi-agent `apply` that ambient value is
 * whatever the outer process exported — commonly a DIFFERENT agent's token —
 * so falling back silently wrote agent B's bot token into agent A's
 * `telegram/.env`. When resolution fails we return undefined; callers write
 * the placeholder (see TELEGRAM_ENV_PLACEHOLDER) and a later reconcile picks
 * up the real token once the vault grant lands. The vault is the sole source
 * of truth for a vault-referenced token — never a cross-agent env var.
 */
function resolveBotToken(rawToken: string): string | undefined {
  if (!isVaultReference(rawToken)) {
    return rawToken;
  }

  // Try vault resolution via passphrase. Static imports here (rather than
  // lazy require) so import-time errors surface loudly instead of falling
  // back silently to env vars and masking a real config problem.
  const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (passphrase) {
    try {
      const vaultPath = resolvePath(process.env.SWITCHROOM_VAULT_PATH ?? "~/.switchroom/vault.enc");
      const secrets = openVault(passphrase, vaultPath);
      const key = parseVaultReference(rawToken);
      const entry = secrets[key];
      if (entry && entry.kind === "string") {
        return entry.value;
      }
    } catch (err) {
      // Known "vault missing / wrong passphrase" outcomes are expected when
      // callers haven't set one up — treat the token as unresolvable and let
      // the caller write the placeholder. Any other error is a real problem
      // and should bubble up so the user sees it.
      if (!(err instanceof VaultError)) throw err;
    }
  }

  // Unresolvable for THIS agent. Return undefined — do NOT fall back to
  // $TELEGRAM_BOT_TOKEN (may belong to another agent on a multi-agent apply).
  return undefined;
}

/**
 * Refresh an agent's `telegram/.env` when it still holds the placeholder and a
 * real bot token is now resolvable (M3, review 2026-07-11). Runs on the
 * reconcile/apply path so a `vault:` bot-token that was ungranted at first
 * scaffold — and therefore wrote the placeholder — is picked up once the grant
 * lands, without a rescaffold. Deterministic and safe:
 *
 *   - No-op when the token still can't be resolved (a later grant re-triggers).
 *   - No-op when the `.env` is absent (scaffold owns first creation).
 *   - Overwrites ONLY when the current body is still the placeholder
 *     (`isTelegramEnvPlaceholder`) — a real operator-set token is never
 *     clobbered.
 */
function refreshTelegramBotTokenEnv(
  agentDir: string,
  resolvedBotToken: string | undefined,
  changes: string[],
): void {
  if (!resolvedBotToken) return;
  const envPath = join(agentDir, "telegram", ".env");
  if (!existsSync(envPath)) return;
  const current = readFileSync(envPath, "utf-8");
  if (!isTelegramEnvPlaceholder(current)) return;
  const next = `TELEGRAM_BOT_TOKEN=${resolvedBotToken}\n`;
  if (next === current) return;
  writeFileSync(envPath, next, { encoding: "utf-8", mode: 0o600 });
  changes.push(envPath);
}

/**
 * Strip any `telegram@claude-plugins-official` entry from an
 * installed_plugins.json payload. Exported for unit testing.
 *
 * Background: Claude Code auto-installs the official Telegram plugin
 * from the marketplace whenever it's available. For switchroom agents
 * that use the switchroom-telegram fork (the default), having both
 * plugins alive polls the same bot token from two processes, so
 * Telegram returns "Conflict: terminated by other getUpdates" and
 * every inbound message is missed. Scrubbing the copied inventory
 * keeps the fork as the sole Telegram owner for this agent.
 *
 * Users who opted into the official plugin (`channels.telegram.plugin:
 * official`) keep the entry — this only runs when useSwitchroomPlugin
 * is true.
 */
export function stripOfficialTelegramPlugin(payload: string): string {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return payload; // malformed — don't touch it
  }
  if (!data || typeof data !== "object") return payload;
  const obj = data as Record<string, unknown>;
  const plugins = obj.plugins;
  if (!plugins || typeof plugins !== "object") return payload;
  const pluginsObj = plugins as Record<string, unknown>;
  if (!("telegram@claude-plugins-official" in pluginsObj)) return payload;
  delete pluginsObj["telegram@claude-plugins-official"];
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Set up plugin symlinks and config files in the agent's CLAUDE_CONFIG_DIR.
 *
 * Symlinks the official Telegram plugin marketplace from the user's global
 * ~/.claude/plugins/ and copies plugin config files if they exist. When
 * `useSwitchroomPlugin` is true, the copied installed_plugins.json is
 * scrubbed of the official Telegram plugin so it doesn't race the
 * switchroom fork for the same bot token.
 */
export function setupPlugins(agentDir: string, useSwitchroomPlugin = false): void {
  const home = process.env.HOME ?? "/root";
  const globalPluginsDir = join(home, ".claude", "plugins");
  const agentPluginsDir = join(agentDir, ".claude", "plugins");
  const agentMarketplacesDir = join(agentPluginsDir, "marketplaces");

  // Create plugin directories
  mkdirSync(agentMarketplacesDir, { recursive: true });

  // Symlink the official marketplace
  const globalMarketplace = join(globalPluginsDir, "marketplaces", "claude-plugins-official");
  const agentMarketplace = join(agentMarketplacesDir, "claude-plugins-official");

  if (existsSync(globalMarketplace) && !existsSync(agentMarketplace)) {
    try {
      symlinkSync(globalMarketplace, agentMarketplace);
    } catch { /* symlink may fail if target doesn't exist */ }
  }

  // Copy plugin config files if they exist
  const configFiles = ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"];
  for (const file of configFiles) {
    const globalFile = join(globalPluginsDir, file);
    const agentFile = join(agentPluginsDir, file);
    if (existsSync(globalFile) && !existsSync(agentFile)) {
      try {
        if (useSwitchroomPlugin && file === "installed_plugins.json") {
          const scrubbed = stripOfficialTelegramPlugin(readFileSync(globalFile, "utf8"));
          writeFileSync(agentFile, scrubbed);
        } else {
          copyFileSync(globalFile, agentFile);
        }
      } catch { /* ignore copy failures */ }
    }
  }
}

/**
 * Pre-approved MCP tool names for the switchroom enhanced Telegram plugin.
 * When channels.telegram.plugin is "switchroom" we pre-approve these so the agent
 * never has to prompt for MCP tool permissions.
 */
const SWITCHROOM_TELEGRAM_MCP_TOOLS = [
  "mcp__switchroom-telegram",
  "mcp__switchroom-telegram__reply",
  "mcp__switchroom-telegram__react",
  "mcp__switchroom-telegram__edit_message",
  "mcp__switchroom-telegram__send_typing",
  "mcp__switchroom-telegram__pin_message",
  "mcp__switchroom-telegram__delete_message",
  "mcp__switchroom-telegram__forward_message",
  "mcp__switchroom-telegram__download_attachment",
  "mcp__switchroom-telegram__get_recent_messages",
  "mcp__switchroom-telegram__progress_update",
  // Native Telegram checklists (#272). The plugin registers both
  // send_checklist and update_checklist (telegram-plugin/bridge/bridge.ts);
  // they were missing here, so the first checklist call wedged on a
  // per-call permission prompt. Same drift class as the progress_update
  // omission the parity test below guards against.
  "mcp__switchroom-telegram__send_checklist",
  "mcp__switchroom-telegram__update_checklist",
];

/**
 * Mental-model WRITE tools on the Hindsight server that are deliberately
 * NOT pre-approved. These mutate engine-tier mental models, and the
 * agent-proposes / human-approves gate (the `mental_model_propose` card,
 * see reference/rfcs/hindsight-phase5-mental-model-curation.md) is the
 * only sanctioned path to them. Pre-approving them (e.g. via a
 * `mcp__hindsight__*` wildcard) silently bypasses that gate — the very
 * regression this list guards against. Leaving them off the allow-list
 * means a direct agent call falls through to the normal permission
 * prompt instead of the propose card, which is acceptable (the curator
 * skill is instructed to always propose, never call these directly).
 */
export const HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS = [
  "mcp__hindsight__create_mental_model",
  "mcp__hindsight__update_mental_model",
  "mcp__hindsight__delete_mental_model",
  "mcp__hindsight__refresh_mental_model",
];

/**
 * Pre-approved MCP tool names for the Hindsight memory server.
 *
 * This is an ENUMERATED allow-list, deliberately NOT a `mcp__hindsight__*`
 * wildcard and NOT a bare `mcp__hindsight` server grant (either of which
 * would pre-approve every tool on the server). It enumerates the
 * read / retain / reflect / directive tools the agent uses autonomously,
 * and OMITS the mental-model write tools in
 * `HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS`, which must go through the
 * agent-proposes / human-approves propose card instead (Fix 1.2, #2903).
 *
 * When adding a hindsight tool to the surface, add it here explicitly —
 * a wildcard is banned so the next mental-model-write addition can't
 * silently ride in ungated. The permission surface is pinned by
 * tests/agents/hindsight-permission-surface.test.ts against
 * tests/fixtures/hindsight-tools-list.snapshot.json.
 */
export const HINDSIGHT_MCP_TOOLS = [
  // Retain / reflect / recall — the day-to-day store + query surface.
  "mcp__hindsight__recall",
  "mcp__hindsight__retain",
  "mcp__hindsight__sync_retain",
  "mcp__hindsight__reflect",
  // Directives — create_directive is captured autonomously (the #2848
  // directive-capture nudge: recall.py regex-detects correction-shaped
  // inbound and nudges the model to persist it with create_directive).
  "mcp__hindsight__create_directive",
  "mcp__hindsight__update_bank",
  "mcp__hindsight__list_directives",
  // Retirement. These two are SHIM-SYNTHESIZED (src/cli/hindsight-mcp-shim.ts,
  // SYNTHESIZED_TOOL_TABLE), not backend tools — hindsight's MCP surface has no
  // directive-update tool at all, so they are answered locally over REST with
  // the bank pinned to HINDSIGHT_BANK_ID and a PATCH body whitelisted to
  // is_active + provenance tags. Rationale for pre-approving them is with the
  // #2911 note below.
  "mcp__hindsight__deactivate_directive",
  "mcp__hindsight__reactivate_directive",
  // Banks.
  "mcp__hindsight__create_bank",
  "mcp__hindsight__get_bank",
  "mcp__hindsight__get_bank_stats",
  "mcp__hindsight__list_banks",
  // Memories.
  "mcp__hindsight__get_memory",
  "mcp__hindsight__list_memories",
  // Reversible memory writes — pre-approved. Both are SHIM-SYNTHESIZED
  // (src/cli/hindsight-mcp-shim.ts) and REVERSIBLE, which is why they ride
  // with the read/retain surface rather than behind a per-call card:
  //   • invalidate_memory — soft-retire (is_active:false). It has a `restore`
  //     path that reactivates the exact memory (shim SYNTHESIZED_TOOL_TABLE,
  //     `restore` arg), so nothing is destroyed.
  //   • update_memory — edits an existing memory's fields in place.
  // The agent uses these autonomously for user corrections / "actually it's X"
  // amendments (an automated-flow dependency, same shape as delete_document
  // above), and every uncurated call otherwise raises a fresh Telegram
  // permission card — a flood on high-frequency correction workloads. The
  // PERMANENTLY-destructive memory tool, clear_memories, stays gated below.
  "mcp__hindsight__invalidate_memory",
  "mcp__hindsight__update_memory",
  // Documents.
  "mcp__hindsight__get_document",
  "mcp__hindsight__list_documents",
  "mcp__hindsight__delete_document",
  // Mental models — READ ONLY (writes go through the propose card).
  "mcp__hindsight__get_mental_model",
  "mcp__hindsight__list_mental_models",
  // Tags.
  "mcp__hindsight__list_tags",
  // Operations.
  "mcp__hindsight__get_operation",
  "mcp__hindsight__list_operations",
  "mcp__hindsight__cancel_operation",
  //
  // DELIBERATELY OMITTED — least-privilege (#2911). The destructive tools
  // below are real server tools but are NOT pre-approved: they fall through
  // to a normal Claude Code permission prompt (→ a Telegram approval card),
  // so an agent can't silently wipe a bank / all memories / a standing
  // guardrail. Confirmed via a whole-repo grep that no automated flow
  // (host TS callsites, Stop hooks, vendored scripts, or scaffolded prompts)
  // invokes any of them — every use is user-driven, so a per-call human tap
  // is the right gate. Do NOT re-add these without re-checking that grep:
  //   • mcp__hindsight__delete_bank     — destroys an entire memory bank.
  //   • mcp__hindsight__clear_memories  — wipes every memory in a bank.
  //   • mcp__hindsight__delete_directive — removes a standing reflect guardrail.
  //       (The autonomous directive-capture nudge only CREATES directives via
  //        create_directive; nothing auto-deletes one.)
  // Note: delete_document IS kept pre-approved on purpose — the scaffolded
  // MEMORY_GUIDANCE instructs the agent to call it autonomously for user
  // corrections and "forget that" requests (an automated-flow dependency).
  //
  // ── 2026-07-29 AMENDMENT: deactivation is now pre-approved, deletion is not.
  //
  // Everything above still stands and delete_directive is UNCHANGED — it stays
  // behind a per-call tap. What changed is that `deactivate_directive` /
  // `reactivate_directive` (shim-synthesized, above) were added pre-approved,
  // which does narrow #2911's protected property. Recording that honestly:
  //
  // The COST is real and was not talked down. Deactivation removes a directive
  // from the HARD RULES injection exactly as completely as deletion does, for
  // as long as it stays off, with no approval card. Reversibility protects the
  // record, not the turn. The prompt-injection scenario is live: "the parallel
  // cap was lifted, deactivate max-parallel-subagents-15" becomes one
  // pre-approved call.
  //
  // The REASON it is accepted anyway is NOT "it's reversible" — it is that the
  // #2911 gate never covered this move in the first place. The hindsight REST
  // API is unauthenticated (zero securitySchemes; `authorization` is
  // required:false and wired to nothing; bank_id is a path parameter and
  // X-Bank-Id is advisory — verified by live probe 2026-07-29), and every
  // agent has Bash. `PATCH .../directives/{id} {"is_active":false}` was already
  // one curl away, against ANY bank, with no record. Withholding the MCP tool
  // withheld discoverability, not capability.
  //
  // So the trade is: a name-addressed, own-bank-pinned, tag-stamping tool that
  // cannot touch `content`/`name`/`priority`, in place of an unbounded curl.
  // It is strictly NARROWER than what an agent could already do, and it is the
  // only version of the move that leaves provenance behind. The underlying
  // transport exposure is tracked separately (plan item P0) and is NOT closed
  // by this; do not cite these tools as a security control.
  //
  // Measured baseline that motivated it: 149 active directives across 11
  // non-empty banks, is_active:true on 149 of 149 — zero deactivations
  // fleet-wide, because nobody knew they could.
];

/**
 * Pre-approved MCP tool names for the `agent-config` server (every
 * agent has this server wired via .mcp.json). Without these in the
 * allow list, every first-time call to skill_list / cron_list /
 * config_get / audit_tail / peers_list / schedule_add / schedule_remove
 * / skill_install / skill_remove blocks on a Claude Code permission
 * prompt that the operator has to approve via Telegram. The first
 * inbound that needs one of these tools wedges the agent — the very
 * regression that surfaced in the UAT for PR #1215 (skill_list
 * permission popup screenshot). Wildcard covers future additions to
 * the same server without another scaffold bump.
 */
const AGENT_CONFIG_MCP_TOOLS = [
  "mcp__agent-config",
  "mcp__agent-config__*",
];

/**
 * Pre-approved hostd MCP tool names. ONLY the pure read-only verb
 * (`update_check` — a `switchroom update --check` dry-run, no side
 * effects) is pre-approved; pre-approving it just avoids a first-use
 * permission wedge on a harmless query.
 *
 * The mutating / host-control verbs the hostd MCP server also exposes
 * — `update_apply`, `agent_exec`, `agent_restart`, `agent_start`,
 * `agent_stop`, `agent_logs` — are deliberately ABSENT from this list
 * and the old blanket `mcp__hostd` / `mcp__hostd__*` wildcard is gone.
 * A prompt-injected admin agent invoking one of them now hits the
 * Telegram approval card (human-in-the-loop) instead of executing
 * silently. That is the fix for apex-chain link 1 of #1400: the
 * daemon-side checkGate still authorizes, but it is no longer the
 * ONLY thing between an injected agent and a host-root-equivalent
 * `update_apply`/`agent_exec`. Operator-initiated `/restart`,
 * `/update apply`, etc. are unaffected — those dispatch through the
 * gateway's direct hostd UDS path, not the agent's MCP tool surface.
 *
 * See reference/rfcs/host-control-daemon.md §5.4 and the
 * project_hostd_admin_privilege_human_approval design call: autonomous
 * only for self + read-only; mutating / host verbs gated by approval.
 * Existing fleet agents that already baked in the wildcard are
 * converged by the LEGACY_HOSTD_BLANKET_TOKENS retraction on reconcile.
 */
const HOSTD_MCP_TOOLS = [
  "mcp__hostd__update_check",
];

/**
 * Pre-approved MCP tool names for the fleet-default `webkite` server
 * (wired by resolveWebkiteMcpEntry unless the agent opts out). Without
 * these in the allow list, the FIRST time the model reaches for any
 * webkite_* tool — i.e. the first "read this URL for me" — Claude Code
 * blocks on a permission prompt the operator must approve via Telegram,
 * wedging the turn. Since webkite REPLACES native WebFetch/WebSearch
 * (those are denied), that first web fetch is guaranteed and common, so
 * an un-approved webkite is effectively a broken web-fetch capability.
 * Wildcard covers all 13 webkite tools (read/search/extract/crawl/map/
 * clip/session/diagnose/…) and any future additions without a re-bump.
 * Same shape + rationale as AGENT_CONFIG_MCP_TOOLS above.
 */
const WEBKITE_MCP_TOOLS = [
  "mcp__webkite",
  "mcp__webkite__*",
];

/**
 * Pre-approved MCP tool names for the fleet-default `context7` server
 * (wired by resolveContext7McpEntry unless the agent opts out).
 * LIBRARY_DOCS_GUIDANCE instructs every agent to reach for context7
 * before answering a library-API question, so the FIRST such question
 * would wedge the turn on a Telegram permission prompt if these
 * weren't pre-approved — i.e. the guidance would train agents that the
 * tool is annoying rather than useful.
 *
 * ENUMERATED, deliberately NOT wildcarded like WEBKITE_MCP_TOOLS. The
 * difference is who controls the tool namespace. webkite is a binary
 * the operator builds and mounts, so `mcp__webkite__*` can only grow
 * when the operator makes it grow. context7's tool surface is defined
 * by a remote endpoint a third party (Upstash) controls: a
 * `mcp__context7__*` grant would silently pre-approve whatever verb
 * they ship next — on every fleet agent, with no approval card and no
 * change on our side. Enumeration pins the grant to the two read-only
 * lookups that exist today (verified against the live server's
 * `tools/list` on 2026-07-26: exactly `resolve-library-id` and
 * `query-docs`), so a third tool costs the operator one approval tap
 * — the correct default for a surface we don't control.
 *
 * Narrowing precedent: HOSTD_MCP_TOOLS above. Like that set, there is
 * deliberately NO bare `mcp__context7` token — the bare server token
 * approves the whole server and would defeat the enumeration.
 */
const CONTEXT7_MCP_TOOLS = [
  "mcp__context7__resolve-library-id",
  "mcp__context7__query-docs",
];

/**
 * Blanket `context7` grants retracted from an existing agent's
 * `settings.permissions.allow` when that agent opts out. Not a
 * released shape — the wildcard never shipped in a tagged release —
 * but an agent scaffolded from an in-development build of the
 * context7 branch can hold it, and an opt-out must not leave a
 * server-wide pre-approval behind. See the merge-path retraction in
 * scaffoldAgent.
 */
const CONTEXT7_BLANKET_TOKENS = ["mcp__context7", "mcp__context7__*"];

/**
 * Legacy `mcp__switchroom__*` permission tokens that pre-#235 agents have
 * baked into their `settings.permissions.allow`. The switchroom-mcp server
 * is deprecated (#235) — its 4 tools were dormant (zero callers) and the
 * functionality is covered natively by Hindsight's MCP (`mcp__hindsight__*`)
 * + Claude Code's built-in `Read`/`Grep`/`Edit`. Reconcile actively strips
 * these so existing agents don't keep stale entries forever.
 */
const LEGACY_SWITCHROOM_MCP_TOKENS = ["mcp__switchroom", "mcp__switchroom__*"];

/**
 * The pre-#1400 blanket hostd grant. Earlier scaffolds pre-approved
 * `mcp__hostd` + `mcp__hostd__*` unconditionally, so a prompt-injected
 * admin agent could invoke the mutating host-control verbs
 * (`update_apply` / `agent_exec` / `agent_restart` / …) with NO
 * Telegram approval prompt — apex-chain link 1 of #1400. Reconcile
 * actively strips these tokens so existing fleet agents converge on
 * the narrowed read-only-only HOSTD_MCP_TOOLS set and the mutating
 * verbs fall through to the human approval card. Mirrors the
 * LEGACY_SWITCHROOM_MCP_TOKENS retraction pattern.
 */
const LEGACY_HOSTD_BLANKET_TOKENS = ["mcp__hostd", "mcp__hostd__*"];

/**
 * Built-in tools that are safe to pre-approve for every agent, regardless
 * of dangerous_mode. Discovering files, searching content, and reading back
 * data don't mutate host state, so gating them just adds latency for no
 * safety benefit.
 *
 * `Bash` is included deliberately. An ordinary fleet agent runs in its own
 * Docker container (one per agent), so the blast radius of a shell command
 * is that agent's sandbox — the same isolation boundary that already makes
 * Read/Grep/Glob safe. Gating Bash bought no real containment (the agent
 * could already script the host it can't reach via other pre-approved
 * tools); it only stormed the operator with an approval card on the first,
 * routine shell call of nearly every task. Bash STAYS operator-controllable:
 * an agent that should be kept shell-free sets `tools.deny: ["Bash"]`
 * (deny wins in Claude Code), and adding it here — rather than as an
 * unconditional spread in computeDesiredPermissionAllow — means it is only
 * seeded for default agents and never becomes an always-on grant that only
 * tools.deny could remove. (Root-tier agents whose Bash reaches the host run
 * with tools.allow: [all] already, so this default-set change adds them no
 * new exposure; their coverage is the deliberate root-debug tier, not
 * container isolation.)
 *
 * Edit and Write are NOT here — they remain covered by the `acceptEdits`
 * defaultMode gate. WebFetch/WebSearch/NotebookEdit and anything that
 * reaches the network stay off this list too and go through the standard
 * permission prompt, which in switchroom becomes the Telegram inline-button
 * approval flow via the plugin's permission_request notification handler.
 *
 * Used when the agent's tools.allow is empty AND dangerous_mode is
 * off/unset — otherwise explicit user config wins.
 */
const DEFAULT_READ_ONLY_PREAPPROVED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "LS",
  "Task",
  "TodoWrite",
  "ExitPlanMode",
  // Safe because ordinary agents are per-container isolated — see the
  // block comment above for the full rationale and the tools.deny lever.
  "Bash",
  // Skill itself just loads instruction context — the side-effecting
  // tools the skill body invokes (Bash, Write, etc) retain their own
  // approval gates. Pre-approving Skill lets routine "/loop", "/init",
  // and the bundled-skill invocations land without a prompt, which
  // matters for the skill-coverage UAT runner (every probe would
  // otherwise stall on an approval).
  "Skill",
];

/**
 * Fleet-baseline deny list seeded into every agent's settings.json
 * `permissions.deny` unless the agent has opted out of webkite. The
 * model still has full web-fetch capability — via the webkite_*
 * MCP tools — but the native WebFetch / WebSearch tools are off so
 * the model reaches for webkite by default. Webkite is operator-
 * mounted (private beta binary) and pre-credentialed via the vault-
 * broker; the model doesn't need to know about any of that.
 *
 * Opt-out: per-agent `mcp_servers.webkite: false` skips the deny too
 * — the agent gets native WebFetch back. (Documented behavior — if
 * you turn off webkite, you keep WebFetch.)
 */
const WEBKITE_FLEET_DENY_TOOLS = ["WebFetch", "WebSearch"];

/**
 * Fleet-baseline deny for blocking interactive TUI tools.
 *
 * `AskUserQuestion` renders a *blocking* full-screen multiple-choice
 * selector inside claude's TUI ("❯ 1. … · Enter to select · ↑/↓ to
 * navigate · Esc to cancel"). Every switchroom agent is driven from
 * Telegram with no human at the terminal, so that selector blocks
 * forever — claude waits on a keystroke that never comes, the turn
 * never completes, and queued inbounds pile up behind it until the
 * agent looks mute (real incident: klanker wedged this way 2026-06-01,
 * recovered only by a manual tmux `Esc`).
 *
 * Denying the tool is the root-cause fix, not a workaround: a denied
 * `AskUserQuestion` does NOT crash the turn — claude degrades gracefully
 * and asks the same question as plain text, which is exactly what we
 * want (the question reaches the operator over Telegram instead of
 * stalling at an invisible TUI).
 *
 * Unconditional (no per-agent opt-out knob): there is no fleet scenario
 * where a headless, Telegram-driven agent benefits from a blocking
 * terminal selector. A power-user who genuinely needs it can still
 * re-enable via the `settings_raw` deep-merge escape hatch.
 */
const INTERACTIVE_TUI_FLEET_DENY_TOOLS = ["AskUserQuestion"];

/**
 * In-container PATH location of the operator-mounted webkite binary
 * (compose.ts mounts `~/.switchroom/bin/webkite` here). Host-side
 * staging path is `~/.switchroom/bin/webkite`.
 */
const WEBKITE_BINARY_CONTAINER_PATH = "/usr/local/bin/webkite";

/**
 * Fail-safe gate for the WebFetch/WebSearch deny: only strip the
 * native tools when a webkite binary is actually staged, so a
 * degraded install (binary missing, glibc-incompatible build pulled,
 * operator hasn't run the one-time setup yet) keeps native WebFetch
 * as a safety net instead of going dark on web access entirely.
 *
 * Checks BOTH contexts scaffold/reconcile can run in:
 *   - host apply  → `~/.switchroom/bin/webkite` (operator staging path)
 *   - in-container reconcile → `/usr/local/bin/webkite` (compose mount)
 *
 * This is deliberately a presence check, not a runnability check — we
 * can't exec the binary at scaffold time across both contexts. A
 * present-but-broken binary still trips the deny; the doctor probe
 * (follow-up) is where runnability gets surfaced. Presence alone
 * closes the dominant failure mode: operator simply hasn't staged it.
 *
 * `SWITCHROOM_WEBKITE_BINARY` env overrides the probe path entirely —
 * a real operator knob for a non-standard webkite location, and the
 * deterministic seam tests use (point it at a tmp file to simulate
 * "staged", at a bogus path to simulate "absent").
 */
function webkiteBinaryAvailable(): boolean {
  const override = process.env.SWITCHROOM_WEBKITE_BINARY;
  if (override !== undefined && override !== "") {
    return existsSync(override);
  }
  return (
    existsSync(join(homedir(), ".switchroom", "bin", "webkite")) ||
    existsSync(WEBKITE_BINARY_CONTAINER_PATH)
  );
}

/**
 * Resolve the effective WebFetch/WebSearch deny for an agent.
 * Applied only when webkite is BOTH not-opted-out AND actually
 * staged (the fail-safe gate above).
 */
function webkiteDenyForAgent(agentConfig: AgentConfig): string[] {
  if (agentConfig.mcp_servers?.["webkite"] === false) return [];
  if (!webkiteBinaryAvailable()) return [];
  return WEBKITE_FLEET_DENY_TOOLS;
}

/**
 * Switchroom-shipped default model + thinking effort for main agents.
 *
 * Sonnet 5 + effort=low is the right starting point for the
 * conversational main-agent role:
 *   - Time-to-first-token is ~3–5s vs Opus's 15–30s on chat replies.
 *     Forensics on a real klanker turn (2026-04-30 11:59:30Z) showed
 *     19s of Opus extended-thinking dominating a 25s turn — most of
 *     that thinking is wasted on chat-mode answers.
 *   - Sonnet 5 input cost is ~5x lower; effort=low cuts hidden
 *     thinking tokens to near-zero.
 *   - Accuracy on chat / lookup / structured replies is ~95% of Opus.
 *     The accuracy gap opens up on hard reasoning, code, research
 *     synthesis — exactly the workloads CLAUDE.md tells the main agent
 *     to delegate to sub-agents (worker / researcher / reviewer).
 *
 * Operators override per-agent or in `defaults.model` / `defaults.thinking_effort`
 * in switchroom.yaml when an agent's role demands more reasoning at the
 * main-session level (rare).
 *
 * Sub-agents are NOT affected by these constants — sub-agent models are
 * resolved separately from `SubagentSchema.model` (default falls back to
 * "claude-sonnet-5" when a sub-agent doesn't specify, see line ~1778
 * in this file). Sub-agents that want Opus reasoning should set
 * `model: opus` explicitly.
 */
export const SWITCHROOM_DEFAULT_MAIN_MODEL = "claude-sonnet-5";
export const SWITCHROOM_DEFAULT_THINKING_EFFORT = "low";

/**
 * Resolve a config `model:` value for the agent's claude launch.
 *
 * Footgun guard: a bare `model: default` is NOT "use the switchroom default" —
 * claude passes the literal string through, and Anthropic resolves it to the
 * *account's* default model (e.g. claude-fable-5). If the account has no access
 * to that model, EVERY turn 4xx's ("model may not exist or you may not have
 * access"). That bit test-harness on 2026-06-13. We remap the `default` alias
 * (and unset) to switchroom's known-good default so a config `model:` can never
 * resolve to an inaccessible account-default. Any explicit real model id or
 * other alias (opus/sonnet/haiku/full id) passes through unchanged — operators
 * who want a specific model still get it.
 */
export function resolveMainModel(model: string | undefined): string {
  if (model === undefined || model === "default") return SWITCHROOM_DEFAULT_MAIN_MODEL;
  return normalizeModelAlias(model);
}

/**
 * Declared routing INTENT for a resolved main model — the mode start.sh will
 * actually LAND on after its repoint case, NOT the raw compose `isClaudeModel`
 * env split. start.sh (profiles/_base/start.sh.hbs) repoints
 * `sr-*|fable|claude-fable-5` onto the LiteLLM model-router ROOT whenever the
 * proxy is live/unreachable-with-key, so a healthy configured-fable boot lands
 * on `router-root` even though compose baked its ANTHROPIC_BASE_URL on the
 * `/anthropic` passthrough (fable is a Claude model). Only NON-fable Claude
 * models (opus/sonnet/haiku/default) keep the passthrough. Non-Claude models
 * (sr-*) have no `.session-model-override` carrier and route via the root too.
 *
 * `.routing-mode` compares the LANDED mode against this DECLARED value, so it
 * must encode the post-repoint intent — otherwise a healthy fable boot fires a
 * spurious "Routing divergence" alert and a permanent 🟡 boot-card row.
 * Mirror the repoint `case` set exactly.
 */
export function declaredRoutingMode(resolvedModel: string): "passthrough" | "router-root" {
  if (
    resolvedModel === "fable" ||
    resolvedModel === "claude-fable-5" ||
    resolvedModel.startsWith("sr-")
  ) {
    return "router-root";
  }
  return isClaudeModel(resolvedModel) ? "passthrough" : "router-root";
}

/**
 * Prefer the `fable` alias over the retired `claude-fable-5` codename in
 * anything we launch or persist. The codename 4xxs direct-to-Anthropic and
 * only resolves via the LiteLLM router; the alias resolves everywhere the
 * model is reachable at all (the claude CLI maps it via
 * ANTHROPIC_DEFAULT_FABLE_MODEL), so it is the only safe spelling to write.
 *
 * Beyond the fable codename we then run the config-default token through the
 * SAME `expandModelAlias` the gateway `/model` path uses (#3998): a switchroom
 * shortcut like `opus48` / `opus-4-8` expands to its pinned `claude-*` id, an
 * sr-* shortcut (`flash`, `codex`, …) to its full `sr-*` id, and any `claude-*`
 * id is case-canonicalized — so an operator-configured `model:` resolves to the
 * exact same launch token as typing that alias into `/model`. Before this both
 * sites carried divergent tables: scaffold expanded ONLY the fable codename, so
 * a config `model: opus48` reached `claude --model` verbatim and 4xx'd. Family
 * aliases the CLI resolves itself (`opus`/`sonnet`/`haiku`/`fable`/`default`)
 * are in neither shortcut table and pass through unchanged, as before.
 */
export function normalizeModelAlias(model: string): string {
  if (model === "claude-fable-5") return "fable";
  return expandModelAlias(model);
}

/**
 * Built-in Claude Code tools. When `tools.allow: [all]` is set in
 * switchroom.yaml, every one of these is pre-approved so the agent never
 * blocks on a permission prompt at runtime.
 *
 * Claude Code does NOT accept a literal "all" or "*" in permissions.allow,
 * which is why we have to enumerate. defaultMode: acceptEdits is also set
 * as a backstop, but it only auto-accepts file edits — Bash/Read/Write/
 * WebFetch all still prompt unless explicitly listed.
 */
/** Stable de-duplication preserving first-seen order. */
function dedupe<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * POSIX-safe single-quote wrapping for embedding a user-supplied string
 * in a generated shell script. Every embedded single-quote is replaced
 * with the `'"'"'` sequence, which closes the current single-quoted
 * literal, emits a double-quoted single quote, and reopens a new
 * single-quoted literal. Works with arbitrary bytes including
 * newlines, backticks, and dollar signs — the shell never interprets
 * the content.
 */
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * The real host home for values BAKED into generated artifacts (start.sh's
 * `cd "{{agentDir}}"`, the `$HOME/.switchroom` symlink target, …).
 *
 * `homedir()` / `$HOME` is the right answer when `switchroom apply` runs on
 * the host. But hostd shells out `switchroom apply` from INSIDE its container
 * (the `config_propose_edit` reconcile path), where `$HOME` is `/host-home`
 * (the in-container mount point of the operator's home — a bind, not a host
 * filesystem path). Baking `/host-home/...` into an agent's start.sh is fatal:
 * the agent containers mount `~/.switchroom` at its REAL host path (same path
 * in/out, `network_mode: host`) and have NO `/host-home` mount, so every
 * `cd "{{agentDir}}"` / `--plugin-dir {{agentDir}}/...` / `$HOME/.switchroom`
 * symlink dangles and claude falls to the login screen (2026-06-14 carrie/
 * fleet-wide scaffold poison).
 *
 * Filesystem WRITES during apply must still use `$HOME` (`/host-home`, which
 * bind-resolves to the real dir) — only BAKED values are translated. This
 * mirrors `write-compose.ts` (`homeDir: SWITCHROOM_HOST_HOME || homedir()`),
 * which already protects the compose bind SOURCES the same way; the scaffold
 * path was the unprotected sibling.
 *
 * `SWITCHROOM_HOST_HOME` is the generator's authoritative host home, baked
 * into the hostd container env by `compose.ts`. On the host it is unset (or
 * equals `$HOME`), so this is a no-op there. Returns `undefined` only when
 * BOTH are unset (test / non-host context) — the template's
 * `{{#if hostHomeQ}}` guard then renders the symlink block as a no-op, exactly
 * as the pre-fix `process.env.HOME ? … : undefined` did.
 */
function hostHomeForBake(): string | undefined {
  return process.env.SWITCHROOM_HOST_HOME || process.env.HOME || undefined;
}

/** Shell-quoted host home for baking into start.sh, or undefined when unset. */
function hostHomeQForBake(): string | undefined {
  const h = hostHomeForBake();
  return h ? shellSingleQuote(h) : undefined;
}

/**
 * Translate a path rooted at the in-container home (`$HOME`, e.g.
 * `/host-home/.switchroom/agents/foo`) to the real host home
 * (`SWITCHROOM_HOST_HOME`, e.g. `/home/op/.switchroom/agents/foo`) so it is
 * safe to BAKE into an agent artifact. No-op when:
 *   - running on the host (`SWITCHROOM_HOST_HOME` unset or == `$HOME`), or
 *   - the path is not under `$HOME` (e.g. `/state/config/...`,
 *     `/opt/switchroom/...`) — those are already container-correct.
 * See {@link hostHomeForBake} for why this exists.
 */
export function toHostHomePath(p: string): string {
  const hostHome = process.env.SWITCHROOM_HOST_HOME;
  const containerHome = process.env.HOME;
  if (
    hostHome &&
    containerHome &&
    hostHome !== containerHome &&
    (p === containerHome || p.startsWith(containerHome + "/"))
  ) {
    return hostHome + p.slice(containerHome.length);
  }
  return p;
}

/**
 * Compose a template-generated file with an optional user sidecar.
 * Result = <rendered template>\n\n---\n\n<sidecar contents> if sidecar exists,
 * else just <rendered template>.
 */
function composeWithSidecar(renderedBase: string, sidecarPath: string): string {
  if (!existsSync(sidecarPath)) return renderedBase;
  const sidecar = readFileSync(sidecarPath, "utf-8").trimEnd();
  if (sidecar.length === 0) return renderedBase;
  return `${renderedBase.trimEnd()}\n\n---\n\n${sidecar}\n`;
}

/**
 * Visible boundary between the Switchroom-managed (scaffold-regenerated)
 * top of `<agentDir>/CLAUDE.md` and the operator-owned bottom that survives
 * every `switchroom apply`.
 *
 * STRUCTURAL PROMISE — never change this text or its semantics again.
 * Operators edit below this line; the scaffold rewrites everything above it
 * on every reconcile and preserves everything below it verbatim. See #1857.
 *
 * Canonical definition lives in generation-stamp.ts (KEN-130) so the
 * gateway-side drift probe can split CLAUDE.md without importing this
 * module; re-exported above (import block) for existing importers.
 */
export { CLAUDE_MD_YOURS_MARKER };

/**
 * Placeholder written below the marker for a fresh agent that has neither an
 * existing below-marker section nor a legacy `workspace/CLAUDE.custom.md`
 * sidecar to migrate. Self-teaching: the first time an operator opens the
 * file they see what's editable and why.
 */
const CLAUDE_MD_YOURS_PLACEHOLDER =
  "This space is yours. Add per-agent rules, exceptions, or context the " +
  "Switchroom template doesn't capture. Everything above the marker line is " +
  "regenerated on every apply; this section is preserved.";

/**
 * Resolve the operator-owned "below the marker" section for a two-section
 * `<agentDir>/CLAUDE.md`, in priority order:
 *
 *   (a) the existing file already contains the marker → preserve everything
 *       after the FIRST marker occurrence verbatim (operator content survives);
 *   (b) else a legacy `workspace/CLAUDE.custom.md` sidecar exists with content
 *       → migrate its content below the marker AND rename the sidecar to
 *       `.deprecated` (one-time migration, logged);
 *   (c) else the fresh-agent placeholder paragraph.
 *
 * Side effect: case (b) renames the sidecar. This is deliberate and lives here
 * so BOTH write paths (first-scaffold + reconcile) get identical migration
 * behaviour from the single shared helper.
 */
function resolveClaudeMdYoursSection(
  existingFileContent: string | null,
  sidecarPath: string,
): string {
  // (a) preserve everything after the FIRST marker occurrence, verbatim.
  if (existingFileContent) {
    const idx = existingFileContent.indexOf(CLAUDE_MD_YOURS_MARKER);
    if (idx !== -1) {
      const afterMarker = existingFileContent
        .slice(idx + CLAUDE_MD_YOURS_MARKER.length)
        .replace(/^[\r\n]+/, ""); // drop the blank line(s) between the marker and the content
      return afterMarker.trimEnd();
    }
  }

  // (b) one-time sidecar migration.
  if (existsSync(sidecarPath)) {
    const sidecar = readFileSync(sidecarPath, "utf-8").trimEnd();
    if (sidecar.length > 0) {
      const deprecatedPath = sidecarPath + ".deprecated";
      try {
        renameSync(sidecarPath, deprecatedPath);
        console.log(
          chalk.green(
            `  migrated CLAUDE.custom.md → CLAUDE.md operator section; ` +
              `renamed sidecar to ${deprecatedPath}`,
          ),
        );
      } catch {
        /* best-effort — content still migrates below; sidecar retirement retried next run */
      }
      return sidecar;
    }
  }

  // (c) fresh-agent placeholder.
  return CLAUDE_MD_YOURS_PLACEHOLDER;
}

/**
 * Compose the two-section `<agentDir>/CLAUDE.md`: the Switchroom-managed
 * `managed` block (rendered template + fragments + `claude_md_raw`), a visible
 * marker line, and the operator-owned section resolved by
 * {@link resolveClaudeMdYoursSection}.
 *
 * INVARIANT: for identical inputs this is a deterministic pure function of
 * (`managed`, `existingFileContent`, sidecar state), so the first-scaffold and
 * reconcile paths produce byte-identical output and a re-run with unchanged
 * config is a full no-op. The output is a fixed point: feeding it back in as
 * `existingFileContent` re-derives the same bytes.
 */
export function composeTwoSectionClaudeMd(
  managed: string,
  existingFileContent: string | null,
  sidecarPath: string,
): string {
  const yours = resolveClaudeMdYoursSection(existingFileContent, sidecarPath);
  return `${managed.trimEnd()}\n\n${CLAUDE_MD_YOURS_MARKER}\n\n${yours.trimEnd()}\n`;
}

/**
 * Render the persona SOUL.md for an agent from its profile template +
 * `soul:` config, folding in the SOUL.custom.md sidecar if present.
 * The single source of truth for seed-time and `switchroom soul reset`
 * rendering. SOUL.md.hbs consumes only `{{soul.*}}` (pinned by
 * tests/soul-template-vars.test.ts), so the render context is `{ soul }`.
 * Returns null if the profile ships no SOUL.md.hbs.
 */
export function renderSoulMd(
  profilePath: string,
  agentWorkspaceDir: string,
  soul: unknown,
): string | null {
  const soulMdSrc = join(profilePath, "workspace", "SOUL.md.hbs");
  if (!existsSync(soulMdSrc)) return null;
  const rendered = renderTemplate(soulMdSrc, { soul });
  const customSoulPath = join(agentWorkspaceDir, "SOUL.custom.md");
  return composeWithSidecar(rendered, customSoulPath);
}

/**
 * Human-readable label for an agent + its Hindsight bank in log output.
 * When they match (default case): just the agent name ("clerk").
 * When they differ (custom memory.collection in yaml, e.g. legacy bank_id):
 * "clerk (bank: assistant)" to avoid confusing the bank ID with the agent name.
 */
function formatAgentBankLabel(agentName: string, bankId: string): string {
  if (agentName === bankId) return agentName;
  return `${agentName} (bank: ${bankId})`;
}

/**
 * In-flight Hindsight bank-op chains (bank create → mission read → mission
 * push → mental models). `scaffoldAgent` / `reconcileAgent` are synchronous
 * and start these fire-and-forget, which is fine while the process exits by
 * draining the event loop — a pending fetch keeps node alive. It is NOT fine
 * on a hard `process.exit()`: `runApply` exits with codes 4/5/6 in its vault
 * phases, which run AFTER the scaffold loop, and would truncate a push
 * mid-flight. The 2026-07-25 re-review's retain-mission read (up to 5s)
 * widened that window, so the fix is a real flush rather than a note (L2).
 *
 * Callers that hard-exit await `flushPendingBankOps()` after the scaffold
 * loop. Everything else can ignore it and keep the old drain behaviour.
 */
const pendingBankOps = new Set<Promise<unknown>>();

/**
 * Register a bank-op chain so `flushPendingBankOps` can wait on it.
 *
 * Entries self-evict the moment they settle. `flushPendingBankOps` is only
 * awaited by apply, but chains are also started from `switchroom setup`,
 * `agent`, `create-orchestrator`, `doctor`, `rename-orchestrator` and the
 * reconcile bridge — without eviction a long-lived process would accumulate
 * one settled promise per scaffold forever (PR #3529 review, N2b).
 */
function trackBankOps(p: Promise<unknown>): void {
  // Swallow here only for tracking purposes — each chain already has its own
  // .catch for user-facing reporting.
  const tracked: Promise<void> = p
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      // `tracked` is assigned and added below before this microtask can run,
      // so the delete always finds its own entry.
      pendingBankOps.delete(tracked);
    });
  pendingBankOps.add(tracked);
}

/**
 * Drop every registered chain without waiting on it. Test-hygiene hook only:
 * the scaffold/reconcile suites start real chains that must not leak into a
 * later test's flush (PR #3529 review, N2a). Product code uses
 * `flushPendingBankOps`, which actually waits.
 */
export function __resetPendingBankOpsForTests(): void {
  pendingBankOps.clear();
}

/** Number of chains still registered. Test-only observability for N2b. */
export function __pendingBankOpsCountForTests(): number {
  return pendingBankOps.size;
}

/**
 * Wait for every in-flight bank-op chain, bounded by `timeoutMs`. Never
 * throws; returns true if everything settled, false if the timeout won (in
 * which case the caller is exiting anyway and apply is idempotent — the
 * operator's next run re-pushes).
 *
 * Exported for tests and for `runApply`.
 */
export async function flushPendingBankOps(timeoutMs = 15_000): Promise<boolean> {
  if (pendingBankOps.size === 0) return true;
  const inFlight = [...pendingBankOps];
  pendingBankOps.clear();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    // Don't hold the event loop open just for the deadline.
    timer.unref?.();
  });
  const settled = Promise.all(inFlight).then(() => true);
  const result = await Promise.race([settled, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * Decide what `retain_mission` (if anything) to push at this bank, and log the
 * outcome. Shared by BOTH bank-op sites — `scaffoldAgent` and `reconcileAgent`
 * — because `switchroom apply` re-scaffolds every existing agent and never
 * calls reconcile (`src/cli/apply.ts`), so a guard living only in reconcile is
 * unreachable on the path operators actually run (2026-07-25 re-review H1).
 *
 * One path, three outcomes, driven by `decideRetainMissionUpgrade`:
 *  - operator yaml set          → push it verbatim (wins outright, no read needed)
 *  - bank unset / superseded    → push DEFAULT_RETAIN_MISSION
 *  - bank customized or current → push nothing
 *
 * A FAILED read pushes nothing (unless yaml set one): "unknown" must never be
 * treated as "upgradable", or a transient Hindsight hiccup would clobber a
 * customized mission. This also means a genuinely fresh bank is seeded via the
 * normal "mission unset → upgrade" outcome rather than a separate fresh-agent
 * branch — no created-vs-existed signal is needed from `createBank`, whose MCP
 * envelope does not carry one.
 */
async function resolveRetainMissionPush(
  apiUrl: string,
  bankId: string,
  configured: string | undefined,
  label: string,
): Promise<string | undefined> {
  // Config wins outright and needs no read — push it regardless.
  if (configured) return configured;

  const current = await fetchBankRetainMission(apiUrl, bankId, { timeoutMs: 5000 });
  if (!current.ok) {
    console.warn(
      `  ${chalk.yellow("⚠")} Could not read current retain_mission for ${label} (${current.reason}) — leaving it untouched`,
    );
    return undefined;
  }

  const decision = decideRetainMissionUpgrade(configured, current.mission);
  if (decision.action === "upgrade") {
    console.log(
      `  ${chalk.green("✓")} Upgrading superseded default retain_mission for ${label}`,
    );
  }
  return decision.mission;
}

/**
 * `observations_mission` counterpart of {@link resolveRetainMissionPush}, and
 * deliberately the same shape: read the bank's current value, and push only
 * when it is unset or byte-equals a mission switchroom itself shipped. Returns
 * `undefined` for "push nothing".
 *
 * Before this existed, `observations_mission` reached `updateBankMissions`
 * straight out of `resolveBankMissionExtras` and was therefore pushed
 * UNCONDITIONALLY on every `switchroom apply` — the same clobber hazard the
 * retain path was fixed for (2026-07-25 re-review H1). It never bit only
 * because the sole value that could be produced came from a profile no live
 * agent uses. Now that a fleet default makes this path hot, it goes through the
 * read-first decision.
 *
 * A FAILED read pushes nothing: "unknown" must never be treated as
 * "upgradable", or a Hindsight hiccup would overwrite an operator's mission.
 */
async function resolveObservationsMissionPush(
  apiUrl: string,
  bankId: string,
  configured: string | undefined,
  profileName: string,
  label: string,
): Promise<string | undefined> {
  // Config wins outright and needs no read — push it regardless.
  if (configured) return configured;

  const profileDefault = PROFILE_MEMORY_DEFAULTS[profileName]?.observations_mission;
  const current = await fetchBankObservationsMission(apiUrl, bankId, { timeoutMs: 5000 });
  if (!current.ok) {
    console.warn(
      `  ${chalk.yellow("⚠")} Could not read current observations_mission for ${label} (${current.reason}) — leaving it untouched`,
    );
    return undefined;
  }

  const decision = decideObservationsMissionUpgrade(configured, profileDefault, current.mission);
  if (decision.action === "upgrade") {
    console.log(
      `  ${chalk.green("✓")} Seeding default observations_mission for ${label}`,
    );
  }
  return decision.mission;
}

/**
 * Decide which disposition traits to push to a bank, read-first.
 *
 * Shared by the scaffold and reconcile bank-op chains. Before the fleet-wide
 * floor existed, `disposition` was only ever non-empty for an agent on a
 * specialist profile or with explicit yaml, so pushing it unconditionally was
 * nearly free. A floor makes it non-empty for EVERY agent, which without this
 * would (a) send an `update_bank` on every apply for every agent forever, and
 * (b) overwrite the disposition of every bank an operator had tuned by hand.
 * See {@link decideDispositionPush}.
 *
 * Returns `undefined` for "push nothing" — including when the read fails,
 * because "unknown" must never be treated as "unset".
 */
async function resolveDispositionPush(
  apiUrl: string,
  bankId: string,
  desired: BankDisposition | undefined,
  memory: { disposition?: BankDisposition } | undefined,
  profileName: string,
  label: string,
): Promise<BankDisposition | undefined> {
  if (!desired) return undefined;
  const current = await fetchBankDisposition(apiUrl, bankId, { timeoutMs: 5000 });
  if (!current.ok) {
    console.warn(
      `  ${chalk.yellow("⚠")} Could not read current disposition for ${label} (${current.reason}) — leaving it untouched`,
    );
    return undefined;
  }
  return decideDispositionPush(
    desired,
    current.disposition,
    fleetOnlyDispositionTraits(memory, profileName),
  );
}

/**
 * Seed / upgrade the anti-confabulation directive on one bank, and report the
 * outcome in the same voice as the sibling bank ops.
 *
 * Shared by BOTH the scaffold and reconcile bank-op chains, for the reason
 * `resolveObservationsMissionPush` is: `switchroom apply` re-scaffolds every
 * existing agent and never calls `reconcileAgent`, so a seed wired into only
 * one of the two paths reaches roughly none of the fleet.
 *
 * Best-effort by contract — {@link ensureAntiConfabulationDirective} never
 * throws, and this never rejects. A guardrail directive is worth an apply, not
 * worth failing one.
 */
async function seedAntiConfabulationDirective(
  apiUrl: string,
  bankId: string,
  configured: boolean | string | undefined,
  label: string,
): Promise<void> {
  try {
    const outcome = await ensureAntiConfabulationDirective(
      apiUrl,
      bankId,
      configured,
      { timeoutMs: 5000 },
    );
    switch (outcome.action) {
      case "created":
        console.log(
          `  ${chalk.green("✓")} Seeded "${outcome.name}" directive for ${label}`,
        );
        break;
      case "upgraded":
        console.log(
          `  ${chalk.green("✓")} Upgrading superseded default "${outcome.name}" directive for ${label}`,
        );
        break;
      case "skipped":
        // "disabled" is the operator's own choice, not news.
        if (outcome.reason !== "disabled") {
          console.warn(
            `  ${chalk.yellow("⚠")} Skipped "${outcome.name}" directive for ${label}: ${outcome.reason}`,
          );
        }
        break;
      case "failed":
        console.warn(
          `  ${chalk.yellow("⚠")} Failed to ensure "${outcome.name}" directive for ${label}: ${outcome.reason}`,
        );
        break;
      case "unchanged":
        break;
    }
  } catch (err) {
    console.warn(
      `  ${chalk.yellow("⚠")} Directive seed error for ${label}: ${err}`,
    );
  }
}

/**
 * Parse a duration string like "2h", "30m", "7200s" into seconds.
 * Returns undefined for undefined input.
 */
function parseDurationToSeconds(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const match = d.match(/^(\d+)([smh])$/);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    default: return undefined;
  }
}

/**
 * Per-agent cron script generation was retired with the cron-fold-in
 * (Phase 4, #890-#893) — cron now fires through the in-container
 * `agent-scheduler` sibling, which synthesizes an `InboundMessage`
 * tagged `meta.source="cron"` and delivers it via `inject_inbound`
 * IPC to the live claude session (`src/scheduler/dispatch.ts`). The
 * legacy `telegram/cron-<sha12>.sh` artifacts that wrapped `claude -p`
 * have been deleted from disk by `reconcileAgentDir` since this commit.
 *
 * Why removed (not just retired): `claude -p` is *programmatic* usage
 * under Anthropic's 2026-06-15 policy (off the subscription) and
 * spawned a parasitic second telegram bridge that ping-pong'd with
 * the live agent's bridge — the #1613/#1616 "bridge reconnect race".
 * Even though no operator-side cron invoked the scripts in the
 * post-Phase-4 fleet, leaving the files on disk was a latent
 * compliance violation and could be re-armed by a future operator
 * adding an external trigger.
 */

/**
 * Resolve the global switchroom skills pool directory. Honors the optional
 * `switchroom.skills_dir` override in switchroom.yaml and falls back to
 * `~/.switchroom/skills`. Expands a leading `~/` against $HOME.
 */
function resolveSkillsPoolDir(override: string | undefined): string {
  return resolveDualPath(override ?? "~/.switchroom/skills");
}

/**
 * Remove symlinks from the legacy <agentDir>/skills/ directory that point
 * into the global skills pool. Claude Code never discovered them there, so
 * they were dead weight — we clear them on reconcile after migration so a
 * user's agent dir ends up clean. Real files (profile-bundled skills copied
 * before migration) are left in place.
 */
function migrateLegacySkillsDir(agentDir: string, skillsPool: string): void {
  const legacyDir = join(agentDir, "skills");
  let entries: string[];
  try {
    entries = readdirSync(legacyDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = join(legacyDir, entry);
    let target: string | null = null;
    try {
      target = readlinkSync(entryPath);
    } catch {
      continue; // not a symlink — leave it
    }
    // Resolve relative targets against the link dir so both the current
    // RELATIVE link form and the legacy ABSOLUTE form are recognized (footgun A).
    const resolved = target
      ? (isAbsolute(target) ? target : resolve(dirname(entryPath), target))
      : null;
    if (resolved && resolved.startsWith(skillsPool)) {
      try {
        rmSync(entryPath, { force: true });
      } catch { /* best effort */ }
    }
  }
}

/**
 * Sync the set of global-skill symlinks in an agent's .claude/skills/
 * directory against the user's declared `skills:` list (already merged with
 * defaults). Idempotent and safe to call on reconcile:
 *
 *   - Missing links for declared skills are created.
 *   - Stale links whose target no longer appears in the list are
 *     removed. Only symlinks are ever removed — real files/directories
 *     from the template's copySkills pass are untouched.
 *   - Missing pool entries (user listed a skill that doesn't exist at
 *     <skills_dir>/<name>) produce a warning but don't throw — this is
 *     a non-fatal configuration lint.
 */
function syncGlobalSkills(
  agentDir: string,
  declared: string[],
  skillsDirOverride: string | undefined,
): void {
  const skillsPool = resolveSkillsPoolDir(skillsDirOverride);
  // Claude Code only discovers skills under $CLAUDE_CONFIG_DIR/.claude/skills/.
  // Symlink there so declared skills actually surface in available-skills.
  const agentSkillsDir = join(agentDir, ".claude", "skills");
  mkdirSync(agentSkillsDir, { recursive: true });

  // Migrate any pre-existing symlinks from the legacy <agentDir>/skills/
  // location (pre-.claude/skills migration) so reconcile cleanly relocates
  // them instead of leaving orphaned links behind.
  migrateLegacySkillsDir(agentDir, skillsPool);

  // Create symlinks for each declared skill. Skip entries that are
  // already correct; replace ones pointing at the wrong target.
  for (const name of declared) {
    if (!name || name.includes("/") || name === "." || name === "..") {
      console.warn(`  WARNING: invalid skill name "${name}" — skipping`);
      continue;
    }
    const src = join(skillsPool, name);
    const dest = join(agentSkillsDir, name);
    if (!existsSync(src)) {
      console.warn(
        `  WARNING: skill "${name}" not found in pool (${skillsPool}) — skipping`,
      );
      continue;
    }
    // Relative link target (footgun A): a path relative to the link's own
    // directory, so it resolves identically across container mount contexts
    // (hostd's /host-home view vs the agent's /home view share one
    // ~/.switchroom root). Depth is computed, never hardcoded.
    const relTarget = relative(dirname(dest), src);
    // If dest exists and is a symlink to the right target, leave it.
    // If dest exists as a real file/dir (e.g. from profile copySkills),
    // also leave it — profile-bundled skills take priority over the
    // pool to avoid silent surprises. Use lstatSync so broken symlinks
    // are detected (statSync would follow them and throw, falsely
    // indicating the path is free).
    let linkStat;
    try {
      linkStat = lstatSync(dest);
    } catch {
      linkStat = null;
    }
    if (linkStat) {
      if (linkStat.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = readlinkSync(dest);
        } catch { /* unreadable; leave alone */ }
        // Already the correct RELATIVE link — idempotent no-op.
        if (target === relTarget) {
          continue;
        }
        // A link pointing into the pool (resolved against the link dir so
        // a legacy ABSOLUTE target is handled too): replace it — this both
        // heals a stale/broken pool link and migrates an absolute link to
        // the relative form. Anything foreign: leave alone.
        const resolved = target
          ? (isAbsolute(target) ? target : resolve(dirname(dest), target))
          : null;
        if (resolved && resolved.startsWith(skillsPool)) {
          try {
            rmSync(dest, { force: true });
          } catch { /* best effort */ }
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    try {
      symlinkSync(relTarget, dest);
    } catch (err) {
      console.warn(
        `  WARNING: failed to symlink skill "${name}": ${(err as Error).message}`,
      );
    }
  }

  // Clean up stale symlinks — ones that point into the skills pool but
  // aren't in the current declared set. Real files and symlinks that
  // point elsewhere are left untouched. Bundled-default symlinks
  // (targets under `~/.switchroom/skills/_bundled/`) are owned by the
  // reconcile-default-skills path; skip them here so we don't prune
  // them as orphans (RCA: #1164).
  const declaredSet = new Set(declared);
  for (const entry of readdirSync(agentSkillsDir)) {
    if (declaredSet.has(entry)) continue;
    const entryPath = join(agentSkillsDir, entry);
    let linkTarget: string | null = null;
    try {
      linkTarget = readlinkSync(entryPath);
    } catch {
      continue; // not a symlink
    }
    // Resolve relative targets against the link dir before classifying, so
    // the current RELATIVE link form is recognized as well as the legacy
    // ABSOLUTE form (footgun A).
    const resolved = linkTarget
      ? (isAbsolute(linkTarget) ? linkTarget : resolve(dirname(entryPath), linkTarget))
      : null;
    if (resolved && resolved.includes("/.switchroom/skills/_bundled/")) {
      continue; // owned by reconcile-default-skills
    }
    if (resolved && resolved.startsWith(skillsPool)) {
      rmSync(entryPath, { force: true });
    }
  }
}

/**
 * Symlink every switchroom-* skill from the switchroom project's built-in skills/
 * directory into <agentDir>/.claude/skills/<name>.
 *
 * **Role gate (#235 follow-up).** Only `role: "foreman"` agents get
 * the bundled operator skills. Default-role assistants are fleet
 * agents doing user-facing tasks; loading switchroom-manage / install
 * / health into their tool list adds cognitive overhead per turn for
 * no benefit (they never call these skills). For non-foreman roles
 * this function actively REMOVES any pre-existing operator skill
 * symlinks (idempotent retraction) so a role flip foreman → assistant
 * cleans up correctly on the next reconcile.
 *
 * Rules:
 *   - Only directories that start with "switchroom-" and contain a SKILL.md
 *     file are linked (when installing).
 *   - The destination .claude/skills/ directory is created if absent.
 *   - Existing entries at the destination are left untouched on install
 *     (idempotent symlink refresh; pre-existing real dirs/files preserved).
 *   - On retraction, only switchroom-installed symlinks are removed —
 *     never real dirs/files (operator may have placed those manually).
 */
export function installSwitchroomSkills(
  agentDir: string,
  opts: { role?: "assistant" | "foreman" } = {},
): void {
  const builtinSkillsDir = resolve(homedir(), ".switchroom/skills/_bundled");
  if (!existsSync(builtinSkillsDir)) {
    process.stderr.write(
      `switchroom: bundled skills pool dir not found at ${builtinSkillsDir} — run \`switchroom update\` to install it.\n`,
    );
    return;
  }

  const targetDir = join(agentDir, ".claude", "skills");
  mkdirSync(targetDir, { recursive: true });

  // Discover the universe of switchroom-* skills upfront so the same
  // list drives both install and retract paths.
  let entries: string[];
  try {
    entries = readdirSync(builtinSkillsDir);
  } catch {
    return;
  }
  // Universal-default switchroom-* skills (cli/status/health) flow through
  // the new bundled-defaults path (`reconcileAgentDefaultSkills`) for ALL
  // roles, with per-key opt-out. Exclude them here so the foreman-gate
  // logic only owns the operator-only trio (install/manage/architecture).
  const universalDefaultSkills = new Set([
    "switchroom-cli",
    "switchroom-status",
    "switchroom-health",
  ]);
  const switchroomSkillNames = entries.filter((name) => {
    if (!name.startsWith("switchroom-")) return false;
    if (universalDefaultSkills.has(name)) return false;
    const src = join(builtinSkillsDir, name);
    try {
      const st = lstatSync(src);
      return st.isDirectory() && existsSync(join(src, "SKILL.md"));
    } catch {
      return false;
    }
  });

  // Role gate: only foreman agents get the operator skills auto-installed.
  // For other roles, retract any pre-existing symlinks (idempotent).
  if (opts.role !== "foreman") {
    for (const name of switchroomSkillNames) {
      const dest = join(targetDir, name);
      let existing;
      try {
        existing = lstatSync(dest);
      } catch {
        continue; // nothing to retract
      }
      // Only remove symlinks we plausibly installed. Don't touch real
      // dirs or files the operator placed there manually.
      if (!existing.isSymbolicLink()) continue;
      let currentTarget: string | null = null;
      try {
        currentTarget = readlinkSync(dest);
      } catch { /* unreadable — assume foreign, leave alone */ }
      // Retract a link we plausibly installed — in either the RELATIVE
      // form (current) or the legacy ABSOLUTE form (pre-footgun-A). Resolve
      // relative targets against the link dir before comparing.
      if (!currentTarget) continue;
      const resolvedTarget = isAbsolute(currentTarget)
        ? currentTarget
        : resolve(dirname(dest), currentTarget);
      if (resolvedTarget !== join(builtinSkillsDir, name)) continue;
      try {
        rmSync(dest, { force: true });
      } catch { /* best effort */ }
    }
    return;
  }

  // Foreman path: install (or refresh stale) symlinks for each skill.
  for (const name of switchroomSkillNames) {
    const src = join(builtinSkillsDir, name);
    const dest = join(targetDir, name);
    // Relative link target (footgun A) — mount-context-invariant, computed
    // depth (never a hardcoded `../` literal).
    const relTarget = relative(dirname(dest), src);
    // Idempotent: leave correctly-pointing symlinks and real dirs alone.
    // But refresh stale symlinks whose target is a different switchroom-
    // lookalike path (e.g. old clerk/skills/ after the clerk→switchroom
    // rename), AND migrate a correct-but-absolute legacy link to relative.
    let existing;
    try {
      existing = lstatSync(dest);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        let currentTarget: string | null = null;
        try {
          currentTarget = readlinkSync(dest);
        } catch { /* unreadable */ }
        if (currentTarget === relTarget) continue; // already correct (relative)
        try {
          rmSync(dest, { force: true });
        } catch { /* best effort; symlinkSync below will error cleanly */ }
      } else {
        continue; // real file/dir — don't touch
      }
    }
    try {
      symlinkSync(relTarget, dest);
    } catch (err) {
      console.warn(
        `  WARNING: failed to symlink switchroom skill "${name}": ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Translate per-channel YAML fields into env vars the telegram-plugin
 * will read at startup. Today: SWITCHROOM_TG_FORMAT,
 * SWITCHROOM_TG_STREAM_MODE, and the progress-card threshold knobs.
 *
 * Returns an object that can be merged into the user env. User-declared
 * env vars with the same key take precedence (see the call site) since
 * an explicit `env:` entry is a more precise signal than a channel
 * default.
 */
function channelsToEnv(agent: AgentConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const tg = agent.channels?.telegram;
  if (!tg) return out;
  if (tg.format !== undefined) out.SWITCHROOM_TG_FORMAT = tg.format;
  // SWITCHROOM_TG_RATE_LIMIT_MS removed in #3161 — nothing in
  // telegram-plugin ever read it; the send gate (on by default since
  // #3153) is the real outbound throttle.
  if (tg.stream_mode !== undefined) {
    out.SWITCHROOM_TG_STREAM_MODE = tg.stream_mode;
  }
  if (tg.stream_throttle_ms !== undefined) {
    out.SWITCHROOM_TG_STREAM_THROTTLE_MS = String(tg.stream_throttle_ms);
  }
  // Progress-card driver thresholds — only effective when stream_mode=checklist.
  if (tg.orphan_promotion_ms !== undefined) {
    out.SWITCHROOM_TG_ORPHAN_PROMOTION_MS = String(tg.orphan_promotion_ms);
  }
  if (tg.cold_sub_agent_threshold_ms !== undefined) {
    out.SWITCHROOM_TG_COLD_SUB_AGENT_THRESHOLD_MS = String(tg.cold_sub_agent_threshold_ms);
  }
  if (tg.deferred_completion_timeout_ms !== undefined) {
    out.SWITCHROOM_TG_DEFERRED_COMPLETION_TIMEOUT_MS = String(tg.deferred_completion_timeout_ms);
  }
  // Operator approval-card lifetime (minutes) → ms for the plugin's
  // PERMISSION_TTL_MS / vault-request reaps. Only emit when explicitly set so
  // the plugin's built-in 60-min default owns the unset case.
  if (tg.approval_timeout_minutes !== undefined) {
    out.SWITCHROOM_TG_APPROVAL_TIMEOUT_MS = String(tg.approval_timeout_minutes * 60_000);
  }
  if (tg.sub_agent_tick_interval_ms !== undefined) {
    out.SWITCHROOM_TG_SUB_AGENT_TICK_INTERVAL_MS = String(tg.sub_agent_tick_interval_ms);
  }
  if (tg.edit_budget_threshold !== undefined) {
    out.SWITCHROOM_TG_EDIT_BUDGET_THRESHOLD = String(tg.edit_budget_threshold);
  }
  // Deterministic send-gate rate limits (channels.telegram.send_gate.*).
  // Each knob is emitted only when explicitly set so the send gate's built-in
  // compile-time default (send-gate.ts SEND_GATE_DEFAULTS) owns the unset case
  // — omitting the whole block reproduces today's exact behaviour. The gateway
  // resolves these via sendGateConfigFromEnv(). NOTE: `enabled` here is DISTINCT
  // from the operator break-glass valve SWITCHROOM_TELEGRAM_SEND_GATE, which is
  // never written by scaffold and always wins when explicitly set (see
  // sendGateConfigFromEnv precedence).
  const sg = tg.send_gate;
  if (sg) {
    if (sg.enabled !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_ENABLED = sg.enabled ? "1" : "0";
    }
    if (sg.global_per_sec !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_GLOBAL_PER_SEC = String(sg.global_per_sec);
    }
    if (sg.global_burst !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_GLOBAL_BURST = String(sg.global_burst);
    }
    if (sg.per_chat_per_sec !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_PER_CHAT_PER_SEC = String(sg.per_chat_per_sec);
    }
    if (sg.per_chat_burst !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_PER_CHAT_BURST = String(sg.per_chat_burst);
    }
    if (sg.per_group_per_min !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_PER_GROUP_PER_MIN = String(sg.per_group_per_min);
    }
    if (sg.per_group_burst !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_PER_GROUP_BURST = String(sg.per_group_burst);
    }
    if (sg.edit_floor_ms !== undefined) {
      out.SWITCHROOM_TG_SEND_GATE_EDIT_FLOOR_MS = String(sg.edit_floor_ms);
    }
  }
  // Coalesced worker-activity feed tuning (channels.telegram.worker_feed.*).
  // Only emitted when explicitly set so the feed's built-in default (8) owns
  // the unset case — omitting the block reproduces today's behaviour.
  const wf = (tg as { worker_feed?: { max_rows?: number } } | undefined)?.worker_feed;
  if (wf?.max_rows !== undefined) {
    out.SWITCHROOM_TG_WORKER_FEED_MAX_ROWS = String(wf.max_rows);
  }
  // Whether to DELETE the activity/status feed when the final answer lands.
  // Default (unset) = keep it as a record; only emit the env when explicitly
  // set so the gateway's default-off parse owns the unset case.
  if (tg.clear_status_on_completion !== undefined) {
    out.SWITCHROOM_TG_CLEAR_STATUS_ON_COMPLETION = tg.clear_status_on_completion ? "1" : "0";
  }
  // Whether to SILENTLY pin the already-rendered status message while its
  // work is in-flight (and auto-unpin on completion). Default ON in the
  // gateway; only emit the env when explicitly set so the gateway's
  // default-on parse owns the unset case. See status-pin.ts.
  if (tg.pin_status_while_working !== undefined) {
    out.SWITCHROOM_TG_PIN_STATUS_WHILE_WORKING = tg.pin_status_while_working ? "1" : "0";
  }
  // Linear capture default team (#2312) — only needed for multi-team
  // workspaces, where the create tool can't auto-resolve. Single-team
  // workspaces leave this unset and the tool resolves the only team.
  const linearDefaultTeam = (
    tg as { linear_agent?: { default_team_id?: string } } | undefined
  )?.linear_agent?.default_team_id;
  if (linearDefaultTeam) {
    out.SWITCHROOM_LINEAR_DEFAULT_TEAM_ID = linearDefaultTeam;
  }
  return out;
}

/**
 * Build env vars exposing per-agent worktree paths to the agent's
 * runtime. Slug `switchroom-web` → `SWITCHROOM_REPO_SWITCHROOM_WEB`.
 * Path is computed deterministically from the agent dir and slug
 * (`<agentDir>/work/<slug>/`); the worktree itself is provisioned
 * separately during reconcile (see src/repos/agent-worktree.ts).
 */
function buildRepoEnvVars(
  _agentName: string,
  agentDir: string,
  agent: AgentConfig,
): Record<string, string> {
  const repos = agent.repos;
  if (!repos) return {};
  const out: Record<string, string> = {};
  for (const slug of Object.keys(repos)) {
    const envName = `SWITCHROOM_REPO_${slug.toUpperCase().replace(/-/g, "_")}`;
    out[envName] = agentWorktreePath(agentDir, slug);
  }
  return out;
}

/**
 * Export HUMANIZER_VOICE_FILE when the agent has a humanizer_voice_file
 * configured. The bundled humanizer skill (and its calibrate companion)
 * read this env var to locate the user's voice template. When unset, the
 * humanizer falls back to its generic "human writing" rules.
 *
 * Relative paths are resolved against the agent's directory so per-agent
 * templates can live alongside agent state.
 */
function buildHumanizerEnvVars(
  agentDir: string,
  agent: AgentConfig,
): Record<string, string> {
  const voiceFile = agent.humanizer_voice_file;
  if (!voiceFile) return {};
  const expanded = voiceFile.startsWith("~/")
    ? voiceFile.replace(/^~/, process.env.HOME ?? "~")
    : voiceFile;
  const resolved = expanded.startsWith("/")
    ? expanded
    : resolve(agentDir, expanded);
  return { HUMANIZER_VOICE_FILE: resolved };
}

/**
 * Claude Code tool-search env. Defers (lazy-loads) MCP tool schemas so the
 * heavy per-agent integration servers (webkite/perplexity/marketing — ~31k
 * tokens of schema) stop occupying the context window every turn; the model
 * fetches a schema only when it actually calls that tool. The load-bearing
 * framework servers (switchroom-telegram, hindsight, agent-config) carry
 * `alwaysLoad: true` in .mcp.json so reply/get_recent_messages/recall never
 * defer (no per-turn ToolSearch round-trip).
 *
 * Default value `true` (force-defer). `auto` was the prior default but it
 * NEVER fires on this fleet: `auto`'s char threshold scales with the model
 * window, and on the 1M-Opus window the whole ~50-80k MCP tool surface fits
 * under it, so claude loads everything upfront (measured 2026-06-18: clerk
 * baseline 79,056 tok under `auto`, unchanged even by the per-tool diet).
 * `true` forces deferral of every tool NOT pinned via
 * `_meta["anthropic/alwaysLoad"]` — switchroom pins the load-bearing hot path
 * (reply / etc. in the telegram bridge; hindsight + agent-config
 * server-wide), so the reply path stays loaded while the heavy business-MCP +
 * cold-tool surface defers. Canary (test-harness, 2026-06-18): baseline
 * 79,056 → 47,064 tok (~40%) with the reply UAT still passing.
 *
 * Override per fleet via SWITCHROOM_TOOL_SEARCH_MODE (e.g. `auto` / `auto:N`).
 * Kill switch SWITCHROOM_DISABLE_TOOL_SEARCH=1 omits the var entirely → claude
 * loads all tools. A per-agent `env: {ENABLE_TOOL_SEARCH}` in switchroom.yaml
 * still wins (spread after this in the env builder).
 *
 * Consumed by claude (inner start.sh pass), not the gateway, so the
 * env-before-gateway-fork landmine does not constrain placement.
 */
export function buildToolSearchEnvVars(): Record<string, string> {
  if (process.env.SWITCHROOM_DISABLE_TOOL_SEARCH === "1") return {};
  return { ENABLE_TOOL_SEARCH: process.env.SWITCHROOM_TOOL_SEARCH_MODE ?? "true" };
}

/**
 * Top-level settings.json keys that switchroom's scaffold/reconcile
 * pipeline owns and rebuilds on every run. When the settings_raw
 * escape hatch injects additional top-level keys (e.g. `effort`,
 * `apiKeyHelper`), they're tracked via the `_switchroomManagedRawKeys`
 * side-car so reconcile can retract them if the user removes them
 * from switchroom.yaml. Keys in this set are never retracted because the
 * scaffold path rebuilds them deterministically from switchroom.yaml.
 */
const SWITCHROOM_OWNED_SETTINGS_KEYS = new Set<string>([
  "permissions",
  "mcpServers",
  "autoMemoryEnabled",
  "hooks",
  "model",
]);

/**
 * Strip opt-out entries from a user-declared mcp_servers map before writing
 * to settings.json. An entry with value `false` means "don't include this
 * server" — used to suppress a built-in default (e.g. playwright) on a
 * per-agent basis without removing it from `defaults.mcp_servers`.
 */
function filterMcpServers(
  servers: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(servers)) {
    if (value === false) continue; // opt-out: skip this server
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      // Strip switchroom-internal fields before they reach .mcp.json
      // (#1806). Currently just `secrets:` — the broker-ACL declaration
      // for vault keys the launcher will fetch (see vault-broker.md).
      // Claude Code ignores unknown fields, but leaking the field
      // (a) clutters .mcp.json which agents may read directly, and
      // (b) discloses which vault keys an MCP needs to anything that
      // can read the file. Discloses key NAMES only (not values), but
      // there's no upside to keeping it.
      const { secrets: _secrets, ...rest } = value as Record<string, unknown>;
      out[key] = rest;
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const ALL_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillBash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "Workflow",
  "ExitPlanMode",
];

/**
 * Recursively copy a directory tree, overwriting existing files. Used to
 * deploy vendored plugin files into each agent's .claude/plugins/ dir.
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const s = statSync(srcPath);
    if (s.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
      // Preserve executable bit for hook scripts (cleared on copy by default)
      if (s.mode & 0o100) {
        chmodSync(destPath, s.mode);
      }
    }
  }
}

/**
 * Write `content` to `filePath` only when the on-disk bytes differ.
 * Returns true when a write happened, false when skipped.
 *
 * Why this exists (idempotent apply): per-agent state dirs are mode
 * 0700 owned by per-agent UIDs (v0.7+ docker model). An `apply` that
 * rewrites byte-identical files needs write access to EVERY agent's
 * dir even when nothing changed — which is exactly what made hostd's
 * in-container reconcile fail fleet-wide ("Scaffolded 0/12 agents …
 * cannot write without privilege escalation") after a single-agent
 * config edit. Skipping identical content makes an idempotent apply
 * a true no-op for untouched agents: no write syscall, no write
 * permission needed.
 */
export function writeFileSyncIfChanged(
  filePath: string,
  content: string,
  mode?: number,
): boolean {
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, "utf-8") === content) return false;
    } catch {
      // Unreadable existing file — fall through and attempt the write;
      // the write's own error (if any) is the actionable one.
    }
  }
  writeFileSync(
    filePath,
    content,
    mode !== undefined ? { encoding: "utf-8" as const, mode } : "utf-8",
  );
  return true;
}

/**
 * Deep-compare two directories: true when `dest` contains exactly the
 * same file tree as `src` with byte-identical contents (and a matching
 * executable bit on files). Used to skip the rm+recopy of the vendored
 * hindsight plugin when nothing changed — see writeFileSyncIfChanged
 * for why unchanged content must not be rewritten.
 *
 * `contentOverrides` maps a POSIX-style path RELATIVE to `src` to the
 * content the DEST copy is expected to hold instead of the src bytes —
 * used for files switchroom rewrites after copy (the hindsight plugin's
 * settings.json gets switchroom overrides applied on top of the
 * vendor defaults, so the deployed file legitimately differs).
 *
 * Keys were once bare top-level file names and the map was DROPPED when
 * recursing into subdirectories. That silently broke the moment a stamped
 * file lived in a subdir: `hooks/hooks.json` is rewritten post-copy, so the
 * dest never matches the vendor bytes, so this returned false on every
 * reconcile and forced a needless rm+recopy of the whole plugin tree — which
 * also demands write access into an untouched agent's 0700 per-UID state dir,
 * the exact cost the fast path exists to avoid. Keys are now relative paths
 * and are threaded through the recursion.
 */
export function dirContentEquals(
  src: string,
  dest: string,
  contentOverrides?: Record<string, string>,
  relBase = "",
): boolean {
  if (!existsSync(src) || !existsSync(dest)) return false;
  let srcEntries: string[];
  let destEntries: string[];
  try {
    srcEntries = readdirSync(src).sort();
    destEntries = readdirSync(dest).sort();
  } catch {
    return false;
  }
  if (srcEntries.length !== destEntries.length) return false;
  for (let i = 0; i < srcEntries.length; i++) {
    if (srcEntries[i] !== destEntries[i]) return false;
  }
  for (const entry of srcEntries) {
    const s = join(src, entry);
    const d = join(dest, entry);
    let sStat;
    let dStat;
    try {
      sStat = statSync(s);
      dStat = statSync(d);
    } catch {
      return false;
    }
    const rel = relBase === "" ? entry : `${relBase}/${entry}`;
    if (sStat.isDirectory() !== dStat.isDirectory()) return false;
    if (sStat.isDirectory()) {
      if (!dirContentEquals(s, d, contentOverrides, rel)) return false;
    } else {
      if ((sStat.mode & 0o100) !== (dStat.mode & 0o100)) return false;
      try {
        const expected = contentOverrides?.[rel];
        if (expected !== undefined) {
          if (readFileSync(d, "utf-8") !== expected) return false;
        } else if (!readFileSync(s).equals(readFileSync(d))) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
}

/**
 * Seed the agent's `workspace/` directory from the profile's `workspace/`
 * subdirectory (if any). `.hbs` files are rendered with the handlebars
 * context; everything else is copied verbatim. Existing files are preserved
 * so user edits survive `switchroom apply` runs.
 *
 * Profiles should put OpenClaw-style bootstrap files (AGENTS.md, USER.md,
 * IDENTITY.md, TOOLS.md, MEMORY.md, ...) under their `workspace/` dir. At
 * runtime, `loadStableBootstrapFiles` / `loadDynamicBootstrapFiles` in
 * `src/agents/workspace.ts` discover and inject these files into Claude's
 * system prompt (stable) and per-turn context (dynamic).
 */
function seedWorkspaceBootstrapFiles(params: {
  profilePath: string;
  agentDir: string;
  context: Record<string, unknown>;
  created: string[];
  skipped: string[];
  rewrittenWithBackup: string[];
  /**
   * When false (agent `memory.file: false`), do NOT seed the curated
   * workspace MEMORY.md. Hindsight-native agents carry memory in the bank
   * (directives + mental models + retained facts), so seeding the file
   * here would re-create it after a migration delete. Defaults to seeding.
   */
  seedMemoryFile?: boolean;
}): void {
  const profileWorkspaceDir = join(params.profilePath, "workspace");
  if (!existsSync(profileWorkspaceDir)) {
    return;
  }
  const agentWorkspaceDir = join(params.agentDir, "workspace");
  mkdirSync(agentWorkspaceDir, { recursive: true });

  const walk = (relDir: string): void => {
    const srcDir = join(profileWorkspaceDir, relDir);
    if (!existsSync(srcDir)) return;
    for (const entry of readdirSync(srcDir)) {
      if (entry.startsWith(".") && entry !== ".gitkeep") continue;
      const relPath = relDir ? join(relDir, entry) : entry;
      const srcPath = join(profileWorkspaceDir, relPath);
      const srcStat = statSync(srcPath);
      if (srcStat.isDirectory()) {
        mkdirSync(join(agentWorkspaceDir, relPath), { recursive: true });
        walk(relPath);
        continue;
      }
      if (entry === ".gitkeep") continue; // presence-only marker, ignore
      // Hindsight-native gate: skip the curated MEMORY.md when the agent
      // opted out of file memory (memory.file: false). Covers both the
      // `.hbs` template and a plain MEMORY.md. Without this, a reconcile
      // would re-seed the file after a migration delete.
      if (params.seedMemoryFile === false && relPath.replace(/\.hbs$/, "") === "MEMORY.md") {
        params.skipped.push(join(agentWorkspaceDir, "MEMORY.md"));
        continue;
      }
      if (entry.endsWith(".hbs")) {
        const destRel = relPath.replace(/\.hbs$/, "");
        const destPath = join(agentWorkspaceDir, destRel);
        // SOUL.default.md is switchroom-OWNED, not user-owned: restore it
        // from the current profile template on every reconcile (overwrite
        // when changed) so baseline-persona improvements propagate
        // fleet-wide. The operator never edits it — their persona lives in
        // SOUL.md (seed-once below), which is composed AFTER it in the
        // stable bootstrap and therefore takes precedence. No sidecar
        // fold and no backup: there are no operator edits to preserve.
        if (destRel === "SOUL.default.md") {
          const rendered = renderTemplate(srcPath, params.context);
          const existed = existsSync(destPath);
          const current = existed ? readFileSync(destPath, "utf8") : null;
          if (current !== rendered) {
            writeFileSync(destPath, rendered);
            params.created.push(destPath);
          } else {
            params.skipped.push(destPath);
          }
          continue;
        }
        const renderFn = (): string => {
          // SOUL.md goes through the shared renderSoulMd path (folds in
          // the SOUL.custom.md sidecar at seed time). Post-seed the file
          // is the user's; the sidecar only shapes the initial draft.
          if (destRel === "SOUL.md") {
            return (
              renderSoulMd(
                params.profilePath,
                agentWorkspaceDir,
                params.context.soul,
              ) ?? renderTemplate(srcPath, params.context)
            );
          }
          return renderTemplate(srcPath, params.context);
        };
        // All workspace bootstrap files — SOUL.md (persona) included —
        // are user-owned: seeded once from the profile template, then
        // never overwritten by scaffold/reconcile/update. The profile
        // SOUL.md.hbs and `soul:` config are seed-time inputs only.
        // To re-seed from the (current) profile on demand, the operator
        // runs `switchroom soul reset <agent>`, which backs the file up
        // to SOUL.md.bak first. This is the deliberate inverse of
        // CLAUDE.md, which stays switchroom-managed via
        // rerenderWithFingerprint so machinery/template changes
        // propagate fleet-wide.
        writeIfMissing(
          destPath,
          renderFn,
          params.created,
          params.skipped,
        );
      } else {
        const destPath = join(agentWorkspaceDir, relPath);
        if (!existsSync(destPath)) {
          copyFileSync(srcPath, destPath);
          params.created.push(destPath);
        } else {
          params.skipped.push(destPath);
        }
      }
    }
  };
  walk("");
}

/**
 * Pre-seed migration: if the agent has a legacy `workspace/AGENTS.md`
 * regular file (pre-Phase 5 scaffold) and no `workspace/CLAUDE.md` yet,
 * rename AGENTS.md → CLAUDE.md so any agent-specific edits survive.
 * The subsequent seed pass is `writeIfMissing`, so it will skip CLAUDE.md
 * and preserve the migrated content. A later step replaces AGENTS.md with
 * a symlink into CLAUDE.md.
 *
 * Safe to call multiple times — does nothing if AGENTS.md is already a
 * symlink or if CLAUDE.md already exists.
 */
function migrateLegacyAgentsMdIfPresent(
  agentWorkspaceDir: string,
  created: string[],
): void {
  const agentsMd = join(agentWorkspaceDir, "AGENTS.md");
  const claudeMd = join(agentWorkspaceDir, "CLAUDE.md");
  if (!existsSync(agentsMd)) return;
  const stat = lstatSync(agentsMd);
  if (stat.isSymbolicLink()) return; // already migrated
  if (existsSync(claudeMd)) {
    // CLAUDE.md already present — legacy AGENTS.md will be removed by
    // ensureClaudeMdSymlinks so the symlink can take its place.
    return;
  }
  // Preserve agent-specific customizations by renaming.
  const content = readFileSync(agentsMd, "utf-8");
  writeFileSync(claudeMd, content, "utf-8");
  rmSync(agentsMd);
  created.push(claudeMd);
  console.log(
    chalk.dim(
      `  migrated legacy workspace/AGENTS.md → workspace/CLAUDE.md (content preserved)`,
    ),
  );
}

/**
 * Ensure `workspace/AGENTS.md` and `workspace/AGENT.md` are symlinks
 * pointing at `CLAUDE.md`. Mirrors the pattern used in the switchroom
 * repo's own root where AGENTS.md/AGENT.md are symlinks to CLAUDE.md so
 * every tooling convention resolves to the same file.
 *
 * Migration-safe: removes any pre-existing regular file or wrong-target
 * symlink at those paths before re-linking. Idempotent across reconcile
 * runs.
 *
 * No-op if workspace/CLAUDE.md doesn't exist (edge case — template wasn't
 * rendered, nothing to link to).
 */
function ensureClaudeMdSymlinks(
  agentWorkspaceDir: string,
  changes: string[],
): void {
  const claudeMd = join(agentWorkspaceDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) return;

  for (const name of ["AGENTS.md", "AGENT.md"] as const) {
    const linkPath = join(agentWorkspaceDir, name);
    if (existsSync(linkPath) || lstatExists(linkPath)) {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(linkPath);
        if (target === "CLAUDE.md") continue; // already correct
        rmSync(linkPath);
      } else {
        // Regular file from a previous scaffold — remove so the symlink
        // can take its place. Content has already been migrated into
        // CLAUDE.md by migrateLegacyAgentsMdIfPresent when applicable.
        rmSync(linkPath);
      }
    }
    symlinkSync("CLAUDE.md", linkPath);
    changes.push(linkPath);
  }
}

/**
 * `existsSync` follows symlinks, so a broken symlink reads as "doesn't
 * exist". Use lstat to detect link entries regardless of target health.
 */
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize the workspace directory as a git repository (if git is available).
 * Creates .gitignore to exclude ephemeral state (*.log), then makes an
 * initial commit capturing the seeded template content. SOUL.md is
 * user-owned and intentionally tracked so persona edits are versioned
 * and recoverable.
 *
 * Degrades gracefully if git is not on PATH. Returns true if init succeeded.
 */
function initWorkspaceGitRepo(
  workspaceDir: string,
  agentName: string,
): boolean {
  // Check git availability
  try {
    execSync("command -v git", { stdio: "ignore" });
  } catch {
    console.log(chalk.dim("  git not available, workspace versioning disabled"));
    return false;
  }

  // Skip if already a git repo
  const gitDir = join(workspaceDir, ".git");
  if (existsSync(gitDir)) {
    return true;
  }

  // Write .gitignore before git init
  const gitignore = `# Ephemeral runtime state
*.log

# OS/editor noise
.DS_Store
Thumbs.db
*.swp
*~
`;
  writeFileSync(join(workspaceDir, ".gitignore"), gitignore, "utf-8");

  // Initialize repo
  try {
    execSync("git init --quiet", { cwd: workspaceDir, stdio: "pipe" });
    execSync("git add -A", { cwd: workspaceDir, stdio: "pipe" });

    // Use switchroom's git identity if available from env, else fall back to generic.
    // execFileSync (argv array) — never interpolate env vars into a shell string.
    // GIT_AUTHOR_NAME='";rm -rf $HOME;#' as an env var would have been a real
    // injection vector through the previous execSync template literal.
    const userEmail = process.env.GIT_AUTHOR_EMAIL || "switchroom@localhost";
    const userName = process.env.GIT_AUTHOR_NAME || "Switchroom Agent";

    execFileSync(
      "git",
      [
        "-c", `user.email=${userEmail}`,
        "-c", `user.name=${userName}`,
        "commit",
        "-m", "chore: seed workspace from switchroom scaffold",
      ],
      { cwd: workspaceDir, stdio: "pipe" },
    );

    console.log(chalk.green(`  initialized workspace git repo (${agentName})`));
    return true;
  } catch (err) {
    // Non-fatal: workspace still usable without git
    console.log(chalk.dim(`  workspace git init failed: ${err instanceof Error ? err.message : String(err)}`));
    return false;
  }
}

/**
 * Vendored hindsight-memory plugin location. Pinned to the version we
 * ship; updated by `switchroom update`.
 *
 * Shares the shipped-asset probe with profiles/ and skills/ (#4160) —
 * the bare `resolve(import.meta.dirname, "../../vendor/hindsight-memory")`
 * resolved to `/vendor/hindsight-memory` inside a `bun build --compile`
 * binary, where `import.meta.dirname` is the bunfs virtual root.
 */
function resolveHindsightVendorResolution(): ShippedAssetResolution {
  return resolveShippedAsset(HINDSIGHT_VENDOR_ASSET, {
    bundleDir: import.meta.dirname,
    execPath: process.execPath,
  });
}

/**
 * Result of installing the vendored hindsight-memory plugin into an agent.
 */
export interface HindsightPluginInstall {
  pluginDir: string;
  apiBaseUrl: string;
  bankId: string;
}

/**
 * Install (or refresh) the vendored hindsight-memory plugin for an agent.
 *
 * Copies the plugin tree into <agentDir>/.claude/plugins/hindsight-memory/
 * and returns the metadata needed by the start.sh template to set
 * env vars and the --plugin-dir flag.
 *
 * Returns null when:
 *  - switchroom.yaml memory backend is not hindsight
 *  - the agent has memory.auto_recall: false
 *  - the vendored plugin source isn't present (e.g., bare switchroom install
 *    without the vendor dir)
 *
 * The plugin reads its config from environment variables (HINDSIGHT_*)
 * which start.sh exports — see templates/_base/start.sh.hbs.
 */
export function installHindsightPlugin(
  agentName: string,
  agentDir: string,
  switchroomConfig: SwitchroomConfig | undefined,
  /**
   * The caller's ALREADY-CASCADED agent config (defaults → profile → agent) —
   * the exact object the start.sh env exports are rendered from. Pass it
   * whenever you have one: it is what makes the two channels for the recall
   * envelope (env exports and plugin stamp) provably the same input rather than
   * two independent re-derivations that can disagree. Both production callers
   * (scaffoldAgent, reconcileAgentInner) thread it. See
   * resolveHindsightRecallConfig for what the fallback can and cannot do.
   */
  resolvedAgentConfig?: AgentConfig,
): HindsightPluginInstall | null {
  if (!switchroomConfig) return null;
  const memory = switchroomConfig.memory;
  // Same SWITCHROOM_MEMORY_BACKEND=none precedence as every other
  // hindsight gate — this runs unconditionally on scaffold AND
  // reconcile/restart, so a config-only check would re-copy the
  // hindsight plugin tree (re-activating its memory hooks) on a
  // `none` install (install-validation 2026-05-17, R2 review round 3).
  if (!isHindsightEnabled(switchroomConfig)) return null;
  // isHindsightEnabled true ⇒ memory.backend === "hindsight" ⇒ memory
  // is defined. Explicit narrowing for the type-checker (the old
  // `memory?.backend !== "hindsight"` gate used to provide it).
  if (!memory) return null;

  const agentMemory = switchroomConfig.agents[agentName]?.memory;
  // auto_recall from the CASCADED config (defaults → profile → agent), NOT the
  // raw per-agent map entry: a fleet-wide `defaults.memory.auto_recall: false`
  // or a profile-tier opt-out must disable the plugin too. Reading the raw
  // `agents[name].memory.auto_recall` here silently dropped both tiers (#3914),
  // installing the plugin for an agent the operator had turned recall off for.
  // resolveHindsightRecallConfig documents why re-deriving from the raw entry is
  // not equivalent to the caller's already-cascaded config.
  if (resolveHindsightAutoRecall(switchroomConfig, agentName, resolvedAgentConfig) === false) {
    return null;
  }

  const vendorResolution = resolveHindsightVendorResolution();
  if (vendorResolution.path === null) {
    // Loud about it: a missing vendor dir means the npm tarball was
    // packed without the `vendor/` entry (regression of the bug fixed
    // in this PR — `files` array in package.json must include
    // `vendor`). Silent-null left a fleet on v0.12.27 with `apply`
    // never refreshing the hindsight plugin tree on existing agents,
    // forcing manual sed workarounds across 9 agents.
    process.stderr.write(
      `installHindsightPlugin: vendor source missing ` +
        `(${describeShippedAssetSearch(vendorResolution)}) ` +
        `— hindsight plugin NOT installed for ${agentName}. ` +
        `Likely a packaging regression: check the npm tarball's files array.\n`,
    );
    return null;
  }
  const sourcePath = vendorResolution.path;

  // Copy the vendored plugin into the agent's .claude/plugins dir.
  // Force overwrite on every reconcile so plugin updates from
  // `switchroom update` propagate — but skip the rm+recopy entirely
  // when the deployed tree is already byte-identical to the vendor
  // source (idempotent apply must not need write access into an
  // untouched agent's 0700 per-UID state dir; see writeFileSyncIfChanged).
  // The deployed settings.json legitimately differs from the vendor's
  // (switchroom overrides applied post-copy below), so the comparison
  // uses the EXPECTED post-override rendering for that one file.
  const destPath = join(agentDir, ".claude", "plugins", "hindsight-memory");
  const additionalBanks = resolveUsers(switchroomConfig, agentName).additionalBanks;
  // Resolve the auto-retain cadence knobs from the CASCADED config
  // (defaults → profile → agent), mirroring how the recall knobs are read
  // in the env-export path (see resolveHindsightRetainConfig). These drive
  // the stamped settings.json values below, so a switchroom.yaml
  // `memory.retain.*` override is authoritative and survives reconcile.
  const retainConfig = resolveHindsightRetainConfig(
    switchroomConfig,
    agentName,
    resolvedAgentConfig,
  );
  // Per-row observation scope + per-retain strategy, from the CASCADED config.
  // These MUST be mirrored into the deployed settings.json (below), not left to
  // the start.sh env export alone: start.sh only exports HINDSIGHT_OBSERVATION_*
  // into the supervised claude session, so a docker-exec'd backfill/drain that
  // does NOT inherit that env falls back to the vendor settings.json default
  // (scope None / strategy "curated") and silently retains under the WRONG scope
  // (#3915). Stamping settings.json makes the supervised and exec'd processes
  // resolve identically — config.py reads settings.json first, env overrides it
  // with the same value in the supervised case.
  const observationScopeSettings = resolveHindsightObservationScopeSettings(
    switchroomConfig,
    agentName,
    resolvedAgentConfig,
  );
  // Recall latency envelope (hook ceiling / parallel deadline / per-bank
  // timeout) from the CASCADED config. Stamped onto the deployed plugin below
  // so `switchroom apply` RE-ASSERTS these values instead of reverting them —
  // see src/setup/hindsight-recall-tunables.ts for the full rationale.
  const recallTunables = resolveHindsightRecallTunables(
    resolveHindsightRecallConfig(switchroomConfig, agentName, resolvedAgentConfig),
  );
  const contentOverrides: Record<string, string> = {};
  try {
    const vendorSettingsPath = join(sourcePath, "settings.json");
    if (existsSync(vendorSettingsPath)) {
      const expectedSettings = renderHindsightSettingsOverrides(
        readFileSync(vendorSettingsPath, "utf-8"),
        additionalBanks,
        retainConfig,
        recallTunables,
        observationScopeSettings,
      );
      if (expectedSettings != null) contentOverrides["settings.json"] = expectedSettings;
    }
    const vendorHooksPath = join(sourcePath, "hooks", "hooks.json");
    if (existsSync(vendorHooksPath)) {
      const expectedHooks = renderHindsightHooksOverrides(
        readFileSync(vendorHooksPath, "utf-8"),
        recallTunables,
      );
      if (expectedHooks != null) contentOverrides["hooks/hooks.json"] = expectedHooks;
    }
  } catch {
    // Comparison aid only — a read failure just means we recopy.
  }
  const upToDate = dirContentEquals(sourcePath, destPath, contentOverrides);
  if (!upToDate) {
    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    copyDirRecursive(sourcePath, destPath);
  }

  // Apply switchroom-specific overrides on top of the vendored plugin's
  // default settings.json. Vendor stays untouched; overrides are applied
  // after every copy so they survive reconcile/restart.
  //
  // `retainEveryNTurns` / `retainOverlapTurns` (override from vendor
  // defaults `10` / `2`): the vendor default throttles auto-retention to
  // every 10th turn, so a short session can end before retention ever
  // fires. Switchroom stamps the CASCADED config value (defaults →
  // profile → agent, `memory.retain.every_n_turns` / `.overlap_turns`),
  // falling back to the switchroom scaffold defaults of 3 / 1 when unset.
  //
  // History: this used to be a hardcoded 1 / 2 (retain every single turn,
  // 3-turn window). That guaranteed a ≤2-turn fact-sharing session
  // survived a restart (the jtbd-memory-survives-restart UAT, 2026-05-20),
  // but once retain/consolidation moved to a LOCAL Ollama reasoning model
  // (gpt-oss-20b), the every-turn cadence with large overlapping windows
  // made the model run away (single retains generating 22k–37k output
  // tokens over 100–200s, starving workers). Default 3 / 1 = ~3× fewer,
  // smaller retains. Tradeoff: at n=3, up to ~3 turns of transcript can be
  // lost on a hard crash instead of ≤2 — an intentional swap of a little
  // crash durability for far cheaper, calmer retains. Operators who need
  // the tight every-turn guarantee back set `memory.retain.every_n_turns: 1`
  // in switchroom.yaml (per-agent or fleet-wide under `defaults`); chatty
  // banks can raise it further. Making it a yaml knob also makes the value
  // update-proof — it survives `switchroom apply`/reconcile, which
  // regenerates this settings.json and would otherwise revert hand-edits.
  // Resolve the effective extra recall banks for this agent — the static
  // shared-bank foundation for per-user memory (ship-B; RFC
  // reference/rfcs/per-speaker-memory-routing.md). Read from the CASCADED
  // config (defaults → profile → agent), mirroring how the env-export path
  // reads the sibling recall knobs (max_memories etc.) — so a fleet-wide
  // `defaults.memory.recall.additional_banks` is honoured, not just a
  // per-agent value. Now also folds in the `knows`-assigned user/bank profiles
  // (user concept, RFC reference/rfcs/user-concept.md); resolveUsers() handles
  // the cascade + union (defaults ∪ agent, generated ∪ explicit) itself.
  applyHindsightSettingsOverrides(
    destPath,
    additionalBanks,
    retainConfig,
    recallTunables,
    observationScopeSettings,
  );
  // Stamp the UserPromptSubmit recall-hook ceiling into the deployed
  // hooks/hooks.json. Claude Code reads this file directly and does NOT expand
  // env vars in the `timeout` field, so unlike the settings.json knobs there is
  // no env channel available — stamping the deployed copy is the only way to
  // make this value declarative. See hindsight-recall-tunables.ts.
  applyHindsightHooksOverrides(destPath, recallTunables);

  // Resolve the agent's bank/collection name and the Hindsight REST URL.
  // The plugin's hooks expect HINDSIGHT_API_URL (the REST base), not the
  // /mcp/ MCP endpoint URL — strip the suffix.
  const bankId = agentMemory?.collection ?? agentName;
  const mcpUrl = (memory.config?.url as string | undefined)
    ?? HINDSIGHT_DEFAULT_MCP_URL;
  const apiBaseUrl = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");

  return { pluginDir: destPath, apiBaseUrl, bankId };
}

/**
 * Switchroom scaffold defaults for the hindsight auto-retain cadence,
 * used when switchroom.yaml leaves `memory.retain.*` unset. Raised from
 * the historical 1 / 2 after retain/consolidation moved to a local
 * reasoning model that ran away on every-turn overlapping payloads — see
 * the rationale comment in installHindsightPlugin().
 */
const HINDSIGHT_DEFAULT_RETAIN_EVERY_N_TURNS = 3;
const HINDSIGHT_DEFAULT_RETAIN_OVERLAP_TURNS = 1;

/** Resolved auto-retain cadence for an agent (post-cascade, defaults applied). */
interface HindsightRetainConfig {
  everyNTurns: number;
  overlapTurns: number;
}

/**
 * Resolve the effective auto-retain cadence for an agent from the CASCADED
 * config (defaults → profile → agent), applying the switchroom scaffold
 * defaults when `memory.retain.*` is unset. Mirrors how the recall knobs
 * are resolved in the env-export path (resolveAgentConfig, then read the
 * merged `memory.recall.*`).
 */
function resolveHindsightRetainConfig(
  switchroomConfig: SwitchroomConfig | undefined,
  agentName: string,
  /**
   * The caller's already-cascaded agent config, when it has one. Preferred over
   * re-deriving for the SAME reason as resolveHindsightRecallConfig: the fallback
   * below resolves the `defaults:` tier ONLY (an empty stand-in carries no
   * `extends:`), so re-deriving there silently drops any
   * `profiles.<name>.memory.retain.*`. Both production callers thread it (#3914).
   */
  resolvedAgentConfig?: AgentConfig,
): HindsightRetainConfig {
  const retain = resolvedAgentConfig
    ? resolvedAgentConfig.memory?.retain
    : switchroomConfig
      ? resolveAgentConfig(
          switchroomConfig.defaults,
          switchroomConfig.profiles,
          // Some scaffold paths install the plugin for an agent that isn't in
          // the `agents` map yet (fresh scaffold); resolve against an empty
          // agent so the defaults tier still applies.
          switchroomConfig.agents[agentName] ?? ({} as AgentConfig),
        )?.memory?.retain
      : undefined;
  return {
    everyNTurns: retain?.every_n_turns ?? HINDSIGHT_DEFAULT_RETAIN_EVERY_N_TURNS,
    overlapTurns: retain?.overlap_turns ?? HINDSIGHT_DEFAULT_RETAIN_OVERLAP_TURNS,
  };
}

/**
 * Resolve the effective `memory.auto_recall` for an agent, honouring the full
 * cascade (defaults → profile → agent). Mirrors resolveHindsightRecallConfig:
 * prefer the caller's already-cascaded config; fall back to re-deriving for
 * config-free callers (whose fallback resolves the `defaults:` tier only — an
 * empty stand-in carries no `extends:`).
 */
function resolveHindsightAutoRecall(
  switchroomConfig: SwitchroomConfig | undefined,
  agentName: string,
  resolvedAgentConfig?: AgentConfig,
): boolean | undefined {
  if (resolvedAgentConfig) return resolvedAgentConfig.memory?.auto_recall;
  if (!switchroomConfig) return undefined;
  return resolveAgentConfig(
    switchroomConfig.defaults,
    switchroomConfig.profiles,
    switchroomConfig.agents[agentName] ?? ({} as AgentConfig),
  )?.memory?.auto_recall;
}

/**
 * The per-row observation scope pin (`memory.observation_scopes`) and the
 * per-retain strategy (`memory.observation_scope_strategy`), resolved from the
 * CASCADED config. `undefined` for a field means "operator set nothing" — the
 * stamp leaves the vendor default in place, exactly as start.sh emits no env
 * export in that case.
 */
interface HindsightObservationScopeSettings {
  observationScopes?: string;
  observationScopeStrategy?: string;
}

/**
 * Resolve the observation-scope settings for an agent, honouring the cascade
 * (defaults → profile → agent). Same prefer-cascaded / fallback-re-derive shape
 * as resolveHindsightRetainConfig; feeds the settings.json mirror so a
 * docker-exec'd retain resolves the same scope the supervised session does
 * (#3915).
 */
function resolveHindsightObservationScopeSettings(
  switchroomConfig: SwitchroomConfig | undefined,
  agentName: string,
  resolvedAgentConfig?: AgentConfig,
): HindsightObservationScopeSettings {
  const memory = resolvedAgentConfig
    ? resolvedAgentConfig.memory
    : switchroomConfig
      ? resolveAgentConfig(
          switchroomConfig.defaults,
          switchroomConfig.profiles,
          switchroomConfig.agents[agentName] ?? ({} as AgentConfig),
        )?.memory
      : undefined;
  return {
    observationScopes: memory?.observation_scopes,
    observationScopeStrategy: memory?.observation_scope_strategy,
  };
}

/**
 * Resolve the cascaded `memory.recall.*` block for an agent (defaults →
 * profile → agent). Mirrors resolveHindsightRetainConfig; feeds the recall
 * latency envelope resolver.
 */
export function resolveHindsightRecallConfig(
  switchroomConfig: SwitchroomConfig | undefined,
  agentName: string,
  /**
   * The caller's already-cascaded agent config, when it has one. Preferred over
   * re-deriving, and not merely as an optimisation: `start.sh.hbs` claims the
   * env exports and the plugin stamp "cannot diverge" because they share this
   * resolver — but sharing a resolver only helps if it is fed the same INPUT.
   * The env path reads the cascaded `agentConfig`; re-deriving here from
   * `switchroomConfig.agents[name]` reads a different object whenever the
   * caller's raw config is not literally that map entry.
   */
  resolvedAgentConfig?: AgentConfig,
): RecallTunableInput | undefined {
  if (resolvedAgentConfig) {
    return resolvedAgentConfig.memory?.recall as RecallTunableInput | undefined;
  }
  if (!switchroomConfig) return undefined;
  // Fallback for callers with no cascaded config (direct unit-test calls).
  // NOTE the limit, because the previous comment here overstated it: an agent
  // absent from the `agents` map carries no `extends:`, so an empty stand-in
  // resolves the `defaults:` tier ONLY and silently drops any
  // `profiles.<name>.memory.recall.*`. Both production callers thread their
  // cascaded config above, so the live path never takes this branch.
  const resolved = resolveAgentConfig(
    switchroomConfig.defaults,
    switchroomConfig.profiles,
    switchroomConfig.agents[agentName] ?? ({} as AgentConfig),
  );
  return resolved?.memory?.recall as RecallTunableInput | undefined;
}

/**
 * Stamp the managed UserPromptSubmit recall-hook ceiling into the deployed
 * plugin's `hooks/hooks.json`. Idempotent — runs after every plugin copy on
 * every scaffold/reconcile/restart, which is exactly what makes the value
 * survive `switchroom apply` reinstalling the plugin tree.
 */
function applyHindsightHooksOverrides(
  pluginDestPath: string,
  tunables: HindsightRecallTunables,
): void {
  const hooksPath = join(pluginDestPath, "hooks", "hooks.json");
  if (!existsSync(hooksPath)) return; // vendor structure changed; bail safely
  let raw: string;
  try {
    raw = readFileSync(hooksPath, "utf-8");
  } catch {
    return;
  }
  const next = renderHindsightHooksOverrides(raw, tunables);
  if (next == null) return; // malformed / no recall hook; don't make it worse
  writeFileSyncIfChanged(hooksPath, next);
}

/**
 * Per-bank recall slot floors, switchroom's shipped defaults.
 *
 * Sized against the cap this fleet actually deploys — 6, from
 * `defaults.memory.recall.max_memories` in switchroom.yaml, which cascades to
 * HINDSIGHT_RECALL_MAX_MEMORIES and wins over the 8 stamped into the plugin's
 * settings.json. recall.py bounds the two floors to half the cap between them
 * (`_reservable_slots`), so 2 + 1 is the largest pair that is fully honoured at
 * cap 6 while still leaving three slots to pure global relevance. Floors that
 * summed to the cap would stop being floors and become a fixed quota.
 *
 * These are also the values exported to the environment unconditionally (see
 * `start.sh.hbs`) so a stale `~/.hindsight/claude-code.json` — which loads
 * AFTER the plugin's settings.json — cannot shadow them (#3774).
 */
const HINDSIGHT_OWN_BANK_MIN_SLOTS_DEFAULT = 2;
const HINDSIGHT_ADDITIONAL_BANK_MIN_SLOTS_DEFAULT = 1;

/**
 * Absolute relevance floor for injected memories (#3837), switchroom's shipped
 * default: OFF.
 *
 * 0 disables the filter outright in recall.py (`_filter_by_min_score`
 * short-circuits), so the fleet's injected sets are unchanged by #3837 until an
 * operator opts in. That is deliberate and it is what the measurement supports:
 * a below-floor `scores.final` predicts noise on a DEGRADED own-bank read
 * (98.4% of those rows have a best injected score under 0.01) but not on a
 * healthy one (28.4% do), and the score is not calibrated across queries, so
 * there is no fleet-wide value safe to turn on unmeasured.
 *
 * The scope constant is the population a non-zero floor binds on and defaults
 * to "degraded" for the same reason — it is inert while the floor is 0. Both
 * are exported unconditionally for the #3774 reason above.
 */
const HINDSIGHT_RECALL_MIN_SCORE_DEFAULT = 0;
const HINDSIGHT_RECALL_MIN_SCORE_SCOPE_DEFAULT = "degraded";

/**
 * Merge switchroom-specific overrides into the vendored hindsight
 * plugin's `settings.json`. Idempotent — runs after every plugin
 * copy on every scaffold/reconcile/restart.
 *
 * Currently overrides:
 *   - `retainEveryNTurns`: 10 → configured (default 3; `memory.retain.every_n_turns`)
 *   - `retainOverlapTurns`: 2 → configured (default 1; `memory.retain.overlap_turns`)
 *   - `retainMode`: full-session → chunked (Phase 6b: window, not whole
 *     transcript, re-consolidated per fire; paired with the vendor
 *     retain.py divergence)
 *   - `recallMaxMemories`: 12 → 8 (tighter prompt, less model noise)
 *   - `recallOwnBankMinSlots` / `recallAdditionalBankMinSlots`: 0/0 → 2/1
 *     (neither bank can take every slot of the deployed cap of 6)
 *
 * Future overrides go here, NOT in the vendor file. The vendor is
 * third-party code and must remain untouched for clean upstream
 * updates. This function is the single point of switchroom-specific
 * memory tuning.
 */
function applyHindsightSettingsOverrides(
  pluginDestPath: string,
  additionalBanks: readonly string[],
  retainConfig: HindsightRetainConfig,
  recallTunables: HindsightRecallTunables,
  observationScopeSettings: HindsightObservationScopeSettings,
): void {
  const settingsPath = join(pluginDestPath, "settings.json");
  if (!existsSync(settingsPath)) return; // vendor structure changed; bail safely
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return;
  }
  const next = renderHindsightSettingsOverrides(
    raw,
    additionalBanks,
    retainConfig,
    recallTunables,
    observationScopeSettings,
  );
  if (next == null) return; // malformed settings; don't make it worse
  writeFileSyncIfChanged(settingsPath, next);
}

/**
 * Pure half of applyHindsightSettingsOverrides: given the raw
 * settings.json text, return the post-override serialization (or null
 * when the input isn't valid JSON). Split out so installHindsightPlugin
 * can compute the EXPECTED deployed settings.json from the vendor
 * source and feed it to dirContentEquals' topLevelOverrides — that's
 * what lets an unchanged plugin tree skip the rm+recopy entirely.
 */
function renderHindsightSettingsOverrides(
  raw: string,
  additionalBanks: readonly string[],
  retainConfig: HindsightRetainConfig,
  recallTunables: HindsightRecallTunables,
  observationScopeSettings: HindsightObservationScopeSettings,
): string | null {
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(raw);
  } catch {
    return null; // vendor's settings.json malformed; don't make it worse
  }
  // Override: auto-retain cadence, from the cascaded config (defaults 3 / 1).
  // See the rationale in installHindsightPlugin() above — the yaml knob
  // (memory.retain.every_n_turns / .overlap_turns) is authoritative and,
  // being stamped here on every scaffold/reconcile, survives `switchroom
  // apply` regenerating this file.
  settings.retainEveryNTurns = retainConfig.everyNTurns;
  // Phase 6b (RFC reference/rfcs/hindsight-synthesis-layers.md): switch from
  // the vendor default retainMode="full-session" to "chunked". This is the
  // crux of Phase 6b option A — STOP re-consolidating the whole accumulated
  // transcript on every Stop fire. Under full-session, each fire re-sent the
  // entire growing transcript to Hindsight's consolidation engine — the
  // ~1M-tokens/day/agent invisible spend. In chunked mode retain.py slices
  // only the recent window (retainOverlapTurns + retainEveryNTurns turns) per
  // fire.
  //
  // Crash-durability note: at the historical retainEveryNTurns=1 every turn
  // retained on its own fire, so no fact could fall outside a window and a
  // ≤2-turn session always survived a restart (the jtbd-memory-survives-
  // restart UAT). At the current default of 3, retention fires every 3rd
  // turn, so up to ~3 turns of transcript can be lost on a hard crash before
  // the next fire — the intentional tradeoff for smaller, calmer retains that
  // don't run the local reasoning consolidation model away. Operators who
  // need the tight guarantee back set memory.retain.every_n_turns: 1.
  //
  // This chunked override is INERT without the paired vendor patch: upstream
  // retain.py gated chunked window-slicing on `retainEveryNTurns > 1`. The
  // switchroom divergence in vendor/hindsight-memory/scripts/retain.py
  // (select_retain_window) decouples the window slice from that throttle,
  // which is what makes chunked retain actually take effect. See that file's
  // header comment + the CHANGELOG entry.
  settings.retainMode = "chunked";
  // retainOverlapTurns from the cascaded config (default 1) → window =
  // overlap_turns + every_n_turns recent turns per fire (default 1 + 3 = 4).
  settings.retainOverlapTurns = retainConfig.overlapTurns;
  // Provenance on auto-retained transcript content. The vendor default is
  // `["{session_id}"]` — a bare session UUID, which is filterable but carries
  // no meaning, so nothing downstream could ask "did a human assert this, or
  // did fact extraction lift it out of a transcript (possibly out of the
  // agent's OWN synthesis)?". Hindsight's best-practices page is explicit that
  // metadata is NOT filterable and tags ARE, so the marker has to be a tag.
  // `{session_id}` is kept — it is what the curated observation-scope strategy
  // recognises as volatile, and what `switchroom memory` surfaces. See
  // src/memory/hindsight-retain-provenance.ts for the full rationale, including
  // why the paired vendor change keeps the new tag OUT of the consolidation
  // scope so this is not a silent scope migration.
  settings.retainTags = [...RETAIN_TAGS_DEFAULT];
  // v0.13.22 smart defaults: at our recallBudget=low the vendor's 12
  // memories is generous; 8 keeps prompt noise down without hurting
  // the substantive recall@N (top-8 carries the same dominant facts
  // that top-12 does, per the 2026-05-24 audit's recall-quality sample).
  // Operators can re-raise via memory.recall.max_memories in switchroom.yaml.
  settings.recallMaxMemories = 8;
  // Recall latency envelope. Both of these were previously UNMANAGED:
  // `recallParallelDeadlineSeconds` was readable from config but nothing in
  // switchroom ever resolved it from switchroom.yaml, and the per-bank timeout
  // was a bare `timeout=8` literal in recall.py with no config key at all. So
  // the only way to tune either was to hand-edit the installed plugin, which
  // the next `switchroom apply` reverted (three recorded times). Stamping them
  // here from the cascaded config is what makes an apply RE-ASSERT the
  // operator's value instead of throwing it away.
  //
  // The values are a nested set of deadlines (per-bank <= shared <= hook
  // ceiling); resolveHindsightRecallTunables owns the derivation and clamping,
  // and the hook ceiling half is stamped into hooks/hooks.json by
  // applyHindsightHooksOverrides. Operators tune via
  // memory.recall.{hook,parallel_deadline,request}_timeout_seconds.
  settings.recallParallelDeadlineSeconds = recallTunables.parallelDeadlineSeconds;
  settings.recallRequestTimeoutSeconds = recallTunables.requestTimeoutSeconds;
  // Phase 1 (RFC reference/rfcs/hindsight-synthesis-layers.md): consume
  // the synthesized `observation` tier at recall, not just raw
  // world/experience. Observations are deduped, dated, provenance-backed
  // syntheses the consolidation engine already generates on every retain
  // — excluding them threw away the curated tier and left recall as the
  // "grab-bag" the remember-across-sessions job calls bad. An A/B on the
  // test-harness bank showed observations rank top, reconcile contradictory
  // raw facts, and dedup near-duplicates, at neutral recall latency and
  // zero model spend (recall is retrieval + local rerank). This is the
  // ON-BY-DEFAULT value for every agent on every install; operators opt
  // OUT per-agent (or fleet-wide under `defaults`) via memory.recall.types
  // in switchroom.yaml — start.sh exports HINDSIGHT_RECALL_TYPES only when
  // overridden, and the env value wins over this settings.json default.
  settings.recallTypes = ["world", "experience", "observation"];
  // Per-bank slot FLOORS inside recallMaxMemories. The merged multi-bank set
  // is sorted globally by `scores.final` and head-sliced, which is
  // winner-take-all across banks: on a turn where both banks return more
  // candidates than the cap, one bank's score distribution can fill every slot.
  // The shared `ken-profile` bank is the side that wins in practice (short,
  // dense, highly-rerankable statements), so the agent is handed a dossier
  // about its operator and none of its own session memory.
  //
  // Scope, stated honestly: this fixes score-based crowd-out among results that
  // DID return. It does NOT fix the own-bank timeout — a timed-out bank
  // contributes no candidates, so reservation is a strict no-op there. Across
  // 1,036 multi-bank non-cache recalls since 2026-07-20, both banks were alive
  // on 15.1% of turns fleet-wide (6.4% for overlord); own-dead/profile-alive is
  // 67.0% (83.5% for overlord). The telemetry shipped alongside this
  // (`injected_own_bank_count`) is what makes THAT case legible — it is the
  // field that would have caught the own-bank outage, since a fully timed-out
  // own bank still logs a full `result_count`.
  //
  // 2/1 against the cap this fleet actually deploys — which is 6, not the 8
  // stamped above: `defaults.memory.recall.max_memories: 6` in switchroom.yaml
  // cascades to HINDSIGHT_RECALL_MAX_MEMORIES, and env wins over settings.json.
  // FLOORS, not quotas, and enforced as such: recall.py bounds the two floors to
  // HALF the cap between them (`_reservable_slots`), so at least three of six
  // slots are always won on pure relevance and composition still moves with the
  // scores. Floors that summed to the cap (4+2 at 6) would be a fixed quota with
  // no score influence at all. Each side also gets its floor only if it returned
  // that many, so a silent bank wastes nothing. Operators re-tune via
  // memory.recall.own_bank_min_slots / .additional_bank_min_slots in
  // switchroom.yaml (0/0 = the pre-fix head-slice). Vendor default is 0/0; this
  // is the switchroom opt-in.
  settings.recallOwnBankMinSlots = HINDSIGHT_OWN_BANK_MIN_SLOTS_DEFAULT;
  settings.recallAdditionalBankMinSlots = HINDSIGHT_ADDITIONAL_BANK_MIN_SLOTS_DEFAULT;
  // Phase 6a: on top of the ack-skip, skip recall on plausibly-stateless
  // trivial turns (time/date/day, bare greetings) — saves the ~1-2s
  // recall arm + up to ~1024 injected tokens on turns that never need
  // user memory. Conservative + guarded against any personal/stateful
  // signal (see recall.py `_is_trivial_stateless`). On by default; operators
  // opt OUT via memory.recall.skip_trivial=false in switchroom.yaml
  // (exported as HINDSIGHT_RECALL_SKIP_TRIVIAL only when overridden).
  settings.recallSkipTrivial = true;
  // #2848 Stage B: deterministic directive-capture nudge ON by default.
  // Stage A audit found a ~55% miss rate on durable corrections (guidance-
  // only capture is a per-agent lottery), so recall.py regex-detects
  // correction-shaped inbound and nudges the model to persist it with
  // create_directive — the model does the judgment in-session (no model
  // callsite). Operators opt OUT per-agent via memory.directive_capture_nudge
  // =false (exported as HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE only when overridden;
  // the env value wins over this settings.json default).
  settings.directiveCaptureNudge = true;
  // hindsight-leverage PR5 — recall-side weight for sidechain (sub-agent)
  // memories. The paired SubagentStop retain (vendor .../subagent_retain.py)
  // tags delegated worker process-facts `sidechain`; this down-weights their
  // recall `scores.final` by 0.8 so first-party session memory ranks first,
  // while a sidechain fact still surfaces when it is the only relevant hit
  // (a DOWN-RANK, not the hard demote-tag DROP filter).
  //
  // #3841: the first-class knob is now `memory.recall.tag_weights`, which
  // MERGES over this seed (an explicit `sidechain: 1.0` neutralises it) and is
  // exported as HINDSIGHT_RECALL_TAG_WEIGHTS from start.sh unconditionally.
  // The seed literal lives in hindsight-recall-passthrough.ts so this stamp and
  // that export cannot drift. NOTE the migration: because the export is now
  // unconditional, a raw `HINDSIGHT_RECALL_TAG_WEIGHTS` in an agent's `env:`
  // map (the pre-#3841 escape hatch, set on the container BEFORE start.sh runs)
  // no longer wins — use the yaml knob.
  settings.recallTagWeights = { ...HINDSIGHT_RECALL_TAG_WEIGHT_SEED };
  // Static shared-bank recall (RFC reference/rfcs/per-speaker-memory-routing.md,
  // ship-B): recall these extra banks on every turn, merged into the agent's
  // own bank results. Sourced from memory.recall.additional_banks (cascaded);
  // written per-agent because settings.json is per-agent. Left at the vendor
  // default ([]) when unset. The plugin recalls each with an 8s timeout and is
  // non-fatal on failure. Single-tenant: all banks are the operator's data.
  if (additionalBanks.length > 0) {
    settings.recallAdditionalBanks = [...additionalBanks];
  }
  // #2816 tag-filter port — still DORMANT BY DEFAULT, now operator-reachable.
  // The vendored recall.py reads `recallTags` / `recallTagsMatch` /
  // `recallTagGroups` / `recallAdditionalBankFilters` (upstream 962140eef).
  // Nothing is stamped here, deliberately: the settings.json side stays at the
  // vendor no-op (empty filter = match everything), so an agent with no
  // `memory.recall.tags*` config filters nothing, exactly as before.
  //
  // What #3841 changed is only the LEVER, not the default. The four keys now
  // have a `memory.recall.{tags,tags_match,tag_groups,additional_bank_filters}`
  // cascade surface, exported unconditionally from start.sh at their existing
  // effective values ([] / "any" / {} / {}) — the passthrough shape #3774
  // requires. That is the wiring the old TODO here described, minus the part it
  // warned against: switchroom still does NOT invent a per-bank tag taxonomy.
  // reference/rfcs/hindsight-synthesis-layers.md frames the port as "a
  // ready-made hook for future recall shaping (e.g. scoping additional-bank
  // recall to specific tags), currently dormant"; an operator who has such a
  // taxonomy in their own bank can now express it in switchroom.yaml instead of
  // hand-editing the installed plugin, and one who does not is unaffected.
  // Per-row observation scope pin + per-retain strategy (#3915). Mirror the
  // CASCADED config into the deployed settings.json so a docker-exec'd retain —
  // a `backfill_transcripts.py` / consolidation drain that does NOT inherit the
  // supervised session's start.sh env exports — resolves the SAME scope the
  // supervised session does. config.py loads settings.json first and lets the
  // HINDSIGHT_OBSERVATION_* env override it, so in the supervised case the two
  // channels carry the identical value; in the exec'd case settings.json is the
  // only channel, and before this it silently fell back to the vendor default
  // (scope None / strategy "curated") — retaining under the wrong scope.
  //
  // Stamp ONLY when the operator set the value, byte-for-byte matching start.sh's
  // "export only when set" semantics: an unset field leaves the vendor default
  // (config.py: observationScopes None, observationScopeStrategy "curated"), so
  // an agent that configured neither is unchanged and the field never reaches
  // the wire. No re-validation here — the schema already rejects off-list values
  // at parse time, and matching start.sh's raw passthrough is what keeps the two
  // channels provably identical.
  const observationScopes = observationScopeSettings.observationScopes;
  if (typeof observationScopes === "string" && observationScopes.length > 0) {
    settings.observationScopes = observationScopes;
  }
  const observationScopeStrategy = observationScopeSettings.observationScopeStrategy;
  if (typeof observationScopeStrategy === "string" && observationScopeStrategy.length > 0) {
    settings.observationScopeStrategy = observationScopeStrategy;
  }
  return JSON.stringify(settings, null, 2) + "\n";
}

/**
 * Attempt to locate the switchroom CLI binary. Used to populate SWITCHROOM_CLI_PATH
 * in the .mcp.json env for the switchroom-telegram MCP server. Falls back to
 * the literal string "switchroom" if `which switchroom` is unavailable.
 */
function resolveSwitchroomCliPath(): string {
  try {
    const result = execSync("which switchroom", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (result) {
      return result;
    }
  } catch {
    /* switchroom not on PATH */
  }
  return "switchroom";
}

/**
 * Scaffold (or reconcile) the directory structure for a single agent.
 *
 * Idempotent: creates missing files and directories but never overwrites
 * existing ones.
 */
/**
 * Inputs for {@link buildWorkspaceContext}. Shared shape used by both
 * `scaffoldAgent` (full-context builder for start.sh / settings.json /
 * workspace templates) and `reconcileAgent` (workspace re-seed path).
 *
 * Keeping one source of truth means a new handlebars key added to any
 * workspace template automatically resolves identically on both paths —
 * closing the gap where `reconcileAgent` used to rebuild a 7-key subset
 * and silently render `""` for anything else.
 */
/**
 * The `permissions.defaultMode` values Claude Code accepts in
 * .claude/settings.json. This is a SUBSET of the schema's `permission_mode`
 * enum — `auto` and `dontAsk` are valid `--permission-mode` CLI flags but
 * have no settings.json defaultMode equivalent, so they degrade to the
 * built-in default in resolvePermissionDefaultMode().
 */
const VALID_SETTINGS_DEFAULT_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
] as const;
type SettingsDefaultMode = (typeof VALID_SETTINGS_DEFAULT_MODES)[number];

/** The switchroom-wide built-in default permission mode (no yaml needed). */
const SWITCHROOM_DEFAULT_PERMISSION_MODE: SettingsDefaultMode = "acceptEdits";

/**
 * Resolve the settings.json `permissions.defaultMode` for an agent.
 *
 * Precedence (highest wins):
 *   1. agentConfig.permission_mode                 — per-agent override
 *   2. switchroomConfig.defaults?.permission_mode  — fleet-wide override
 *   3. "acceptEdits"                               — switchroom built-in default
 *
 * This is deliberately INDEPENDENT of the `[all]` tools wildcard: the wildcard
 * drives allow-list expansion (ALL_BUILTIN_TOOLS) only, never the mode default.
 * So every agent gets a defaultMode — an [all] agent still defaults to
 * acceptEdits, and an explicit per-agent `permission_mode: default` wins even
 * over the wildcard.
 *
 * NOTE: resolveAgentConfig / merge.ts already folds `defaults.permission_mode`
 * into `agentConfig.permission_mode` (per-agent wins, defaults fill blanks),
 * so (2) is a belt-and-suspenders fallback for any caller that passes an
 * unmerged config — it never changes the outcome once the cascade has run.
 */
function resolvePermissionDefaultMode(
  agentConfig: AgentConfig,
  switchroomConfig?: SwitchroomConfig,
): SettingsDefaultMode {
  const raw =
    agentConfig.permission_mode ??
    switchroomConfig?.defaults?.permission_mode ??
    SWITCHROOM_DEFAULT_PERMISSION_MODE;
  if ((VALID_SETTINGS_DEFAULT_MODES as readonly string[]).includes(raw)) {
    return raw as SettingsDefaultMode;
  }
  // `raw` is a schema-valid permission_mode with no settings.json defaultMode
  // equivalent (auto/dontAsk), or an unexpected value. The `--permission-mode`
  // CLI flag (start.sh.hbs) still carries the original value; for the
  // settings.json defaultMode we degrade to the built-in default and warn.
  console.warn(
    chalk.yellow(
      `[switchroom] permission_mode "${raw}" has no settings.json defaultMode ` +
      `equivalent — using "${SWITCHROOM_DEFAULT_PERMISSION_MODE}" for ` +
      `permissions.defaultMode (the --permission-mode CLI flag still carries "${raw}").`,
    ),
  );
  return SWITCHROOM_DEFAULT_PERMISSION_MODE;
}

interface BuildWorkspaceContextArgs {
  name: string;
  agentDir: string;
  agentConfig: AgentConfig;
  telegramConfig: TelegramConfig;
  switchroomConfig?: SwitchroomConfig;
  switchroomConfigPath?: string;
  topicId?: number;
  tools: { allow?: string[]; deny?: string[] };
  permissionAllow: string[];
  hasAllWildcard: boolean;
  resolvedBotToken?: string;
  rawBotToken?: string;
  hindsightAutoRecallEnabled: boolean;
  hindsightBankId: string;
  hindsightApiBaseUrl: string;
  hindsightRecallMaxMemories: number | undefined;
  hindsightRecallCacheTtlSecs: number | undefined;
  // Recall latency envelope — always defined (resolveHindsightRecallTunables
  // supplies the shipped defaults), because start.sh exports these
  // unconditionally so switchroom.yaml outranks a stale
  // ~/.hindsight/claude-code.json. See the template comment.
  hindsightRecallParallelDeadlineSeconds: number;
  /**
   * Switchroom #3757 — BM25 term cap for the recall query, the bank-specific
   * stop-term list beside it, and the per-bank request timeout. These live in
   * switchroom.yaml specifically so they SURVIVE `switchroom apply`: apply
   * re-copies the plugin from `vendor/hindsight-memory`, so a hand-edit of the
   * installed `scripts/recall.py` is reverted on the next reconcile — which is
   * exactly how the hardcoded 8s timeout came back on 2026-07-27.
   */
  // Always concrete — these three are exported unconditionally (see the
  // resolution site) so the env can never be shadowed by a stale
  // ~/.hindsight/claude-code.json.
  hindsightRecallQueryMaxTokens: number;
  hindsightRecallQueryStopTermsJson: string;
  hindsightRecallRequestTimeoutSeconds: number;
  // Always resolved (operator override ?? shipped default) — start.sh exports
  // these unconditionally so a stale claude-code.json cannot shadow them.
  hindsightRecallOwnBankMinSlots: number;
  hindsightRecallAdditionalBankMinSlots: number;
  // #3837 — absolute relevance floor + the population it binds on. Also always
  // resolved and always exported (0 = off, the shipped default).
  hindsightRecallMinScore: number;
  hindsightRecallMinScoreScope: string;
  // #3841 — the remaining recall knobs, resolved to their effective values and
  // exported unconditionally for the same #3774 reason. Carried as one object
  // rather than 15 flat fields; buildWorkspaceContext shell-quotes the
  // JSON/string members into `hindsightRecallPass` for the template.
  hindsightRecallPassthrough: HindsightRecallPassthrough;
  // Phase 1 / 6a opt-out cascade. Comma-joined types + stringified bool,
  // each undefined unless the operator overrode the switchroom default.
  hindsightRecallTypes?: string;
  hindsightRecallSkipTrivial?: string;
  // #2848 Stage B — directive-capture nudge opt-out. Stringified bool,
  // undefined unless the operator overrode the switchroom default (on).
  hindsightDirectiveCaptureNudge?: string;
  // Per-row observation scope. undefined unless the operator set
  // memory.observation_scopes; exported only when set.
  hindsightObservationScopes?: string;
  // Per-retain observation-scope strategy selector. undefined unless the
  // operator set memory.observation_scope_strategy; exported only when set.
  hindsightObservationScopeStrategy?: string;
  // PR6 — supergroup-mode topic tagging. JSON map of {alias: thread_id}
  // injected as HINDSIGHT_TOPIC_ALIASES_JSON so retain.py can resolve
  // numeric thread_ids to human alias names in memory metadata.
  // Optional filter-mode env injected at scaffold time (default
  // "soft-preamble" if unset; "hard-filter" to drop cross-topic memories).
  hindsightTopicAliasesJson?: string;
  // Switchroom (per-speaker memory routing): JSON map of {sender: bank}
  // injected as HINDSIGHT_SENDER_BANKS_JSON so recall.py routes recall to
  // the speaker's profile bank.
  hindsightSenderBanksJson?: string;
  hindsightTopicFilterMode?: string;
}

/**
 * Build the handlebars render context used for profile templates
 * (start.sh, settings.json) AND workspace bootstrap templates
 * (AGENTS.md, SOUL.md, ...). Both scaffold and reconcile call this so
 * new workspace-template keys stay in lockstep across the two paths.
 */
function buildWorkspaceContext(args: BuildWorkspaceContextArgs): Record<string, unknown> {
  const {
    name,
    agentDir,
    agentConfig,
    telegramConfig,
    switchroomConfig,
    switchroomConfigPath,
    topicId,
    tools,
    permissionAllow,
    resolvedBotToken,
    rawBotToken,
    hindsightAutoRecallEnabled,
    hindsightBankId,
    hindsightApiBaseUrl,
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallParallelDeadlineSeconds,
    hindsightRecallQueryMaxTokens,
    hindsightRecallQueryStopTermsJson,
    hindsightRecallRequestTimeoutSeconds,
    hindsightRecallOwnBankMinSlots,
    hindsightRecallAdditionalBankMinSlots,
    hindsightRecallMinScore,
    hindsightRecallMinScoreScope,
    hindsightRecallPassthrough,
    hindsightRecallTypes,
    hindsightRecallSkipTrivial,
    hindsightDirectiveCaptureNudge,
    hindsightObservationScopes,
    hindsightObservationScopeStrategy,
    hindsightTopicAliasesJson,
    hindsightSenderBanksJson,
    hindsightTopicFilterMode,
  } = args;
  return {
    name,
    // BAKED into start.sh (cd, CLAUDE_CONFIG_DIR, --plugin-dir, …). Must be a
    // HOST path, not the in-container /host-home, when apply runs inside hostd.
    // See toHostHomePath. The filesystem writes elsewhere keep the local value.
    agentDir: toHostHomePath(agentDir),
    topicId,
    topicName: agentConfig.topic_name,
    topicEmoji: agentConfig.topic_emoji,
    soul: agentConfig.soul,
    user: (agentConfig as unknown as { user?: unknown }).user,
    agentConfig,
    tools,
    toolsDeny: dedupe([
      ...(tools.deny ?? []),
      ...webkiteDenyForAgent(agentConfig),
      ...INTERACTIVE_TUI_FLEET_DENY_TOOLS,
    ]),
    permissionAllow,
    // settings.json permissions.defaultMode. Decoupled from the `[all]` tools
    // wildcard (#PR): the built-in switchroom default is acceptEdits for EVERY
    // agent, overridable per-agent via permission_mode or fleet-wide via
    // defaults.permission_mode. See resolvePermissionDefaultMode.
    defaultMode: resolvePermissionDefaultMode(agentConfig, switchroomConfig),
    memory: agentConfig.memory,
    model: agentConfig.model,
    mcpServers: agentConfig.mcp_servers
      ? filterMcpServers(agentConfig.mcp_servers)
      : agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: resolvedBotToken ?? rawBotToken,
    forumChatId: telegramConfig.forum_chat_id,
    dangerousMode: agentConfig.dangerous_mode === true,
    // `{{#if admin}}` in CLAUDE.md.hbs (the "Admin operations" section)
    // keys off this. MUST mirror the reconcile path's claudeContext
    // (~scaffold.ts `admin: agentConfig.admin === true`). It was
    // missing here, so the `switchroom apply` / scaffoldAgent render
    // (which uses THIS context) always rendered the non-admin
    // `{{else}}` branch — every admin agent's CLAUDE.md told it "you
    // are NOT admin, hand fleet ops off", the klanker incident. The
    // two render sites diverging on exactly this field is the hazard
    // the comment at the reconcile site warns about.
    // `root: true` implies admin, so the root agent also gets the
    // Admin-operations section; `root` additionally selects the
    // root-tier capability block (see CLAUDE.md.hbs `{{#if root}}`).
    admin: agentConfig.admin === true || agentConfig.root === true,
    root: agentConfig.root === true,
    useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
    useHotReloadStable: agentConfig.channels?.telegram?.hotReloadStable === true,
    // PR C: surface channels.telegram.enabled into start.sh as a literal
    // "true"/"false" string. Default true preserves prior behavior.
    telegramEnabledFlag:
      agentConfig.channels?.telegram?.enabled === false ? "false" : "true",
    // `{{#if linearAgentEnabled}}` in the agent-self-service fragment keys
    // off this to render the capture-on-reaction → Linear playbook (#2312).
    // Set HERE in the shared builder (not at the two render sites) precisely
    // to avoid the klanker hazard: both scaffoldAgent's `context` and
    // reconcileAgent's `claudeContext` derive from buildWorkspaceContext, so
    // the flag resolves identically on both paths — a diverging value would
    // diff-abort every reconcile.
    linearAgentEnabled:
      (
        agentConfig.channels?.telegram as
          | { linear_agent?: { enabled?: boolean } }
          | undefined
      )?.linear_agent?.enabled === true,
    // sec WS8-F1 / #1416: unconditional read-only image-baked
    // security-hooks plugin dir. Always set — it is the unstrippable
    // tool-safety authority, not an opt-in feature.
    securityPluginDir: DOCKER_SECURITY_PLUGIN_PATH,
    hindsightEnabled: hindsightAutoRecallEnabled,
    hindsightBankIdQ: shellSingleQuote(hindsightBankId),
    hindsightApiBaseUrlQ: shellSingleQuote(hindsightApiBaseUrl),
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallParallelDeadlineSeconds,
    hindsightRecallQueryMaxTokens,
    hindsightRecallQueryStopTermsJson,
    hindsightRecallRequestTimeoutSeconds,
    hindsightRecallOwnBankMinSlots,
    hindsightRecallAdditionalBankMinSlots,
    hindsightRecallMinScore,
    hindsightRecallMinScoreScope,
    // #3841 — one nested object, so start.sh.hbs reads
    // `{{hindsightRecallPass.budget}}` etc. Structural values arrive
    // pre-serialised from the resolver and are shell-single-quoted here (the
    // preamble is free-form operator text and the JSON carries double quotes;
    // neither is safe bare). Never empty: an empty export is skipped by
    // `_cast_env` and hands authority back to ~/.hindsight/claude-code.json.
    // Built by the shared helper, NOT inline: reconcileAgentInner hand-builds
    // its own template context, and a second copy of this mapping is the
    // init-vs-reconcile drift scaffold.memory-prompt.test.ts guards.
    hindsightRecallPass: recallPassthroughTemplateFields(
      hindsightRecallPassthrough,
      shellSingleQuote,
    ),
    hindsightRecallTypes,
    hindsightRecallSkipTrivial,
    hindsightDirectiveCaptureNudge,
    hindsightObservationScopesQ: hindsightObservationScopes
      ? shellSingleQuote(hindsightObservationScopes)
      : undefined,
    hindsightObservationScopeStrategyQ: hindsightObservationScopeStrategy
      ? shellSingleQuote(hindsightObservationScopeStrategy)
      : undefined,
    // PR6 — only emit the env-export blocks when we actually have a
    // value, so `{{#if hindsightTopicAliasesJsonQ}}` and friends are
    // false-y for fleet-shared / DM agents (the dominant case).
    hindsightTopicAliasesJsonQ: hindsightTopicAliasesJson
      ? shellSingleQuote(hindsightTopicAliasesJson)
      : undefined,
    hindsightSenderBanksJsonQ: hindsightSenderBanksJson
      ? shellSingleQuote(hindsightSenderBanksJson)
      : undefined,
    hindsightTopicFilterMode,
    switchroomConfigPathQ: switchroomConfigPath
      ? shellSingleQuote(resolve(switchroomConfigPath))
      : undefined,
    // Host home — baked into start.sh.hbs's $HOME/.switchroom symlink
    // (#910). Prefer SWITCHROOM_HOST_HOME so an in-hostd apply bakes the real
    // host home, not /host-home (see hostHomeForBake). When neither is set
    // (e.g. tests with no HOME) the template's {{#if hostHomeQ}} guard renders
    // the symlink block as a no-op.
    hostHomeQ: hostHomeQForBake(),
    // modelQ is the CONFIGURED default only. A Telegram `/model` switch is
    // session-scoped (reference/rfcs/session-model-stickiness.md §0.1): a
    // relaunch-requiring switch writes a CONSUME-ONCE `.session-model` carrier
    // that start.sh applies on its single apply-relaunch and then deletes, so
    // EVERY subsequent restart boots modelQ. Live Claude switches write no
    // carrier at all. The override is never persisted here or to
    // switchroom.yaml. See profiles/_base/start.sh.hbs (Session model
    // resolution) and telegram-plugin/gateway/model-command.ts.
    modelQ: shellSingleQuote(resolveMainModel(agentConfig.model)),
    // Declared routing INTENT — the POST-REPOINT mode start.sh lands on (see
    // declaredRoutingMode), NOT the raw compose isClaudeModel env split: a
    // configured fable rides compose's `/anthropic` env but start.sh repoints
    // it onto the router root, so declared must say `router-root`. start.sh
    // compares the LANDED routing mode against this and writes both to
    // `.routing-mode` (2026-07-17 boot-race incident).
    declaredRoutingQ: shellSingleQuote(
      declaredRoutingMode(resolveMainModel(agentConfig.model)),
    ),
    ...buildCronSessionContext(agentConfig),
    thinkingEffort: agentConfig.thinking_effort ?? SWITCHROOM_DEFAULT_THINKING_EFFORT,
    permissionMode: agentConfig.permission_mode,
    fallbackModelQ: agentConfig.fallback_model
      ? shellSingleQuote(agentConfig.fallback_model)
      : undefined,
    userEnvQuoted: (() => {
      const combined = {
        ...buildToolSearchEnvVars(),
        ...channelsToEnv(agentConfig),
        ...(agentConfig.env ?? {}),
        ...buildRepoEnvVars(name, agentDir, agentConfig),
        ...buildHumanizerEnvVars(agentDir, agentConfig),
      };
      if (Object.keys(combined).length === 0) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(combined)) {
        out[k] = shellSingleQuote(v);
      }
      return out;
    })(),
    systemPromptAppendShellQuoted: (() => {
      // Lane 1 invariants (telegram pacing / memory protocol / sandbox
      // primer) used to be concatenated here. They now reach the model
      // via Claude Code native CLAUDE.md auto-discovery from
      // `~/.switchroom/fleet/switchroom-invariants.md`, loaded by the
      // `--add-dir` flag set in start.sh.hbs. See `renderFleetInvariants()`
      // at the top of this file.
      //
      // EXCEPTION — the Telegram formatting FLOOR CARD is injected here, into
      // `--append-system-prompt`, deterministically for EVERY session (it must
      // not depend on the model choosing to load a discovered file). Single
      // source of truth: TELEGRAM_FORMATTING_FLOOR_CARD above.
      //
      // What also remains here: the operator's per-agent
      // `system_prompt_append` (yaml passthrough). Reserved for genuinely
      // per-agent system-prompt extensions; fleet-wide content goes in
      // `~/.switchroom/fleet/CLAUDE.md` (lane 2, operator-owned).
      const baseAppend = agentConfig.system_prompt_append ?? '';
      const combined = baseAppend.length > 0
        ? `${TELEGRAM_FORMATTING_FLOOR_CARD}\n\n${baseAppend}`
        : TELEGRAM_FORMATTING_FLOOR_CARD;
      return shellSingleQuote(combined);
    })(),
    extraCliArgs: (() => {
      const parts: string[] = []
      if (agentConfig.cli_args && agentConfig.cli_args.length > 0) {
        parts.push(...agentConfig.cli_args.map(shellSingleQuote))
      }
      // #199: native Claude Code flag pass-through. add_dirs becomes
      // repeated --add-dir <path>; allowed_tools / disallowed_tools become
      // a single space-separated --allowedTools "..." / --disallowedTools "..."
      // arg. Coexistence semantics with the coarse `tools.allow`: granular-
      // only-when-present (Claude Code's own OR semantics), so existing
      // operators on `tools.allow` are unaffected.
      if (agentConfig.add_dirs && agentConfig.add_dirs.length > 0) {
        for (const dir of agentConfig.add_dirs) {
          parts.push("--add-dir", shellSingleQuote(dir))
        }
      }
      if (agentConfig.allowed_tools && agentConfig.allowed_tools.length > 0) {
        parts.push("--allowedTools", shellSingleQuote(agentConfig.allowed_tools.join(" ")))
      }
      if (agentConfig.disallowed_tools && agentConfig.disallowed_tools.length > 0) {
        parts.push("--disallowedTools", shellSingleQuote(agentConfig.disallowed_tools.join(" ")))
      }
      return parts.length > 0 ? " " + parts.join(" ") : undefined
    })(),
    sessionMaxIdleSecs: parseDurationToSeconds(agentConfig.session?.max_idle),
    sessionMaxTurns: agentConfig.session?.max_turns,
    handoffEnabled: agentConfig.session_continuity?.enabled !== false,
    resumeMode: agentConfig.session_continuity?.resume_mode ?? "handoff",
    resumeMaxBytes:
      agentConfig.session_continuity?.resume_max_bytes ?? 2_000_000,
    // Boot-resume policy for in-flight-turn recovery across restarts
    // (session_continuity.boot_resume; default 'in-flight'). Threaded to the
    // gateway process as SWITCHROOM_BOOT_RESUME (exported before the gateway
    // fork in start.sh — the gateway reads it at boot-resume time).
    bootResumeMode: agentConfig.session_continuity?.boot_resume ?? "in-flight",
    // Boot-briefing transport flag (session_continuity.briefing; default
    // 'legacy'). Threaded to both the gateway (SWITCHROOM_SESSION_BRIEFING,
    // exported before the gateway fork) and the inner handoff block (which
    // skips handoff-briefing.sh when 'gateway' owns the briefing).
    sessionBriefingMode: agentConfig.session_continuity?.briefing ?? "legacy",
    // Capability sentinel for the start.sh ↔ gateway-bundle version handshake
    // (#4245). Templated into start.sh's outer pass, which greps the deployed
    // gateway bundle for this literal before trusting `briefing: gateway`.
    // Single source of truth in telegram-plugin/gateway/boot-briefing-capability.ts.
    gatewayBriefingCapability: GATEWAY_BOOT_BRIEFING_CAPABILITY,
    // True only when the generated start.sh can actually set CONTINUE_FLAG="--continue"
    // at runtime (i.e. resume_mode is 'auto' or 'continue'). In handoff/none mode the
    // case branches for auto/continue are omitted entirely so the literal string
    // CONTINUE_FLAG="--continue" never appears in the rendered script (closes #377).
    resumeModeHasContinuePath: (() => {
      const mode = agentConfig.session_continuity?.resume_mode ?? "handoff";
      return mode === "auto" || mode === "continue";
    })(),
  };
}

/**
 * Path the v0.7 docker agent image bakes telegram-plugin into.
 * Mirrors the `COPY telegram-plugin/...` block in `docker/Dockerfile.agent`.
 * Used by `.mcp.json` generation in docker mode so the MCP server resolves
 * inside the container regardless of where switchroom was installed on
 * the host (npm-global, dev checkout, ad-hoc tarball).
 */
export const DOCKER_TELEGRAM_PLUGIN_PATH = "/opt/switchroom/telegram-plugin";

/**
 * In-image path where Dockerfile.agent COPYs `telegram-plugin/hooks/*.mjs`.
 * Claude Code spawns hooks as child processes from the path written into
 * `settings.json.hooks` at scaffold time; pre-Bug-3 the scaffold emitted
 * the operator's host repo path here, which doesn't exist inside the
 * container — hooks silently never ran (RFC Phase 3 §Bug 3 in
 * reference/rfcs/sub-agent-visibility.md).
 */
export const DOCKER_HOOKS_PATH = `${DOCKER_TELEGRAM_PLUGIN_PATH}/hooks`;

/**
 * In-image path for hooks bundled from src/ TypeScript at build time
 * (rather than copied from telegram-plugin/hooks/*.mjs source).
 * Today: only the RFC E §4.2 Cut 2 drive-write hook lives here. The
 * bundle is emitted by `scripts/build.mjs` to `dist/cli/*.mjs` and
 * baked into the agent image at `/opt/switchroom/hooks/` (see
 * docker/Dockerfile.agent).
 */
export const DOCKER_BUNDLED_HOOKS_PATH = "/opt/switchroom/hooks";

/**
 * In-image path where Dockerfile.agent COPYs the `bin/*-hook.sh` family
 * (run-hook.sh, timezone-hook.sh, workspace-stable-hook.sh,
 * workspace-dynamic-hook.sh, user-profile-refresh-hook.sh). Same
 * rationale as DOCKER_HOOKS_PATH — these are invoked from the
 * scaffolded settings.json hooks block.
 */
export const DOCKER_BIN_PATH = "/opt/switchroom/bin";

/**
 * In-image path of the minimal security-hooks plugin (sec WS8-F1 /
 * #1416). Dockerfile.agent assembles `.claude-plugin/plugin.json` +
 * `hooks/hooks.json` + the two load-bearing PreToolUse safety hooks
 * (secret-guard-pretool, drive-write-pretool) here. start.sh passes
 * this as `--plugin-dir` on every claude exec variant, unconditionally
 * — it is THE security boundary, not optional like hindsight. Because
 * Claude Code unions plugin-dir hooks with settings.json hooks and a
 * plugin-dir-loaded hook cannot be suppressed by an agent rewriting
 * its own settings.json, this read-only image copy is the unstrippable
 * authority; the settings.json copy (still emitted) is a harmless
 * zero-regression fallback. Never point this at the agent-writable
 * scaffold dir.
 */
export const DOCKER_SECURITY_PLUGIN_PATH = "/opt/switchroom/security-plugin";

/**
 * In-container path where compose bind-mounts the operator's
 * `switchroom.yaml`. Mirror of the volume mount line emitted in
 * compose generation (`${host}:/state/config/switchroom.yaml:ro`).
 * Used anywhere scaffold writes a path that will be read inside an
 * agent container — `.mcp.json` SWITCHROOM_CONFIG env, and the
 * `--config` flag baked into the handoff hook (#1079).
 */
export const DOCKER_CONFIG_PATH = "/state/config/switchroom.yaml";

/**
 * In-container path to the switchroom CLI. `Dockerfile.agent` symlinks
 * `dist/cli/switchroom.js` onto PATH here. Used for MCP entries whose
 * `command` is a switchroom-internal verb (agent-config, hostd, and the
 * gdrive `drive-mcp-launcher`) — the host's repo/npm-global path is
 * irrelevant inside the container.
 */
export const DOCKER_SWITCHROOM_CLI_PATH = "/usr/local/bin/switchroom";

/**
 * In-container path to the auth-broker UDS. The gdrive launcher resolves
 * Google credentials through the auth-broker; Claude Code spawns MCP
 * servers with a sanitized env (NOT the container env), so this MUST be
 * threaded explicitly onto the gdrive `.mcp.json` entry or the launcher
 * talks to the wrong (default) socket and dies.
 * MUST mirror src/agents/compose.ts emitAgentService env (compose.ts:1312).
 */
export const DOCKER_AUTH_BROKER_SOCKET = "/run/switchroom/auth-broker/sock";

/**
 * In-container path to the vault-broker UDS. Needed when the configured
 * `google_client_secret` is a `vault:` reference the launcher must
 * resolve through the vault broker.
 * MUST mirror src/agents/compose.ts emitAgentService env (compose.ts:1304).
 */
export const DOCKER_VAULT_BROKER_SOCKET = "/run/switchroom/broker/sock";

/**
 * In-container HOME for the agent. The launcher (and uvx beneath it)
 * writes to ~/.cache, ~/.config, ~/.local; without HOME pointed at the
 * writable bind mount it defaults to "/" on the read-only root fs.
 * MUST mirror src/agents/compose.ts emitAgentService env (compose.ts:1248).
 */
export const DOCKER_AGENT_HOME = "/state/agent/home";

/**
 * Decide whether the per-agent `gdrive` MCP entry should be written into
 * `mcpServers`, and if so produce it.
 *
 * Net-new conditional logic (unlike `getBuiltinDefaultMcpEntries()`,
 * which is unconditional). Shared by BOTH the `scaffoldAgent` and
 * `reconcileAgent` mcpServers-assembly paths so an agent can never get a
 * `gdrive` entry it can't satisfy at the broker.
 *
 * Gate (all must hold):
 *   1. NOT a hard opt-out — `mcp_servers: { gdrive: false }`.
 *   2. `shouldEmitGdriveMcp(name, account, google_accounts)` — i.e. the
 *      agent has `google_workspace.account` set AND that account lists
 *      this agent in its `google_accounts.<account>.enabled_for[]`. This
 *      is the SAME predicate the auth-broker uses to select+authorize a
 *      Google account, so scaffold and broker can never disagree.
 *
 * The `--tier` passed to the launcher is per-agent override → top-level
 * default (mirrors approvers/tier override semantics elsewhere). The
 * launcher re-reads tier from config and is authoritative; threading it
 * here just makes the resolved choice visible in settings.json.
 *
 * Returns `null` when the entry must not be emitted.
 */
export function resolveGdriveMcpEntry(
  agentName: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig } | null {
  if ((agentConfig.mcp_servers ?? {})["gdrive"] === false) return null;
  const account = agentConfig.google_workspace?.account;
  const googleAccounts = switchroomConfig?.google_accounts;
  if (!shouldEmitGdriveMcp(agentName, account, googleAccounts)) return null;
  const tier =
    agentConfig.google_workspace?.tier ??
    switchroomConfig?.google_workspace?.tier;
  // Per-account selection (v1 read-only scope model): thread the
  // persisted `google_accounts.<email>.{readonly,services}` record to
  // the launcher alongside --tier. The launcher re-reads the record
  // from config and is authoritative; threading makes the resolved
  // choice visible in settings.json — and the SAME record minted the
  // account's OAuth scopes, so tool exposure and token scope agree.
  const accountRecord = account
    ? googleAccounts?.[account.trim().toLowerCase()]
    : undefined;
  const entry = getGdriveMcpSettingsEntry(DOCKER_SWITCHROOM_CLI_PATH, {
    ...(tier ? { tier } : {}),
    ...(accountRecord?.services && accountRecord.services.length > 0
      ? { services: accountRecord.services }
      : {}),
    ...(accountRecord?.readonly ? { readOnly: true } : {}),
  });
  // Claude Code spawns MCP servers with a SANITIZED env (not the
  // parent/container env), so the drive-mcp-launcher gets none of the
  // compose-emitted SWITCHROOM_* / HOME vars unless we thread them onto
  // the entry explicitly. Without this block the launcher dies at spawn
  // ("No switchroom.yaml found", or it connects to the wrong broker
  // socket). Every value here MUST mirror the canonical value emitted by
  // src/agents/compose.ts emitAgentService env (line cited per key) so
  // the in-MCP-spawn env can never disagree with the container env.
  entry.value.env = {
    SWITCHROOM_CONFIG: DOCKER_CONFIG_PATH, // compose.ts SWITCHROOM_CONFIG / volume mount (scaffold.ts:1755)
    SWITCHROOM_AGENT_NAME: agentName, // compose.ts:1275 (a.name)
    SWITCHROOM_CONTAINER: "1", // compose.ts:1276
    SWITCHROOM_AUTH_BROKER_SOCKET: DOCKER_AUTH_BROKER_SOCKET, // compose.ts:1312
    SWITCHROOM_VAULT_BROKER_SOCK: DOCKER_VAULT_BROKER_SOCKET, // compose.ts:1304
    HOME: DOCKER_AGENT_HOME, // compose.ts:1248
  };
  return entry;
}

/**
 * RFC #1873 PR 3 — resolve the per-agent `ms-365` MCP entry.
 *
 * Mirrors `resolveGdriveMcpEntry` for Microsoft 365. Gate is identical
 * shape: NOT hard opt-out + `shouldEmitMs365Mcp` returns true (i.e.
 * `microsoft_workspace.account` set AND that account lists this agent
 * in `microsoft_accounts.<account>.enabled_for[]`).
 *
 * Returns null when the entry must not be emitted.
 */
export function resolveMs365McpEntries(
  agentName: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig }[] {
  if ((agentConfig.mcp_servers ?? {})["ms-365"] === false) return [];
  const mw = agentConfig.microsoft_workspace;
  const microsoftAccounts = switchroomConfig?.microsoft_accounts;
  const bindings = bindingsForAgent(agentName, mw, microsoftAccounts);
  if (bindings.length === 0) return [];

  // Guard against two distinct emails colliding on the same slug/key on
  // one agent — fail loud rather than silently dropping a binding.
  const seenKeys = new Set<string>();
  const entries: { key: string; value: McpServerConfig }[] = [];
  for (const b of bindings) {
    const key = ms365McpKeyForBinding(mw, b.account);
    if (seenKeys.has(key)) {
      throw new Error(
        `agent '${agentName}': Microsoft account slug collision on MCP key '${key}' ` +
        `(account '${b.account}'). Rename or disambiguate the accounts.`,
      );
    }
    seenKeys.add(key);
    // org_mode: per-binding override → top-level default. Launcher
    // re-reads from config and is authoritative; threading here just
    // makes the resolved choice visible in settings.json.
    const orgMode =
      b.org_mode ??
      switchroomConfig?.microsoft_workspace?.org_mode ??
      false;
    // Only thread --account for the multi-account (plural) form so a
    // single-account agent keeps byte-identical settings (bare ms-365,
    // no --account) — back-compat.
    const isMulti = key !== "ms-365";
    const entry = getMs365McpSettingsEntry(DOCKER_SWITCHROOM_CLI_PATH, {
      orgMode,
      key,
      ...(isMulti ? { account: b.account } : {}),
      ...(b.tools ? { enabledTools: b.tools } : {}),
    });
    // Env-threading shape, minus vault-broker (the m365 launcher only
    // talks to the auth-broker — no vault calls for client_secret yet
    // because that gates per-agent vault ACL which isn't wired in PR 3).
    // If a future PR teaches the launcher to resolve `vault:` refs for
    // client_secret directly, re-add SWITCHROOM_VAULT_BROKER_SOCK here.
    entry.value.env = {
      SWITCHROOM_CONFIG: DOCKER_CONFIG_PATH,
      SWITCHROOM_AGENT_NAME: agentName,
      SWITCHROOM_CONTAINER: "1",
      SWITCHROOM_AUTH_BROKER_SOCKET: DOCKER_AUTH_BROKER_SOCKET,
      HOME: DOCKER_AGENT_HOME,
    };
    entries.push(entry);
  }
  return entries;
}

/**
 * Singular back-compat shim: returns the FIRST resolved ms-365 entry (or
 * null). Retained for callers/tests that expect one entry; multi-account
 * callers use `resolveMs365McpEntries`.
 */
export function resolveMs365McpEntry(
  agentName: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig } | null {
  return resolveMs365McpEntries(agentName, agentConfig, switchroomConfig)[0] ?? null;
}

/**
 * All mcpServers keys the ms-365 integration COULD own for this agent —
 * the bare `ms-365` plus `ms-365-<slug>` for every declared binding
 * (regardless of ACL). Used at reconcile to retract stale per-account
 * keys when an agent's bindings shrink or the ACL is revoked.
 */
export function ms365OwnedKeys(agentConfig: AgentConfig): Set<string> {
  const keys = new Set<string>(["ms-365"]);
  for (const b of normalizeMicrosoftBindings(agentConfig.microsoft_workspace)) {
    keys.add(`ms-365-${microsoftAccountSlug(b.account)}`);
  }
  return keys;
}

/**
 * RFC reference/rfcs/notion-integration.md PR 2 — resolve the per-agent
 * `notion` MCP entry.
 *
 * Mirrors `resolveMs365McpEntry` shape. Gate: NOT hard opt-out +
 * `shouldEmitNotionMcp` returns true (top-level `notion_workspace:`
 * exists AND the agent has a `notion_workspace:` block — even an
 * empty one, which counts as "this agent wants Notion with no DB
 * restriction").
 *
 * Returns null when the entry must not be emitted.
 *
 * Notion has no per-account concept (one integration = one workspace),
 * so the launcher only needs:
 *   - SWITCHROOM_AGENT_NAME (for vault-broker peercred identity)
 *   - SWITCHROOM_VAULT_BROKER_SOCK (to fetch the integration token)
 *   - SWITCHROOM_CONFIG (so the launcher can read config-level
 *     overrides — vault_key, mcp_version)
 */
export function resolveNotionMcpEntry(
  agentName: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig } | null {
  if ((agentConfig.mcp_servers ?? {})["notion"] === false) return null;
  if (!switchroomConfig) return null;
  if (!shouldEmitNotionMcp(agentName, switchroomConfig)) return null;

  const vaultKey =
    switchroomConfig.notion_workspace?.vault_key ?? "notion/integration-token";
  const mcpVersion = switchroomConfig.notion_workspace?.mcp_version;
  const entry = getNotionMcpSettingsEntry(DOCKER_SWITCHROOM_CLI_PATH, {
    vaultKey,
    mcpVersion,
  });
  // Mirror m365/gdrive env-threading shape. The launcher needs vault-
  // broker reach (token fetch) and the standard switchroom env block.
  entry.value.env = {
    SWITCHROOM_CONFIG: DOCKER_CONFIG_PATH,
    SWITCHROOM_AGENT_NAME: agentName,
    SWITCHROOM_CONTAINER: "1",
    SWITCHROOM_VAULT_BROKER_SOCK: DOCKER_VAULT_BROKER_SOCKET,
    HOME: DOCKER_AGENT_HOME,
  };
  return entry;
}

/**
 * Registry of MCP-server integrations resolved by scaffold + reconcile.
 *
 * Each entry pairs the `resolve` predicate with two keys: `emitKey`
 * (the mcpServers key the resolver returns when it emits an entry —
 * matches the integration's settings.json key) and `retractionKey`
 * (the literal mcpServers key to `delete` at the reconcile site when
 * resolve returns null). They are equal today for every integration,
 * but kept as separate fields so a future integration whose
 * opt-out key differs from its emit key can't silently drift.
 *
 * **Iteration order is part of the contract.** The order here
 * determines which integration's entry lands first at every call
 * site; that matters at Site 2 (.mcp.json framework-wins), where a
 * later user-spread can override but two integrations colliding on
 * the same key would have the last-wins ordering pinned here. Today
 * no two integrations share a key — but the order is still load-
 * bearing for the tests that pin precedence semantics
 * (`tests/scaffold.integration-registry.test.ts`).
 *
 * Adding a new integration: append one entry here + define the
 * `resolve` function above. The 4 mcpServers-assembly sites in
 * `scaffold.ts` (and the reconcile-side equivalents) pick it up
 * automatically.
 *
 * @see `tests/scaffold.integration-registry.test.ts` for the
 * regression-gate tests pinning each site's conflict policy.
 */
export interface IntegrationMcpResolver {
  /** Display label for diagnostics. */
  label: string;
  /** The mcpServers key the resolver emits — also the user-facing opt-out key (`mcp_servers.<key>: false`). */
  emitKey: string;
  /**
   * The literal mcpServers key to `delete` at Site 3 (settings.json
   * reconcile) when resolve returns null. Kept separate from
   * emitKey so a future opt-out-key vs emit-key drift can't silently
   * break retraction.
   */
  retractionKey: string;
  resolve: (
    name: string,
    agentConfig: AgentConfig,
    switchroomConfig: SwitchroomConfig | undefined,
  ) => { key: string; value: McpServerConfig } | null;
  /**
   * OPTIONAL plural resolver for integrations that emit MORE THAN ONE
   * mcpServers key (e.g. Microsoft 365 multi-account: one `ms-365-<slug>`
   * per bound account). When present it supersedes `resolve` for
   * emission; `resolve` is kept as a single-entry shim for callers/tests
   * that expect one entry.
   */
  resolveEntries?: (
    name: string,
    agentConfig: AgentConfig,
    switchroomConfig: SwitchroomConfig | undefined,
  ) => { key: string; value: McpServerConfig }[];
  /**
   * OPTIONAL retraction-key set for plural integrations: every mcpServers
   * key this integration COULD own for the agent under the CURRENT config
   * (regardless of ACL). NOTE: this cannot see a FULLY-REMOVED binding
   * (its slug is gone from config), so it only handles the
   * ACL-revoked-while-still-declared case. Durable full retraction uses
   * `ownsKeyName` (namespace predicate) instead — see
   * `retractStaleIntegrationKeys`.
   */
  ownedKeys?: (agentConfig: AgentConfig) => Set<string>;
  /**
   * OPTIONAL namespace predicate: does `key` belong to THIS integration's
   * mcpServers namespace (e.g. `ms-365` or `ms-365-<slug>`)? Used by
   * `retractStaleIntegrationKeys` to drop stale keys present in EXISTING
   * settings that are no longer emitted — WITHOUT enumerating from the
   * current config, so a binding that was fully removed (its slug no
   * longer in config) is still retracted. When absent, retraction falls
   * back to the single literal `retractionKey`.
   */
  ownsKeyName?: (key: string) => boolean;
}

/**
 * Durable, namespace-scoped retraction: delete every key in `existing`
 * that (a) belongs to the integration's namespace (`ownsKeyName`, or the
 * literal `retractionKey` fallback), (b) is NOT in the freshly-emitted
 * set, and (c) is NOT a user-declared mcp_servers key. Mutates `existing`
 * in place and returns the removed keys.
 *
 * This is the fix for the multi-account retraction gap: `ownedKeys`
 * (config enumeration) minus emitted can never drop a binding that was
 * FULLY removed from `microsoft_workspace.accounts` (its slug is in
 * neither set). Diffing the EXISTING mcpServers object against the emitted
 * set by namespace catches the removed slug. The user-declared guard keeps
 * an operator's hand-written `mcp_servers` entry from being swept.
 */
export function retractStaleIntegrationKeys(
  integration: IntegrationMcpResolver,
  emittedKeys: ReadonlySet<string>,
  existing: Record<string, unknown>,
  protectedKeys?: ReadonlySet<string>,
): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(existing)) {
    if (emittedKeys.has(key)) continue;
    if (protectedKeys?.has(key)) continue;
    const owns = integration.ownsKeyName
      ? integration.ownsKeyName(key)
      : key === integration.retractionKey;
    if (owns) {
      delete existing[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * The set of user-declared mcp_servers keys (truthy values only — `false`
 * is an opt-out sentinel, not a declaration) — protected from namespace
 * retraction so an operator's hand-written entry survives.
 */
export function userDeclaredMcpKeys(agentConfig: AgentConfig): Set<string> {
  return new Set(
    Object.entries(agentConfig.mcp_servers ?? {})
      .filter(([, v]) => v !== false)
      .map(([k]) => k),
  );
}

/**
 * The mcpServers entries an integration emits for an agent — plural-aware.
 * Uses `resolveEntries` when present, else wraps the single `resolve`.
 */
export function integrationMcpEntries(
  integration: IntegrationMcpResolver,
  name: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig }[] {
  if (integration.resolveEntries) {
    return integration.resolveEntries(name, agentConfig, switchroomConfig);
  }
  const entry = integration.resolve(name, agentConfig, switchroomConfig);
  return entry ? [entry] : [];
}

/**
 * The set of mcpServers keys to `delete` for an integration at reconcile
 * that are NOT in the currently-emitted set — plural-aware retraction.
 */
export function integrationRetractionKeys(
  integration: IntegrationMcpResolver,
  name: string,
  agentConfig: AgentConfig,
  switchroomConfig: SwitchroomConfig | undefined,
): string[] {
  const emitted = new Set(
    integrationMcpEntries(integration, name, agentConfig, switchroomConfig).map(
      (e) => e.key,
    ),
  );
  const owned = integration.ownedKeys
    ? integration.ownedKeys(agentConfig)
    : new Set<string>([integration.retractionKey]);
  return [...owned].filter((k) => !emitted.has(k));
}

/**
 * Resolve the per-agent `webkite` MCP entry.
 *
 * Unlike gdrive/ms-365/notion, webkite has no top-level switchroom.yaml
 * config block to gate on — it's a fleet-default capability that swaps
 * in for the native WebFetch/WebSearch tools (disabled at the cascade
 * level — see defaults `disallowed_tools`). The only gate is the
 * per-agent opt-out (`mcp_servers.webkite: false`).
 *
 * Distribution model (see docker/Dockerfile.agent + compose.ts):
 *   - `webkite` binary: operator-mounted from `~/.switchroom/bin/webkite`
 *     onto the in-container PATH at `/usr/local/bin/webkite`. The
 *     binary itself is a private-beta release that never lives in this
 *     repo or the agent image.
 *   - cloakbrowser Python tool: baked into the agent image at
 *     `/opt/cloakbrowser` (public OSS, no constraint violation).
 *   - cloakbrowser Chromium: operator-mounted RO from
 *     `~/.switchroom/cloakbrowser/` onto the image's
 *     CLOAKBROWSER_CACHE_DIR (`/opt/switchroom/cloakbrowser-cache`) so
 *     the whole fleet shares one ~700MB install (#TBD).
 *
 * Credential injection: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN /
 * FIRECRAWL_API_KEY are fetched from the vault-broker by start.sh.hbs
 * at agent boot and exported into the agent process env. Claude
 * inherits them on `exec claude`, so the `webkite mcp` child process
 * sees them via env inheritance. No per-server env block needed here —
 * unlike gdrive/m365 (which spawn through a launcher that talks to the
 * auth-broker), webkite's env-from-vault is one-shot at boot.
 *
 * Returns null when the entry must not be emitted.
 */
export function resolveWebkiteMcpEntry(
  _agentName: string,
  agentConfig: AgentConfig,
  _switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig } | null {
  if ((agentConfig.mcp_servers ?? {})["webkite"] === false) return null;
  return {
    key: "webkite",
    value: {
      command: "webkite",
      args: ["mcp"],
    },
  };
}

/**
 * The Context7 remote MCP endpoint. Streamable-HTTP, public, no
 * credential required for the free tier — verified against the live
 * service on 2026-07-26 (`initialize` → Context7 3.2.5, `tools/list` →
 * `resolve-library-id` + `query-docs`, and a `resolve-library-id` call
 * for "react" all succeeded with no auth header).
 */
const CONTEXT7_MCP_URL = "https://mcp.context7.com/mcp";

/**
 * Resolve the per-agent `context7` MCP entry.
 *
 * Same shape as webkite: a fleet-default capability with no top-level
 * switchroom.yaml config block, gated only on the per-agent opt-out
 * (`mcp_servers.context7: false`). It pairs with
 * LIBRARY_DOCS_GUIDANCE, which is the half that makes agents actually
 * call it.
 *
 * Transport choice — remote HTTP, NOT `npx -y @upstash/context7-mcp`
 * (which is what Anthropic's official context7 plugin uses):
 *   - `npx -y` resolves and installs the LATEST published version from
 *     the npm registry at every session spawn. That is a per-boot
 *     network dependency on a second registry, a multi-second cold
 *     start on every agent, and an unpinned third-party package
 *     executing inside the agent container. The HTTP transport has
 *     none of those properties.
 *   - Claude Code speaks streamable HTTP natively (`type: "http"`),
 *     the same transport hindsight uses in http mode.
 *
 * Credentials: none. Context7's free tier is IP-rate-limited and
 * anonymous. An optional `CONTEXT7_API_KEY` raises those limits; if
 * the fleet ever hits them, the upgrade is a vault key
 * (`context7/api-key`) resolved into an `Authorization: Bearer`
 * header here. Deliberately NOT wired now: a `secrets:` declaration
 * for a key the vault doesn't hold would fail the broker on every
 * agent for a capability that works fine without it.
 *
 * Returns null when the entry must not be emitted.
 */
export function resolveContext7McpEntry(
  _agentName: string,
  agentConfig: AgentConfig,
  _switchroomConfig: SwitchroomConfig | undefined,
): { key: string; value: McpServerConfig } | null {
  if ((agentConfig.mcp_servers ?? {})["context7"] === false) return null;
  return {
    key: "context7",
    value: {
      type: "http",
      url: CONTEXT7_MCP_URL,
    },
  };
}

export const INTEGRATION_MCP_RESOLVERS: readonly IntegrationMcpResolver[] = [
  {
    label: "Google Workspace",
    emitKey: "gdrive",
    retractionKey: "gdrive",
    resolve: resolveGdriveMcpEntry,
  },
  {
    label: "Microsoft 365",
    emitKey: "ms-365",
    retractionKey: "ms-365",
    resolve: resolveMs365McpEntry,
    resolveEntries: resolveMs365McpEntries,
    ownedKeys: ms365OwnedKeys,
    // Namespace: the bare `ms-365` OR any `ms-365-<slug>` per-account key.
    // Lets retraction drop a fully-removed binding's stale key without
    // enumerating from the (already-shrunk) config.
    ownsKeyName: (key: string) => key === "ms-365" || /^ms-365-[a-z0-9-]+$/.test(key),
  },
  {
    label: "Notion",
    emitKey: "notion",
    retractionKey: "notion",
    resolve: resolveNotionMcpEntry,
  },
  {
    label: "Webkite",
    emitKey: "webkite",
    retractionKey: "webkite",
    resolve: resolveWebkiteMcpEntry,
  },
  {
    label: "Context7",
    emitKey: "context7",
    retractionKey: "context7",
    resolve: resolveContext7McpEntry,
  },
];

/**
 * Compute the effective `permissions.allow` list for an agent's
 * settings.json from its resolved config (footgun G — one converge engine).
 *
 * This is the SINGLE SOURCE OF TRUTH for the allow-list, called by BOTH the
 * create path (`scaffoldAgent`) and the reconcile path (`reconcileAgentInner`).
 * The two used to inline byte-identical copies with a comment demanding they
 * "stay in lockstep" — the exact drift footgun. Extracting it makes the
 * lockstep a compile-time fact, not a discipline, and the scaffold↔reconcile
 * parity test pins that no caller diverges.
 *
 * IMPORTANT: this reads `agentConfig.tools.allow` as-is. The reconcile path's
 * separate legacy-token strip (which mutates the persisted `tools.allow`) must
 * run AFTER this is called, so the computed allow-list matches the historical
 * pre-strip `baseAllow` behaviour exactly. Do not reorder.
 *
 * @param agentConfig      Cascade-resolved agent config.
 * @param hindsightEnabled Result of `isHindsightEnabled(switchroomConfig)`
 *                         (passed in so both callers share the one probe).
 */
export function computeDesiredPermissionAllow(
  agentConfig: AgentConfig,
  hindsightEnabled: boolean,
): string[] {
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  const baseAllow = hasAllWildcard
    // `[all]` means "all built-ins" — but it must ALSO keep any explicit tools
    // the operator listed alongside it. A 🔁 "Always allow" tap persists a
    // privileged hostd / Skill / 3rd-party-MCP rule into tools.allow as
    // `[all, mcp__hostd__agent_logs]` (those are deliberately NOT in
    // ALL_BUILTIN_TOOLS — the leash: even an [all] admin approves them once).
    // Dropping the explicit entries here is why such grants never reached
    // settings.json and the agent re-asked forever (klanker, 2026-06-15).
    ? [...ALL_BUILTIN_TOOLS, ...rawAllow.filter((t) => t !== "all")]
    : rawAllow.filter((t) => t !== "all");
  // If the user didn't specify any allowed tools AND dangerous_mode is off,
  // seed a safe read-only default set so routine tool calls don't spam the
  // approval UI. Risky tools still prompt and hit the Telegram button flow.
  const dangerousMode = agentConfig.dangerous_mode === true;
  const hadExplicitAllow = rawAllow.length > 0;
  const readOnlyDefaults =
    !dangerousMode && !hadExplicitAllow ? DEFAULT_READ_ONLY_PREAPPROVED_TOOLS : [];
  return dedupe([
    ...baseAllow,
    ...readOnlyDefaults,
    ...(usesSwitchroomTelegramPlugin(agentConfig) ? SWITCHROOM_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    // agent-config + hostd are always wired into .mcp.json so the
    // prompt fragment can claim "you have these tools available" —
    // but Claude Code blocks the first call on a permission prompt
    // unless the tool is on the allow list. Pre-approve unconditionally
    // (daemon-side gates remain the real security boundary).
    ...AGENT_CONFIG_MCP_TOOLS,
    ...HOSTD_MCP_TOOLS,
    // Webkite is fleet-default (resolveWebkiteMcpEntry) unless the agent
    // opts out. Pre-approve its tools so the first web fetch doesn't
    // wedge on a permission prompt — webkite IS the web-fetch path now
    // (native WebFetch/WebSearch are denied). Gated on the same opt-out
    // as the MCP entry emission, so a webkite-disabled agent doesn't
    // carry dangling pre-approvals.
    ...(agentConfig.mcp_servers?.["webkite"] === false ? [] : WEBKITE_MCP_TOOLS),
    // Context7 is fleet-default (resolveContext7McpEntry) unless the
    // agent opts out. Same reasoning as webkite: LIBRARY_DOCS_GUIDANCE
    // tells every agent to look library docs up before answering, so
    // the first such lookup is common and would otherwise wedge on a
    // permission prompt. Gated on the same opt-out as the MCP entry
    // emission.
    //
    // NOTE — this function RETURNS a freshly computed list, so an
    // opted-out agent gets no context7 token here by construction.
    // That is NOT by itself enough to claim "no dangling pre-approval
    // anywhere": on a DEPLOYED agent, `switchroom apply` takes the
    // settings.json merge path in scaffoldAgent, which reads the
    // existing allow list rather than rebuilding it from this
    // function. Retraction on that path is explicit — see the
    // context7 filter in that merge block. (reconcileAgent assigns
    // computeDesiredPermissionAllow's output wholesale, so it retracts
    // by reconstruction.)
    ...(agentConfig.mcp_servers?.["context7"] === false ? [] : CONTEXT7_MCP_TOOLS),
  ]);
}

export function scaffoldAgent(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  switchroomConfig?: SwitchroomConfig,
  userIdOverride?: string,
  switchroomConfigPath?: string,
): ScaffoldResult {
  // Apply the full cascade: global defaults → inline profile (from
  // `extends:`) → per-agent config. When switchroom.yaml has no `defaults:`
  // or `profiles:` and no `extends:` on the agent, the result is
  // identical to agentConfigRaw so existing behavior is preserved.
  const agentConfig = resolveAgentConfig(
    switchroomConfig?.defaults,
    switchroomConfig?.profiles,
    agentConfigRaw,
  );

  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];
  /**
   * Files we re-rendered AND backed up an operator-edited version
   * of. Surfaced via stderr at the end of scaffoldAgent so operators
   * notice; per-agent items are also included in `created` for the
   * normal "N files created" count.
   */
  const rewrittenWithBackup: string[] = [];

  const profilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
  const basePath = getBaseProfilePath();

  // Load user config for Telegram user ID
  const userConfig = loadUserConfig();
  const userId = userIdOverride ?? userConfig?.userId;

  // Resolve topic ID: config takes priority, then topics.json state file
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve bot token: per-agent token takes priority, then global telegram token
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);

  // Compute the effective permissions.allow list for settings.json.
  //
  // Special handling:
  //   - If the user writes `tools.allow: [all]`, Claude Code rejects the
  //     literal string "all" in the permissions.allow list. The correct
  //     equivalent is to use defaultMode: "acceptEdits" with an empty
  //     allow list.
  //   - If channels.telegram.plugin is "switchroom", pre-approve the switchroom-telegram
  //     MCP tool names so the agent never has to confirm MCP tool
  //     permissions at runtime.
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  // Single source of truth — honors SWITCHROOM_MEMORY_BACKEND=none
  // (install-validation 2026-05-17, R2 / prior #25).
  const hindsightEnabled = isHindsightEnabled(switchroomConfig);
  // The allow-list computation is shared with reconcileAgentInner via
  // computeDesiredPermissionAllow (footgun G — one source of truth, no drift).
  const permissionAllow = computeDesiredPermissionAllow(agentConfig, hindsightEnabled);

  // Compute Hindsight plugin context for the start.sh + settings.json
  // templates. Mirrors installHindsightPlugin's gating logic so the
  // template only emits the env vars and --plugin-dir flag when the
  // plugin will actually be installed.
  const hindsightAutoRecallEnabled = hindsightEnabled
    && agentConfig.memory?.auto_recall !== false;
  const hindsightBankId = agentConfig.memory?.collection ?? name;
  const hindsightApiBaseUrl = (switchroomConfig?.memory?.config?.url as string | undefined)
    ? (switchroomConfig!.memory!.config!.url as string).replace(/\/mcp\/?$/, "").replace(/\/$/, "")
    : HINDSIGHT_DEFAULT_API_BASE_URL;
  // Cascading recall cap. Per-agent value already merged from defaults
  // by config/merge.ts (memory is shallow-merged), so reading
  // agentConfig.memory.recall.max_memories here picks up the resolved
  // value. `undefined` means "let the plugin's settings.json default
  // apply" — start.sh.hbs gates the env var on this being defined.
  const hindsightRecallMaxMemories = agentConfig.memory?.recall?.max_memories;
  // Per-session recall cache TTL (#424 phase 4.1). Same cascade
  // semantics as max_memories. `undefined` here means "use the
  // switchroom-managed default of 600s baked into start.sh.hbs."
  // Set to 0 in switchroom.yaml to disable caching for an agent.
  const hindsightRecallCacheTtlSecs = agentConfig.memory?.recall?.cache_ttl_secs;
  // Recall latency envelope, resolved (and mutually clamped) once here so the
  // env exports and the plugin stamps cannot disagree.
  const hindsightRecallTunables = resolveHindsightRecallTunables(
    agentConfig.memory?.recall as RecallTunableInput | undefined,
  );
  const hindsightRecallParallelDeadlineSeconds =
    hindsightRecallTunables.parallelDeadlineSeconds;
  const hindsightRecallRequestTimeoutSeconds =
    hindsightRecallTunables.requestTimeoutSeconds;
  // Switchroom #3757 — BM25 query shaping + per-request timeout. Resolved from
  // the CASCADED config (defaults → profile → agent) like the sibling recall
  // knobs, so a fleet-wide `defaults.memory.recall.*` is honoured.
  //
  // ALWAYS resolved to a concrete value, and start.sh exports all three
  // UNCONDITIONALLY (#3774 defect class). The plugin's own precedence is
  // DEFAULTS -> settings.json -> ~/.hindsight/claude-code.json -> env
  // (`vendor/hindsight-memory/scripts/lib/config.py:437-470`), so a knob that
  // is not exported lets a stale hand-written `claude-code.json` shadow the
  // shipped default silently. Exporting an EMPTY string does not help either:
  // `_cast_env("", int)` returns None and `config.py:466-468` then skips the
  // assignment, so an empty export is indistinguishable from no export. The
  // only shape that actually wins is a real number/JSON on every boot, which
  // is why these fall back to the plugin's DEFAULTS values here.
  // `tests/scaffold.test.ts` pins the fallbacks against `lib/config.py` so the
  // two cannot drift.
  const hindsightRecallQueryMaxTokens =
    agentConfig.memory?.recall?.query_max_tokens ?? HINDSIGHT_RECALL_QUERY_MAX_TOKENS_DEFAULT;
  const rawRecallQueryStopTerms = agentConfig.memory?.recall?.query_stop_terms;
  const hindsightRecallQueryStopTermsJson = JSON.stringify(rawRecallQueryStopTerms ?? []);
  // Per-bank slot floors inside the count cap. Same cascade, but resolved to
  // the shipped default rather than left undefined: start.sh exports these
  // UNCONDITIONALLY (#3774). `~/.hindsight/claude-code.json` survives an apply
  // and loads AFTER the plugin's settings.json, so a conditional export lets a
  // stale hand-edited value there shadow what switchroom stamps — silently, and
  // permanently. Exporting the resolved effective value makes env authoritative.
  const hindsightRecallOwnBankMinSlots =
    agentConfig.memory?.recall?.own_bank_min_slots ?? HINDSIGHT_OWN_BANK_MIN_SLOTS_DEFAULT;
  const hindsightRecallAdditionalBankMinSlots =
    agentConfig.memory?.recall?.additional_bank_min_slots ??
    HINDSIGHT_ADDITIONAL_BANK_MIN_SLOTS_DEFAULT;
  // #3837 score floor. Same unconditional-export treatment as the slot floors
  // (#3774): a conditional export would let a stale hand-edited
  // `~/.hindsight/claude-code.json` silently turn a filter ON that switchroom
  // ships OFF. Resolving to 0 here makes "disabled" the authoritative state.
  const hindsightRecallMinScore =
    agentConfig.memory?.recall?.min_score ?? HINDSIGHT_RECALL_MIN_SCORE_DEFAULT;
  const hindsightRecallMinScoreScope =
    agentConfig.memory?.recall?.min_score_scope ??
    HINDSIGHT_RECALL_MIN_SCORE_SCOPE_DEFAULT;
  // #3841 — everything else recall.py reads. Resolved from the same CASCADED
  // agent config, always to a concrete value, and exported unconditionally.
  // THROWS on an out-of-enum / wrong-typed value: a bad knob must red the
  // apply, not sail through to a fail-open `_cast_env` that silently restores
  // the plugin default while switchroom.yaml reads as though it were tuned.
  const hindsightRecallPassthrough = resolveHindsightRecallPassthrough(
    agentConfig.memory?.recall as RecallPassthroughInput | undefined,
  );
  // Phase 1 / 6a opt-out: undefined unless the operator overrode the
  // switchroom default (observations on, trivial-skip on). Exported only
  // when set (see start.sh.hbs), so an unset value leaves the on-by-default
  // settings.json override in force.
  const hindsightRecallTypes = agentConfig.memory?.recall?.types?.length
    ? agentConfig.memory.recall.types.join(",")
    : undefined;
  const hindsightRecallSkipTrivial =
    agentConfig.memory?.recall?.skip_trivial === undefined
      ? undefined
      : String(agentConfig.memory.recall.skip_trivial);
  // #2848 Stage B — directive-capture nudge cascade. undefined unless the
  // operator overrode the switchroom default (on). Exported only when set
  // (see start.sh.hbs), so an unset value leaves the on-by-default
  // settings.json override in force. Top-level memory.* knob (not under
  // memory.recall) — it gates a correction-detection nudge, not recall tuning.
  const hindsightDirectiveCaptureNudge =
    agentConfig.memory?.directive_capture_nudge === undefined
      ? undefined
      : String(agentConfig.memory.directive_capture_nudge);
  // Per-row observation scope (memory.observation_scopes cascade). undefined
  // unless the operator set it — exported only when set (see start.sh.hbs), so
  // the default retain body never carries the field and the engine default
  // stands. Top-level memory.* knob: it stamps every retain path, not just the
  // Stop-hook cadence under memory.retain.
  const hindsightObservationScopes = agentConfig.memory?.observation_scopes;
  // Per-retain observation-scope strategy (memory.observation_scope_strategy
  // cascade). undefined unless the operator set it — exported only when set
  // (see start.sh.hbs), so an unset value leaves the plugin's on-by-default
  // `curated` strategy in force. Selects curated-vs-not; the pin above wins.
  const hindsightObservationScopeStrategy =
    agentConfig.memory?.observation_scope_strategy;

  // PR6 — supergroup-mode topic tagging. Build the {alias: thread_id}
  // JSON for retain.py + recall.py to resolve numeric thread_ids to
  // human alias names. Only emitted for supergroup-owned agents
  // (channels.telegram.topic_aliases set); fleet-shared / DM agents
  // get undefined and the env-export blocks no-op via the
  // {{#if hindsightTopicAliasesJsonQ}} guard.
  const topicAliases = agentConfig.channels?.telegram?.topic_aliases;
  const hindsightTopicAliasesJson = topicAliases && Object.keys(topicAliases).length > 0
    ? JSON.stringify(topicAliases)
    : undefined;
  // Switchroom (per-speaker memory routing): {sender: bank} map →
  // HINDSIGHT_SENDER_BANKS_JSON. Sourced from memory.recall.sender_banks
  // (cascaded). Undefined when no map is set (the env-export block no-ops).
  // `serves`-assigned users generate sender_banks (speaker routing), unioned
  // with any explicit map — resolved by resolveUsers() (user concept, RFC
  // reference/rfcs/user-concept.md). Falls back to the explicit map when no
  // full config is in scope.
  const senderBanks = switchroomConfig
    ? resolveUsers(switchroomConfig, name).senderBanks
    : agentConfig.memory?.recall?.sender_banks ?? {};
  const hindsightSenderBanksJson = senderBanks && Object.keys(senderBanks).length > 0
    ? JSON.stringify(senderBanks)
    : undefined;
  // PR6 — topic filter mode opt-in. Defaults to undefined (the script
  // falls back to "soft-preamble" internally). Operator sets via
  // memory.recall.topic_filter_mode in switchroom.yaml when binding
  // failures are observed; the start.sh.hbs gate emits the env-export
  // only when set, leaving recall.py to read its own internal default.
  const hindsightTopicFilterMode = (
    agentConfig.memory?.recall as { topic_filter_mode?: string } | undefined
  )?.topic_filter_mode;

  // Build the template rendering context via the shared helper so
  // scaffold and reconcile always produce the same shape for workspace
  // template rendering (see buildWorkspaceContext).
  const context = buildWorkspaceContext({
    name,
    agentDir,
    agentConfig,
    telegramConfig,
    switchroomConfig,
    switchroomConfigPath,
    topicId,
    tools,
    permissionAllow,
    hasAllWildcard,
    resolvedBotToken,
    rawBotToken,
    hindsightAutoRecallEnabled,
    hindsightBankId,
    hindsightApiBaseUrl,
    hindsightRecallMaxMemories,
    hindsightRecallCacheTtlSecs,
    hindsightRecallParallelDeadlineSeconds,
    hindsightRecallQueryMaxTokens,
    hindsightRecallQueryStopTermsJson,
    hindsightRecallRequestTimeoutSeconds,
    hindsightRecallOwnBankMinSlots,
    hindsightRecallAdditionalBankMinSlots,
    hindsightRecallMinScore,
    hindsightRecallMinScoreScope,
    hindsightRecallPassthrough,
    hindsightRecallTypes,
    hindsightRecallSkipTrivial,
    hindsightDirectiveCaptureNudge,
    hindsightObservationScopes,
    hindsightObservationScopeStrategy,
    hindsightTopicAliasesJson,
    hindsightSenderBanksJson,
    hindsightTopicFilterMode,
  });

  // --- Create directory structure ---
  const dirs = [
    agentDir,
    join(agentDir, ".claude"),
    join(agentDir, ".claude", "skills"),
    join(agentDir, "memory"),
    join(agentDir, "telegram"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // --- Render and write base templates ---
  // start.sh is purely template-driven (no user-merged sections), so it
  // must be regenerated whenever the template changes. writeIfMissing
  // would skip an existing file regardless of whether the template has
  // since gained new content (e.g. v0.7.5 added the docker-mode tmux
  // preamble — agents whose start.sh predated that release booted
  // without the preamble after `apply --only=<name>` because the file
  // already existed). See #879.
  writeIfChanged(
    join(agentDir, "start.sh"),
    () => renderTemplate(join(basePath, "start.sh.hbs"), context),
    created,
    skipped,
  );
  // Make start.sh executable
  if (existsSync(join(agentDir, "start.sh"))) {
    chmodSync(join(agentDir, "start.sh"), 0o700);
  }

  // Cheap-cron (L4): render the Tier-1 cron-session launcher ONLY when this
  // agent has a context:fresh entry. No current fleet agent does, so this is
  // skipped fleet-wide — and the start.sh fork that runs it is empty too.
  if (context.cronSessionEnabled) {
    writeIfChanged(
      join(agentDir, "cron-session.sh"),
      () => renderTemplate(join(basePath, "cron-session.sh.hbs"), context),
      created,
      skipped,
    );
    if (existsSync(join(agentDir, "cron-session.sh"))) {
      chmodSync(join(agentDir, "cron-session.sh"), 0o700);
    }
  }

  writeIfMissing(
    join(agentDir, ".claude", "settings.json"),
    () => renderTemplate(join(basePath, "settings.json.hbs"), context),
    created,
    skipped,
    0o600,
  );

  // --- Merge MCP configs into settings.json ---
  if (switchroomConfig) {
    const settingsPath = join(agentDir, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }

      // Hindsight memory MCP
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry && !settings.mcpServers[hindsightEntry.key]) {
        settings.mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }

      // Pre-allow the every-agent MCP servers in settings.permissions.allow
      // so existing agents pick up the wildcards on `switchroom apply`
      // (writeIfMissing above skips settings.json for existing agents,
      // so a fresh permissionAllow would otherwise only land on first
      // scaffold). Without this merge a first call to skill_list /
      // cron_list / config_get / audit_tail / peers_list wedges the
      // agent on a Claude Code permission prompt the operator has to
      // approve via Telegram one-tool-at-a-time. See the UAT for
      // PR #1215 (skill_list screenshot).
      settings.permissions = settings.permissions ?? {};
      // #1400 link 1: actively retract the pre-#1400 blanket hostd
      // grant before re-seeding the narrowed read-only-only set, so
      // an existing agent that baked in `mcp__hostd__*` stops having
      // the mutating verbs pre-approved.
      //
      // Context7 opt-out must RETRACT on this path, not merely stop
      // re-seeding. The loop below is union-only (push-if-absent), and
      // this merge block is the path every already-deployed agent takes
      // on `switchroom apply` — so without an explicit filter, setting
      // `mcp_servers.context7: false` would drop the .mcp.json server
      // (retractStaleIntegrationKeys, below) while leaving the
      // pre-approval tokens behind indefinitely, converging only if the
      // agent later went through reconcileAgent. Retract the enumerated
      // tokens AND any blanket `mcp__context7*` grant an agent picked up
      // from an in-development build.
      //
      // Two things this filter deliberately does NOT do. It never fires
      // for an opted-IN agent, so a token the operator wants stays. And
      // it never strips a token the agent DECLARES in its own
      // `tools.allow` — reconcileAgent assigns computeDesiredPermissionAllow's
      // output wholesale and that output includes the declared list
      // regardless of the opt-out, so stripping a declared token here
      // would make the two paths disagree and flip-flop the file on
      // alternating apply/reconcile runs.
      //
      // webkite has the same latent union-only gap on this path —
      // deliberately not changed here (it alters behaviour for already-
      // deployed opted-out agents); tracked in #3672.
      const context7OptedOut = agentConfig.mcp_servers?.["context7"] === false;
      const declaredAllow = new Set(agentConfig.tools?.allow ?? []);
      const context7Retract = context7OptedOut
        ? [...CONTEXT7_MCP_TOOLS, ...CONTEXT7_BLANKET_TOKENS].filter(
          (t) => !declaredAllow.has(t),
        )
        : [];
      const allow: string[] = (Array.isArray(settings.permissions.allow)
        ? settings.permissions.allow
        : []
      ).filter(
        (p: string) =>
          !LEGACY_HOSTD_BLANKET_TOKENS.includes(p) && !context7Retract.includes(p),
      );
      // Webkite is fleet-default; re-seed its tools into EXISTING agents'
      // allow on apply (writeIfMissing above skips the template for
      // existing agents, so the fresh permissionAllow never lands). This
      // is the existing-agent twin of the permissionAllow webkite spread.
      // Without it, every deployed agent's first webkite_* call wedges on
      // a permission prompt even though .mcp.json wires webkite (the merge
      // at the INTEGRATION_MCP_RESOLVERS loop below). Gated on the same
      // opt-out as the MCP entry emission.
      const webkiteAllowTools =
        agentConfig.mcp_servers?.["webkite"] === false ? [] : WEBKITE_MCP_TOOLS;
      // Existing-agent twin of the permissionAllow context7 spread —
      // same rationale as webkiteAllowTools directly above. Without it
      // every already-deployed agent's first context7 call wedges on a
      // permission prompt despite .mcp.json wiring the server. The
      // opted-out direction is handled by `context7Retract` above.
      const context7AllowTools = context7OptedOut ? [] : CONTEXT7_MCP_TOOLS;
      for (const t of [
        ...AGENT_CONFIG_MCP_TOOLS,
        ...HOSTD_MCP_TOOLS,
        ...webkiteAllowTools,
        ...context7AllowTools,
      ]) {
        if (!allow.includes(t)) allow.push(t);
      }
      settings.permissions.allow = allow;

      // Fleet-baseline interactive-TUI deny must also re-seed into EXISTING
      // agents on `switchroom apply` — writeIfMissing above skips the
      // settings.json template for existing agents, so the fresh-path deny
      // (buildWorkspaceContext.toolsDeny) never lands on a deployed agent.
      // Additive so any user-declared or webkite denies already present are
      // preserved. Without this, a deployed agent keeps rendering the
      // blocking AskUserQuestion selector until it next goes through the
      // reconcileAgent path. See INTERACTIVE_TUI_FLEET_DENY_TOOLS.
      const deny: string[] = Array.isArray(settings.permissions.deny)
        ? settings.permissions.deny
        : [];
      for (const t of INTERACTIVE_TUI_FLEET_DENY_TOOLS) {
        if (!deny.includes(t)) deny.push(t);
      }
      settings.permissions.deny = deny;

      // #235: actively retract the legacy switchroom-mcp entry on reconcile
      // so existing agents stop spawning the dormant child process. The 4
      // tools it exposed had zero callers and are subsumed by Hindsight's
      // MCP + Claude Code's built-in Read/Grep.
      if (settings.mcpServers && "switchroom" in settings.mcpServers) {
        delete settings.mcpServers["switchroom"];
      }

      // Built-in default MCPs (e.g. playwright). Single source of truth lives
      // in scaffold-integration.ts so scaffold + `switchroom update` reconcile
      // stay in sync. Agents can suppress any default with
      // `mcp_servers: { <key>: false }` in switchroom.yaml; defaults are added
      // here AFTER the template renders user-declared mcp_servers, and the
      // opt-out check reads the user's mcp_servers map directly to honour
      // `false` even though filterMcpServers strips that sentinel before the
      // template sees it.
      for (const entry of getBuiltinDefaultMcpEntries()) {
        const agentOptOut = (agentConfig.mcp_servers ?? {})[entry.optOutKey] === false;
        if (!agentOptOut && !settings.mcpServers[entry.key]) {
          settings.mcpServers[entry.key] = entry.value;
        }
      }

      // Per-agent conditional `gdrive` MCP. Net-new gated logic (the
      // built-in defaults above are unconditional). Emitted ONLY when the
      // agent is broker-authorized for a Google account — the gate
      // mirrors the auth-broker's account selection + ACL exactly so the
      // launcher never spawns an MCP the broker would refuse. Honours the
      // `mcp_servers: { gdrive: false }` hard opt-out. A user-declared
      // `gdrive` entry (already in settings.mcpServers) wins, same as the
      // built-in defaults above.
      // Site 1 — user-wins precedence: a user-declared mcp_servers
      // entry already in settings.mcpServers takes priority. Registry
      // iteration preserves the gdrive → ms-365 → notion order from
      // INTEGRATION_MCP_RESOLVERS.
      const site1Protected = userDeclaredMcpKeys(agentConfig);
      for (const integration of INTEGRATION_MCP_RESOLVERS) {
        const entries = integrationMcpEntries(
          integration,
          name,
          agentConfig,
          switchroomConfig,
        );
        for (const entry of entries) {
          if (!settings.mcpServers[entry.key]) {
            settings.mcpServers[entry.key] = entry.value;
          }
        }
        // Durable retraction on this MERGE path (existing settings.json is
        // read + merged, never rebuilt): drop any owned-namespace key
        // (bare `ms-365` or `ms-365-<slug>`) still present from a prior
        // apply that is no longer emitted — e.g. an account removed from
        // `microsoft_workspace.accounts`. Without this the stale per-account
        // key lingers in settings.json.mcpServers across `switchroom apply`.
        //
        // This IS load-bearing, not hygiene: the main session's `exec claude`
        // in profiles/_base/start.sh.hbs does NOT pass `--strict-mcp-config`
        // (only the cron session does — cron-session.sh.hbs), so Claude Code
        // loads MCP servers from settings.json.mcpServers in ADDITION to
        // .mcp.json. A stale `ms-365-<slug>` left here would resurrect the
        // removed account's tool namespace. (The reconcileAgentInner
        // settings.json + .mcp.json paths rebuild `mcpServers` from scratch,
        // so they retract fully-removed slugs by reconstruction — this merge
        // path is the only one that needs an explicit prefix-scoped diff.)
        retractStaleIntegrationKeys(
          integration,
          new Set(entries.map((e) => e.key)),
          settings.mcpServers,
          site1Protected,
        );
      }

      // Hindsight memory plugin install (replaces our old shell hook).
      // The vendored plugin's own hooks.json wires SessionStart /
      // UserPromptSubmit / Stop / SessionEnd via Claude Code's plugin
      // loader once start.sh passes --plugin-dir.
      installHindsightPlugin(name, agentDir, switchroomConfig, agentConfig);

      // Disable Claude Code's built-in auto-memory so the model doesn't
      // get dueling instructions (write to local .md files vs use
      // Hindsight). The settings flag gates the memory system-prompt
      // block at the source.
      // Use the CASCADED gate computed above, not a re-read of the raw
      // `agents[name].memory.auto_recall`: this and installHindsightPlugin must
      // agree, or an agent with a defaults/profile-tier `auto_recall: false`
      // would get the plugin skipped (correct) yet keep Claude Code's built-in
      // auto-memory disabled here (wrong) — the exact split #3914 is about.
      if (hindsightAutoRecallEnabled) {
        settings.autoMemoryEnabled = false;
      }

      // --- Phase 2: user-declared hooks and model ---
      //
      // Hooks from switchroom.yaml (merged with defaults) are translated from
      // switchroom's flat shape to Claude Code's nested shape and assigned
      // wholesale to settings.hooks. Switchroom owns the entire settings.hooks
      // object — plugin-installed hooks (hindsight) live in the plugin's
      // own hooks.json and are loaded via --plugin-dir, so they're not
      // affected by this and Claude Code merges them at runtime.
      // Per #142, the SessionStart greeting hook + session-greeting.sh
      // curl script are deleted. The boot card (telegram-plugin/gateway/
      // boot-card.ts) now handles "agent is back" UX with a quiet, settle-
      // gated single-line ack; the full config audit content moves to a
      // future `/status` command (#142 PR 3).
      //
      // buildSettingsHooksBlock() is the single source of truth for the full
      // hooks block (user yaml + switchroom-owned). Reconcile calls the same
      // function so both paths are guaranteed byte-identical.
      settings.hooks = buildSettingsHooksBlock({
        agentName: name,
        agentConfig,
        hindsightEnabled,
        useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
        configPath: switchroomConfigPath,
      });
      // Model: explicit override from yaml wins; otherwise apply the
      // switchroom default (sonnet 5, see SWITCHROOM_DEFAULT_MAIN_MODEL
      // for rationale). Always written to settings.model so the user
      // doesn't have to pass --model on every invocation, and so the
      // doctor / debug surfaces show the resolved choice.
      settings.model = resolveMainModel(agentConfig.model);

      // --- Phase 5: settings_raw escape hatch ---
      //
      // Final step before writing: deep-merge any user-declared raw
      // settings onto the computed object. This lets power users reach
      // Claude Code settings keys switchroom doesn't wrap directly (e.g.
      // `effort`, `apiKeyHelper`, future keys). Happens last so switchroom's
      // typed fields can be overridden — that's the point of the hatch.
      // Also stamp the `_switchroomManagedRawKeys` side-car so reconcile can
      // retract non-switchroom-owned keys if the user removes them later.
      const mergedSettings = agentConfig.settings_raw
        ? (deepMergeJson(settings, agentConfig.settings_raw) as Record<string, unknown>)
        : settings;
      if (agentConfig.settings_raw && Object.keys(agentConfig.settings_raw).length > 0) {
        mergedSettings._switchroomManagedRawKeys = Object.keys(agentConfig.settings_raw);
      }

      writeFileSyncIfChanged(settingsPath, JSON.stringify(mergedSettings, null, 2) + "\n");
    }
  }

  // --- Write project-level .mcp.json for switchroom-telegram development channel ---
  //
  // When channels.telegram.plugin is "switchroom", Claude Code's
  // `--dangerously-load-development-channels server:NAME` flag resolves
  // the MCP server definition from the project-level .mcp.json in the
  // working directory — NOT from settings.json mcpServers. Write it here
  // so the enhanced Telegram plugin can be launched as a dev channel.
  //
  // Captured here, applied to the trust allowlist a SECOND time after
  // `.claude.json` is created (~`preTrustWorkspace` below). The in-block
  // ensureMcpServersTrusted call is a silent no-op on a brand-new agent
  // (`.claude.json` doesn't exist that early) — without the post-create
  // pass a net-new agent's gdrive/agent-config/hostd servers are never
  // trusted and Claude silently ignores them.
  let mcpServerKeysToTrust: string[] | null = null;
  if (usesSwitchroomTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    // The agent image (Dockerfile.agent) COPYs the plugin to a stable
    // in-image path and bakes a `switchroom` symlink at /usr/local/bin.
    // Reference those — the host's repo checkout / npm-global install
    // path is irrelevant inside the container and would resolve to a
    // non-existent path. Compose bind-mounts switchroom.yaml at
    // /state/config/switchroom.yaml.
    const pluginDir = DOCKER_TELEGRAM_PLUGIN_PATH;
    const switchroomCliPath = "/usr/local/bin/switchroom";
    const resolvedConfigPath = DOCKER_CONFIG_PATH;

    // TELEGRAM_STATE_DIR MUST be the in-container view, not derived from
    // `agentDir` (which is HOME-dependent and differs between host CLI and
    // in-container CLI). Both writers target the same on-disk .mcp.json via
    // bind-mount; the file is consumed by the in-container Claude, so the
    // value must always be the in-container path regardless of where the
    // writer runs. Pre-fix: host apply wrote `/home/<user>/...`, in-container
    // reconcile wrote `/state/agent/home/...`, each invocation flipped the
    // file and the broker's cron-only reconcile saw drift on every
    // `schedule_add`. See switchroom#1892.
    const telegramStateDir = `${DOCKER_AGENT_HOME}/.switchroom/agents/${name}/telegram`;

    // Linear connection gate (P4-A): the bridge only advertises the
    // linear_* tools when this agent actually has the Linear connection
    // configured. Mirrors the `linearAgentEnabled` derivation in
    // buildWorkspaceContext (scaffold.ts:2362) so both stay in lockstep.
    const linearAgentEnabled =
      (
        agentConfig.channels?.telegram as
          | { linear_agent?: { enabled?: boolean } }
          | undefined
      )?.linear_agent?.enabled === true;

    const mcpServers: Record<string, McpServerConfig> = {
      "switchroom-telegram": {
        command: "bun",
        args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
        env: {
          TELEGRAM_STATE_DIR: telegramStateDir,
          SWITCHROOM_CONFIG: resolvedConfigPath,
          SWITCHROOM_CLI_PATH: switchroomCliPath,
          // Gate the linear_* tools (P4-A). Only set when the Linear
          // connection is configured; the bridge drops those 3 tools
          // otherwise so a non-Linear agent never carries their schema.
          ...(linearAgentEnabled ? { SWITCHROOM_TELEGRAM_LINEAR: "1" } : {}),
        },
        // Tool-search right-sizing (P4-B): the server is NO LONGER pinned
        // wholesale. The bridge pins the load-bearing hot tools (reply /
        // get_recent_messages / react / edit_message /
        // send_typing / download_attachment) individually via the native
        // per-tool `_meta["anthropic/alwaysLoad"]` annotation, so they
        // never defer (no orphaned-reply round-trip), while the ~14 cold
        // tools (linear / vault / checklist / gif / sticker / pin / delete
        // / forward / ask_user) defer and load on first use — reclaiming
        // ~5k tokens of always-on baseline per agent.
        alwaysLoad: false,
      },
      // Read-only agent-config broker. Exposes 4 tools (config_get,
      // cron_list, skill_list, audit_tail) that re-exec the switchroom
      // CLI. Identity is pinned by SWITCHROOM_AGENT_NAME — the CLI
      // refuses cross-agent reads.
      "agent-config": {
        command: switchroomCliPath,
        args: ["mcp", "agent-config"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
        // Deferred: 4-tool read-only server loads on demand via tool search.
        // Agents invoke agent-config tools only occasionally (schedule adds,
        // skill installs, config reads) — pinning it server-wide (~4 tools)
        // burned always-on context budget for no first-turn benefit.
        alwaysLoad: false,
      },
    };

    // hostd MCP — admin-only (#1175 RFC C / PR δ). Compose only
    // bind-mounts the hostd socket for admin agents, so non-admin
    // entries here would just surface ENOENT at first call.
    if (agentConfig.admin === true || agentConfig.root === true) {
      mcpServers["hostd"] = {
        command: switchroomCliPath,
        args: ["mcp", "hostd"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
      };
    }

    // Add hindsight memory MCP if configured
    if (hindsightEnabled && switchroomConfig) {
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry) {
        mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }
    }

    // Per-agent conditional `gdrive` MCP. THIS .mcp.json (not
    // settings.json.mcpServers) is the surface Claude Code actually
    // loads for switchroom-telegram-plugin agents — see the block
    // comment at the top of this branch. Same shared broker-ACL gate.
    if (switchroomConfig) {
      // Site 2 — framework-wins on first write; subsequent user
      // spread (below) wins on key collision. Order preserved from
      // INTEGRATION_MCP_RESOLVERS so two integrations never silently
      // disagree on precedence between sites.
      for (const integration of INTEGRATION_MCP_RESOLVERS) {
        for (const entry of integrationMcpEntries(
          integration,
          name,
          agentConfig,
          switchroomConfig,
        )) {
          mcpServers[entry.key] = entry.value;
        }
      }
    }

    // User-declared mcp_servers from switchroom.yaml (`defaults.mcp_servers`
    // and per-agent `agents.<name>.mcp_servers`, already merged by the
    // config cascade). Spread AFTER the framework set so user-declared
    // entries can override on key collision — matching the
    // settings.json precedence at line ~2255 where built-in defaults
    // only land when `!settings.mcpServers[entry.key]`. `false`
    // opt-outs are stripped by `filterMcpServers`. Without this spread
    // (the pre-fix state since v0.7.6) the only MCPs Claude could see
    // were the framework set — perplexity, notion, and any other
    // operator-declared entries were silently dropped.
    if (agentConfig.mcp_servers) {
      const filtered = filterMcpServers(agentConfig.mcp_servers);
      if (filtered) {
        for (const [key, value] of Object.entries(filtered)) {
          mcpServers[key] = value as McpServerConfig;
        }
      }
    }

    // .mcp.json contents: framework MCPs + user-declared MCPs from
    // switchroom.yaml. writeIfChanged so a stale file from a pre-v0.7.6
    // release (different plugin path resolution) is rewritten on the
    // next `switchroom apply`.
    writeIfChanged(
      mcpJsonPath,
      () => JSON.stringify({ mcpServers }, null, 2) + "\n",
      created,
      skipped,
      0o600,
    );
    // Cheap-cron Tier-1 (#2307): full-set .claude-cron/.mcp.json for the cron
    // session (shared memory + tools, tool-search-deferred; cron-only liveness
    // path) — no-op unless this agent runs a cron session.
    maybeWriteCronMcp(
      agentDir,
      mcpServers,
      buildCronSessionContext(agentConfig).cronSessionEnabled,
    );
    // Claude Code only loads project `.mcp.json` servers that are on the
    // per-project trust allowlist. preTrustWorkspace sets
    // hasTrustDialogAccepted but never enabledMcpjsonServers, so any
    // server scaffolded after original onboarding (gdrive, plus
    // agent-config/hostd for non-original agents) is silently ignored.
    // Union every server we just wrote into the allowlist. UNION-ONLY:
    // ensureMcpServersTrusted never removes a key, so a server that
    // stops being emitted (e.g. `mcp_servers.context7: false`) keeps its
    // stale `enabledMcpjsonServers` entry across applies. That entry is
    // inert — trust is a per-server allowlist consulted only for servers
    // that are actually present in `.mcp.json`, and the opted-out server
    // is retracted from `.mcp.json` — so this is untidiness, not a
    // dangling capability. Deliberately not "fixed" here: the removal
    // direction would need a switchroom-owned-key ledger to avoid
    // clobbering trust an operator granted by hand for a server
    // switchroom doesn't manage. Tracked in #3672.
    // NOTE: on a brand-new agent `.claude.json` does not exist yet at this point —
    // this call silently no-ops and the post-`preTrustWorkspace` pass
    // below is what actually lands the trust. Kept here too because it
    // is idempotent and covers the re-scaffold path where the file
    // already exists.
    mcpServerKeysToTrust = Object.keys(mcpServers);
    ensureMcpServersTrusted(agentDir, mcpServerKeysToTrust);
  }

  // --- Render template-specific files ---
  // Phase 2: SOUL.md moved to workspace/SOUL.md (seedWorkspaceBootstrapFiles)
  const templateFiles: Array<{ src: string; dest: string }> = [
    { src: "CLAUDE.md.hbs", dest: "CLAUDE.md" },
  ];

  for (const { src, dest } of templateFiles) {
    const srcPath = join(profilePath, src);
    if (existsSync(srcPath)) {
      // CLAUDE.md uses a fingerprint-aware re-render so profile-template
      // changes (e.g. `_shared/telegram-style.md.hbs`) propagate to
      // existing agents on `switchroom apply`. Old behaviour
      // (writeIfMissing) froze the file forever after first scaffold —
      // the root cause of the #1122 conversational-pacing rollout
      // silently bypassing every running agent's prompt. Operator
      // hand-edits are preserved as a backup at
      // `<filename>.before-rerender.<unix-ms>` so they can be
      // re-merged manually.
      const renderManaged = () => {
          let rendered = renderTemplate(srcPath, context);
          if (dest === "CLAUDE.md") {
            // Reply-discipline rides at the TOP (prepended after the
            // title), unlike the tail fragments below — the "reply tool
            // or it's invisible" contract must be one of the first things
            // the model reads. Every profile gets it.
            rendered = prependReplyDiscipline(rendered, context);
            const vaultProtocol = renderVaultProtocolFragment(context);
            if (vaultProtocol) {
              rendered = rendered.trimEnd() + "\n\n" + vaultProtocol + "\n";
            }
            // Agent-self-service fragment (#1163) — names the agent-config
            // MCP tools (config_get / cron_list / skill_list / schedule_add
            // / schedule_remove / audit_tail) + the safety rails. Same
            // unconditional-append pattern as vault-protocol — every agent
            // gets the prompt grounding because every agent gets the tools
            // wired via .mcp.json. Without this fragment, the model has
            // the tools available in tools/list but no awareness of when
            // to reach for them, so natural-language asks like "remind me
            // to call mom at 5pm" fall back to free-styling a yaml paste-
            // block instead of calling schedule_add directly.
            const selfService = renderAgentSelfServiceFragment(context);
            if (selfService) {
              rendered = rendered.trimEnd() + "\n\n" + selfService + "\n";
            }
            // Execution-discipline fragment — the fleet-wide grounding /
            // verify-before-assert posture (serves the
            // "feel-like-a-colleague" job: "verifies before claiming").
            // Same unconditional-append pattern as the two above so it
            // reaches EVERY agent on EVERY profile, not just the default
            // profile's CLAUDE.md.
            const executionDiscipline = renderExecutionDisciplineFragment(context);
            if (executionDiscipline) {
              rendered = rendered.trimEnd() + "\n\n" + executionDiscipline + "\n";
            }
            // Dev-protocol fragment — Ken's fleet-wide development
            // protocol (orient/ground, clarify vs proceed, design-align,
            // pipeline, communication). Same unconditional-append
            // pattern so it reaches EVERY agent on EVERY profile; the
            // long-form playbook is the bundled `dev-protocol` skill.
            const devProtocol = renderDevProtocolFragment(context);
            if (devProtocol) {
              rendered = rendered.trimEnd() + "\n\n" + devProtocol + "\n";
            }
            // Delegation golden-rule fragment — appended LAST (after
            // execution-discipline and dev-protocol) on purpose so the
            // "prefer delegating execution to a sub-agent" signal regains
            // tail-of-prompt recency and can't be overridden by the
            // inline-execution voice of the two fragments above (#3231).
            // Same unconditional-append pattern; ORDER (…, dev-protocol,
            // then delegation-golden-rule) must mirror the reconcile path
            // below or the diff-abort trips on every reconcile.
            const delegationGoldenRule = renderDelegationGoldenRuleFragment(context);
            if (delegationGoldenRule) {
              rendered = rendered.trimEnd() + "\n\n" + delegationGoldenRule + "\n";
            }
          }
          if (dest === "CLAUDE.md" && agentConfig.claude_md_raw) {
            rendered = rendered.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
          }
          return rendered;
      };
      if (dest === "CLAUDE.md") {
        // Two-section composition (#1857): the rendered output above is the
        // Switchroom-managed block; everything below the visible marker is
        // operator-owned and preserved across applies. Uses a marker-aware
        // fingerprint writer: only the managed (above-marker) section is
        // fingerprinted, so a below-marker operator edit — the normal,
        // encouraged state — is NOT treated as drift and never triggers a
        // .before-rerender backup. Composition goes through the same shared
        // helper as the reconcile path (Phase 3) so both paths produce
        // byte-identical output.
        writeTwoSectionClaudeMdWithFingerprint(
          join(agentDir, dest),
          renderManaged,
          join(agentDir, "workspace", "CLAUDE.custom.md"),
          created,
          skipped,
          rewrittenWithBackup,
        );
      } else {
        rerenderWithFingerprint(
          join(agentDir, dest),
          renderManaged,
          created,
          skipped,
          rewrittenWithBackup,
        );
      }
    }
  }

  // --- Seed workspace bootstrap files from profile (CLAUDE.md, USER.md, etc.)
  //
  //     Profiles may ship a `workspace/` subdirectory containing .hbs
  //     templates and plain files. Each .hbs is rendered into the agent's
  //     `workspace/` directory; plain files are copied verbatim. These files
  //     are user-editable afterwards — we only seed on first scaffold (via
  //     writeIfMissing) so user edits survive re-runs.
  //
  //     Phase 5: CLAUDE.md is the primary agent-protocol file; AGENTS.md
  //     and AGENT.md are symlinks to it. Run the legacy-AGENTS.md
  //     migration before seeding so any pre-Phase-5 customizations are
  //     preserved into CLAUDE.md before the seed pass runs.
  const phase5WorkspaceDir = join(agentDir, "workspace");
  mkdirSync(phase5WorkspaceDir, { recursive: true });
  migrateLegacyAgentsMdIfPresent(phase5WorkspaceDir, created);
  seedWorkspaceBootstrapFiles({
    profilePath,
    agentDir,
    context,
    created,
    skipped,
    rewrittenWithBackup,
    seedMemoryFile: agentConfig.memory?.file !== false,
  });
  ensureClaudeMdSymlinks(phase5WorkspaceDir, created);

  // --- Persistent agent HOME (Layer 1) ---
  // The container has read-only root + a numeric UID with no
  // /etc/passwd entry, so HOME defaults to "/" — every tool that
  // writes to ~/.config / ~/.cache / ~/.local fails outright.
  // compose.ts sets HOME=/state/agent/home; this section creates that
  // directory inside the existing /state/agent bind mount and seeds
  // a minimal .bashrc / .profile so attached interactive shells get
  // the same PATH/NPM env as start.sh sets for non-interactive
  // children.
  //
  // All seeds are writeIfMissing — agents (and operators) can
  // customize freely without losing changes on `switchroom apply`.
  const persistentHomeDir = join(agentDir, "home");
  mkdirSync(persistentHomeDir, { recursive: true });
  for (const sub of [".local/bin", ".npm-global", "bin"]) {
    mkdirSync(join(persistentHomeDir, sub), { recursive: true });
  }

  // Pre-create the $HOME/.switchroom symlink on the HOST, before the
  // container's first boot (#910 host-side companion). start.sh.hbs also
  // creates this link at runtime, but its guard refuses to clobber a
  // pre-existing real directory at $HOME/.switchroom — and for ADMIN /
  // ROOT agents docker creates exactly that: the admin audit-log binds
  // (`…/vault-audit.log`, `…/host-control-audit.log` in compose.ts) target
  // paths UNDER $HOME/.switchroom, so on a fresh agent's first boot docker
  // materialises $HOME/.switchroom as a real dir to host those mount
  // points BEFORE start.sh runs → the runtime symlink is skipped → the
  // gateway↔claude bridge can't resolve `$HOME/.switchroom/agents/<name>/
  // telegram/gateway.sock` and never registers (the agent silently
  // ingests Telegram DMs into a buffer that never drains). Non-admin
  // agents dodge this only because they have no mounts under the link.
  // Seeding the symlink here means docker resolves those binds THROUGH it
  // (the working klanker shape) and never creates the conflicting dir.
  // Host-only: in-container reconcile has HOME=/state/agent/home (the
  // wrong target) and the link already exists, so skip there. Create-only
  // (never clobbers an existing symlink or a real dir — an already-booted
  // agent is left to start.sh / operator).
  if (!isContainerContext() && process.env.HOME) {
    const dotSwitchroomLink = join(persistentHomeDir, ".switchroom");
    let linkExists = true;
    try {
      lstatSync(dotSwitchroomLink);
    } catch {
      linkExists = false;
    }
    if (!linkExists) {
      try {
        symlinkSync(join(process.env.HOME, ".switchroom"), dotSwitchroomLink);
        created.push(dotSwitchroomLink);
      } catch {
        // Best-effort: a failure here just falls back to start.sh's
        // runtime attempt (which works for non-admin agents).
      }
    }
  }
  const homeEnvBlock = [
    "# switchroom Layer 1: per-agent persistent HOME.",
    "# These exports mirror profiles/_base/start.sh.hbs so attached",
    "# interactive shells see the same PATH and npm-global prefix as",
    "# the agent's non-interactive child processes.",
    'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"',
    'export NPM_CONFIG_PREFIX="$HOME/.npm-global"',
    "",
  ].join("\n");
  writeIfMissing(
    join(persistentHomeDir, ".profile"),
    () => homeEnvBlock,
    created,
    skipped,
  );
  writeIfMissing(
    join(persistentHomeDir, ".bashrc"),
    () =>
      [
        "# switchroom Layer 1: agent .bashrc.",
        "# Defers to .profile for the env so login + non-login shells",
        "# stay in lockstep. Edit freely — `switchroom apply` will not",
        "# overwrite this file once it exists.",
        '[ -f "$HOME/.profile" ] && . "$HOME/.profile"',
        "",
      ].join("\n"),
    created,
    skipped,
  );

  // --- Initialize workspace as git repo (Phase 4) ---
  const workspaceDir = join(agentDir, "workspace");
  initWorkspaceGitRepo(workspaceDir, name);

  // --- Claude Code config (onboarding state) ---
  // Copy onboarding state (.claude.json) from the host's Claude installation
  // so the agent skips the first-run wizard, but intentionally do NOT copy
  // .credentials.json — agent credentials are owned by the RFC-H auth-broker,
  // not by scaffold-time file copies. The broker atomically writes
  // `<agentDir>/.claude/.credentials.json` at boot, on setActive, and on
  // refresh-tick, sourced from the fleet-active account at
  // `~/.switchroom/accounts/<label>/credentials.json`.
  //
  // Operators register one fleet account via `switchroom auth add <label>
  // --via-claude` (drives claude through its native broader-scope OAuth;
  // see src/auth/via-claude.ts) then `switchroom auth use <label>`. Adding
  // the 2nd/3rd/Nth agent to the same account is a YAML edit; no further
  // OAuth round-trips. See `reference/jobs/share-auth-across-the-fleet.md`.
  //
  // UPGRADE WARN: if ~/.claude-home/.credentials.json (or ~/.claude/.credentials.json)
  // exists at scaffold time, we deliberately skip copying it. Agents that were
  // previously scaffolded with the old policy and already have their own
  // .credentials.json are unaffected — we never remove existing credential files.
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    copyOnboardingState(existingClaudeJson, agentDir);
    // NOTE: copyExistingCredentials() intentionally NOT called here (Phase 2).
    // Each agent gets its own fresh OAuth. See CHANGELOG.
    if (!existsSync(join(agentDir, ".claude", "config.json"))) {
      // copyOnboardingState didn't write (file existed), write default
      writeIfMissing(
        join(agentDir, ".claude", "config.json"),
        () =>
          JSON.stringify(
            { hasCompletedOnboarding: true, numStartups: 1 },
            null,
            2,
          ) + "\n",
        created,
        skipped,
        0o600,
      );
    }
  } else {
    // No existing Claude install — create minimal config
    createMinimalClaudeConfig(agentDir);
  }

  // Pre-trust the agent's workspace directory
  preTrustWorkspace(agentDir);

  // Now that `.claude.json` is guaranteed to exist (copyOnboardingState /
  // createMinimalClaudeConfig + preTrustWorkspace just ran), re-apply the
  // MCP trust allowlist. The in-block call during .mcp.json write is a
  // silent no-op on a net-new agent (`.claude.json` absent that early),
  // so without this pass a fresh agent's gdrive/agent-config/hostd
  // servers are never added to enabledMcpjsonServers and Claude Code
  // silently ignores them — the integration would only "work" because
  // reconcileAgent re-trusts on the next restart. ensureMcpServersTrusted
  // is idempotent; running it twice is safe.
  if (mcpServerKeysToTrust) {
    ensureMcpServersTrusted(agentDir, mcpServerKeysToTrust);
  }

  // --- Memory index ---
  writeIfMissing(
    join(agentDir, "memory", "MEMORY.md"),
    () => "# Memory Index\n\nThis file is auto-maintained. Do not edit manually.\n",
    created,
    skipped,
  );

  // --- Telegram .env ---
  writeIfMissing(
    join(agentDir, "telegram", ".env"),
    () => {
      if (resolvedBotToken) {
        return `TELEGRAM_BOT_TOKEN=${resolvedBotToken}\n`;
      }
      return TELEGRAM_ENV_PLACEHOLDER;
    },
    created,
    skipped,
    0o600,
  );

  // --- Telegram access.json ---
  writeIfMissing(
    join(agentDir, "telegram", "access.json"),
    () => buildAccessJson(agentConfig, telegramConfig, topicId, userId),
    created,
    skipped,
    0o600,
  );
  // access.json is writeIfMissing (the gateway owns it at runtime for
  // pairing), so a supergroup added to switchroom.yaml AFTER first scaffold
  // would never register — the gateway silently drops its messages as
  // `group_unknown` (the marko case). Reconcile the CONFIGURED group in
  // idempotently so "set chat_id in config → the agent answers there" is the
  // zero-config default (principles 1 + 2), preserving runtime-added
  // allowFrom / pairings / other groups and any operator policy override.
  reconcileConfiguredGroup(
    join(agentDir, "telegram", "access.json"),
    agentConfig,
    telegramConfig,
  );

  // --- Telegram people.json (person_id name resolution) ---
  // Config-derived only (no runtime state to preserve, unlike access.json)
  // — regenerate on every scaffold/reconcile so a `users:` edit is picked
  // up. The running gateway itself only reads this file ONCE at boot
  // (no hot-reload — docs/configuration.md); a config change here needs an
  // agent restart to take effect.
  writeFileSyncIfChanged(
    join(agentDir, "telegram", "people.json"),
    buildPeopleJson(switchroomConfig),
    0o600,
  );

  // --- Sub-agent definitions (.claude/agents/<name>.md) ---
  //
  // Render each sub-agent from the merged `subagents:` config into a
  // Claude Code custom sub-agent markdown file. These are project-scope
  // agents (`.claude/agents/`) so they're specific to this agent's
  // working directory and don't leak into other agents or the user's
  // global `~/.claude/agents/`.
  if (agentConfig.subagents) {
    const agentsDir = join(agentDir, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const [saName, saDef] of Object.entries(agentConfig.subagents)) {
      const mdPath = join(agentsDir, `${saName}.md`);
      // Post-cascade invariant: description is what Claude Code uses
      // to decide when to delegate to a subagent. The schema allows
      // partial overrides (so profile-level overlays don't have to
      // restate it — see SubagentSchema in src/config/schema.ts), but
      // the FINAL merged subagent must have one. Fail loudly with
      // actionable guidance instead of writing `description: undefined`
      // to the markdown (which Claude Code rejects silently).
      if (!saDef.description) {
        throw new Error(
          `subagent "${saName}" has no description after cascade — add one ` +
            `to your defaults, the profile this agent extends, or the agent's ` +
            `own subagents.${saName} block.`,
        );
      }
      const frontmatter: Record<string, unknown> = {
        name: saName,
        description: saDef.description,
      };
      if (saDef.model) frontmatter.model = saDef.model;
      if (saDef.background != null) frontmatter.background = saDef.background;
      if (saDef.isolation) frontmatter.isolation = saDef.isolation;
      if (saDef.tools) frontmatter.tools = saDef.tools.join(", ");
      if (saDef.disallowedTools) frontmatter.disallowedTools = saDef.disallowedTools.join(", ");
      if (saDef.maxTurns) frontmatter.maxTurns = saDef.maxTurns;
      if (saDef.permissionMode) frontmatter.permissionMode = saDef.permissionMode;
      if (saDef.effort) frontmatter.effort = saDef.effort;
      if (saDef.color) frontmatter.color = saDef.color;
      if (saDef.memory) frontmatter.memory = saDef.memory;
      if (saDef.skills && saDef.skills.length > 0) {
        frontmatter.skills = saDef.skills;
      }
      const fmLines = Object.entries(frontmatter)
        .map(([k, v]) => {
          if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join("\n")}`;
          return `${k}: ${v}`;
        })
        .join("\n");
      const rawBody = saDef.prompt ?? `You are the ${saName} sub-agent.`;
      // `telegramEnabled: true` reflects this scaffold path being inside
      // a switchroom-scaffolded agent (which always has a Telegram surface).
      // The actual gate is `defaultChatId` — when there's no userId we skip
      // the addendum cleanly inside `applyTelegramProgressGuidance`.
      const body = applySubAgentLocalTimeGuidance(
        applyTelegramProgressGuidance(rawBody, {
          telegramEnabled: true,
          defaultChatId: userId,
        }),
        // switchroomConfig is optional on scaffoldAgent; resolveTimezone reads
        // agentConfig.timezone first, then config.switchroom?.timezone (safely
        // optional-chained), so an empty stand-in is sound when it's absent.
        resolveTimezone(switchroomConfig ?? ({} as SwitchroomConfig), agentConfig),
      );
      const content = `---\n${fmLines}\n---\n\n${body}\n`;
      writeFileSyncIfChanged(mdPath, content);
    }
  }

  // --- Scheduled task cron scripts: RETIRED (Phase 4 cron-fold-in) ---
  //
  // Pre-Phase-4 each schedule entry got a self-contained bash script
  // that ran `claude -p`. Phase 4 (#890-#893) moved cron firing into
  // the in-container `agent-scheduler` sibling, which delivers each
  // fire as a synthesized `meta.source="cron"` inbound via
  // `inject_inbound` IPC — there are no more per-agent cron .sh
  // scripts. See `src/scheduler/dispatch.ts`.
  //
  // Sweep any stale `cron-*.sh` + `.source` sidecars from prior
  // installs. This MUST run from the scaffold path (not just
  // `reconcileAgentDir`) because `switchroom apply` calls
  // `scaffoldAgent` — not reconcile — for agents it considers
  // "up to date". Without this sweep, files left over from the
  // pre-retirement code path persist across applies until a
  // separate `switchroom agent reconcile` is run. Idempotent: no-op
  // when nothing matches.
  {
    const telegramDir = join(agentDir, "telegram");
    if (existsSync(telegramDir)) {
      for (const file of readdirSync(telegramDir)) {
        const isCronScript = CRON_SCRIPT_BASENAME_RE.test(file) || LEGACY_CRON_SCRIPT_BASENAME_RE.test(file);
        if (isCronScript) {
          unlinkSync(join(telegramDir, file));
          const sidecar = join(telegramDir, file.replace(/\.sh$/, ".source"));
          if (existsSync(sidecar)) unlinkSync(sidecar);
        }
      }
    }
  }

  // --- Copy skill files from profile ---
  // Profile-bundled skills land in .claude/skills/ so Claude Code discovers
  // them alongside user-declared global skills.
  copyProfileSkills(profilePath, join(agentDir, ".claude", "skills"));

  // --- Materialize profile CLAUDE.md from .hbs template ---
  // Render profiles/<name>/CLAUDE.md from its .hbs source so the profile's
  // rendered output is up-to-date at scaffold time. This is idempotent —
  // no-op when the .hbs doesn't exist. Chunks 3+4 wire the @import and
  // reconcile migration respectively.
  renderProfileClaudeTemplate(agentConfig.extends ?? DEFAULT_PROFILE);

  // --- Symlink global skills from switchroom.skills_dir ---
  //
  // Skills named in `agents.x.skills: [name1, name2]` (merged with
  // defaults.skills) are resolved to <skills_dir>/<name> and symlinked
  // into <agentDir>/skills/<name>. This decouples skill authoring from
  // template authoring — add a skill to the pool once, opt-in per agent.
  if (agentConfig.skills && agentConfig.skills.length > 0) {
    syncGlobalSkills(
      agentDir,
      agentConfig.skills,
      switchroomConfig?.switchroom?.skills_dir,
    );
  }

  // --- Install built-in switchroom-* skills into .claude/skills/ ---
  // Role-gated (#235 follow-up): only foreman agents get the operator
  // skills auto-symlinked. Default `assistant` role retracts any stale
  // ones that may exist from before this gate landed.
  installSwitchroomSkills(agentDir, { role: agentConfig.role });

  // --- Install bundled default skills (anthropic + switchroom-core) ---
  // Universal — every agent gets these regardless of role, with per-key
  // opt-out via `defaults.bundled_skills` or per-agent `bundled_skills`.
  reconcileAgentDefaultSkills(
    agentDir,
    (agentConfig.bundled_skills ?? {}) as Record<string, unknown>,
  );

  // --- Set up plugin symlinks ---
  setupPlugins(agentDir, usesSwitchroomTelegramPlugin(agentConfig));

  // --- Phase 2: symlink <agentDir>/SOUL.md → workspace/SOUL.md ---
  // Claude Code auto-discovers SOUL.md at the project root. Keep parity by
  // symlinking so both paths see the same authoritative workspace/SOUL.md.
  const agentSoulPath = join(agentDir, "SOUL.md");
  const workspaceSoulPath = join(agentDir, "workspace", "SOUL.md");
  if (existsSync(workspaceSoulPath)) {
    // Remove old regular file if present (migration)
    if (existsSync(agentSoulPath)) {
      const stat = lstatSync(agentSoulPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(agentSoulPath);
        if (target === "workspace/SOUL.md") {
          // Already correct symlink, skip
          skipped.push(agentSoulPath);
        } else {
          // Wrong symlink, replace
          rmSync(agentSoulPath);
          symlinkSync("workspace/SOUL.md", agentSoulPath);
          created.push(agentSoulPath);
        }
      } else {
        // Regular file, replace with symlink
        rmSync(agentSoulPath);
        symlinkSync("workspace/SOUL.md", agentSoulPath);
        created.push(agentSoulPath);
      }
    } else {
      // No file exists, create symlink
      symlinkSync("workspace/SOUL.md", agentSoulPath);
      created.push(agentSoulPath);
    }
  }

  // Create the Hindsight bank idempotently. Without this, the first
  // `retain` call against the newly scaffolded agent blows up with a raw
  // foreign-key constraint violation because the bank doesn't exist yet
  // (see reference/rfcs/onboarding-gap-analysis.md §1). create_bank is a no-op
  // if the bank already exists. We intentionally await this BEFORE the
  // downstream bank-mission and mental-model ops — those depend on the
  // bank existing and would fail the same way. If Hindsight itself is
  // unreachable we warn to stderr and carry on — agent scaffolding must
  // still succeed so the operator can start Hindsight and re-run
  // `switchroom agent reconcile <name>` to retry.
  if (hindsightEnabled) {
    const apiUrl = `${hindsightApiBaseUrl}/mcp/`;
    const bankOpsChain = createBank(apiUrl, hindsightBankId, { timeoutMs: 5000 })
      .then((result) => {
        if (result.ok) {
          console.log(`  ${chalk.green("✓")} Hindsight bank ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
          return true;
        }
        if (result.reason === "Unreachable") {
          console.warn(
            `  ${chalk.yellow("⚠")} Hindsight unreachable — skipping bank creation for ${formatAgentBankLabel(name, hindsightBankId)}.`,
          );
          console.warn(
            `     Agent is still usable, but start Hindsight and run: switchroom agent reconcile ${name}`,
          );
        } else {
          console.warn(
            `  ${chalk.yellow("⚠")} Failed to create Hindsight bank for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`,
          );
        }
        return false;
      })
      .catch((err) => {
        console.warn(`  ${chalk.yellow("⚠")} Hindsight bank create error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        return false;
      });

    // Update bank missions — gated on the bank actually existing.
    //
    // Mission selection: explicit user yaml wins. Otherwise the retain mission
    // goes through `resolveRetainMissionPush`, exactly as reconcile does.
    // `switchroom apply` re-scaffolds EVERY existing agent (it never calls
    // `reconcileAgent`), so this site sees established banks far more often
    // than fresh ones — an unconditional seed here clobbered any customized
    // mission on every apply (2026-07-25 re-review H1). A genuinely fresh bank
    // still gets seeded: its mission reads back unset, which is upgradable.
    trackBankOps(bankOpsChain.then(async (bankReady) => {
      if (!bankReady) return;

      const userBankMission = agentConfig.memory?.bank_mission;
      const userRetainMission = agentConfig.memory?.retain_mission;
      const seededRetainMission = await resolveRetainMissionPush(
        apiUrl,
        hindsightBankId,
        userRetainMission,
        formatAgentBankLabel(name, hindsightBankId),
      );

      // reflect_mission / observations_mission / disposition, layering the
      // resolved config over the built-in profile defaults (Phase 2). Config
      // wins; disposition merges per-key.
      const extras = resolveBankMissionExtras(
        agentConfig.memory,
        resolveMemoryProfile(agentConfig),
      );

      const missions: {
        bank_mission?: string;
        retain_mission?: string;
        reflect_mission?: string;
        observations_mission?: string;
        disposition?: { skepticism?: number; literalism?: number; empathy?: number };
      } = { ...extras };
      if (seededRetainMission) {
        missions.retain_mission = seededRetainMission;
      }

      // observations_mission does NOT ride `extras` straight through: like
      // retain_mission it is a switchroom-managed default, so it goes through a
      // read-first decision that never clobbers an operator's hand-edit.
      delete missions.observations_mission;

      // disposition gets the same read-first treatment, for the same reason:
      // it is now non-empty for every agent (fleet floor), so pushing it
      // blindly would both re-send it forever and overwrite hand-tuned banks.
      delete missions.disposition;
      const dispositionPush = await resolveDispositionPush(
        apiUrl,
        hindsightBankId,
        extras.disposition,
        agentConfig.memory,
        resolveMemoryProfile(agentConfig),
        formatAgentBankLabel(name, hindsightBankId),
      );
      if (dispositionPush) missions.disposition = dispositionPush;

      const seededObservationsMission = await resolveObservationsMissionPush(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.observations_mission,
        resolveMemoryProfile(agentConfig),
        formatAgentBankLabel(name, hindsightBankId),
      );
      if (seededObservationsMission) {
        missions.observations_mission = seededObservationsMission;
      }
      if (userBankMission) {
        missions.bank_mission = userBankMission;
      }

      // Same emptiness guard as the reconcile site: in post-upgrade steady
      // state the mission decision is "none" and `missions` is `{}`, so an
      // unconditional call cost every agent two HTTP round-trips on every
      // apply and printed a success line for a call that changed nothing
      // (PR #3529 review, N1).
      if (Object.keys(missions).length > 0) {
        await updateBankMissions(apiUrl, hindsightBankId, missions, { timeoutMs: 5000 })
          .then((result) => {
            if (result.ok) {
              const note = userRetainMission
                ? "(custom retain_mission)"
                : seededRetainMission
                  ? "(default retain_mission)"
                  : "(retain_mission left as-is)";
              console.log(`  ${chalk.green("✓")} Bank missions updated for ${formatAgentBankLabel(name, hindsightBankId)} ${chalk.dim(note)}`);
            } else {
              console.warn(`  ${chalk.yellow("⚠")} Failed to update bank missions for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
            }
          })
          .catch((err) => {
            console.warn(`  ${chalk.yellow("⚠")} Bank mission update error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
          });
      }

      // Ensure operator-DECLARED per-specialist mental models (Phase 5). Only
      // models named in memory.mental_models are created — no blind seeding
      // (that is the #2447 regression this avoids). Best-effort; never blocks.
      await ensureDeclaredMentalModels(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.mental_models,
        { timeoutMs: 5000 },
      )
        .then((outcomes) => {
          for (const o of outcomes) {
            if (o.ok) {
              console.log(`  ${chalk.green("✓")} Mental model "${o.name}" ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
            } else {
              console.warn(`  ${chalk.yellow("⚠")} Failed to ensure mental model "${o.name}" for ${formatAgentBankLabel(name, hindsightBankId)}: ${o.reason}`);
            }
          }
        })
        .catch((err) => {
          console.warn(`  ${chalk.yellow("⚠")} Mental model ensure error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        });

      // Seed the anti-confabulation guardrail directive (default ON, no yaml
      // required). Idempotent and never-clobbering — see
      // src/memory/hindsight-seed-directives.ts.
      await seedAntiConfabulationDirective(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.anti_confabulation_directive,
        formatAgentBankLabel(name, hindsightBankId),
      );
    }));
  }

  // Loud warning when CLAUDE.md (or any future fingerprint-tracked
  // file) was operator-edited and we backed it up. Surfaced via
  // stderr so it lands in `switchroom apply` output; not added to
  // ScaffoldResult to keep the public type stable.
  for (const f of rewrittenWithBackup) {
    process.stderr.write(
      `scaffold: re-rendered ${f} from template change; backed up your `
      + `edited version to ${f}.before-rerender.* — review and re-merge `
      + `manually if needed.\n`,
    );
  }
  // Generation stamp (KEN-130) — fresh agents are stamped at scaffold so
  // drift detection is meaningful before the first reconcile too.
  //
  // Skipped when the caller passed no `switchroomConfig`: the cascade above
  // then degraded to the RAW agent config, while the drift detector always
  // resolves defaults → profile → agent. Stamping an unresolved configHash
  // would make every agent on a fleet that uses `defaults:` / `profiles:`
  // report a phantom "switchroom.yaml changed since last apply". No stamp
  // reads as "not checkable", which is the safe direction; the first
  // reconcile (which always has the full config) writes the real one. Every
  // production callsite passes it — this only guards internal/test callers.
  if (switchroomConfig) stampGeneratedSurfaces(agentDir, agentConfig);

  return { agentDir, created, skipped };
}

/**
 * Result of reconciling an existing agent against the current switchroom.yaml.
 */
export interface ReconcileResult {
  agentDir: string;
  changes: string[];
  changesBySemantics?: {
    hot: string[];
    staleTillRestart: string[];
    restartRequired: string[];
  };
}

/**
 * Categorize a file change by its reload semantics.
 */
type ReloadSemantics =
  | "hot"             // Active next turn, no restart needed (hook re-reads)
  | "stale-till-restart"  // File is part of session-start bake; edits ignored until restart
  | "restart-required";   // File changes MUST restart (MCP/settings/binary/template);
                          // agent won't pick up changes without a restart

export function classifyChange(
  path: string,
  agentDir: string,
  useHotReloadStable: boolean,
): ReloadSemantics {
  // Get the path relative to agentDir
  const relPath = path.startsWith(agentDir)
    ? path.slice(agentDir.length).replace(/^\//, "")
    : path;

  // Hot — per-turn hook re-reads
  if (relPath === "workspace/MEMORY.md") return "hot";
  if (relPath.startsWith("workspace/memory/") && relPath.endsWith(".md")) return "hot";

  // Soul files — persona identity (name, vibe, creature) is baked into
  // --append-system-prompt at session start. When hotReloadStable is true the
  // per-turn hook re-injects SOUL.md so changes go live next turn (hot).
  // When hotReloadStable is false (default), the file is frozen at launch and
  // any edit is invisible until the agent restarts — so we promote it to
  // restart-required so the reconciler auto-restarts immediately.
  if (relPath === "workspace/SOUL.md" || relPath === "workspace/SOUL.custom.md") {
    return useHotReloadStable ? "hot" : "restart-required";
  }

  // Stable workspace files — classification depends on hotReloadStable flag
  // When hotReloadStable is true, these are re-injected on every turn via hook
  // When hotReloadStable is false (default), they're baked into --append-system-prompt at start
  const stableWorkspaceFiles = [
    "workspace/CLAUDE.md",
    "workspace/AGENTS.md",
    "workspace/AGENT.md",
    "workspace/USER.md",
    "workspace/IDENTITY.md",
    "workspace/TOOLS.md",
  ];
  if (stableWorkspaceFiles.includes(relPath)) {
    return useHotReloadStable ? "hot" : "stale-till-restart";
  }

  // CLAUDE.md stays stale-till-restart regardless (Claude Code's own file-load convention)
  if (relPath === "CLAUDE.md") return "stale-till-restart";
  if (relPath === "workspace/CLAUDE.custom.md") return "stale-till-restart";

  // Restart required — claude-code / MCP / subsystem lifecycle
  if (relPath === ".mcp.json") return "restart-required";
  if (relPath === ".claude/settings.json") return "restart-required";
  if (relPath === "start.sh") return "restart-required";

  // Unknown → treat as stale-till-restart (safe default)
  return "stale-till-restart";
}

/**
 * Re-apply switchroom.yaml-derived state to an existing agent without touching
 * user-edited files (CLAUDE.md, SOUL.md, telegram/.env, etc.).
 *
 * Specifically rewrites:
 *   - start.sh (purely template-driven, safe to overwrite)
 *   - .mcp.json (when channels.telegram.plugin is "switchroom")
 *   - .claude/settings.json mcpServers
 *   - .claude/settings.json permissions.allow / .deny / defaultMode
 *   - .claude/plugins/hindsight-memory/ (vendored plugin tree)
 *
 * Does NOT touch CLAUDE.md, SOUL.md, telegram/.env, or any user content.
 *
 * This is the operation a non-developer needs after editing switchroom.yaml —
 * e.g., adding a new MCP server, enabling memory, changing the tool
 * allowlist. It is the lifecycle gap between `switchroom agent create` (which
 * scaffolds once) and a full re-scaffold (which would clobber CLAUDE.md).
 *
 * Throws if the agent directory does not exist.
 */
export interface ReconcileOptions {
  /**
   * If true, skip regenerating CLAUDE.md. Use this to freeze CLAUDE.md
   * as-is, ignoring template updates. Default false (regeneration is default).
   */
  preserveClaudeMd?: boolean;
  /**
   * Set true when reconcile runs INSIDE an agent container (the
   * `reconcileAgentCronOnly` bridge — `src/cli/reconcile-bridge.ts`).
   * Gates every block that reads from the bundled `profiles/` tree, the
   * vendored `vendor/hindsight-memory/` plugin, or the operator-host
   * `~/.switchroom/skills/_bundled/` pool — none of which are shipped
   * into the agent image (`docker/Dockerfile.agent` flattens to
   * `/opt/switchroom/switchroom.js` and copies neither sibling).
   *
   * Concretely, this option short-circuits FIVE blocks inside
   * `reconcileAgent`:
   *
   *   1. start.sh re-render via `getBaseProfilePath()` (the `profiles/_base/`
   *      template tree).
   *   2. CLAUDE.md re-render via `getProfilePath(...)`.
   *   3. `installHindsightPlugin(...)` — copies the vendored plugin tree
   *      from `vendor/hindsight-memory/`. Returns null + writes a misleading
   *      "check the npm tarball" stderr when the source path is absent.
   *   4. `installSwitchroomSkills(...)` + `reconcileAgentDefaultSkills(...)`
   *      — both read from `~/.switchroom/skills/_bundled/` on the operator
   *      host; in-agent that's `/state/agent/.switchroom/...` which doesn't
   *      exist. Both warn + skip silently.
   *   5. The workspace bootstrap re-seed (`getProfilePath` → `seedWorkspace
   *      BootstrapFiles` → `ensureClaudeMdSymlinks`) — throws
   *      "Profile not found: default (searched /profiles)" when the
   *      profile tree is absent, which is THE error that surfaces as
   *      `E_RECONCILE_FAILED` on `schedule_add` from inside an agent.
   *
   * #1618 / PR #1619 originally gated blocks 1+2 only. The remaining
   * three were caught by a follow-up audit (#TODO-PR) that traced the
   * full chain for a `schedule_add` failure on `finn` on 2026-05-24.
   *
   * None of these blocks are needed for a cron-only reconcile: schedule
   * changes only touch `schedule.d/` overlays + `cron.d/` scripts, which
   * the agent-scheduler regenerates from the loaded config; they don't
   * read profile templates, the vendored plugin, or the bundled-skills
   * pool. The host-side full reconcile leaves this option false and
   * continues to run all five.
   */
  skipProfileTemplates?: boolean;
}

/**
 * Parameters for buildSettingsHooksBlock — extracted so the function can be
 * called from both reconcileAgent and the drift-check path without
 * duplicating the logic.
 */
export interface HooksBlockParams {
  /** Agent name (used for `switchroom handoff <name>`) */
  agentName: string;
  /** Merged yaml hooks (defaults → profile → agent, already resolved) */
  agentConfig: AgentConfig;
  /** Whether the Hindsight memory backend is active for this agent */
  hindsightEnabled: boolean;
  /** Whether this agent uses the switchroom telegram plugin */
  useSwitchroomPlugin: boolean;
  /**
   * @deprecated since #1745 — no longer used. Previously baked
   * `--config DOCKER_CONFIG_PATH` into the handoff hook command, but
   * `/state/config/switchroom.yaml` is not bind-mounted into
   * sandboxed agent containers, so the CLI's `loadConfig()` threw
   * `ConfigError` on every Stop hook firing a red issue card. The
   * handoff command now treats config-load as non-fatal and falls
   * back to defaults (see `src/cli/handoff.ts`), so this argument is
   * dead. Kept in the type for source-compat with existing callers;
   * the value is ignored. Will be removed in a later cleanup.
   */
  configPath?: string;
}

/**
 * Compute the full settings.json `hooks` block for a given agent config.
 *
 * Combines:
 *   1. User-declared hooks from switchroom.yaml (via translateHooksToClaudeShape)
 *   2. Switchroom-owned hooks (handoff, user-profile-refresh, secret-scrub,
 *      secret-guard, subagent-tracker, workspace injection, timezone)
 *
 * This is the single source of truth for what reconcileAgent writes to
 * settings.json. Exported so the drift-check path can call it without
 * performing a full reconcile.
 *
 * The output is a plain JSON-serialisable object suitable for
 * `settings.hooks = buildSettingsHooksBlock(...)`.
 */
export function buildSettingsHooksBlock(p: HooksBlockParams): Record<string, unknown> {
  const { agentName, agentConfig, hindsightEnabled, useSwitchroomPlugin } = p;

  const userHooks = translateHooksToClaudeShape(agentConfig.hooks);

  // Wrapping helper. Every switchroom-owned hook is invoked through
  // bin/run-hook.sh so a non-zero exit or a stderr-only failure ends up
  // in the issue sink (#425) and on the Telegram issues card (#428).
  // The wrapper preserves the original exit code, so claude code's
  // hook contract (decision: block, etc.) is unchanged.
  //
  // Path is the docker-baked location. The scaffold runs on the host but
  // settings.json is consumed inside the agent container — referencing
  // the host repo checkout would silently fail (RFC §Bug 3). Mirrors
  // the `.mcp.json` plugin path which already uses DOCKER_TELEGRAM_PLUGIN_PATH
  // for the same reason.
  const wrapper = `bash "${join(DOCKER_BIN_PATH, "run-hook.sh")}"`;
  const wrap = (source: string, command: string): string =>
    `${wrapper} ${shellSingleQuote(source)} ${command}`;

  // --- Switchroom-owned Stop hooks ---
  const handoffEnabled = agentConfig.session_continuity?.enabled !== false;
  // No `--config` arg: `/state/config/switchroom.yaml` is not
  // bind-mounted into sandboxed agent containers, so passing
  // `--config DOCKER_CONFIG_PATH` made `loadConfig()` throw
  // `ConfigError` and the wrapper exit 1 (red issue card on every
  // Stop). The handoff CLI now treats config-load as non-fatal and
  // recovers the agent dir from cwd / `$CLAUDE_PROJECT_DIR`, so the
  // yaml dependency is fully optional (#1745). On the host the
  // CLI's `findConfigFile()` upward walk still locates the yaml.
  const stopHooks: Array<Record<string, unknown>> = [];
  if (handoffEnabled) {
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:handoff",
        `switchroom handoff ${agentName}`,
      ),
      timeout: 35,
      async: true,
    });
  }
  // Per-agent user-profile mental models are retired — dedicated profile
  // banks (users.*.profile_bank, recall additional_banks/sender_banks) are the
  // source of truth, so we no longer auto-create or refresh a per-bank
  // "user-profile" mental model. (No user-profile-refresh Stop hook wired.)
  if (useSwitchroomPlugin) {
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:secret-scrub-stop",
        `node "${join(DOCKER_HOOKS_PATH, "secret-scrub-stop.mjs")}"`,
      ),
      timeout: 15,
      async: true,
    });
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:silent-end-interrupt-stop",
        `node "${join(DOCKER_HOOKS_PATH, "silent-end-interrupt-stop.mjs")}"`,
      ),
      timeout: 5,
      async: false,
    });
    // Narrate-without-execute guard (#396): re-prompt once when a reply
    // claims a dispatch the turn never actually made (no Agent/Task call,
    // no backgrounded Bash). Sync so it can block the stop; fail-open.
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:dispatch-claim-stop",
        `node "${join(DOCKER_HOOKS_PATH, "dispatch-claim-stop.mjs")}"`,
      ),
      timeout: 5,
      async: false,
    });
    // Reaper for the PreToolUse tool-label sidecar files (#783).
    // Runs on every Stop; idempotent age + count rotation.
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:tool-label-stop",
        `node "${join(DOCKER_HOOKS_PATH, "tool-label-stop.mjs")}"`,
      ),
      timeout: 5,
      async: true,
    });
    // Agent self-improvement GATE — RFC
    // reference/rfcs/agent-self-improvement.md slice 1. A cheap,
    // deterministic per-turn triage; on a learning signal it injects a
    // forked review turn (inject_inbound, NOT claude -p). Async so it
    // never sits on the turn-end reply path; bundled from
    // src/cli/self-improve-stop.ts (imports src/self-improve/* + node:net),
    // hence DOCKER_BUNDLED_HOOKS_PATH like skill-validate-pretool.
    stopHooks.push({
      type: "command",
      command: wrap(
        "hook:self-improve-stop",
        `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "self-improve-stop.mjs")}"`,
      ),
      timeout: 10,
      async: true,
    });
  }
  const switchroomStop = stopHooks.length > 0 ? [{ hooks: stopHooks }] : [];

  // --- Switchroom-owned PreToolUse hooks ---
  const switchroomPreToolUse = useSwitchroomPlugin
    ? [
        {
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:secret-guard-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "secret-guard-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // #2053 defense-in-depth: drop a reply call whose
          // payload is only the silent sentinel (NO_REPLY/HEARTBEAT_OK),
          // so the sentinel can never reach chat regardless of any
          // nag-loop behaviour. No matcher — the hook self-filters by
          // tool_name (like secret-guard above).
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:sentinel-reply-guard-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "sentinel-reply-guard-pretool.mjs")}"`,
              ),
              timeout: 5,
            },
          ],
        },
        {
          // Claude Code's hook matcher is a regex. Cover both the legacy
          // 'Agent' and newer 'Task' tool names — same dispatch
          // semantics, only the name varies by Claude Code version. The
          // tracker hooks themselves also gate on both.
          matcher: "^(Agent|Task)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:subagent-tracker-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "subagent-tracker-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // RFC E §4.2 Cut 2 — gates upstream Drive write tools behind
          // a Telegram diff-preview approval card. Scoped matcher so
          // the hook only runs for `mcp__google-workspace__*` tools,
          // avoiding the cost of stdin parse + broker call on every
          // tool fire. Timeout = approval TTL + slack.
          //
          // Path is DOCKER_BUNDLED_HOOKS_PATH (not DOCKER_HOOKS_PATH)
          // because this hook is bundled via scripts/build.mjs from
          // src/cli/drive-write-pretool.ts — it imports src/drive/*
          // helpers that aren't otherwise available inside the agent
          // image. Built output lives at /opt/switchroom/hooks/.
          matcher: "^mcp__google-workspace__",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:drive-write-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "drive-write-pretool.mjs")}"`,
              ),
              // Claude Code timeout is in seconds. 5min approval TTL
              // + 30s slack so a near-timeout grant still lands cleanly.
              timeout: 5 * 60 + 30,
            },
          ],
        },
        {
          // RFC #1873 §8 — gates softeria write tools (OneDrive upload,
          // mail/calendar mutations) behind a Telegram approval card.
          // Mirror of the drive-write-pretool above. Matcher is scoped
          // to the ms-365 MCP server key emitted by resolveMs365McpEntry
          // in PR 3. The hook's GATED_MS365_WRITE_TOOLS set further
          // filters to only write verbs (uploads + create/update/delete
          // for calendar/mail) — read-only tools pass through unchanged.
          matcher: "^mcp__ms-365__",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:ms-365-write-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "ms-365-write-pretool.mjs")}"`,
              ),
              timeout: 5 * 60 + 30,
            },
          ],
        },
        {
          // RFC reference/rfcs/notion-integration.md §8 — gates @notionhq/
          // notion-mcp-server tools behind the per-DB allowlist + the
          // create_database ban + the standalone-page deny. Hook
          // returns block decisions with operator-friendly reasons;
          // walk-required tools make a Notion API call to resolve the
          // parent DB before deciding. Read calls also pass through
          // the allowlist gate (not approval-gated, just allowlisted).
          // No approval card in v1 — that's a follow-up PR; the
          // allowlist + create_database ban are the load-bearing
          // security primitives.
          matcher: "^mcp__notion__",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:notion-write-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "notion-write-pretool.mjs")}"`,
              ),
              // Notion resolver walks are ≤4 API calls at ~200ms each
              // (typical), plus search-filter pass. 30s is generous.
              timeout: 30,
            },
          ],
        },
        {
          // RFC native-by-default skill authoring, Phase 1 — advisory
          // skill-shape linter. Scoped to file-write tools + Bash; the
          // hook itself no-ops unless the target path is under
          // `.claude/skills/`. Non-blocking (returns additionalContext)
          // except the per-skill byte cap and the machine-managed
          // evals.json write-block (the hard stops). Bash is in the
          // matcher so a shell redirect/write into a machine-managed
          // evals.json (`bash -c '… > …/evals/evals.json'`) is blocked
          // the same way a Write is — it otherwise never carries a
          // file_path and slipped past the PII scan and operator tap.
          //
          // DOCKER_BUNDLED_HOOKS_PATH (not DOCKER_HOOKS_PATH): bundled
          // via scripts/build.mjs from src/cli/skill-validate-pretool.ts
          // because it imports the shared validators in skill-common.ts.
          matcher: "^(Write|Edit|MultiEdit|Bash)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:skill-validate-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "skill-validate-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // #2974 — redirect direct hindsight mental-model WRITE calls to
          // the sanctioned mcp__switchroom-telegram__mental_model_propose
          // path. The four write tools (HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS)
          // are un-preapproved by design (#2911), so a direct call would
          // otherwise fall through to a TUI permission prompt that wedges
          // the turn. This hook DENIES them instantly with an instructive
          // message so the agent self-corrects in the same turn; every
          // read tool (get_mental_model, list_mental_models, recall, …)
          // passes through. Matcher scoped to `^mcp__hindsight__` so the
          // hook only spends a stdin parse on hindsight tools.
          //
          // DOCKER_BUNDLED_HOOKS_PATH (not DOCKER_HOOKS_PATH): bundled via
          // scripts/build.mjs from src/cli/hindsight-mental-model-pretool.ts,
          // mirroring skill-validate-pretool.
          matcher: "^mcp__hindsight__",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:hindsight-mental-model-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "hindsight-mental-model-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // Foreground turn-hog gate — deterministic safety net in the
          // #3150 family (fail-closed deny on known-bad shapes, not a
          // heuristic classifier). A foreground Bash call holds the whole
          // session until it returns; this hook DENIES effectively-
          // unbounded foreground shapes (tail -f/--follow, watch,
          // sleep > 30s, sleep-in-a-loop, gh pr checks --watch / gh run
          // watch, docker/kubectl logs -f, journalctl -f) with an
          // instructive message: re-run with run_in_background: true or
          // use a bounded alternative. run_in_background: true always
          // passes; conservative by design so real build/test runs are
          // never blocked. Default ON; kill switch
          // SWITCHROOM_FOREGROUND_HOG_GATE=0 (send-gate convention).
          // Matcher scoped to Bash so the stdin parse only lands there.
          //
          // DOCKER_BUNDLED_HOOKS_PATH: bundled via scripts/build.mjs from
          // src/cli/foreground-hog-pretool.ts, mirroring
          // hindsight-mental-model-pretool.
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:foreground-hog-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "foreground-hog-pretool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // Agent self-improvement APPLY-GUARD — RFC
          // reference/rfcs/agent-self-improvement.md slice 2. The
          // DETERMINISTIC T1 gate: when a self-improve review is pending
          // (the Stop hook dropped a review-context marker), any skill-file
          // Write/Edit must clear own-skill + diff-cap + evals-present +
          // evals-pass (no baseline regression) + the daily auto-apply cap,
          // or it is BLOCKED and downgraded to a T2/T3 pending proposal.
          // No-op on a normal turn (no marker) — the advisory linter above
          // still runs. Bundled like skill-validate-pretool because it
          // imports src/self-improve/*.
          matcher: "^(Write|Edit|MultiEdit)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:self-improve-apply-guard-pretool",
                `node "${join(DOCKER_BUNDLED_HOOKS_PATH, "self-improve-apply-guard-pretool.mjs")}"`,
              ),
              timeout: 30,
            },
          ],
        },
        {
          // Catch-all PreToolUse: deterministic tool-call labels (#783).
          // Hook always exits 0; never emits stdout JSON; writes one line
          // to $TELEGRAM_STATE_DIR/tool-labels-${session_id}.jsonl.
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:tool-label-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "tool-label-pretool.mjs")}"`,
              ),
              timeout: 5,
            },
          ],
        },
        {
          // PR #1811 / v0.13.48 — repo-context auto-injection.
          // When the agent's tool call touches a file under a code repo
          // OUTSIDE its workspace, walk up from the target to find the
          // nearest CLAUDE.md / AGENTS.md / AGENT.md, read it, and
          // inject as additionalContext via hookSpecificOutput. Dedups
          // per session via /tmp/switchroom-repo-context-<session_id>/.
          // Closes the "non-coder user asks agent to work on ~/code/foo
          // and the agent forgets the repo's CLAUDE.md" gap.
          //
          // Scaffold-side registration MUST mirror what's in
          // telegram-plugin/hooks/hooks.json — that JSON is the
          // plugin-system view (loaded when an agent uses
          // --plugin-dir), but Claude Code reads PreToolUse hooks
          // from settings.json at session start, which the scaffold
          // writes from this list. Both must agree or the hook
          // silently doesn't fire (#1811 UAT caught this on v0.13.48
          // — settings.json was missing the entry, so Claude Code
          // never invoked the hook in production).
          matcher: "^(Read|Edit|Write|MultiEdit|NotebookEdit|Bash)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:repo-context-pretool",
                `node "${join(DOCKER_HOOKS_PATH, "repo-context-pretool.mjs")}"`,
              ),
              timeout: 5,
            },
          ],
        },
      ]
    : [];

  // --- Switchroom-owned PostToolUse hooks ---
  const switchroomPostToolUse = useSwitchroomPlugin
    ? [
        {
          // Claude Code's hook matcher is a regex. Cover both the legacy
          // 'Agent' and newer 'Task' tool names — same dispatch
          // semantics, only the name varies by Claude Code version. The
          // tracker hooks themselves also gate on both.
          matcher: "^(Agent|Task)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:subagent-tracker-posttool",
                `node "${join(DOCKER_HOOKS_PATH, "subagent-tracker-posttool.mjs")}"`,
              ),
              timeout: 10,
            },
          ],
        },
        {
          // Layer 2 of the sandbox UX work — detects EROFS / read-only
          // / sandbox-related errors in tool_response and injects a
          // one-line hint via additionalContext so the agent responds
          // usefully on Telegram instead of silently retrying or
          // echoing the raw kernel error. Pairs with the SANDBOX
          // primer in --append-system-prompt. Hook is fail-silent: a
          // broken hint never blocks the tool flow.
          //
          // #1303: matcher narrowed from ".*" to write-capable tools +
          // MCP tools only. Read/Grep/Glob/WebFetch/etc. cannot hit a
          // kernel sandbox boundary by definition, and the old
          // matcher caused false positives every time a Read/Grep
          // payload merely MENTIONED EROFS / read-only-fs strings
          // (file content, code comments, the hook source itself).
          // The hook script also gates on these tools internally as
          // defence in depth.
          matcher: "^(Edit|MultiEdit|Write|NotebookEdit|Bash|mcp__.*)$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:sandbox-hint-posttool",
                `node "${join(DOCKER_HOOKS_PATH, "sandbox-hint-posttool.mjs")}"`,
              ),
              timeout: 3,
            },
          ],
        },
        {
          // Detect a wedged persistent-bash session. Claude Code's Bash
          // tool uses a persistent shell for state continuity (so `cd`
          // persists). When that shell's IO state desyncs after a
          // long/interrupted command, every subsequent Bash call returns
          // exit-1 with empty stdout/stderr — even `true`. This hook
          // counts consecutive empty Bash results and writes a sentinel
          // + logs to stderr after THRESHOLD in a row, plus injects a
          // one-line nudge via additionalContext so the agent tries
          // KillBash or asks for `switchroom agent restart` rather than
          // retrying the wedged shell in a loop. Bash-only matcher
          // because the wedge is shell-specific; counter resets on any
          // other tool firing.
          //
          // Plugin-gated even though the wedge is a Claude-Code-runtime
          // defect (not a telegram-plugin feature) because the hook
          // depends on $TELEGRAM_STATE_DIR for counter / sentinel files
          // and on the gateway surface to act on the sentinel. Operators
          // running with `channels.telegram.plugin: official` won't get
          // the hook, but they also don't have the gateway surface that
          // would act on it. The hook's fail-silent / no-op-without-
          // state-dir contract makes it safe to enable unconditionally
          // in a future iteration if a non-plugin surface is added.
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: wrap(
                "hook:wedge-detect-posttool",
                `node "${join(DOCKER_HOOKS_PATH, "wedge-detect-posttool.mjs")}"`,
              ),
              timeout: 3,
            },
          ],
        },
      ]
    : [];

  // --- Switchroom-owned UserPromptSubmit hooks ---
  const useHotReloadStable = agentConfig.channels?.telegram?.hotReloadStable === true;
  // inject_on_change: default true — suppress re-injection of static/unchanged
  // content each turn, reducing per-turn token overhead by ~3 KB. Set to false
  // per-agent in switchroom.yaml channels.telegram.inject_on_change to revert
  // to legacy always-emit behaviour.
  const useInjectOnChange = agentConfig.channels?.telegram?.inject_on_change !== false;
  // Per-turn pacing directive — v3 (conversational-pacing for Option B,
  // v0.13.61).
  //
  // Why v3 replaces v2 ("ack first"): in v0.13.59 the PreToolUse ack-
  // first gate was stripped in favor of the activity-summary draft
  // transport (#1926/#1927), which surfaces "Read 2 files, ran a
  // command" in the user's Telegram compose area as you work. The v2
  // directive kept telling the model to call reply with an ack BEFORE
  // doing work, so the model kept doing exactly that — persistent
  // "on it…" chat messages piled up alongside the answers. Two-three
  // persistent messages per turn instead of one. Live UX regression
  // observed on clerk 2026-05-28: "Hello?" → "Here, what's up?";
  // "Find restaurant recommendations" → "on it — digging up the Hobart
  // list" → "Found the list…" → "good — let me pin down the date" →
  // "Sunday is Jun 7…" → "on it — pulling the Mona thread" → … (six
  // persistent messages for one turn of work).
  //
  // v4: v3 ("don't ack") over-corrected — the model started classifying
  // bare social messages ("hi", "you there?") as "not substantive" and
  // ending the turn with NO_REPLY, leaving a direct human message
  // unanswered (clerk regression 2026-05-28). The anti-ack rule was only
  // ever about not sending *placeholder acks before doing work* — never
  // about suppressing a reply to a message that expects one. v4 leads
  // with "ALWAYS reply to a direct message" + an explicit greeting
  // carve-out, then keeps the no-placeholder-ack rule.
  const turnPacingDirective =
    '<turn-pacing>You are messaging a human via Telegram. The framework ' +
    'automatically shows the user a live preview in their compose area as ' +
    'you work — they see "Read a file", "Ran 2 commands", etc. as your ' +
    'tool_use events stream. You do NOT need to ack manually.\n\n' +
    'ALWAYS reply to a message the user sends you. A direct message ' +
    'expects a response: a greeting ("hi", "hey", "you there?") gets a ' +
    'greeting back; a thanks gets a brief acknowledgement; a question ' +
    'gets an answer. NEVER end a turn with NO_REPLY when the user has ' +
    'just sent you something — NO_REPLY is only for genuine non-prompts ' +
    '(a system-synthesized event you have already fully handled).\n\n' +
    'What you should NOT do is send a placeholder ack BEFORE doing the ' +
    'work — no "on it", "good question — one sec", "let me dig in", ' +
    '"checking now". Those add chat clutter on top of the activity ' +
    'preview the user already sees, and the preview clears the moment ' +
    'your real reply lands. Do not ack-then-answer; just answer.\n\n' +
    'So:\n' +
    '  - Trivial / social message → reply once, briefly, in your voice. ' +
    'The reply IS the response.\n' +
    '  - Question with a short answer → just reply with the answer.\n' +
    '  - Complex tool-driven work → go straight to the tools (the ' +
    'compose-area preview is the ambient liveness signal), then reply ' +
    'once with the answer or a genuine mid-work pivot ("halfway ' +
    'through — found an unexpected issue, want me to continue?"). Not ' +
    '"still working".\n\n' +
    'LABEL THE WORK AS YOU DO IT. The user watches a live preview built ' +
    'from your tool activity, so what you put in a tool call is what they ' +
    'read. Two output requirements. FIRST: every Bash and tool call gets a ' +
    'plain-English `description` naming the goal — "Checking the gateway ' +
    'logs to find why the turn stalled", never raw tool names ("calling ' +
    'Bash", "Read(x)") and never a debug dump. That description, not the ' +
    'raw command, is what the user sees. SECOND: before a long stretch of ' +
    'work, post ONE short status line saying what you are starting — one ' +
    'line per stretch, in plain words. Emit it as the `description` on the ' +
    'first tool call of the stretch, or as a status line through the ' +
    'progress tool where you have one; do NOT leave it sitting as unsent ' +
    'transcript text (see the reply rule below). This labelling is the ONE ' +
    'thing to keep doing; it is NOT the placeholder ack banned above (that ' +
    'is a chat reply, which you still skip).\n\n' +
    'Do NOT send a trailing confirmation after your answer — no "Done.", ' +
    '"Sent.", "Hope that helps." as a separate message once you have ' +
    'already replied. Your answer is the last thing the user should ' +
    'see; a follow-up "Done." is dead-air clutter (and the user\'s ' +
    'device already pinged on the answer). Stop after the answer.\n\n' +
    'GROUND BEFORE YOU ASSERT. Any fact in your reply that can change ' +
    '(a number, a status, a price, a date, who-uses-what, anything ' +
    '"current" or "latest") must come from a source you actually checked ' +
    'THIS turn: your data tool, a file, the web. Memory and what you ' +
    '"already know" are leads to verify, not sources. If you have not ' +
    'checked it this turn, do not state it as fact: go get it now, or tell ' +
    'the user you will confirm and then do it. A confident wrong number is ' +
    'worse than "let me check".\n\n' +
    'VOICE: write like a sharp colleague, not a chatbot. Lead with the ' +
    'answer, plain words, plain punctuation (commas and periods, not ' +
    'em-dashes). Skip the hollow openers ("You\'re absolutely right", ' +
    '"Great question", "Great catch", "Exactly!") and AI-tell filler ' +
    '("smoking gun", "delve", "it\'s worth noting", "a testament to", "in ' +
    'today\'s fast-paced..."). Genuine acknowledgement is fine when it is ' +
    'real and adds something ("good catch, that was my bug"); what to ' +
    'avoid is the reflexive praise that opens every reply and means ' +
    'nothing. When the user is wrong, say so directly; flattery is not ' +
    'help.\n\n' +
    'TURN-END SHAPE: the human reads your turn-end on a phone. Build it ' +
    'for a thumb, not a terminal. LEAD WITH THE ONE DECISION OR ANSWER ' +
    'in the first line — the single thing the user has to know. A routine ' +
    'turn-end is a FEW SHORT LINES, not a multi-section report; if you ' +
    'find yourself writing more than ~6 lines or stacking labelled ' +
    'sections, you are dumping, not answering. ONE IDEA PER MESSAGE: ' +
    'split genuinely separate topics into separate replies rather than ' +
    'piling sections into one bubble. Push detail BELOW the answer or ' +
    'leave it out — offer "want the detail?" instead of pre-emptively ' +
    'dumping logs, full file contents, or a section per thread you ' +
    'touched. RESERVE the long multi-section structured message for when ' +
    'the operator EXPLICITLY asked to go deep ("full breakdown", "walk me ' +
    'through it", "show everything"). Default to short; expand on ' +
    'request. A wall of text the user has to re-read to find the one fact ' +
    'that matters is the failure this exists to prevent.\n\n' +
    'CRITICAL: "answer" means a call to the reply tool ' +
    '(mcp__switchroom-telegram__reply). ' +
    'Your terminal/transcript text is NEVER delivered to Telegram — the ' +
    'user sees only what you send through the reply tool. After a long ' +
    'tool sequence (scheduling, multi-step research, sub-agent handback), ' +
    'do not let your closing narration stand as the answer: end the turn ' +
    'by passing that narration to the reply tool. No reply tool call = the ' +
    'user got nothing, however much text you wrote. Call the reply tool as ' +
    'your FIRST action when you have the answer — do not write it out as ' +
    'transcript text first and call reply afterward: a framework backstop ' +
    'flushes unsent text after a delay and then your real reply lands late ' +
    'and out of order. This is why the work-labelling above rides on tool ' +
    '`description`s rather than loose prose: a tool description reaches the ' +
    'preview immediately and is never subject to that flush, so there is ' +
    'exactly one rule — user-facing text goes through a tool call, always.' +
    '</turn-pacing>';
  const switchroomUserPromptSubmit: Array<Record<string, unknown>> = [
    ...(useHotReloadStable
      ? [
          {
            hooks: [
              {
                type: "command",
                command: wrap(
                  "hook:workspace-stable",
                  `bash "${join(DOCKER_BIN_PATH, "workspace-stable-hook.sh")}"`,
                ),
                timeout: 6,
              },
            ],
          },
        ]
      : []),
    {
      hooks: [
        {
          type: "command",
          command: wrap(
            "hook:workspace-dynamic",
            // inject-on-change is the unconditional default in the hook; only
            // thread the negation env when an agent opts out via
            // channels.telegram.inject_on_change: false.
            `${useInjectOnChange ? "" : `env SWITCHROOM_INJECT_ON_CHANGE=0 `}bash "${join(DOCKER_BIN_PATH, "workspace-dynamic-hook.sh")}"`,
          ),
          timeout: 5,
        },
      ],
    },
    {
      hooks: [
        {
          type: "command",
          command: wrap(
            "hook:timezone",
            `bash "${join(DOCKER_BIN_PATH, "timezone-hook.sh")}"`,
          ),
          timeout: 3,
        },
      ],
    },
    {
      hooks: [
        {
          type: "command",
          // Emits the per-turn pacing directive (above).
          // inject_on_change=true: use a hook script that gates injection
          //   on session_id + directive hash, suppressing the ~3 KB
          //   re-injection on every subsequent turn of a session.
          // inject_on_change=false: legacy inline printf (every turn).
          command: useInjectOnChange
            ? (() => {
                const directiveHash = createHash("sha256")
                  .update(turnPacingDirective)
                  .digest("hex");
                // Pass directive + hash as env vars in the hook command.
                // The hook script reads TURN_PACING_DIRECTIVE and
                // TURN_PACING_HASH from its environment.
                return wrap(
                  "hook:turn-pacing",
                  `env TURN_PACING_DIRECTIVE=${shellSingleQuote(turnPacingDirective)} TURN_PACING_HASH=${shellSingleQuote(directiveHash)} bash "${join(DOCKER_BIN_PATH, "turn-pacing-hook.sh")}"`,
                );
              })()
            : wrap(
                "hook:turn-pacing",
                `printf '%s\\n' ${shellSingleQuote(turnPacingDirective)}`,
              ),
          timeout: 3,
        },
      ],
    },
  ];

  // --- Switchroom-owned SessionStart hooks ---
  //
  // Re-seat context immediately after context compaction. Wired with matcher
  // "compact" so it fires ONLY on auto/manual compaction — NOT on the
  // "startup"/"resume"/"clear"/"fork" SessionStart sources (which would
  // re-inject on every boot). Per Claude Code's hook contract, SessionStart
  // stdout IS added to the model's context (unlike PreCompact stdout, which is
  // not injected), so what this prints re-seats the model the instant the
  // native summarizer replaces the transcript.
  //
  // The hook emits three layers (see bin/working-state-reload-hook.sh):
  //   1. an unconditional static <compact-recovery> orientation block,
  //   2. the agent's working-state file verbatim, if it keeps one, and
  //   3. a LEAN briefing (P1): a scoped recent Telegram tail + Hindsight
  //      recall, assembled by handoff-briefing.sh --lean (the single briefing
  //      assembler), giving a compacted session fresh-boot parity. This is the
  //      SHARED compaction re-seat path for EVERY agent regardless of
  //      session_continuity.briefing mode (legacy vs gateway).
  //
  // NOT plugin-gated: every agent gets the same default; the static block and
  // working-state append no-op gracefully when nothing is present, and the
  // lean briefing degrades to nothing if history.db / Hindsight are absent.
  // The hook re-checks the `source` field from stdin as belt-and-braces
  // against a matcher regression.
  //
  // Timeout: the lean briefing adds one local SQLite read plus ONE Hindsight
  // network hop (capped at ~3s inside handoff-briefing.sh), so the Claude Code
  // hook timeout is 8s — comfortably above that cap, still bounded. Latency is
  // a non-issue by design (compaction itself takes far longer; the prompt
  // cache is already invalidated by the summary replacing the transcript).
  const switchroomSessionStart: Array<Record<string, unknown>> = [
    {
      matcher: "compact",
      hooks: [
        {
          type: "command",
          command: wrap(
            "hook:working-state-reload",
            `bash "${join(DOCKER_BIN_PATH, "working-state-reload-hook.sh")}"`,
          ),
          timeout: 8,
        },
      ],
    },
  ];

  // Combine user hooks + switchroom-owned hooks
  if (userHooks) {
    return {
      ...userHooks,
      UserPromptSubmit: [
        ...((userHooks.UserPromptSubmit as unknown[]) ?? []),
        ...switchroomUserPromptSubmit,
      ],
      SessionStart: [
        ...((userHooks.SessionStart as unknown[]) ?? []),
        ...switchroomSessionStart,
      ],
      ...(switchroomPreToolUse.length > 0
        ? {
            PreToolUse: [
              ...((userHooks.PreToolUse as unknown[]) ?? []),
              ...switchroomPreToolUse,
            ],
          }
        : {}),
      ...(switchroomPostToolUse.length > 0
        ? {
            PostToolUse: [
              ...((userHooks.PostToolUse as unknown[]) ?? []),
              ...switchroomPostToolUse,
            ],
          }
        : {}),
      ...(switchroomStop.length > 0
        ? {
            Stop: [
              ...((userHooks.Stop as unknown[]) ?? []),
              ...switchroomStop,
            ],
          }
        : {}),
    };
  }

  return {
    UserPromptSubmit: switchroomUserPromptSubmit,
    SessionStart: switchroomSessionStart,
    ...(switchroomPreToolUse.length > 0 ? { PreToolUse: switchroomPreToolUse } : {}),
    ...(switchroomPostToolUse.length > 0 ? { PostToolUse: switchroomPostToolUse } : {}),
    ...(switchroomStop.length > 0 ? { Stop: switchroomStop } : {}),
  };
}

/**
 * Compare an expected hooks block (from buildSettingsHooksBlock) against the
 * actual block read from settings.json.  Returns whether they differ and a
 * short human-readable summary of the difference.
 *
 * Comparison is done via canonical JSON strings (sorted keys) so key-order
 * differences don't produce false positives.
 */
export function detectHooksDrift(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): { drifted: boolean; summary: string } {
  // Canonical serialisation: sort keys at every level so ordering never
  // produces a false positive.
  function canon(v: unknown): string {
    return JSON.stringify(v, (_, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        );
      }
      return val;
    });
  }

  const expectedStr = canon(expected);
  const actualStr = canon(actual);

  if (expectedStr === actualStr) {
    return { drifted: false, summary: "in sync" };
  }

  // Summarise which top-level categories differ
  const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const driftedKeys: string[] = [];
  for (const k of allKeys) {
    if (canon(expected[k]) !== canon(actual[k])) {
      driftedKeys.push(k);
    }
  }

  const summary = `DRIFTED (categories: ${driftedKeys.join(", ")})`;
  return { drifted: true, summary };
}

/**
 * Record the generation stamp for drift detection (KEN-130). Called at
 * the end of scaffold + host-side reconcile, AFTER every managed write,
 * so the stamped hashes describe exactly what this run left on disk.
 * The resolved (post-cascade) agent config is hashed so a later
 * yaml-edit-without-apply reads as named drift. Best-effort — a stamp
 * IO failure must never fail a scaffold/reconcile.
 *
 * Deliberately NOT written on the in-container cron-only reconcile
 * (skipProfileTemplates): that path renders no templates and its
 * in-image VERSION can differ from the host install, which would
 * poison the version-staleness comparison.
 */
function stampGeneratedSurfaces(agentDir: string, resolvedAgentConfig: AgentConfig): void {
  try {
    writeGenerationStamp(agentDir, {
      switchroomVersion: SWITCHROOM_VERSION,
      configHash: computeConfigHash(resolvedAgentConfig),
      files: computeStampFilesFromDisk(agentDir),
    });
  } catch {
    /* best-effort — drift detection just reports "no stamp" */
  }
}

/**
 * Public reconcile entry point — reconcileAgentInner wrapped in an
 * ownership backstop (#3168 review F1).
 *
 * The inner function runs the agent-tree ownership sweep on its SUCCESS
 * path (plus the fail-loud readability assertion). But reconcile can also
 * throw MID-RUN, after the atomic settings.json / .mcp.json rewrites have
 * already replaced inodes on the bind mount (ENOSPC on a later write, a
 * symlink migration error, a template render failure). Without a backstop,
 * a root-run reconcile that dies in that window leaves root:root 0600
 * dotfiles behind and the agent wedges with the exact #3168 permission-card
 * storm on its next boot — silently, because the reconcile "failed cleanly".
 *
 * So: on ANY throw, re-run the sweep best-effort. The sweep's own failure
 * is logged and swallowed here (never mask the original error — that one
 * names the actual bug); the fail-loud readability assertion stays
 * success-path only, inside the inner function.
 */
export function reconcileAgent(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  switchroomConfig: SwitchroomConfig,
  switchroomConfigPath?: string,
  options: ReconcileOptions = {},
): ReconcileResult {
  try {
    return reconcileAgentInner(
      name,
      agentConfigRaw,
      agentsDir,
      telegramConfig,
      switchroomConfig,
      switchroomConfigPath,
      options,
    );
  } catch (err) {
    try {
      alignAgentTreeOwnershipIfRoot(name, resolve(agentsDir, name));
    } catch (sweepErr) {
      console.warn(
        `  ${chalk.yellow("⚠")} ownership backstop sweep failed for ${name} after a ` +
          `mid-reconcile error: ${(sweepErr as Error).message}`,
      );
    }
    throw err;
  }
}

function reconcileAgentInner(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  switchroomConfig: SwitchroomConfig,
  switchroomConfigPath?: string,
  options: ReconcileOptions = {},
): ReconcileResult {
  // Apply the full defaults → profile → agent cascade (same semantics
  // as scaffoldAgent). Every downstream read uses the resolved config.
  const agentConfig = resolveAgentConfig(
    switchroomConfig.defaults,
    switchroomConfig.profiles,
    agentConfigRaw,
  );

  const agentDir = resolve(agentsDir, name);
  const changes: string[] = [];

  // Timezone sanity check — warn when we fell all the way through the
  // cascade to the UTC hard-fallback. That combination almost always
  // means the host is a container inheriting the platform default, not a
  // real expression of the user's locale, and the per-turn time hint will
  // be wrong. Silent when an explicit value is present at any layer. Uses
  // the resolveTimezone onUtcFallback hook so we share the same detection
  // logic the runtime uses rather than re-implementing it inline.
  {
    resolveTimezone(switchroomConfig, agentConfig, {
      onUtcFallback: () => {
        console.warn(
          `  ${chalk.yellow("⚠")} Timezone auto-detected as UTC from server. This is often a container default.`,
        );
        console.warn(
          `     Set \`timezone: "Region/City"\` in switchroom.yaml to silence this warning.`,
        );
      },
    });
  }

  if (!existsSync(agentDir)) {
    throw new Error(
      `Agent directory does not exist: ${agentDir}. Run \`switchroom agent create ${name}\` first.`,
    );
  }

  // --- Migration warning: resume_mode default changed from 'auto' to 'handoff' (#362) ---
  // When an agent has no explicit resume_mode in its YAML config (the most
  // common case for existing installs), it was previously using 'auto' silently.
  // The new default is 'handoff'. We warn once so users know their agent will
  // behave differently, and suppress subsequent warns with a marker file.
  {
    const explicitResumeMode = agentConfig.session_continuity?.resume_mode;
    const markerPath = join(agentDir, ".resume-mode-migration-warned");
    if (!explicitResumeMode && !existsSync(markerPath)) {
      console.warn(
        `  ${chalk.yellow("⚠")} [${name}] resume_mode default changed from 'auto' to 'handoff' (switchroom #362).`,
      );
      console.warn(
        `     Your agent will now start a fresh Claude session on every restart, using a`,
      );
      console.warn(
        `     context briefing instead of --continue. This prevents stale MCP servers`,
      );
      console.warn(
        `     from carrying over and compounds well with the Phase 1 restart changes.`,
      );
      console.warn(
        `     To restore the old behaviour, add to switchroom.yaml:`,
      );
      console.warn(
        `       session_continuity:`,
      );
      console.warn(
        `         resume_mode: auto`,
      );
      console.warn(
        `     (This warning fires once per agent directory and is then suppressed.)`,
      );
      try {
        writeFileSync(markerPath, `resume_mode default changed to handoff at reconcile\n`, "utf-8");
      } catch {
        /* best-effort — if we can't write the marker, we'll warn again next time */
      }
    }
  }

  // --- Phase 4: migrate CLAUDE.custom.md to workspace/ (one-time) ---
  const legacyCustomPath = join(agentDir, "CLAUDE.custom.md");
  const workspaceDir = join(agentDir, "workspace");
  const newCustomPath = join(workspaceDir, "CLAUDE.custom.md");
  if (existsSync(legacyCustomPath) && !existsSync(newCustomPath)) {
    mkdirSync(workspaceDir, { recursive: true });
    const legacyContent = readFileSync(legacyCustomPath, "utf-8");
    writeFileSync(newCustomPath, legacyContent, "utf-8");
    rmSync(legacyCustomPath);
    console.log(chalk.green(`  moved CLAUDE.custom.md → workspace/CLAUDE.custom.md`));
  }

  // Compute the desired permissions.allow list from current config.
  // Lockstep with scaffoldAgent is now STRUCTURAL, not a discipline: both call
  // the one shared computeDesiredPermissionAllow (footgun G), which includes
  // the DEFAULT_READ_ONLY_PREAPPROVED_TOOLS injection when tools.allow is empty
  // and dangerous_mode is off. (Before the extraction, a divergence here made
  // the first `switchroom apply` after scaffold wipe the read-only defaults and
  // storm the approval UI — the scaffold↔reconcile parity test guards it now.)
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  // Single source of truth — must honor SWITCHROOM_MEMORY_BACKEND=none
  // here too: `switchroom agent restart` always reconciles first, so a
  // config-only check would re-wire Hindsight on every restart of a
  // `none` install (install-validation 2026-05-17, R2 review round 2).
  const hindsightEnabled = isHindsightEnabled(switchroomConfig);
  // Allow-list shared with scaffoldAgent via computeDesiredPermissionAllow
  // (footgun G — one source of truth, no lockstep drift). Computed BEFORE the
  // legacy-token strip below, so it matches the historical pre-strip baseAllow
  // behaviour byte-for-byte (the scaffold↔reconcile parity test pins this).
  const desiredAllow = computeDesiredPermissionAllow(agentConfig, hindsightEnabled);
  // #235: drop legacy mcp__switchroom__* tokens from any pre-existing
  // allowlist on every reconcile so existing agents converge on the
  // same shape new ones get. #1400 link 1: same treatment for the
  // pre-#1400 blanket hostd grant so a `mcp__hostd__*` left in an
  // agent's switchroom.yaml tools.allow can't silently re-pre-approve
  // the mutating host-control verbs past the human approval card.
  if (Array.isArray(tools.allow)) {
    tools.allow = tools.allow.filter(
      p =>
        !LEGACY_SWITCHROOM_MCP_TOKENS.includes(p) &&
        !LEGACY_HOSTD_BLANKET_TOKENS.includes(p),
    );
  }
  const desiredDeny = dedupe([
    ...(tools.deny ?? []),
    ...webkiteDenyForAgent(agentConfig),
    ...INTERACTIVE_TUI_FLEET_DENY_TOOLS,
  ]);

  // Resolve topic ID for the start.sh template and session greeting
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve telegram + hindsight context for the start.sh template
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);
  const hindsightAutoRecallEnabled = hindsightEnabled
    && agentConfig.memory?.auto_recall !== false;
  const hindsightBankId = agentConfig.memory?.collection ?? name;
  const hindsightApiBaseUrl = (switchroomConfig.memory?.config?.url as string | undefined)
    ? (switchroomConfig.memory!.config!.url as string).replace(/\/mcp\/?$/, "").replace(/\/$/, "")
    : HINDSIGHT_DEFAULT_API_BASE_URL;
  const hindsightRecallMaxMemories = agentConfig.memory?.recall?.max_memories;
  const hindsightRecallCacheTtlSecs = agentConfig.memory?.recall?.cache_ttl_secs;
  // Recall latency envelope, resolved (and mutually clamped) once here so the
  // env exports and the plugin stamps cannot disagree.
  const hindsightRecallTunables = resolveHindsightRecallTunables(
    agentConfig.memory?.recall as RecallTunableInput | undefined,
  );
  const hindsightRecallParallelDeadlineSeconds =
    hindsightRecallTunables.parallelDeadlineSeconds;
  const hindsightRecallRequestTimeoutSeconds =
    hindsightRecallTunables.requestTimeoutSeconds;
  // Switchroom #3757 — BM25 query shaping + per-request timeout. Resolved from
  // the CASCADED config (defaults → profile → agent) like the sibling recall
  // knobs, so a fleet-wide `defaults.memory.recall.*` is honoured.
  //
  // ALWAYS resolved to a concrete value, and start.sh exports all three
  // UNCONDITIONALLY (#3774 defect class). The plugin's own precedence is
  // DEFAULTS -> settings.json -> ~/.hindsight/claude-code.json -> env
  // (`vendor/hindsight-memory/scripts/lib/config.py:437-470`), so a knob that
  // is not exported lets a stale hand-written `claude-code.json` shadow the
  // shipped default silently. Exporting an EMPTY string does not help either:
  // `_cast_env("", int)` returns None and `config.py:466-468` then skips the
  // assignment, so an empty export is indistinguishable from no export. The
  // only shape that actually wins is a real number/JSON on every boot, which
  // is why these fall back to the plugin's DEFAULTS values here.
  // `tests/scaffold.test.ts` pins the fallbacks against `lib/config.py` so the
  // two cannot drift.
  const hindsightRecallQueryMaxTokens =
    agentConfig.memory?.recall?.query_max_tokens ?? HINDSIGHT_RECALL_QUERY_MAX_TOKENS_DEFAULT;
  const rawRecallQueryStopTerms = agentConfig.memory?.recall?.query_stop_terms;
  const hindsightRecallQueryStopTermsJson = JSON.stringify(rawRecallQueryStopTerms ?? []);
  // Per-bank slot floors inside the count cap. Same cascade, but resolved to
  // the shipped default rather than left undefined: start.sh exports these
  // UNCONDITIONALLY (#3774). `~/.hindsight/claude-code.json` survives an apply
  // and loads AFTER the plugin's settings.json, so a conditional export lets a
  // stale hand-edited value there shadow what switchroom stamps — silently, and
  // permanently. Exporting the resolved effective value makes env authoritative.
  const hindsightRecallOwnBankMinSlots =
    agentConfig.memory?.recall?.own_bank_min_slots ?? HINDSIGHT_OWN_BANK_MIN_SLOTS_DEFAULT;
  const hindsightRecallAdditionalBankMinSlots =
    agentConfig.memory?.recall?.additional_bank_min_slots ??
    HINDSIGHT_ADDITIONAL_BANK_MIN_SLOTS_DEFAULT;
  // #3837 score floor. Same unconditional-export treatment as the slot floors
  // (#3774): a conditional export would let a stale hand-edited
  // `~/.hindsight/claude-code.json` silently turn a filter ON that switchroom
  // ships OFF. Resolving to 0 here makes "disabled" the authoritative state.
  const hindsightRecallMinScore =
    agentConfig.memory?.recall?.min_score ?? HINDSIGHT_RECALL_MIN_SCORE_DEFAULT;
  const hindsightRecallMinScoreScope =
    agentConfig.memory?.recall?.min_score_scope ??
    HINDSIGHT_RECALL_MIN_SCORE_SCOPE_DEFAULT;
  // #3841 — everything else recall.py reads. Resolved from the same CASCADED
  // agent config, always to a concrete value, and exported unconditionally.
  // THROWS on an out-of-enum / wrong-typed value: a bad knob must red the
  // apply, not sail through to a fail-open `_cast_env` that silently restores
  // the plugin default while switchroom.yaml reads as though it were tuned.
  const hindsightRecallPassthrough = resolveHindsightRecallPassthrough(
    agentConfig.memory?.recall as RecallPassthroughInput | undefined,
  );
  // Phase 1 / 6a opt-out: undefined unless the operator overrode the
  // switchroom default (observations on, trivial-skip on). Exported only
  // when set (see start.sh.hbs), so an unset value leaves the on-by-default
  // settings.json override in force.
  const hindsightRecallTypes = agentConfig.memory?.recall?.types?.length
    ? agentConfig.memory.recall.types.join(",")
    : undefined;
  const hindsightRecallSkipTrivial =
    agentConfig.memory?.recall?.skip_trivial === undefined
      ? undefined
      : String(agentConfig.memory.recall.skip_trivial);
  // #2848 Stage B — directive-capture nudge cascade. undefined unless the
  // operator overrode the switchroom default (on). Exported only when set
  // (see start.sh.hbs), so an unset value leaves the on-by-default
  // settings.json override in force. Top-level memory.* knob (not under
  // memory.recall) — it gates a correction-detection nudge, not recall tuning.
  const hindsightDirectiveCaptureNudge =
    agentConfig.memory?.directive_capture_nudge === undefined
      ? undefined
      : String(agentConfig.memory.directive_capture_nudge);
  // Per-row observation scope (memory.observation_scopes cascade). undefined
  // unless the operator set it — exported only when set (see start.sh.hbs), so
  // the default retain body never carries the field and the engine default
  // stands. Top-level memory.* knob: it stamps every retain path, not just the
  // Stop-hook cadence under memory.retain.
  const hindsightObservationScopes = agentConfig.memory?.observation_scopes;
  // Per-retain observation-scope strategy (memory.observation_scope_strategy
  // cascade). undefined unless the operator set it — exported only when set
  // (see start.sh.hbs), so an unset value leaves the plugin's on-by-default
  // `curated` strategy in force. Selects curated-vs-not; the pin above wins.
  const hindsightObservationScopeStrategy =
    agentConfig.memory?.observation_scope_strategy;
  // PR6 — mirror scaffoldAgent's computation. Both paths feed
  // buildWorkspaceContext, so the template sees identical shape.
  const topicAliases = agentConfig.channels?.telegram?.topic_aliases;
  const hindsightTopicAliasesJson = topicAliases && Object.keys(topicAliases).length > 0
    ? JSON.stringify(topicAliases)
    : undefined;
  // Switchroom (per-speaker memory routing): mirror scaffoldAgent's compute.
  // `serves`-assigned users generate sender_banks (speaker routing), unioned
  // with any explicit map — resolved by resolveUsers() (user concept, RFC
  // reference/rfcs/user-concept.md). Falls back to the explicit map when no
  // full config is in scope.
  const senderBanks = switchroomConfig
    ? resolveUsers(switchroomConfig, name).senderBanks
    : agentConfig.memory?.recall?.sender_banks ?? {};
  const hindsightSenderBanksJson = senderBanks && Object.keys(senderBanks).length > 0
    ? JSON.stringify(senderBanks)
    : undefined;
  const hindsightTopicFilterMode = (
    agentConfig.memory?.recall as { topic_filter_mode?: string } | undefined
  )?.topic_filter_mode;

  // --- Provision worktrees for repos: entries ---
  // Runs on every reconcile so the paths injected as SWITCHROOM_REPO_<SLUG>
  // env vars in start.sh actually exist on disk. Both functions are
  // idempotent: first call creates; subsequent calls fetch + ff-only merge
  // (or skip when dirty). Network failures in ensureBareClone are non-fatal
  // (logged and continued) so an unreachable remote does not block reconcile.
  if (agentConfig.repos) {
    for (const [slug, entry] of Object.entries(agentConfig.repos)) {
      try {
        const clonePath = ensureBareClone(slug, entry.url);
        ensureAgentWorktree(name, slug, clonePath, agentDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[switchroom] repo "${slug}": provisioning failed (continuing): ${msg}\n`,
        );
      }
    }
  }

  // --- Reconcile start.sh (purely template-driven, safe to overwrite) ---
  // No existsSync guard: start.sh is a pure function of config+template.
  // If it's missing (user nuked it, bad manual edit, partial disk copy),
  // regenerate it. Previously we bailed on missing file which left the
  // agent permanently unable to launch until a full `agent create` rebuild.
  const startShPath = join(agentDir, "start.sh");
  if (!options.skipProfileTemplates) {
    const basePath = getBaseProfilePath();
    const startShContext: Record<string, unknown> = {
      name,
      // BAKED into start.sh — must be a HOST path, not in-container /host-home,
      // when reconcile (apply) runs inside hostd. See toHostHomePath. startShPath
      // above and the FS writes below keep the local container-relative value.
      agentDir: toHostHomePath(agentDir),
      botToken: resolvedBotToken ?? rawBotToken,
      forumChatId: telegramConfig.forum_chat_id,
      dangerousMode: agentConfig.dangerous_mode === true,
      useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
      // Mirror scaffoldAgent's start.sh context — without this the
      // {{#unless useHotReloadStable}} block always renders, so flipping
      // hotReloadStable on never removes the _WS_STABLE bake from start.sh.
      useHotReloadStable: agentConfig.channels?.telegram?.hotReloadStable === true,
      // PR C: see buildWorkspaceContext for rationale — mirror here so
      // reconcile (apply on existing agents) re-renders start.sh with
      // the current enabled flag.
      telegramEnabledFlag:
        agentConfig.channels?.telegram?.enabled === false ? "false" : "true",
      // sec WS8-F1 / #1416: reconcile re-asserts the security-plugin
      // --plugin-dir on every `switchroom apply` so the boundary
      // self-heals if an older start.sh (without it) is on disk.
      securityPluginDir: DOCKER_SECURITY_PLUGIN_PATH,
      hindsightEnabled: hindsightAutoRecallEnabled,
      hindsightBankIdQ: shellSingleQuote(hindsightBankId),
      hindsightApiBaseUrlQ: shellSingleQuote(hindsightApiBaseUrl),
      hindsightRecallMaxMemories,
      hindsightRecallCacheTtlSecs,
      hindsightRecallParallelDeadlineSeconds,
      hindsightRecallQueryMaxTokens,
      hindsightRecallQueryStopTermsJson,
      hindsightRecallRequestTimeoutSeconds,
      hindsightRecallOwnBankMinSlots,
      hindsightRecallAdditionalBankMinSlots,
      hindsightRecallMinScore,
      hindsightRecallMinScoreScope,
      // #3841 — the SAME builder buildWorkspaceContext uses. This context is
      // hand-built, so passing the resolver object straight through would leave
      // every `{{hindsightRecallPass.*}}` path unknown, and handlebars renders
      // an unknown path as "" rather than throwing: reconcile would silently
      // emit `export HINDSIGHT_RECALL_BUDGET=` and hand the knob back to
      // ~/.hindsight/claude-code.json.
      hindsightRecallPass: recallPassthroughTemplateFields(
        hindsightRecallPassthrough,
        shellSingleQuote,
      ),
      hindsightRecallTypes,
      hindsightRecallSkipTrivial,
      hindsightDirectiveCaptureNudge,
      hindsightObservationScopesQ: hindsightObservationScopes
        ? shellSingleQuote(hindsightObservationScopes)
        : undefined,
      hindsightObservationScopeStrategyQ: hindsightObservationScopeStrategy
        ? shellSingleQuote(hindsightObservationScopeStrategy)
        : undefined,
      // PR6 — supergroup-mode topic tagging env vars. Same gate as
      // buildWorkspaceContext: only emit the shell-quoted JSON when
      // we actually have a topic_aliases map.
      hindsightTopicAliasesJsonQ: hindsightTopicAliasesJson
        ? shellSingleQuote(hindsightTopicAliasesJson)
        : undefined,
      hindsightSenderBanksJsonQ: hindsightSenderBanksJson
        ? shellSingleQuote(hindsightSenderBanksJson)
        : undefined,
      hindsightTopicFilterMode,
      // Mirror buildWorkspaceContext (#910): host home for the
      // $HOME/.switchroom symlink in start.sh's docker preamble. Prefer
      // SWITCHROOM_HOST_HOME so an in-hostd reconcile bakes the real host
      // home, not /host-home (see hostHomeForBake).
      hostHomeQ: hostHomeQForBake(),
      modelQ: shellSingleQuote(resolveMainModel(agentConfig.model)),
      // Mirror buildWorkspaceContext: declared routing intent for the
      // `.routing-mode` landed-vs-declared comparison in start.sh.
      declaredRoutingQ: shellSingleQuote(
        declaredRoutingMode(resolveMainModel(agentConfig.model)),
      ),
      ...buildCronSessionContext(agentConfig),
      thinkingEffort: agentConfig.thinking_effort ?? SWITCHROOM_DEFAULT_THINKING_EFFORT,
      permissionMode: agentConfig.permission_mode,
      fallbackModelQ: agentConfig.fallback_model
        ? shellSingleQuote(agentConfig.fallback_model)
        : undefined,
      userEnvQuoted: (() => {
        const combined = {
          ...buildToolSearchEnvVars(),
          ...channelsToEnv(agentConfig),
          ...(agentConfig.env ?? {}),
          ...buildRepoEnvVars(name, agentDir, agentConfig),
        };
        if (Object.keys(combined).length === 0) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(combined)) {
          out[k] = shellSingleQuote(v);
        }
        return out;
      })(),
      model: agentConfig.model,
      // Keep in lockstep with buildScaffoldContext's systemPromptAppendShellQuoted:
      // when the agent uses the switchroom telegram plugin, append the
      // five-beat "talking to a human on Telegram" pacing block so agents
      // communicate like a person — ack first, narrate meaningful progress,
      // hand back delegations with synthesis, deliver.
      systemPromptAppendShellQuoted: (() => {
        // Lane 1 invariants moved to `~/.switchroom/fleet/switchroom-invariants.md`
        // and reach the model via Claude Code native CLAUDE.md
        // auto-discovery (start.sh.hbs passes `--add-dir ~/.switchroom/fleet`).
        // See the matching scaffoldAgent path above and renderFleetInvariants().
        //
        // EXCEPTION — the Telegram formatting FLOOR CARD is injected here, into
        // `--append-system-prompt`, deterministically for EVERY session. Must
        // stay in lockstep with the scaffoldAgent path above. Single source of
        // truth: TELEGRAM_FORMATTING_FLOOR_CARD.
        const baseAppend = agentConfig.system_prompt_append ?? '';
        const combined = baseAppend.length > 0
          ? `${TELEGRAM_FORMATTING_FLOOR_CARD}\n\n${baseAppend}`
          : TELEGRAM_FORMATTING_FLOOR_CARD;
        return shellSingleQuote(combined);
      })(),
      extraCliArgs: (() => {
        const parts: string[] = []
        if (agentConfig.cli_args && agentConfig.cli_args.length > 0) {
          parts.push(...agentConfig.cli_args.map(shellSingleQuote))
        }
        // #199: native Claude Code flag pass-through (mirror of the
        // initial-scaffold path above; reconcile must keep parity).
        if (agentConfig.add_dirs && agentConfig.add_dirs.length > 0) {
          for (const dir of agentConfig.add_dirs) {
            parts.push("--add-dir", shellSingleQuote(dir))
          }
        }
        if (agentConfig.allowed_tools && agentConfig.allowed_tools.length > 0) {
          parts.push("--allowedTools", shellSingleQuote(agentConfig.allowed_tools.join(" ")))
        }
        if (agentConfig.disallowed_tools && agentConfig.disallowed_tools.length > 0) {
          parts.push("--disallowedTools", shellSingleQuote(agentConfig.disallowed_tools.join(" ")))
        }
        return parts.length > 0 ? " " + parts.join(" ") : undefined
      })(),
      sessionMaxIdleSecs: parseDurationToSeconds(agentConfig.session?.max_idle),
      sessionMaxTurns: agentConfig.session?.max_turns,
      handoffEnabled: agentConfig.session_continuity?.enabled !== false,
      resumeMode: agentConfig.session_continuity?.resume_mode ?? "handoff",
      resumeMaxBytes:
        agentConfig.session_continuity?.resume_max_bytes ?? 2_000_000,
      // Boot-resume policy (session_continuity.boot_resume; default
      // 'in-flight'). Threaded to the gateway as SWITCHROOM_BOOT_RESUME.
      // Mirror of buildWorkspaceContext — reconcile must keep parity.
      bootResumeMode: agentConfig.session_continuity?.boot_resume ?? "in-flight",
      // Boot-briefing transport flag (session_continuity.briefing; default
      // 'legacy'). Mirror of buildWorkspaceContext — reconcile must keep parity.
      sessionBriefingMode: agentConfig.session_continuity?.briefing ?? "legacy",
      // Capability sentinel for the #4245 start.sh ↔ gateway-bundle handshake.
      // Mirror of buildWorkspaceContext — reconcile must keep parity.
      gatewayBriefingCapability: GATEWAY_BOOT_BRIEFING_CAPABILITY,
    };
    const beforeStartSh = existsSync(startShPath)
      ? readFileSync(startShPath, "utf-8")
      : "";
    const afterStartSh = renderTemplate(join(basePath, "start.sh.hbs"), startShContext);
    if (afterStartSh !== beforeStartSh) {
      writeFileSync(startShPath, afterStartSh, "utf-8");
      chmodSync(startShPath, 0o755);
      changes.push(startShPath);
    }

    // Cheap-cron (L4): keep the cron-session launcher in sync on reconcile,
    // only for agents with a context:fresh entry (none in the fleet today).
    if (startShContext.cronSessionEnabled) {
      const cronShPath = join(agentDir, "cron-session.sh");
      const beforeCronSh = existsSync(cronShPath) ? readFileSync(cronShPath, "utf-8") : "";
      const afterCronSh = renderTemplate(join(basePath, "cron-session.sh.hbs"), startShContext);
      if (afterCronSh !== beforeCronSh) {
        writeFileSync(cronShPath, afterCronSh, "utf-8");
        chmodSync(cronShPath, 0o755);
        changes.push(cronShPath);
      }
    }
  }

  // --- Phase 3: regenerate CLAUDE.md by default (unless --preserve-claude-md) ---
  // CLAUDE.md is a two-section file (#1857): the Switchroom-managed block above
  // the visible marker is regenerated deterministically from the template on
  // every apply; everything below the marker is operator-owned and preserved
  // verbatim. A legacy workspace/CLAUDE.custom.md sidecar is migrated below the
  // marker (and renamed .deprecated) on the first apply post-#1857.
  if (!options.preserveClaudeMd && !options.skipProfileTemplates) {
    const profilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
    const claudeMdSrc = join(profilePath, "CLAUDE.md.hbs");
    const claudeMdDest = join(agentDir, "CLAUDE.md");
    const claudeCustomPath = join(agentDir, "workspace", "CLAUDE.custom.md");

    if (existsSync(claudeMdSrc)) {
      const claudeContext: Record<string, unknown> = {
        name,
        agentDir,
        topicName: agentConfig.topic_name,
        topicEmoji: agentConfig.topic_emoji,
        soul: agentConfig.soul,
        tools: agentConfig.tools ?? { allow: [], deny: [] },
        memory: agentConfig.memory,
        model: agentConfig.model,
        schedule: agentConfig.schedule,
        useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
        // Used by the "Admin surface" section of CLAUDE.md.hbs so an
        // admin: true agent gets the fleet-ops paragraph and a regular
        // agent gets the "I'm not admin — ask <peer>" refusal pattern.
        // root: true implies admin and additionally selects the root-tier
        // capability block ({{#if root}} in CLAUDE.md.hbs).
        admin: agentConfig.admin === true || agentConfig.root === true,
        root: agentConfig.root === true,
        // {{#if linearAgentEnabled}} in the agent-self-service fragment.
        // KLANKER HAZARD: this reconcile-path claudeContext is a hand-curated
        // subset, NOT buildWorkspaceContext — so this flag MUST mirror the
        // value buildWorkspaceContext sets (scaffold.ts ~2240) byte-for-byte,
        // or the self-service fragment renders differently on apply vs
        // first-scaffold and the diff-abort below trips on every reconcile.
        linearAgentEnabled:
          (
            agentConfig.channels?.telegram as
              | { linear_agent?: { enabled?: boolean } }
              | undefined
          )?.linear_agent?.enabled === true,
      };

      // Render template, then append the switchroom-managed
      // fragments (every agent gets them; reconcile re-applies on
      // every run so updates propagate without touching per-profile
      // templates). The ORDER must mirror the first-scaffold path
      // (line 2080+ above: vault protocol, then agent-self-service)
      // or the diff-abort below will trip on every reconcile — the
      // root cause of the 30+ scaffold test failures landing before
      // PR #1163 was that this path missed the self-service fragment
      // the other path applied. Both fragments are no-ops if their
      // source file is absent.
      let rendered = renderTemplate(claudeMdSrc, claudeContext);
      // Reply-discipline rides at the TOP (prepended after the title).
      // MUST mirror the first-scaffold path (via the shared
      // prependReplyDiscipline helper) or the diff-abort below trips on
      // every reconcile.
      rendered = prependReplyDiscipline(rendered, claudeContext);
      const vaultProtocol = renderVaultProtocolFragment(claudeContext);
      if (vaultProtocol) {
        rendered = rendered.trimEnd() + "\n\n" + vaultProtocol + "\n";
      }
      const selfService = renderAgentSelfServiceFragment(claudeContext);
      if (selfService) {
        rendered = rendered.trimEnd() + "\n\n" + selfService + "\n";
      }
      // Execution-discipline fragment — fleet-wide grounding posture.
      // ORDER must mirror the first-scaffold path above (vault protocol,
      // then agent-self-service, then execution-discipline) or the
      // diff-abort below trips on every reconcile.
      const executionDiscipline = renderExecutionDisciplineFragment(claudeContext);
      if (executionDiscipline) {
        rendered = rendered.trimEnd() + "\n\n" + executionDiscipline + "\n";
      }
      // Dev-protocol fragment — fleet-wide development protocol. ORDER
      // must mirror the first-scaffold path above (vault protocol, then
      // agent-self-service, then execution-discipline, then
      // dev-protocol) or the diff-abort below trips on every reconcile.
      const devProtocol = renderDevProtocolFragment(claudeContext);
      if (devProtocol) {
        rendered = rendered.trimEnd() + "\n\n" + devProtocol + "\n";
      }
      // Delegation golden-rule fragment — appended LAST (after
      // execution-discipline and dev-protocol) so the "prefer delegating
      // execution to a sub-agent" signal regains tail-of-prompt recency
      // (#3231). ORDER must mirror the first-scaffold path above (…,
      // dev-protocol, then delegation-golden-rule) or the diff-abort below
      // trips on every reconcile.
      const delegationGoldenRule = renderDelegationGoldenRuleFragment(claudeContext);
      if (delegationGoldenRule) {
        rendered = rendered.trimEnd() + "\n\n" + delegationGoldenRule + "\n";
      }
      // claude_md_raw stays in the Switchroom-managed (above-marker) block —
      // it is yaml-driven, scaffold-owned content, not operator hand-edits.
      if (agentConfig.claude_md_raw) {
        rendered = rendered.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
      }

      // Two-section composition (#1857): `rendered` is the Switchroom-managed
      // block; everything below the visible marker is operator-owned and
      // preserved verbatim across applies. The below-marker section is read
      // from the EXISTING file (or migrated one-time from the legacy
      // workspace/CLAUDE.custom.md sidecar). MUST use the same shared helper
      // as the first-scaffold path so both produce byte-identical output —
      // preservation reads the existing file BEFORE composing so an unchanged
      // config re-run is a full no-op (composed === before below).
      const before = existsSync(claudeMdDest) ? readFileSync(claudeMdDest, "utf-8") : "";
      const composed = composeTwoSectionClaudeMd(
        rendered,
        before.length > 0 ? before : null,
        claudeCustomPath,
      );

      if (composed !== before) {
        writeFileSync(claudeMdDest, composed, "utf-8");
        changes.push(claudeMdDest);
      }
    }
  }

  // --- Reconcile settings.json ---
  const settingsPath = join(agentDir, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const before = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(before);

    // Permissions: switchroom-managed keys are allow, deny, defaultMode.
    // Preserve any other keys the user may have added under permissions.
    settings.permissions = settings.permissions ?? {};
    settings.permissions.allow = desiredAllow;
    settings.permissions.deny = desiredDeny;
    // defaultMode is now emitted for EVERY agent (decoupled from the `[all]`
    // wildcard) and MUST stay byte-identical to the scaffold path's
    // buildWorkspaceContext → settings.json.hbs render. See
    // resolvePermissionDefaultMode for the precedence rule.
    settings.permissions.defaultMode = resolvePermissionDefaultMode(
      agentConfig,
      switchroomConfig,
    );

    // mcpServers: rebuild from current switchroom.yaml. Preserves user-defined
    // mcp_servers from agentConfig.mcp_servers in addition to the built-ins.
    // Entries with value `false` in mcp_servers are opt-outs — they suppress
    // a built-in default (e.g. playwright) for this agent and are not written
    // to settings.json.
    const mcpServers: Record<string, unknown> = {};

    // Hindsight first (so it's the most visible to a reader)
    const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
    if (hindsightEntry) {
      mcpServers[hindsightEntry.key] = hindsightEntry.value;
    }

    // #235: switchroom-mcp is deprecated — its 4 tools (switchroom_memory_*,
    // workspace_memory_*) had zero callers; Hindsight's MCP +
    // Claude Code's built-in Read/Grep cover the same ground. New agents
    // skip the entry entirely; reconcile retracts it from existing ones.

    // Built-in default MCPs (e.g. playwright). Single source of truth lives
    // in scaffold-integration.ts; `switchroom update` reconciles the same
    // list onto pre-existing agents. Agents opt out via
    // `mcp_servers: { <key>: false }` in switchroom.yaml.
    for (const entry of getBuiltinDefaultMcpEntries()) {
      const optOut = (agentConfig.mcp_servers ?? {})[entry.optOutKey] === false;
      if (!optOut) {
        mcpServers[entry.key] = entry.value;
      }
    }

    // Per-agent conditional `gdrive` MCP — same shared gate as the
    // scaffoldAgent path (resolveGdriveMcpEntry honours the
    // `mcp_servers: { gdrive: false }` opt-out and the broker-ACL
    // predicate). Placed before the user-defined extras below so an
    // explicit user `gdrive` entry still overrides. `switchroom update`
    // → reconcile re-evaluates this every run, so toggling
    // google_workspace.account / google_accounts.enabled_for[] in
    // switchroom.yaml adds or retracts the entry on the next reconcile.
    {
      // Site 3 — settings.json reconcile: emit-or-retract. Retraction
      // is keyed off `integration.retractionKey` (a separate field from
      // `emitKey`), so a future integration whose opt-out key differs
      // from its emit key cannot silently drift between emit and
      // retract paths. Mirrors how #235 switchroom-mcp retraction works.
      for (const integration of INTEGRATION_MCP_RESOLVERS) {
        for (const entry of integrationMcpEntries(
          integration,
          name,
          agentConfig,
          switchroomConfig,
        )) {
          mcpServers[entry.key] = entry.value;
        }
        // Retract every owned key NOT in the current emit set — for the
        // plural ms-365 integration this deletes stale `ms-365-<slug>`
        // entries when an agent's bindings shrink or an ACL is revoked.
        for (const stale of integrationRetractionKeys(
          integration,
          name,
          agentConfig,
          switchroomConfig,
        )) {
          delete mcpServers[stale];
        }
      }
    }

    // User-defined extras from switchroom.yaml agents.<name>.mcp_servers.
    // Skip `false` values — those are opt-outs for built-in defaults above.
    if (agentConfig.mcp_servers) {
      for (const [key, value] of Object.entries(agentConfig.mcp_servers)) {
        if (value === false) continue; // opt-out sentinel — already handled above
        mcpServers[key] = value;
      }
    }

    settings.mcpServers = mcpServers;

    // Hindsight memory plugin: vendored from vectorize-io/hindsight,
    // copied into <agentDir>/.claude/plugins/hindsight-memory/. The
    // plugin's own hooks.json registers SessionStart / UserPromptSubmit /
    // Stop / SessionEnd hooks via Claude Code's plugin loader. Always
    // re-copy on reconcile so plugin updates propagate via
    // `switchroom update` → reconcile.
    //
    // skipProfileTemplates: vendor source lives at
    // `<install>/vendor/hindsight-memory/`, never shipped into the agent
    // image. In-agent the resolver lands at literal `/vendor/...` and
    // installHindsightPlugin writes a misleading "check the npm tarball"
    // stderr line before returning null. See ReconcileOptions doc-comment.
    if (!options.skipProfileTemplates) {
      installHindsightPlugin(name, agentDir, switchroomConfig, agentConfig);
    }

    // Disable Claude Code's built-in auto-memory when Hindsight is on.
    // This stops the dueling-instruction problem (see research notes
    // for cli.js bl8() and the autoMemoryEnabled settings key).
    if (hindsightEnabled) {
      settings.autoMemoryEnabled = false;
    } else if (settings.autoMemoryEnabled === false) {
      // Memory backend was disabled — restore the default
      delete settings.autoMemoryEnabled;
    }

    // --- Phase 5: drop non-switchroom-owned top-level keys from a prior
    // settings_raw run before rewriting. Reconcile tracks which keys
    // were injected last time via a `_switchroomManagedRawKeys` side-car
    // and removes them here so removed switchroom.yaml entries don't leave
    // stale drift behind. Keys that are also switchroom-owned (permissions,
    // mcpServers, hooks, model, etc) are left alone because the
    // scaffold rebuild below re-derives them from switchroom.yaml anyway.
    const META_KEY = "_switchroomManagedRawKeys";
    const priorRawKeys = Array.isArray(settings[META_KEY])
      ? (settings[META_KEY] as string[])
      : [];
    for (const k of priorRawKeys) {
      if (!SWITCHROOM_OWNED_SETTINGS_KEYS.has(k) && k in settings) {
        delete settings[k];
      }
    }
    delete settings[META_KEY];

    // --- One-shot migration: retract dead settings keys that prior switchroom
    // versions emitted from the hbs template. They were never tracked in
    // _switchroomManagedRawKeys (template-emitted, not settings_raw-injected),
    // so the loop above doesn't catch them on existing agents. Delete them
    // explicitly. Safe to remove this block after a few releases.
    // See settings.json.hbs header for why these keys are no-ops at project scope.
    delete settings.enabledPlugins;
    delete settings.skipDangerousModePermissionPrompt;

    // --- Phase 2: reconcile user hooks (replace, don't merge) ---
    //
    // Fully replace settings.hooks from switchroom.yaml each reconcile, so
    // removing a hook event from switchroom.yaml also removes it from
    // settings.json. Plugin-installed hooks (hindsight) live in the
    // plugin's own hooks.json and are loaded via --plugin-dir, so
    // they're not affected by this. Switchroom-owned.
    //
    // buildSettingsHooksBlock() is the single source of truth for the full
    // hooks block (user yaml + switchroom-owned). It is also called by the
    // drift-check path (reconcile --check) without performing a write.
    // SessionStart greeting hook deleted in #142 — see scaffoldAgent
    // for the rationale.
    settings.hooks = buildSettingsHooksBlock({
      agentName: name,
      agentConfig,
      hindsightEnabled,
      useSwitchroomPlugin: usesSwitchroomTelegramPlugin(agentConfig),
      configPath: switchroomConfigPath,
    });

    // Read userId from access.json (written during scaffold) — used by
    // both the sub-agent prompt addendum and the greeting script below.
    let greetingUserId: string | undefined;
    const accessPath = join(agentDir, "telegram", "access.json");
    if (existsSync(accessPath)) {
      try {
        const access = JSON.parse(readFileSync(accessPath, "utf-8"));
        greetingUserId = access.allowFrom?.[0];
      } catch { /* best effort */ }
    }

    // --- Reconcile sub-agent definitions (.claude/agents/<name>.md) ---
    //
    // Same generation as scaffold — overwrites on every reconcile so
    // config changes propagate. Sub-agent files are fully switchroom-owned.
    if (agentConfig.subagents) {
      const saDir = join(agentDir, ".claude", "agents");
      mkdirSync(saDir, { recursive: true });
      for (const [saName, saDef] of Object.entries(agentConfig.subagents)) {
        const mdPath = join(saDir, `${saName}.md`);
        // Post-cascade invariant — see same check in scaffoldAgent above.
        if (!saDef.description) {
          throw new Error(
            `subagent "${saName}" has no description after cascade — add one ` +
              `to your defaults, the profile this agent extends, or the agent's ` +
              `own subagents.${saName} block.`,
          );
        }
        const frontmatter: Record<string, unknown> = {
          name: saName,
          description: saDef.description,
        };
        if (saDef.model) frontmatter.model = saDef.model;
        if (saDef.background != null) frontmatter.background = saDef.background;
        if (saDef.isolation) frontmatter.isolation = saDef.isolation;
        if (saDef.tools) frontmatter.tools = saDef.tools.join(", ");
        if (saDef.disallowedTools) frontmatter.disallowedTools = saDef.disallowedTools.join(", ");
        if (saDef.maxTurns) frontmatter.maxTurns = saDef.maxTurns;
        if (saDef.permissionMode) frontmatter.permissionMode = saDef.permissionMode;
        if (saDef.effort) frontmatter.effort = saDef.effort;
        if (saDef.color) frontmatter.color = saDef.color;
        if (saDef.memory) frontmatter.memory = saDef.memory;
        if (saDef.skills && saDef.skills.length > 0) {
          frontmatter.skills = saDef.skills;
        }
        const fmLines = Object.entries(frontmatter)
          .map(([k, v]) => {
            if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join("\n")}`;
            return `${k}: ${v}`;
          })
          .join("\n");
        const rawBody = saDef.prompt ?? `You are the ${saName} sub-agent.`;
        const body = applySubAgentLocalTimeGuidance(
          applyTelegramProgressGuidance(rawBody, {
            telegramEnabled: true,
            defaultChatId: greetingUserId,
          }),
          resolveTimezone(switchroomConfig, agentConfig),
        );
        const content = `---\n${fmLines}\n---\n\n${body}\n`;
        const before = existsSync(mdPath) ? readFileSync(mdPath, "utf-8") : "";
        if (content !== before) {
          writeFileSync(mdPath, content, "utf-8");
          changes.push(mdPath);
        }
      }
    }

    // Model resolution mirrors scaffoldAgent's path so reconcile + create
    // produce the same settings.model byte-for-byte. Apply the switchroom
    // default (Sonnet 5) when the operator hasn't set an explicit
    // override in switchroom.yaml.
    settings.model = resolveMainModel(agentConfig.model);

    // --- Phase 5: settings_raw escape hatch ---
    //
    // Apply fresh after the scaffold-rebuild of switchroom-owned fields.
    // Stamp the new META_KEY so the next reconcile knows which keys
    // to retract if the user removes them from switchroom.yaml.
    const mergedSettings = agentConfig.settings_raw
      ? (deepMergeJson(settings, agentConfig.settings_raw) as Record<string, unknown>)
      : settings;
    if (agentConfig.settings_raw && Object.keys(agentConfig.settings_raw).length > 0) {
      mergedSettings[META_KEY] = Object.keys(agentConfig.settings_raw);
    }

    const after = JSON.stringify(mergedSettings, null, 2) + "\n";
    if (after !== before) {
      // Atomic (tmp + fsync + rename) so a crash / ENOSPC mid-write can
      // never leave a torn / truncated settings.json that Claude Code
      // then fails to parse — same guarantee as the M5 fix. Mode 0600
      // preserved (settings.json is not secret-bearing but the prior
      // write pinned it; keep it identical).
      atomicWriteFileSync(settingsPath, after, 0o600);
      changes.push(settingsPath);
    }
  }

  // --- Cleanup retired cron-*.sh + .source sidecars (post-Phase-4) ---
  //
  // Phase 4 cron-fold-in (#890-#893) retired the per-agent cron .sh
  // scripts that wrapped `claude -p`. Cron now fires via the in-
  // container agent-scheduler → inject_inbound IPC → live session
  // (`src/scheduler/dispatch.ts`). Existing installs may still have
  // stale `cron-<sha12>.sh` (or legacy `cron-<index>.sh`) files plus
  // their `.source` sidecars on disk. This block deletes them
  // unconditionally — independent of whether the agent has any
  // `schedule:` entries — so the disk state matches the post-fold-in
  // model. Idempotent: re-running with no .sh files present is a no-op.
  const telegramDir = join(agentDir, "telegram");
  if (existsSync(telegramDir)) {
    const files = readdirSync(telegramDir);
    for (const file of files) {
      const isCronScript = CRON_SCRIPT_BASENAME_RE.test(file) || LEGACY_CRON_SCRIPT_BASENAME_RE.test(file);
      if (isCronScript) {
        const staleScript = join(telegramDir, file);
        unlinkSync(staleScript);
        changes.push(staleScript);
        const sourceSidecar = staleScript.replace(/\.sh$/, ".source");
        if (existsSync(sourceSidecar)) {
          unlinkSync(sourceSidecar);
          changes.push(sourceSidecar);
        }
      }
    }
  }

  // --- Refresh telegram/.env bot token once a vault grant lands (M3) ---
  //
  // scaffold's `.env` write is writeIfMissing, so a token that was an
  // unresolvable `vault:` reference at first scaffold froze the placeholder
  // forever — a later `vault set` + `apply` never picked it up. Re-resolve
  // here and overwrite ONLY when the file is still the placeholder, so a real
  // operator-set token is never clobbered. resolvedBotToken is keyed strictly
  // by THIS agent's config (agentConfig.bot_token ?? telegramConfig.bot_token),
  // so the interrupt window (vault has <new>.bot_token while agents.<old> lingers
  // in config) can't mis-attribute another agent's token here.
  refreshTelegramBotTokenEnv(agentDir, resolvedBotToken, changes);

  // --- Reconcile global skills pool symlinks ---
  //
  // Mirrors the scaffold syncGlobalSkills call so reconcile picks up
  // added/removed entries in switchroom.yaml.
  if (agentConfig.skills) {
    syncGlobalSkills(agentDir, agentConfig.skills, switchroomConfig.switchroom.skills_dir);
  }

  // --- Install built-in switchroom-* skills into .claude/skills/ ---
  // Role-gated (#235 follow-up). Reconcile honors role flips both
  // ways: assistant → foreman installs the symlinks; foreman →
  // assistant retracts them.
  //
  // skipProfileTemplates: both helpers read from
  // `~/.switchroom/skills/_bundled/` on the operator host. In-agent
  // `homedir()` resolves to the agent's state dir (e.g. /state/agent)
  // where the pool doesn't exist; both helpers warn + skip silently
  // but the stderr suggests "run `switchroom update`" — an operator
  // verb unavailable inside the agent container. See ReconcileOptions
  // doc-comment.
  if (!options.skipProfileTemplates) {
    installSwitchroomSkills(agentDir, { role: agentConfig.role });

    // --- Reconcile bundled default skills (anthropic + switchroom-core) ---
    // Mirrors scaffoldAgent — additive, idempotent, honours opt-outs.
    reconcileAgentDefaultSkills(
      agentDir,
      (agentConfig.bundled_skills ?? {}) as Record<string, unknown>,
    );
  }

  // --- Reconcile .mcp.json (switchroom-telegram plugin agents only) ---
  if (usesSwitchroomTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    // Mirror scaffoldAgent: in-image plugin + CLI + bind-mounted config.
    const pluginDir = DOCKER_TELEGRAM_PLUGIN_PATH;
    const switchroomCliPath = "/usr/local/bin/switchroom";
    const resolvedConfigPath = DOCKER_CONFIG_PATH;

    // See companion comment + telegramStateDir derivation in scaffoldAgent
    // (~line 2479). Must match byte-for-byte across both writers or every
    // cron-only reconcile reports drift on the writer's own output.
    // switchroom#1892.
    const telegramStateDir = `${DOCKER_AGENT_HOME}/.switchroom/agents/${name}/telegram`;

    // Linear connection gate (P4-A): the bridge only advertises the
    // linear_* tools when this agent actually has the Linear connection
    // configured. Mirrors the `linearAgentEnabled` derivation in
    // buildWorkspaceContext (scaffold.ts:2362) so both stay in lockstep.
    const linearAgentEnabled =
      (
        agentConfig.channels?.telegram as
          | { linear_agent?: { enabled?: boolean } }
          | undefined
      )?.linear_agent?.enabled === true;

    const mcpServers: Record<string, McpServerConfig> = {
      "switchroom-telegram": {
        command: "bun",
        args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
        env: {
          TELEGRAM_STATE_DIR: telegramStateDir,
          SWITCHROOM_CONFIG: resolvedConfigPath,
          SWITCHROOM_CLI_PATH: switchroomCliPath,
          // Gate the linear_* tools (P4-A). Only set when the Linear
          // connection is configured; the bridge drops those 3 tools
          // otherwise so a non-Linear agent never carries their schema.
          ...(linearAgentEnabled ? { SWITCHROOM_TELEGRAM_LINEAR: "1" } : {}),
        },
        // Tool-search right-sizing (P4-B): the server is NO LONGER pinned
        // wholesale. The bridge pins the load-bearing hot tools (reply /
        // get_recent_messages / react / edit_message /
        // send_typing / download_attachment) individually via the native
        // per-tool `_meta["anthropic/alwaysLoad"]` annotation, so they
        // never defer (no orphaned-reply round-trip), while the ~14 cold
        // tools (linear / vault / checklist / gif / sticker / pin / delete
        // / forward / ask_user) defer and load on first use — reclaiming
        // ~5k tokens of always-on baseline per agent.
        alwaysLoad: false,
      },
      // Read-only agent-config broker. Exposes 4 tools (config_get,
      // cron_list, skill_list, audit_tail) that re-exec the switchroom
      // CLI. Identity is pinned by SWITCHROOM_AGENT_NAME — the CLI
      // refuses cross-agent reads.
      "agent-config": {
        command: switchroomCliPath,
        args: ["mcp", "agent-config"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
        // Deferred: 4-tool read-only server loads on demand via tool search.
        // Agents invoke agent-config tools only occasionally (schedule adds,
        // skill installs, config reads) — pinning it server-wide (~4 tools)
        // burned always-on context budget for no first-turn benefit.
        alwaysLoad: false,
      },
    };

    // hostd MCP — admin-only fleet-management tools (agent_restart,
    // agent_start, agent_stop, update_check, update_apply). Wired only
    // for admin-flagged agents because compose only bind-mounts the
    // per-agent hostd socket for those (#1175 RFC C §5.2). Without
    // the socket, the tools fail at first call with a clean ENOENT
    // error message — but cleaner UX to just not surface them.
    if (agentConfig.admin === true || agentConfig.root === true) {
      mcpServers["hostd"] = {
        command: switchroomCliPath,
        args: ["mcp", "hostd"],
        env: {
          SWITCHROOM_AGENT_NAME: name,
          SWITCHROOM_CONFIG: resolvedConfigPath,
        },
      };
    }

    if (hindsightEnabled) {
      const hindsightEntry = getHindsightSettingsEntry(name, switchroomConfig);
      if (hindsightEntry) {
        mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }
    }

    // Per-agent conditional `gdrive` MCP. THIS .mcp.json (not
    // settings.json.mcpServers) is the surface Claude Code actually
    // loads for switchroom-telegram-plugin agents. mcpServers is rebuilt
    // fresh from the hardcoded set each reconcile, so a retracted gdrive
    // simply isn't re-added (no explicit delete needed). Same shared
    // broker-ACL gate as scaffoldAgent / settings paths.
    {
      // Site 4 — .mcp.json reconcile: emit-only. mcpServers is rebuilt
      // fresh from the hardcoded set each reconcile, so a retracted
      // entry simply isn't re-added (no explicit delete needed).
      for (const integration of INTEGRATION_MCP_RESOLVERS) {
        for (const entry of integrationMcpEntries(
          integration,
          name,
          agentConfig,
          switchroomConfig,
        )) {
          mcpServers[entry.key] = entry.value;
        }
      }
    }

    // User-declared mcp_servers from switchroom.yaml. Mirrors the
    // scaffoldAgent path: spread AFTER the framework set with user
    // winning on key collision. `false` opt-outs stripped by
    // filterMcpServers. Without this spread the entire user MCP
    // surface in switchroom.yaml is silently dropped from .mcp.json
    // (the surface Claude Code actually loads), regression class
    // since v0.7.6's docker cutover — see the in-block comment at
    // the scaffoldAgent writer for the full story.
    if (agentConfig.mcp_servers) {
      const filtered = filterMcpServers(agentConfig.mcp_servers);
      if (filtered) {
        for (const [key, value] of Object.entries(filtered)) {
          mcpServers[key] = value as McpServerConfig;
        }
      }
    }

    const mcpJson = { mcpServers };
    const after = JSON.stringify(mcpJson, null, 2) + "\n";
    const before = existsSync(mcpJsonPath)
      ? readFileSync(mcpJsonPath, "utf-8")
      : "";
    if (after !== before) {
      // Atomic (tmp + fsync + rename) so a crash / ENOSPC mid-write can
      // never leave a torn / truncated .mcp.json that Claude Code then
      // fails to parse — same guarantee as the M5 fix. Mode 0600
      // preserved from the prior write.
      atomicWriteFileSync(mcpJsonPath, after, 0o600);
      changes.push(mcpJsonPath);
    }
    // Cheap-cron Tier-1 (#2307): keep the cron .mcp.json (full set + cron-only
    // liveness path) in sync on reconcile.
    const cronMcp = maybeWriteCronMcp(
      agentDir,
      mcpServers,
      buildCronSessionContext(agentConfig).cronSessionEnabled,
    );
    if (cronMcp) changes.push(cronMcp);
    // Mirror scaffoldAgent: keep every scaffolded server on Claude
    // Code's per-project trust allowlist (idempotent — runs every
    // reconcile so a newly-added gdrive/hostd is trusted on the next
    // `switchroom apply`, not just at original onboarding).
    ensureMcpServersTrusted(agentDir, Object.keys(mcpServers));
  }

  // --- Re-seed workspace bootstrap files from the profile.
  //
  //     writeIfMissing semantics mean user edits survive, but new template
  //     files added to the profile will be seeded on reconcile — matching
  //     scaffold behavior. Without this call, agents scaffolded before a
  //     template addition stay out of date until rescaffolded.
  //
  // skipProfileTemplates: `getProfilePath` resolves source-relative to
  // `<install>/profiles/<name>` and falls back to `<install>/profiles/default`;
  // in-agent both resolve to literal `/profiles/...` (absent), so the call
  // throws "Profile not found: default (searched /profiles)" — the exact
  // error that surfaces as E_RECONCILE_FAILED on `schedule_add` from
  // inside an agent container (#1618). See ReconcileOptions doc-comment.
  const reconcileWorkspaceDir = join(agentDir, "workspace");
  if (!options.skipProfileTemplates) {
    const reconcileProfilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
    // Use the same helper scaffoldAgent uses so workspace templates see
    // an identical context shape on both paths. Without this, any new
    // handlebars key referenced by a workspace template renders on
    // scaffold but as "" on reconcile.
    const workspaceContext = buildWorkspaceContext({
      name,
      agentDir,
      agentConfig,
      telegramConfig,
      switchroomConfig,
      switchroomConfigPath,
      topicId,
      tools,
      permissionAllow: desiredAllow,
      hasAllWildcard,
      resolvedBotToken,
      rawBotToken,
      hindsightAutoRecallEnabled,
      hindsightBankId,
      hindsightApiBaseUrl,
      hindsightRecallMaxMemories,
      hindsightRecallCacheTtlSecs,
      hindsightRecallParallelDeadlineSeconds,
      hindsightRecallQueryMaxTokens,
      hindsightRecallQueryStopTermsJson,
      hindsightRecallRequestTimeoutSeconds,
      hindsightRecallOwnBankMinSlots,
      hindsightRecallAdditionalBankMinSlots,
      hindsightRecallMinScore,
      hindsightRecallMinScoreScope,
      hindsightRecallPassthrough,
      hindsightRecallTypes,
      hindsightRecallSkipTrivial,
      hindsightDirectiveCaptureNudge,
      hindsightObservationScopes,
      hindsightObservationScopeStrategy,
      hindsightTopicAliasesJson,
      hindsightSenderBanksJson,
      hindsightTopicFilterMode,
    });
    // Phase 5 migration: preserve any agent-specific edits to the legacy
    // workspace/AGENTS.md (pre-rename) by renaming it to CLAUDE.md before
    // the seed pass runs. seedWorkspaceBootstrapFiles is writeIfMissing,
    // so it will then skip CLAUDE.md and preserve the migrated content.
    mkdirSync(reconcileWorkspaceDir, { recursive: true });
    migrateLegacyAgentsMdIfPresent(reconcileWorkspaceDir, changes);
    seedWorkspaceBootstrapFiles({
      profilePath: reconcileProfilePath,
      agentDir,
      context: workspaceContext,
      created: changes,
      skipped: [],
      rewrittenWithBackup: changes,
      // Hindsight-native gate must hold on the RECONCILE path too — this is
      // what runs on every `agent restart` / `apply`, so without it a deleted
      // MEMORY.md would be re-seeded here and the migration would not stick.
      seedMemoryFile: agentConfig.memory?.file !== false,
    });
    ensureClaudeMdSymlinks(reconcileWorkspaceDir, changes);
  }

  // --- Phase 4: idempotent workspace git init (for existing agents) ---
  if (existsSync(reconcileWorkspaceDir)) {
    initWorkspaceGitRepo(reconcileWorkspaceDir, name);
  }

  // SOUL.md is user-owned (seeded once by seedWorkspaceBootstrapFiles
  // above via writeIfMissing — which also covers an agent first created
  // on the reconcile path). Reconcile/update deliberately never
  // regenerates it from config; `switchroom soul reset <agent>` is the
  // explicit re-seed path. See seedWorkspaceBootstrapFiles for the
  // ownership contract.

  // --- Phase 2: symlink <agentDir>/SOUL.md → workspace/SOUL.md (migration) ---
  const agentSoulPath = join(agentDir, "SOUL.md");
  const workspaceSoulPath = join(agentDir, "workspace", "SOUL.md");
  if (existsSync(workspaceSoulPath)) {
    if (existsSync(agentSoulPath)) {
      const stat = lstatSync(agentSoulPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(agentSoulPath);
        if (target !== "workspace/SOUL.md") {
          rmSync(agentSoulPath);
          symlinkSync("workspace/SOUL.md", agentSoulPath);
          changes.push(agentSoulPath);
        }
      } else {
        // Regular file, replace with symlink
        rmSync(agentSoulPath);
        symlinkSync("workspace/SOUL.md", agentSoulPath);
        changes.push(agentSoulPath);
      }
    } else {
      symlinkSync("workspace/SOUL.md", agentSoulPath);
      changes.push(agentSoulPath);
    }
  }

  // --- Generation stamp (KEN-130): record what this reconcile left on disk ---
  // Written BEFORE the ownership sweep below so a root-run reconcile
  // sweeps the stamp back to the agent UID with everything else.
  if (!options.skipProfileTemplates) {
    stampGeneratedSurfaces(agentDir, agentConfig);
  }

  // --- Ownership invariant (#3168): root-written files must land agent-owned ---
  //
  // The hostd rollout runs this whole function as root (`switchroom agent
  // restart` spawned by src/cli/rollout.ts:681 — restart reconciles first).
  // Any write above that created a NEW inode (atomicWriteFileSync's
  // tmp+rename for settings.json / .mcp.json, first-writes, plugin recopy)
  // landed root-owned — and root:root 0600 settings.json means the agent's
  // claude loads NO permission allowlist and every tool call throws an
  // operator approval card (2026-07-12 fleet-wide incident, v0.18.14 roll).
  // Sweep the tree back to the agent UID (the reconcile twin of apply's
  // alignAgentUid), then assert the files this reconcile touched are
  // actually readable by the agent UID — fail loudly, never wedge silently.
  {
    const sweptUid = alignAgentTreeOwnershipIfRoot(name, agentDir);
    if (sweptUid !== null) {
      // #3333 amendment B: the assert candidate set is the UNION of the
      // static scoped set (derived from the same scope constants the sweep
      // uses — scope-of-sweep == scope-of-assert) and this run's dynamic
      // `changes` list. The `changes` term must be PRESERVED, never
      // replaced: it is what catches a touched-but-out-of-scope file (e.g.
      // a future top-level write) that the static set doesn't name. Dedup
      // so a file in both terms is only reported once.
      const critical = [
        ...new Set([
          ...scopedAssertCandidates(agentDir),
          ...changes.filter((p) => p.startsWith(agentDir + "/")),
        ]),
      ];
      const unreadable = findAgentUnreadablePaths(critical, sweptUid);
      if (unreadable.length > 0) {
        throw new Error(
          `reconcile left agent-unreadable files in ${agentDir} (agent uid ${sweptUid}): ` +
            `${unreadable.join(", ")}. The agent cannot load these (permission-card ` +
            `storm on next boot). This is a bug in the ownership sweep — see #3168.`,
        );
      }
    }
  }

  // Categorize changes by reload semantics
  const hot: string[] = [];
  const staleTillRestart: string[] = [];
  const restartRequired: string[] = [];

  const useHotReloadStableClassify = agentConfig.channels?.telegram?.hotReloadStable === true;
  for (const change of changes) {
    const semantics = classifyChange(change, agentDir, useHotReloadStableClassify);
    if (semantics === "hot") {
      hot.push(change);
    } else if (semantics === "stale-till-restart") {
      staleTillRestart.push(change);
    } else {
      restartRequired.push(change);
    }
  }

  // Ensure bank exists before any mission/MM ops — same rationale as
  // scaffoldAgent. reconcile is also the operator's retry path when
  // Hindsight was down during `agent create`.
  if (hindsightEnabled) {
    const apiUrl = `${hindsightApiBaseUrl}/mcp/`;
    const bankOpsChain = createBank(apiUrl, hindsightBankId, { timeoutMs: 5000 })
      .then((result) => {
        if (result.ok) {
          console.log(`  ${chalk.green("✓")} Hindsight bank ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
          return true;
        }
        if (result.reason === "Unreachable") {
          console.warn(
            `  ${chalk.yellow("⚠")} Hindsight unreachable — skipping bank creation for ${formatAgentBankLabel(name, hindsightBankId)}.`,
          );
          console.warn(
            `     Start Hindsight, then re-run: switchroom agent reconcile ${name}`,
          );
        } else {
          console.warn(
            `  ${chalk.yellow("⚠")} Failed to create Hindsight bank for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`,
          );
        }
        return false;
      })
      .catch((err) => {
        console.warn(`  ${chalk.yellow("⚠")} Hindsight bank create error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        return false;
      });

    trackBankOps(bankOpsChain.then(async (bankReady) => {
      if (!bankReady) return;

      // Reconcile pushes reflect_mission / observations_mission / disposition
      // — including the built-in profile defaults — so EXISTING banks pick up
      // Phase 2 changes on `switchroom apply`, not only fresh ones. Config
      // wins over profile defaults; disposition merges per-key.
      const extras = resolveBankMissionExtras(
        agentConfig.memory,
        resolveMemoryProfile(agentConfig),
      );

      const missions: {
        bank_mission?: string;
        retain_mission?: string;
        reflect_mission?: string;
        observations_mission?: string;
        disposition?: { skepticism?: number; literalism?: number; empathy?: number };
      } = { ...extras };
      if (agentConfig.memory?.bank_mission) {
        missions.bank_mission = agentConfig.memory.bank_mission;
      }

      // retain_mission on reconcile (2026-07-25 review finding 1). Until then
      // this pushed ONLY when the operator had set it in yaml, so a rewrite of
      // DEFAULT_RETAIN_MISSION never reached an existing bank through THIS
      // path. It now follows the same "push the default so existing banks pick
      // up changes" rule as reflect/observations above — via the shared
      // `resolveRetainMissionPush`, which upgrades only when the bank's current
      // mission byte-equals a known previous default (SUPERSEDED_RETAIN_MISSIONS)
      // or is unset, and pushes nothing on a failed read.
      const retainMission = await resolveRetainMissionPush(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.retain_mission,
        formatAgentBankLabel(name, hindsightBankId),
      );
      if (retainMission) missions.retain_mission = retainMission;

      // Same read-first treatment for observations_mission — see
      // `resolveObservationsMissionPush`.
      delete missions.observations_mission;

      // disposition gets the same read-first treatment, for the same reason:
      // it is now non-empty for every agent (fleet floor), so pushing it
      // blindly would both re-send it forever and overwrite hand-tuned banks.
      delete missions.disposition;
      const dispositionPush = await resolveDispositionPush(
        apiUrl,
        hindsightBankId,
        extras.disposition,
        agentConfig.memory,
        resolveMemoryProfile(agentConfig),
        formatAgentBankLabel(name, hindsightBankId),
      );
      if (dispositionPush) missions.disposition = dispositionPush;

      const observationsMission = await resolveObservationsMissionPush(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.observations_mission,
        resolveMemoryProfile(agentConfig),
        formatAgentBankLabel(name, hindsightBankId),
      );
      if (observationsMission) missions.observations_mission = observationsMission;

      if (Object.keys(missions).length > 0) {
        await updateBankMissions(apiUrl, hindsightBankId, missions, { timeoutMs: 5000 })
          .then((result) => {
            if (result.ok) {
              console.log(`  ${chalk.green("✓")} Bank missions updated for ${formatAgentBankLabel(name, hindsightBankId)}`);
            } else {
              console.warn(`  ${chalk.yellow("⚠")} Failed to update bank missions for ${formatAgentBankLabel(name, hindsightBankId)}: ${result.reason}`);
            }
          })
          .catch((err) => {
            console.warn(`  ${chalk.yellow("⚠")} Bank mission update error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
          });
      }

      // Ensure operator-DECLARED per-specialist mental models (Phase 5) on
      // reconcile too — declared models are the desired steady state, so a
      // newly-added declaration lands on the next apply/restart. Only named
      // models are created; nothing is auto-seeded. Best-effort; never blocks.
      await ensureDeclaredMentalModels(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.mental_models,
        { timeoutMs: 5000 },
      )
        .then((outcomes) => {
          for (const o of outcomes) {
            if (o.ok) {
              console.log(`  ${chalk.green("✓")} Mental model "${o.name}" ready for ${formatAgentBankLabel(name, hindsightBankId)}`);
            } else {
              console.warn(`  ${chalk.yellow("⚠")} Failed to ensure mental model "${o.name}" for ${formatAgentBankLabel(name, hindsightBankId)}: ${o.reason}`);
            }
          }
        })
        .catch((err) => {
          console.warn(`  ${chalk.yellow("⚠")} Mental model ensure error for ${formatAgentBankLabel(name, hindsightBankId)}: ${err}`);
        });

      // Seed the anti-confabulation guardrail directive (default ON, no yaml
      // required). Idempotent and never-clobbering — see
      // src/memory/hindsight-seed-directives.ts.
      await seedAntiConfabulationDirective(
        apiUrl,
        hindsightBankId,
        agentConfig.memory?.anti_confabulation_directive,
        formatAgentBankLabel(name, hindsightBankId),
      );
    }));
  }

  return {
    agentDir,
    changes,
    changesBySemantics: { hot, staleTillRestart, restartRequired },
  };
}

/**
 * Write a file only if it doesn't already exist.
 * Tracks what was created vs skipped for reporting.
 *
 * Exported for tests (M1 atomicity — see scaffold-write-atomic.test.ts).
 */
export function writeIfMissing(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  mode?: number,
): void {
  if (existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }
  // Atomic tmp+fsync+rename: an interrupted scaffold (crash / ENOSPC / SIGKILL
  // mid-write) must never leave a torn or truncated file behind. This matters
  // most for settings.json — a partial write here is read back and JSON.parse'd
  // a few dozen lines later (the MCP-merge pass), so a half-written file would
  // throw and abort the scaffold with a corrupt agent on disk. When `mode` is
  // omitted we pass 0o666 to mirror plain writeFileSync's default (the process
  // umask is applied by the O_CREAT open, so the on-disk mode is unchanged).
  atomicWriteFileSync(filePath, contentFn(), mode ?? 0o666);
  created.push(filePath);
}

// Content-aware write for purely template-driven files (see #879).
// Reads existing content, renders fresh, writes only when different.
// Existing-and-changed counts as "created" for the caller's running
// total — `apply`'s "N files created" line then truthfully reflects
// that the file was rewritten, instead of silently reporting
// "up to date" when the template has drifted.
function writeIfChanged(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  mode?: number,
): void {
  const next = contentFn();
  const prev = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  if (prev === next) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, next, mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  created.push(filePath);
}

/**
 * Smart-rerender for files we GENERATE from a template but that the
 * operator MIGHT hand-edit between scaffolds. The previous
 * `writeIfMissing` behaviour froze the file forever after first write
 * — which meant a profile-template change (e.g. a new
 * `_shared/telegram-style.md.hbs` prompt) never reached existing
 * agents via `switchroom apply`. That was the root cause of the
 * #1122 conversational-pacing rollout silently bypassing every
 * agent's CLAUDE.md (discovered 2026-05-12 UAT overnight run).
 *
 * Contract:
 *  - First write: fresh content, drop a fingerprint sidecar
 *    (`<filename>.fingerprint`) holding the SHA-256 of what we wrote.
 *  - Subsequent apply:
 *     - Render fresh. If `hash(rendered) === hash(file_on_disk)`,
 *       no-op — file already reflects current template.
 *     - Else, read the fingerprint sidecar.
 *        - If sidecar matches `hash(file_on_disk)`: the operator has
 *          NOT touched the file since we last wrote it — template
 *          drifted, safe to overwrite + update fingerprint.
 *        - If sidecar doesn't match (or is missing): operator
 *          hand-edited the file. Back up the existing file to
 *          `<filename>.before-rerender.<unix-ms>` and overwrite
 *          + update fingerprint. The backup is loud enough for the
 *          operator to notice and re-merge their edits manually.
 *
 * Caveat: hashing is SHA-256 (`node:crypto`); cost is microseconds
 * per call. Fingerprint sidecar gets ~64 bytes per file. Trivial.
 */
/**
 * The Switchroom-managed section of a two-section CLAUDE.md: everything up to
 * and INCLUDING the marker line. If the marker is absent (legacy pre-#1857
 * file) the whole content counts as managed — which reproduces the old
 * whole-file fingerprint semantics for exactly the files that predate the
 * two-section regime.
 */
function claudeMdManagedSection(content: string): string {
  const idx = content.indexOf(CLAUDE_MD_YOURS_MARKER);
  if (idx === -1) return content;
  return content.slice(0, idx + CLAUDE_MD_YOURS_MARKER.length);
}

/**
 * Marker-aware fingerprint writer for the two-section `<agentDir>/CLAUDE.md`
 * (#1857). Same clobber/backup decision tree as rerenderWithFingerprint, with
 * one deliberate difference: the fingerprint covers ONLY the Switchroom-managed
 * (above-marker) section, and drift is judged against the existing file's
 * above-marker section only.
 *
 * Why: below-marker operator edits are a first-class, encouraged state — the
 * composition preserves them verbatim, so they are NOT drift. Under a
 * whole-file fingerprint every below-marker edit would mismatch the recorded
 * hash forever, and every subsequent template change would spuriously write a
 * `.before-rerender.<ts>` backup on every apply. Above-marker hand-edits still
 * get the full backup + regenerate treatment; legacy files without the marker
 * degrade to whole-file semantics (one backup on migration if hand-edited).
 */
function writeTwoSectionClaudeMdWithFingerprint(
  filePath: string,
  managedFn: () => string,
  sidecarPath: string,
  created: string[],
  skipped: string[],
  rewrittenWithBackup: string[],
): void {
  const prev = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const next = composeTwoSectionClaudeMd(managedFn(), prev, sidecarPath);
  const nextManagedHash = createHash("sha256")
    .update(claudeMdManagedSection(next), "utf-8")
    .digest("hex");
  const fingerprintPath = filePath + ".fingerprint";

  if (prev === null) {
    writeFileSync(filePath, next, "utf-8");
    writeFileSync(fingerprintPath, nextManagedHash, "utf-8");
    created.push(filePath);
    return;
  }

  if (prev === next) {
    // Already exactly what we'd write — refresh the fingerprint (covers
    // fingerprint deletion and migration from the whole-file regime).
    try {
      writeFileSync(fingerprintPath, nextManagedHash, "utf-8");
    } catch {
      // best-effort
    }
    skipped.push(filePath);
    return;
  }

  // Managed section drifted (or the below-marker section normalized). Decide
  // whether the operator touched the MANAGED section since our last write.
  const prevManagedHash = createHash("sha256")
    .update(claudeMdManagedSection(prev), "utf-8")
    .digest("hex");
  const recordedFingerprint = existsSync(fingerprintPath)
    ? readFileSync(fingerprintPath, "utf-8").trim()
    : null;

  if (recordedFingerprint === prevManagedHash) {
    // Managed section untouched by the operator — template/config drifted
    // upstream. Clobber the managed section cleanly; the below-marker
    // section is preserved by the composition above. No backup.
    writeFileSync(filePath, next, "utf-8");
    writeFileSync(fingerprintPath, nextManagedHash, "utf-8");
    created.push(filePath);
    return;
  }

  // Above-marker hand-edit (fingerprint mismatch) or legacy state (no
  // fingerprint). Back up + overwrite — same regime as rerenderWithFingerprint.
  const backupPath = `${filePath}.before-rerender.${Date.now()}`;
  try {
    writeFileSync(backupPath, prev, "utf-8");
  } catch (err) {
    process.stderr.write(
      `scaffold: refusing to overwrite ${filePath} — backup write failed ` +
      `(${(err as Error).message}). Operator edits preserved.\n`,
    );
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, next, "utf-8");
  writeFileSync(fingerprintPath, nextManagedHash, "utf-8");
  rewrittenWithBackup.push(filePath);
  created.push(filePath);
}

function rerenderWithFingerprint(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  rewrittenWithBackup: string[],
  mode?: number,
): void {
  const next = contentFn();
  const nextHash = createHash("sha256").update(next, "utf-8").digest("hex");
  const fingerprintPath = filePath + ".fingerprint";
  const writeMode = mode !== undefined ? { encoding: "utf-8" as const, mode } : "utf-8" as const;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, next, writeMode);
    writeFileSync(fingerprintPath, nextHash, "utf-8");
    created.push(filePath);
    return;
  }

  const prev = readFileSync(filePath, "utf-8");
  if (prev === next) {
    // File is already exactly what we'd render — refresh the fingerprint
    // (cheap, covers the case where someone deleted the fingerprint or
    // we're migrating an existing file into the fingerprint regime).
    try {
      writeFileSync(fingerprintPath, nextHash, "utf-8");
    } catch {
      // best-effort
    }
    skipped.push(filePath);
    return;
  }

  // Source has drifted. Decide whether to clobber.
  const prevHash = createHash("sha256").update(prev, "utf-8").digest("hex");
  const recordedFingerprint = existsSync(fingerprintPath)
    ? readFileSync(fingerprintPath, "utf-8").trim()
    : null;

  if (recordedFingerprint === prevHash) {
    // Operator hasn't touched the file since we last wrote it —
    // template drifted, clobber cleanly.
    writeFileSync(filePath, next, writeMode);
    writeFileSync(fingerprintPath, nextHash, "utf-8");
    created.push(filePath);
    return;
  }

  // Either no fingerprint (legacy state — file pre-dates this regime)
  // or fingerprint mismatch (operator edited). Back up + overwrite.
  const backupPath = `${filePath}.before-rerender.${Date.now()}`;
  try {
    writeFileSync(backupPath, prev, "utf-8");
  } catch (err) {
    // If we can't back up, BAIL — refuse to clobber unrecoverable
    // operator edits. Push to `skipped` so apply's summary lists
    // the file as untouched and the operator can investigate.
    process.stderr.write(
      `scaffold: refusing to overwrite ${filePath} — backup write failed ` +
      `(${(err as Error).message}). Operator edits preserved.\n`,
    );
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, next, writeMode);
  writeFileSync(fingerprintPath, nextHash, "utf-8");
  rewrittenWithBackup.push(filePath);
  // Also count this as "created" for apply's running total so the
  // post-apply summary reflects that the file was rewritten rather
  // than silently absent from both columns.
  created.push(filePath);
}

/**
 * Idempotently reconcile the agent's CONFIGURED supergroup/forum chat into an
 * existing `access.json`'s `groups`. Called on every reconcile (apply,
 * agent restart) AFTER the writeIfMissing above.
 *
 * Why: `access.json` is writeIfMissing — the gateway owns it at runtime
 * (pairing, operator policy edits). So a supergroup added to switchroom.yaml
 * after the agent was first scaffolded never lands in `groups`, and the
 * gateway drops every message from it as `group_unknown` (the marko case).
 * This closes that gap so the supergroup easy-path is zero-config.
 *
 * Strictly additive + non-destructive:
 *  - only ADDS the configured group if absent — never rewrites an existing
 *    group's policy (so an operator's `requireMention: true` / topic edits
 *    survive),
 *  - preserves `allowFrom`, pairings, other groups, and every other field,
 *  - no-op for dm_only agents and when no real forum chat is in scope.
 *
 * Smart default for a newly-registered group: `requireMention: false` — a
 * supergroup the agent OWNS is a dedicated working room, so it answers every
 * message (override to `true` for a shared channel).
 */
/**
 * Effective supergroup chat for an agent. The per-agent
 * `channels.telegram.chat_id` override (supergroup-owned topology) wins
 * over the fleet-wide `telegram.forum_chat_id` (fleet-shared topology).
 * Mirrors resolveAgentChannelTarget in
 * `src/agent-scheduler/channel-target.ts` — same precedence so the access
 * list, the cron router, and the gateway all agree on which chat the
 * agent owns. (`agentConfig` is already cascade-resolved by the caller.)
 */
function resolveAgentForumChatId(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
): string {
  const override = agentConfig.channels?.telegram?.chat_id;
  if (typeof override === "string" && override.length > 0) return override;
  return telegramConfig.forum_chat_id ?? "";
}

export function reconcileConfiguredGroup(
  accessPath: string,
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
): void {
  if (!existsSync(accessPath)) return; // fresh agent — buildAccessJson handled it
  const forumChatId = resolveAgentForumChatId(agentConfig, telegramConfig);
  const hasRealForumChat = forumChatId !== "" && forumChatId !== "0";
  if (agentConfig.dm_only || !hasRealForumChat) return;

  let access: Record<string, unknown>;
  try {
    access = JSON.parse(readFileSync(accessPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return; // malformed runtime file — leave it for the gateway/operator
  }
  const groups = (access.groups ??= {}) as Record<string, unknown>;
  if (groups[forumChatId] !== undefined) return; // already registered — preserve operator policy

  const allowFrom = Array.isArray(access.allowFrom) ? access.allowFrom : [];
  groups[forumChatId] = { requireMention: false, allowFrom };
  const tmp = accessPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(access, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, accessPath);
  console.log(
    chalk.green(
      `  registered supergroup ${forumChatId} in access.json ` +
      `(responds to all topics; requireMention=false)`,
    ),
  );
}

/**
 * `telegram/people.json` — a plain, config-derived projection of `users:`
 * entries that carry a `person_id` (docs/configuration.md). Deliberately a
 * SIBLING file to `access.json`, never merged into it: `access.json` is the
 * fail-CLOSED access-control allowlist (a different concern, gateway-owned
 * at runtime, written `writeIfMissing`); this file is fail-OPEN display
 * data only, purely derived from static config, so it's regenerated every
 * time `scaffoldAgent` runs (the `switchroom apply` reconcile path calls
 * `scaffoldAgent` idempotently for every configured agent) via
 * `writeFileSyncIfChanged` (not `writeIfMissing`) — there's no runtime
 * state here to preserve.
 *
 * All semantic validation (dedup, dropping malformed entries, the
 * fleet-alert on a dropped entry) happens gateway-side at boot
 * (`telegram-plugin/gateway/resolve-person.ts`), not here — this is a dumb
 * projection only.
 */
function buildPeopleJson(switchroomConfig: SwitchroomConfig | undefined): string {
  const entries = switchroomConfig ? resolvePersonEntries(switchroomConfig) : [];
  return JSON.stringify({ entries }, null, 2) + "\n";
}

function buildAccessJson(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
  resolvedTopicId?: number,
  userId?: string,
): string {
  // Issue #1001: defensive String() coercion so a numeric userId from a
  // legacy `~/.switchroom/user.json` (saveUserConfig is typed `string`
  // but TS can't enforce at runtime) doesn't land an unquoted JSON
  // number in allowFrom (which the gateway then rejects as "non-string
  // entries — treating as empty").
  const allowFrom = userId ? [String(userId)] : [];
  if (allowFrom.length === 0) {
    console.warn(
      "  WARNING: No user ID available for access.json allowFrom. " +
      "DM the bot /start and run `switchroom setup` again to pair your Telegram account."
    );
  }
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom,
  };
  // DM-only bots opt out of inheriting the global forum_chat_id into
  // the access list. Without this, the boot probe sweeps a chat the
  // bot isn't a member of and emits a noisy "boot-probe-failed: 400
  // chat not found" every restart (plus a misleading user-facing
  // notification). See the schema doc on `dm_only` for the design
  // rationale.
  //
  // Issue #1002: also skip when the resolved forum chat id is the
  // empty string or the v0.7 sentinel "0" — those are the values
  // `switchroom agent add --topology dm` emits when no real forum
  // chat is in scope, and the bug surfaced as a spurious 404 on every
  // fresh DM-topology agent.
  //
  // Supergroup-owned agents carry their chat at the per-agent
  // `channels.telegram.chat_id` override, which wins over the fleet
  // `forum_chat_id` — resolve the effective chat so a fresh
  // supergroup-owned agent registers the chat it actually owns, not the
  // shared fleet forum.
  const forumChatId = resolveAgentForumChatId(agentConfig, telegramConfig);
  const hasRealForumChat = forumChatId !== "" && forumChatId !== "0";
  if (!agentConfig.dm_only && hasRealForumChat) {
    access.groups = {
      [forumChatId]: {
        requireMention: false,
        allowFrom,
      },
    };
  }

  // #596: project resolved telegram-channel features (stickers, voice_in,
  // telegraph) into access.json so the gateway picks them up at runtime
  // without re-reading switchroom.yaml. The cascade in mergeAgentConfig
  // already folds the deprecated root-level fields into channels.telegram.*,
  // so reading from the new canonical location covers both old and new
  // switchroom.yaml shapes.
  const tg = agentConfig.channels?.telegram;
  if (tg?.stickers && Object.keys(tg.stickers).length > 0) {
    access.stickers = tg.stickers;
  }
  if (tg?.voice_in) {
    access.voice_in = tg.voice_in;
  }
  // PR-C2: project resolved voice_out (TTS) settings so the gateway can
  // synthesize spoken replies without re-reading switchroom.yaml. Rides
  // access.json like voice_in; the gateway gates the 'kokoro' engine on the
  // compose-injected SWITCHROOM_VOICE_ENGINE verdict at send-time.
  if (tg?.voice_out) {
    access.voice_out = tg.voice_out;
  }
  if (tg?.telegraph) {
    access.telegraph = tg.telegraph;
  }
  // Inbound coalescing window. Projected into the long-standing
  // `coalescingGapMs` access field the gateway already reads per-message
  // (createInboundCoalescer gapMs callback) so config-driven tuning takes
  // effect at the next message after a scaffold+restart. Cascades from
  // defaults.channels.telegram.coalesce.window_ms.
  if (typeof tg?.coalesce?.window_ms === "number") {
    access.coalescingGapMs = tg.coalesce.window_ms;
  }
  // Max attachments merged into one coalesced turn (A2). Default 1 keeps the
  // historical single-attachment behaviour; the gateway reads this per-message
  // to decide whether a second media item / album extends the current turn or
  // starts its own. Cascades from defaults.channels.telegram.coalesce.max_attachments.
  if (typeof tg?.coalesce?.max_attachments === "number") {
    access.coalesceMaxAttachments = tg.coalesce.max_attachments;
  }
  // Cooldown window for the litellm-local 429 notice (the debounced "fleet
  // token limiter engaged" message). Projected into the camelCase access
  // field the gateway reads per-event (parseLitellmNoticeWindowMs guards
  // invalid values with the 15-min default). Cascades from
  // defaults.channels.telegram.litellm_notice.window_ms.
  if (typeof tg?.litellm_notice?.window_ms === "number") {
    access.litellmNoticeWindowMs = tg.litellm_notice.window_ms;
  }
  // Deferred-interrupt safe-boundary (Problem B). Default-off: when unset the
  // gateway fires a `!` interrupt synchronously (historical behaviour). When
  // true, a `!` that lands mid-tool-call waits for the in-flight tool to
  // finish (bounded by interruptMaxWaitMs) before SIGINT + resume. The gateway
  // reads both per-message via loadAccess(). Cascades from
  // defaults.channels.telegram.interrupt.
  if (typeof tg?.interrupt?.safe_boundary === "boolean") {
    access.interruptSafeBoundary = tg.interrupt.safe_boundary;
  }
  if (typeof tg?.interrupt?.max_wait_ms === "number") {
    access.interruptMaxWaitMs = tg.interrupt.max_wait_ms;
  }
  // #789: project the button-choice-confirmation config so the gateway can
  // annotate a "✅ You chose: X" line on inline_keyboard taps without
  // re-reading switchroom.yaml. Same #596 plumbing pattern as above — the
  // gateway reads access.button_choice_confirmation per-tap via loadAccess().
  if (tg?.button_choice_confirmation) {
    access.button_choice_confirmation = tg.button_choice_confirmation;
  }

  return JSON.stringify(access, null, 2) + "\n";
}
