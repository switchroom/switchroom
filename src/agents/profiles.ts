import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, sep as pathSep } from "node:path";
import Handlebars from "handlebars";
import {
  PROFILES_ASSET,
  describeShippedAssetSearch,
  resolveShippedAsset,
  type ShippedAssetResolution,
} from "../util/shipped-assets.js";

/**
 * Resolve the root of the filesystem profiles directory (project-level).
 * Each subdirectory is a named profile containing `CLAUDE.md.hbs`,
 * optional `SOUL.md.hbs`, and an optional `skills/` subdir. The
 * `_base/` sibling holds framework-level render templates
 * (start.sh.hbs, settings.json.hbs) that every agent uses regardless
 * of their `extends:` choice.
 *
 * The bundle ships in three layouts and the profiles dir sits in a
 * DIFFERENT place in each. The candidate probe lives in
 * `src/util/shipped-assets.ts` so `profiles/`, `skills/` and
 * `vendor/hindsight-memory/` cannot drift apart again (#3346, #3492,
 * #4160). `SWITCHROOM_PROFILES_ROOT` still wins outright.
 *
 * If nothing exists we return the npm-layout path so the historical
 * error shape survives — but the error now also names EVERY candidate
 * (`PROFILES_ROOT_SEARCH`). "searched /profiles" named a path no
 * install has ever used, which is why #4160 read as a mystery.
 */
export function resolveProfilesRootDetailed(): ShippedAssetResolution {
  return resolveShippedAsset(PROFILES_ASSET, {
    bundleDir: import.meta.dirname,
    execPath: process.execPath,
  });
}

export function resolveProfilesRoot(): string {
  const resolution = resolveProfilesRootDetailed();
  return resolution.path ?? resolution.candidates[0];
}

const PROFILES_RESOLUTION = resolveProfilesRootDetailed();
export const PROFILES_ROOT =
  PROFILES_RESOLUTION.path ?? PROFILES_RESOLUTION.candidates[0];
/** Every path probed while resolving PROFILES_ROOT — for error messages. */
export const PROFILES_ROOT_SEARCH: readonly string[] =
  PROFILES_RESOLUTION.candidates;

/**
 * Resolve the filesystem path for a named profile. Falls back to
 * `default` if the requested profile directory doesn't exist. Rejects
 * names that would escape PROFILES_ROOT via `..`, absolute paths, or
 * symlinks pointing outside the root.
 */
export function getProfilePath(profileName: string): string {
  const requested = resolve(PROFILES_ROOT, profileName);

  // Lexical boundary check — `resolve()` normalizes `..` segments so a
  // traversal like `"../etc"` ends up as a string that does NOT start
  // with PROFILES_ROOT + sep. Use `path.sep` (not a hardcoded "/") so
  // the comparison is correct on Windows too.
  if (requested !== PROFILES_ROOT && !requested.startsWith(PROFILES_ROOT + pathSep)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  // Symlink boundary check — same pattern as `memory-search.ts:274` and
  // `web/server.ts:302`. `path.resolve()` does NOT follow symlinks, so a
  // profile dir under PROFILES_ROOT that's actually a symlink to /etc
  // would pass the lexical check above and let `existsSync` /
  // `readFileSync` operate on the symlink target. Re-check after
  // realpath to close the gap. The `try { realpathSync } catch` is for
  // ENOENT — non-existent paths fall through to the existsSync branch
  // below where `hasProfileFiles` returns false and we use the fallback.
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    real = requested;
  }
  if (real !== PROFILES_ROOT && !real.startsWith(PROFILES_ROOT + pathSep)) {
    throw new Error(`Invalid profile name: ${profileName}`);
  }

  if (existsSync(requested) && hasProfileFiles(requested)) {
    return requested;
  }
  const fallback = resolve(PROFILES_ROOT, "default");
  if (existsSync(fallback)) {
    return fallback;
  }
  // Name EVERY path that was probed. When PROFILES_ROOT itself is the
  // "nothing existed" fall-through (the SEA case, #4160), reporting only
  // it tells the operator switchroom looked somewhere it never could
  // have found anything.
  const searched =
    PROFILES_RESOLUTION.path === null
      ? describeShippedAssetSearch(PROFILES_RESOLUTION)
      : PROFILES_ROOT;
  throw new Error(`Profile not found: ${profileName} (searched ${searched})`);
}

function hasProfileFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".hbs") || f === "skills");
  } catch {
    return false;
  }
}

/**
 * List the filesystem profiles under PROFILES_ROOT that a user can
 * pass to `switchroom agent create --profile <name>`. Skips the
 * framework-internal `_base/` profile (underscore-prefixed by
 * convention — users aren't meant to pick it) and any entry that
 * doesn't look like a real profile directory.
 */
export function listAvailableProfiles(): string[] {
  try {
    return readdirSync(PROFILES_ROOT)
      .filter((name) => !name.startsWith("_"))
      .filter((name) => {
        const p = resolve(PROFILES_ROOT, name);
        try {
          return statSync(p).isDirectory() && hasProfileFiles(p);
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * Path to the `_base/` profile directory. Contains framework-level
 * render templates (start.sh.hbs, settings.json.hbs) that every
 * agent uses regardless of their `extends:` choice. Hardcoded name,
 * not user input, so no traversal check needed.
 */
export function getBaseProfilePath(): string {
  return resolve(PROFILES_ROOT, "_base");
}

/**
 * Read a .hbs file and render it with the given context.
 *
 * noEscape: our templates are markdown (*.md.hbs), shell (start.sh.hbs),
 * and JSON (settings.json.hbs). None are HTML. Handlebars' default HTML
 * escaping turns apostrophes into `&#x27;` and quotes into `&quot;`,
 * which is wrong everywhere it fires: markdown gets literal entity refs
 * in prompts the model sees (`Ken&#x27;s` instead of `Ken's`), and JSON
 * output breaks JSON-literal expectations. Disable escaping globally;
 * author templates defensively (no raw user HTML in contexts).
 */
export function renderTemplate(
  templatePath: string,
  context: Record<string, unknown>,
): string {
  const source = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context);
}

/**
 * Recursively copy files from a profile's `skills/` directory into
 * the destination. Skips files that already exist at the destination
 * (idempotent). Used for bundled profile skills; user-selected global
 * skills come through a separate symlink path in scaffold.ts.
 */
export function copyProfileSkills(profilePath: string, destPath: string): void {
  const skillsSrc = join(profilePath, "skills");
  if (!existsSync(skillsSrc)) {
    return;
  }
  copyDirRecursive(skillsSrc, destPath);
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      // Idempotent: don't overwrite existing files
      if (!existsSync(destPath)) {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Register a "json" helper for Handlebars to emit raw JSON
Handlebars.registerHelper("json", (value: unknown) => {
  return new Handlebars.SafeString(JSON.stringify(value, null, 2));
});

// Register an "isNumber" helper. Plain `{{#if value}}` treats 0 as
// falsy, but several config knobs (like memory.recall.max_memories)
// use 0 as a meaningful "disable cap" sentinel — rendering must
// distinguish "operator set 0" from "operator left it unset". This
// helper returns true for any finite number, including 0.
Handlebars.registerHelper("isNumber", (value: unknown) => {
  return typeof value === "number" && Number.isFinite(value);
});

// Register shared profile fragments as Handlebars partials so any profile
// template can use {{> fragment-name}} instead of copy-pasting the content.
// The _shared/ directory is underscore-prefixed (like _base/) and is not
// listed by listAvailableProfiles() — it's framework-internal.
const SHARED_FRAGMENTS_DIR = resolve(PROFILES_ROOT, "_shared");
const SHARED_FRAGMENTS = ["vault-protocol", "agent-self-service", "execution-discipline", "reply-discipline", "dev-protocol", "local-time"] as const;
for (const name of SHARED_FRAGMENTS) {
  const fragPath = join(SHARED_FRAGMENTS_DIR, `${name}.md.hbs`);
  if (existsSync(fragPath)) {
    Handlebars.registerPartial(name, readFileSync(fragPath, "utf-8"));
  }
}

/**
 * Render the vault-protocol fragment standalone for unconditional
 * append to every agent's CLAUDE.md. vault-protocol is load-bearing
 * safety guidance — every agent gets it, regardless of whether their
 * profile template remembered to include a partial.
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderVaultProtocolFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "vault-protocol.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render the agent-self-service fragment standalone for unconditional
 * append to every agent's CLAUDE.md. Same pattern as
 * {@link renderVaultProtocolFragment} — the `agent-config` MCP server
 * exposes cron/skill self-service tools to every agent, so every agent
 * needs the prompt grounding that names those tools and the safety
 * rails. Without this, the model has the tools available in `tools/list`
 * but no awareness of WHEN to reach for them, and the natural-language
 * path ("remind me to call mom at 5pm") falls back to free-styling
 * a regular reply instead.
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderAgentSelfServiceFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "agent-self-service.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render the execution-discipline fragment standalone for unconditional
 * append to every agent's CLAUDE.md. Same pattern as
 * {@link renderVaultProtocolFragment} — the grounding / verify-before-
 * assert posture is fleet-wide work-quality guidance (serves the
 * "feel-like-a-colleague" job: "verifies before claiming"). It must
 * reach EVERY agent on EVERY profile, not just the default profile's
 * CLAUDE.md — so it rides the unconditional-append carrier rather than
 * living in a single profile template that the coding /
 * executive-assistant / health-coach profiles never inherit.
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderExecutionDisciplineFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "execution-discipline.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render the dev-protocol fragment standalone for unconditional append
 * to every agent's CLAUDE.md. Same unconditional-carrier pattern as
 * {@link renderExecutionDisciplineFragment} — Ken's fleet-wide
 * development protocol (approved 2026-07-11): orient/ground, clarify
 * vs proceed, design-align on larger tasks, the branch→test→review→CI
 * pipeline, and communication rules (consolidated messages, no long
 * foreground watches, sub-agent cap). It must reach EVERY agent on
 * EVERY profile, so it rides the append carrier rather than living in
 * a single profile template. The long-form playbook lives in the
 * bundled `dev-protocol` skill (loaded on demand); this fragment is
 * the always-loaded summary that points at it.
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderDevProtocolFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "dev-protocol.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render the local-time fragment standalone for unconditional append to
 * every agent's CLAUDE.md. Same unconditional-carrier pattern as
 * {@link renderDevProtocolFragment}.
 *
 * Why this is a PROMPT rule and not only a platform fix: the container
 * `/etc/localtime` defect (Dockerfile.agent de-symlink) stopped the OS
 * lying about what UTC is, but nothing stops an agent — or a skill it
 * writes — from correctly reading a UTC stamp and then showing that UTC
 * stamp to a human, or from hardcoding `+10:00` / `"AEST"` into a
 * formatter that then breaks at the DST boundary. Those are prompt-level
 * failures no amount of tzdata correctness prevents.
 *
 * Deliberately zone-AGNOSTIC: it names the `SWITCHROOM_TIMEZONE` → `TZ` →
 * UTC cascade (the same one `bin/timezone-hook.sh`,
 * `src/config/timezone.ts` and
 * `vendor/hindsight-memory/scripts/lib/content.py:_resolve_agent_timezone`
 * use) rather than baking a resolved zone in. That keeps it correct on
 * every install, and — unlike a rendered zone — needs no new key threaded
 * through BOTH the `buildWorkspaceContext` scaffold context and the
 * hand-curated reconcile `claudeContext`, which must mirror each other
 * byte-for-byte or the reconcile diff-abort trips.
 *
 * Not a duplicate of the existing guidance:
 * `buildSubAgentLocalTimeLine` (src/agents/sub-agent-telegram-prompt.ts)
 * reaches Task-tool sub-agents only and says "the wall clock is already
 * local, treat it as now"; `bin/timezone-hook.sh` injects the current
 * local time per turn. Neither states a rule about how a timestamp must
 * be FORMATTED before a human sees it, which is the gap this closes.
 *
 * Kept to a heading plus two bullets on purpose — this is prompt budget
 * every agent pays on every turn, and the worst-case CLAUDE.md byte
 * ratchet (tests/scaffold.persona.test.ts,
 * scripts/claude-md-byte-ratchet.txt) had ~18 chars of headroom before
 * this fragment existed. Its 432 chars are funded by deleting duplicated
 * rules from profiles/default/CLAUDE.md.hbs in the same change, NOT by
 * raising the ceiling — which that test forbids. A profiles.test.ts
 * ratchet pins the fragment at < 500 chars so it cannot creep back.
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderLocalTimeFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "local-time.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render the delegation golden-rule fragment standalone for unconditional
 * append to every agent's CLAUDE.md. Same unconditional-carrier pattern as
 * {@link renderDevProtocolFragment}, but this one is deliberately appended
 * LAST — after execution-discipline and dev-protocol — so the "prefer
 * delegating execution to a sub-agent" signal regains tail-of-prompt
 * recency.
 *
 * Root cause it closes (regression #3231): the strong delegation guidance
 * ("Golden rule: when in doubt, delegate") lived mid-file in the profile
 * body, while the execution-discipline ("Act in-turn — do it this turn")
 * and dev-protocol ("read the code, run the tests, keep moving") fragments
 * were appended at the tail. In a long prompt the tail-end inline-execution
 * voice won on recency and overrode the mid-file delegation rule, so agents
 * started doing execution inline instead of dispatching a worker.
 *
 * The first fix was ordering: re-state the golden rule in this tail
 * fragment and cross-reference it from the two competing fragments. That
 * left the SAME rule stated three times ("## Sub-Agent Delegation" in the
 * profile body, "## Execution Bias", "## Delegation — the last word") with
 * conflicting absolutes, which is the failure mode Anthropic's Claude 5
 * context-engineering guidance calls out directly — overlapping and
 * conflicting instructions make the model deliberate more, not behave
 * better.
 *
 * This fragment is now the SINGLE source: the profile-body sections and the
 * "Execution Bias" section were deleted, their non-duplicated content folded
 * in here (including the steer-or-queue rule, which previously only reached
 * the default and coding profiles). Single-sourcing is strictly stronger
 * than ordering — there is no competing statement left to lose to — and tail
 * position is retained on top of it. Both properties are pinned in
 * `src/agents/profiles.test.ts` ("delegation single-sourcing + recency").
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderDelegationGoldenRuleFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "delegation-golden-rule.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render the reply-discipline fragment standalone for unconditional
 * PREPEND (near the top) of every agent's CLAUDE.md. Same
 * unconditional-carrier pattern as {@link renderVaultProtocolFragment}
 * and {@link renderExecutionDisciplineFragment}, but this one rides at
 * the TOP rather than the tail: the "your plain text is invisible —
 * only the `reply` tool reaches Telegram" contract is turn-critical, so
 * it must be one of the first things the model reads, and it must reach
 * EVERY agent on EVERY profile (default / coding / health-coach /
 * executive-assistant), not just the default profile's CLAUDE.md.
 *
 * Root cause it closes: this contract previously lived ONLY in the
 * telegram MCP runtime instruction blob, which the model deprioritizes —
 * agents ended turns writing the finished answer as plain assistant text
 * that never reached Telegram, so the owed-reply safety net force-flushed
 * it 2-4 min late, burning extra turns. Baking it into the base CLAUDE.md
 * template makes the discipline durable + fleet-wide.
 *
 * Returns the rendered Markdown, or an empty string if the fragment
 * file is missing (e.g. partial install).
 */
export function renderReplyDisciplineFragment(
  context: Record<string, unknown> = {},
  /** Override the profiles root; used by tests. */
  profilesRoot: string = PROFILES_ROOT,
): string {
  const fragPath = join(resolve(profilesRoot, "_shared"), "reply-discipline.md.hbs");
  if (!existsSync(fragPath)) return "";
  const source = readFileSync(fragPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context).trimEnd();
}

/**
 * Render `profiles/<profileName>/CLAUDE.md.hbs` into
 * `profiles/<profileName>/CLAUDE.md` using the profile-level context
 * (no agent-specific values — those belong in the per-agent layer).
 *
 * Returns `{ wrote: true, path }` when the template was found and the
 * output file was written, or `{ wrote: false, path }` when the .hbs
 * source doesn't exist (caller can skip gracefully) OR the target dir
 * is read-only (e.g. switchroom installed under
 * `/usr/local/lib/node_modules/switchroom/profiles/` and run as a
 * non-root user). In the read-only case, the rendered output isn't
 * consumed by anything downstream — the per-agent scaffold renders
 * its own CLAUDE.md from the same .hbs source at `scaffold.ts:2127`
 * — so a graceful skip with a warning is correct here.
 */
export function renderProfileClaudeTemplate(
  profileName: string,
  /** Override the profiles root; used by tests to avoid touching real profiles. */
  profilesRoot: string = PROFILES_ROOT,
): { wrote: boolean; path: string } {
  const profileDir = resolve(profilesRoot, profileName);
  const hbsPath = join(profileDir, "CLAUDE.md.hbs");
  const outPath = join(profileDir, "CLAUDE.md");

  if (!existsSync(hbsPath)) {
    return { wrote: false, path: outPath };
  }

  const source = readFileSync(hbsPath, "utf-8");
  const template = Handlebars.compile(source, { noEscape: true });
  const rendered = template({ profile: profileName });
  try {
    writeFileSync(outPath, rendered, "utf-8");
    return { wrote: true, path: outPath };
  } catch (err) {
    // EACCES / EROFS: switchroom is installed under a root-owned dir
    // and we're running as a non-root operator. The per-agent scaffold
    // path re-renders the same .hbs into the agent dir anyway, so this
    // bookkeeping write is non-load-bearing — warn once and continue.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
      console.warn(
        `Note: profile CLAUDE.md at ${outPath} is not writable (${code}); ` +
          `skipping bookkeeping render. Agent scaffolds re-render the .hbs ` +
          `into their own dir, so this is non-fatal.`,
      );
      return { wrote: false, path: outPath };
    }
    throw err;
  }
}
