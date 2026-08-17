/**
 * rules-store — Memory v2 M1 IO orchestration (carve-M1.md §1/§3).
 *
 * Reads/writes an agent's `CLAUDE.md` THROUGH the below-marker "Yours"
 * seam (`CLAUDE_MD_YOURS_MARKER`, `src/agents/generation-stamp.ts`) so
 * writes here re-derive the exact bytes `composeTwoSectionClaudeMd`
 * would produce — reconcile/apply stay no-ops on a rules-block agent.
 * Appends a hash-chained mutation-log row per write (reusing
 * `src/util/audit-hashchain.ts` wholesale — M1 invents no crypto) and
 * maintains `memory/rules-archive.md` (retired rules; NEVER loaded by
 * any hook or context-assembly path — see the module doc below).
 *
 * Location (OQ2, carve open question — adopted the carve's own
 * recommendation): `<agentDir>/memory/rules-mutation.log` +
 * `<agentDir>/memory/rules-archive.md`. `$CLAUDE_PLUGIN_DATA/state/` is
 * hook-native but not reliably set in CLI-tool context, where this
 * module actually runs; `<agentDir>/memory/` is reachable identically
 * by the CLI tool, the SessionStart hook (`$CLAUDE_PROJECT_DIR`), and
 * doctor, and is agent-owned by construction (no root-write EACCES
 * hazard — see `bin/rules-sentinel-hook.sh`'s header for the sibling
 * half of that discipline).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../util/atomic.js";
import { seedChain, chainRow, verifyAuditChain, CHAIN_GENESIS } from "../util/audit-hashchain.js";
import {
  RULES_BLOCK_BEGIN,
  RULES_BLOCK_END,
  INDEX_BLOCK_BEGIN,
  INDEX_BLOCK_END,
  RULES_BLOCK_BUDGET_BYTES,
  renderRulesBlock,
  parseRulesBlock,
  renderIndexBlock,
  parseIndexBlock,
  upsertMarkerBlock,
  renderedByteLen,
  checkContradiction,
  computeSentinel,
  type Rule,
  type RuleMutationEntry,
} from "./rules-block.js";

/**
 * The exact marker line generation-stamp.ts exports — duplicated here
 * (not imported) deliberately: this module must not create a runtime
 * dependency edge from `src/memory/*` back into `src/agents/scaffold.ts`
 * (which pulls in the entire scaffold-template machinery). The string
 * is pinned by `tests/scaffold.memory-cascade.test.ts`-adjacent
 * coverage on the scaffold side; a divergence would be caught by the
 * reconcile byte-identical fixture test (T5/B's scaffold suite).
 */
const CLAUDE_MD_YOURS_MARKER = "# --- Yours (preserved across apply) ---";

export class BudgetExceededError extends Error {
  constructor(bytes: number) {
    super(
      `Rules+index blocks would be ${bytes} bytes, exceeding the ` +
        `${RULES_BLOCK_BUDGET_BYTES}-byte budget. Retire a rule first, or ` +
        `shorten the new rule text.`,
    );
    this.name = "BudgetExceededError";
  }
}

export class NoYoursMarkerError extends Error {
  constructor(claudeMdPath: string) {
    super(
      `${claudeMdPath} has no "${CLAUDE_MD_YOURS_MARKER}" marker — the ` +
        `agent has not been scaffolded with a two-section CLAUDE.md yet.`,
    );
    this.name = "NoYoursMarkerError";
  }
}

export class MarkerBlockOverlapError extends Error {
  constructor() {
    super(
      "Refusing to edit: the target span overlaps a switchroom:rules/" +
        "switchroom:index marker block. Use `memory rule add/retire` for " +
        "rules; direct edits are reserved for the free-text Yours content.",
    );
    this.name = "MarkerBlockOverlapError";
  }
}

/** The target agent's `memory.rules_block` flag is not `true`, so no write
 *  (add/retire/supersede/edit-yours) is permitted — the rules-block toolchain
 *  is dark for this agent. Read verbs (list/verify) stay open. Refused before
 *  any IO, so nothing is written. */
export class RulesBlockDisabledError extends Error {
  constructor(agent: string) {
    super(
      `memory.rules_block is off for agent "${agent}" — the rules-block ` +
        `toolchain is dark; no rule/edit-yours write is permitted until the ` +
        `flag is flipped (M3 rollout). Read verbs (list/verify) stay open.`,
    );
    this.name = "RulesBlockDisabledError";
  }
}

/** A rule's `text` or `source` contains characters that would break the
 *  single-line rules-block render/parse round-trip (a marker comment, or a
 *  source char that trips `ruleLineRe`). Refused at ingestion — the file is
 *  never touched. */
export class InvalidRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRuleError";
  }
}

/**
 * A rule's `source` must survive `renderRuleLine`/`ruleLineRe`'s
 * `(source: <src>, added ...)` framing. `,` and the delimiters `(` `)` `*`
 * (and any newline) either truncate or drop the whole rule line at parse —
 * yielding a false "tamper" on the next verify. Reject them at ingestion.
 */
const SAFE_SOURCE_RE = /^[^,()*\n\r]+$/;

/** Reject any switchroom marker substring in caller-supplied rule content
 *  (mirrors editYoursContent's guard): a rule that embeds the end-marker
 *  would truncate `parseRulesBlock` and hide every rule after it. */
function assertNoMarkers(s: string, what: string): void {
  if (
    s.includes(RULES_BLOCK_BEGIN) ||
    s.includes(RULES_BLOCK_END) ||
    s.includes(INDEX_BLOCK_BEGIN) ||
    s.includes(INDEX_BLOCK_END)
  ) {
    throw new InvalidRuleError(
      `Rule ${what} must not contain a switchroom marker comment.`,
    );
  }
}

/** Flatten whitespace to a single space and trim — the SAME normalization
 *  `renderRuleLine` applies, done ONCE at ingestion so the stored text is
 *  byte-identical to what renders and parses back (no false tamper on a
 *  rule added with a newline or double space). */
function flattenWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function memoryDir(agentDir: string): string {
  return join(agentDir, "memory");
}
function mutationLogPath(agentDir: string): string {
  return join(memoryDir(agentDir), "rules-mutation.log");
}
function archivePath(agentDir: string): string {
  return join(memoryDir(agentDir), "rules-archive.md");
}
function claudeMdPath(agentDir: string): string {
  return join(agentDir, "CLAUDE.md");
}

function readClaudeMd(agentDir: string): string {
  const p = claudeMdPath(agentDir);
  if (!existsSync(p)) throw new NoYoursMarkerError(p);
  return readFileSync(p, "utf-8");
}

/** Mirrors `resolveClaudeMdYoursSection`'s case-(a) normalization
 *  exactly (marker present): drop the blank line(s) right after the
 *  marker, trim trailing whitespace. See scaffold.ts:1923. */
function extractYours(fullText: string): { managed: string; yours: string } {
  const idx = fullText.indexOf(CLAUDE_MD_YOURS_MARKER);
  if (idx === -1) throw new NoYoursMarkerError("<CLAUDE.md>");
  const managed = fullText.slice(0, idx).trimEnd();
  const yours = fullText
    .slice(idx + CLAUDE_MD_YOURS_MARKER.length)
    .replace(/^[\r\n]+/, "")
    .trimEnd();
  return { managed, yours };
}

/** Recompose full file bytes exactly as `composeTwoSectionClaudeMd`
 *  would, given a managed slice + a resolved Yours body. */
function recompose(managed: string, yours: string): string {
  return `${managed}\n\n${CLAUDE_MD_YOURS_MARKER}\n\n${yours.trimEnd()}\n`;
}

function nextRuleId(existing: Rule[]): string {
  let max = 0;
  for (const r of existing) {
    const m = /^R-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `R-${String(max + 1).padStart(2, "0")}`;
}

function ensureMemoryDir(agentDir: string): void {
  const dir = memoryDir(agentDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function appendMutationRow(agentDir: string, entry: RuleMutationEntry): void {
  ensureMemoryDir(agentDir);
  const logPath = mutationLogPath(agentDir);
  const state = seedChain(logPath);
  const { line } = chainRow(state, entry as unknown as Record<string, unknown>);
  const before = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  atomicWriteFileSync(logPath, before + line, 0o600);
}

/** The `blockHash` recorded by the mutation log's LAST row (the head of the
 *  hash chain), or `undefined` if the log is empty/unparseable. The chain
 *  itself is verified separately by `verifyAuditChain` before this is trusted. */
function lastLoggedBlockHash(logText: string): string | undefined {
  const rows = logText.split("\n").filter((l) => l.length > 0);
  const lastRow = rows[rows.length - 1];
  if (!lastRow) return undefined;
  try {
    const parsed = JSON.parse(lastRow) as { blockHash?: string };
    return parsed.blockHash;
  } catch {
    return undefined;
  }
}

export interface VerifyIntegrityResult {
  ok: boolean;
  /** Present when the mutation log itself is internally broken. */
  chainBrokenAtLine?: number;
  chainReason?: string;
  /** Present when the on-disk block's sentinel doesn't match the
   *  mutation log's head blockHash (block edited out-of-band). */
  blockVsLogMismatch?: boolean;
  detail: string;
}

/**
 * Recompute the on-disk rules block's sentinel and compare it against
 * (a) the sentinel line embedded in the block and (b) the mutation
 * log's head `blockHash`. Two independent tamper detectors — see
 * module doc + carve-M1.md §3 "Hash chain."
 */
export function verifyIntegrity(agentDir: string): VerifyIntegrityResult {
  const logPath = mutationLogPath(agentDir);
  const logText = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  const chainResult = verifyAuditChain(logText, CHAIN_GENESIS);
  if (!chainResult.ok) {
    return {
      ok: false,
      chainBrokenAtLine: chainResult.brokenAtLine,
      chainReason: chainResult.reason,
      detail:
        `Mutation log tampered: break at line ${chainResult.brokenAtLine} ` +
        `(${chainResult.reason}).`,
    };
  }

  // The mutation log's last recorded blockHash — the ground truth for what
  // the block SHOULD hash to. Used both to cross-check a present block and
  // to detect a whole-block deletion (markers gone, but the log says the
  // last sanctioned state was a non-empty rule set).
  const loggedHead = lastLoggedBlockHash(logText);
  const emptyHash = computeSentinel([]).hash;
  const blockDeletedFail = (context: string): VerifyIntegrityResult => ({
    ok: false,
    blockVsLogMismatch: true,
    detail:
      `${context} but the mutation log's last recorded hash ` +
      `(sha256=${loggedHead}) records a non-empty rule set. The block was ` +
      `deleted without a corresponding logged mutation.`,
  });

  let fullText: string;
  try {
    fullText = readClaudeMd(agentDir);
  } catch {
    // No CLAUDE.md at all. Genuinely dark only if the log never recorded a
    // non-empty block; otherwise the whole file (block included) was removed.
    if (loggedHead && loggedHead !== emptyHash) {
      return blockDeletedFail("No CLAUDE.md present,");
    }
    return { ok: true, detail: "No CLAUDE.md present — nothing to verify (dark)." };
  }
  const parsed = parseRulesBlock(fullText);
  if (!parsed) {
    // Markers absent. Dark only if the log agrees the last state was empty;
    // a logged non-empty head means the block was sed-deleted out of band.
    if (loggedHead && loggedHead !== emptyHash) {
      return blockDeletedFail("No rules block present,");
    }
    return { ok: true, detail: "No rules block present — nothing to verify (dark)." };
  }
  const recomputed = computeSentinel(parsed.rules);
  const embedded = parsed.sentinel;
  if (!embedded || embedded.hash !== recomputed.hash || embedded.count !== recomputed.count) {
    return {
      ok: false,
      detail:
        `Rules block sentinel mismatch: embedded ` +
        `sha256=${embedded?.hash ?? "(missing)"} rules=${embedded?.count ?? "?"}, ` +
        `recomputed sha256=${recomputed.hash} rules=${recomputed.count}. ` +
        `The block was edited outside the memory rule tool.`,
    };
  }

  // Log-head vs block cross-check: the last row's blockHash must match the
  // recomputed on-disk block hash.
  if (loggedHead && loggedHead !== recomputed.hash) {
    return {
      ok: false,
      blockVsLogMismatch: true,
      detail:
        `Rules block hash (sha256=${recomputed.hash}) does not match the ` +
        `mutation log's last recorded hash (sha256=${loggedHead}). ` +
        `The block was edited outside the memory rule tool without a ` +
        `corresponding logged mutation.`,
    };
  }

  return { ok: true, detail: "Rules block sentinel and mutation log agree." };
}

function currentIndexModels(fullText: string): string[] {
  return parseIndexBlock(fullText)?.models ?? [];
}

/**
 * Deliberately NOT `Omit<RuleMutationEntry, "blockHash">`: RuleMutationEntry
 * carries a `[key: string]: unknown` index signature, and `Omit` on an
 * indexed type collapses via `Pick<T, Exclude<keyof T, K>>` — `keyof T`
 * for an indexed type is `string`, so the named fields' specific types
 * are lost and every call site widens to `{[x: string]: unknown}`. A
 * standalone interface avoids the pitfall entirely.
 */
interface MutationEntryInput {
  id: string;
  action: RuleMutationEntry["action"];
  actor: string;
  source: string;
  ts: string;
}

function writeBlocksAndLog(
  agentDir: string,
  rules: Rule[],
  entry: MutationEntryInput,
): void {
  const full = readClaudeMd(agentDir);
  const { managed, yours } = extractYours(full);

  const rulesBlock = renderRulesBlock(rules);
  const indexBlock = renderIndexBlock(currentIndexModels(yours));
  const bytes = renderedByteLen(rulesBlock, indexBlock);
  if (bytes > RULES_BLOCK_BUDGET_BYTES) {
    throw new BudgetExceededError(bytes);
  }

  let newYours = upsertMarkerBlock(yours, RULES_BLOCK_BEGIN, RULES_BLOCK_END, rulesBlock);
  // Ensure the index block also exists (dark: empty until M1's regen
  // primitive or M5+ seeds it) so both blocks are always adjacent and
  // parseable — but never invent model content here.
  if (parseIndexBlock(newYours) === null) {
    newYours = upsertMarkerBlock(newYours, INDEX_BLOCK_BEGIN, INDEX_BLOCK_END, indexBlock);
  }

  const composed = recompose(managed, newYours);
  atomicWriteFileSync(claudeMdPath(agentDir), composed, 0o644);

  const sentinel = computeSentinel(rules);
  appendMutationRow(agentDir, { ...entry, blockHash: sentinel.hash });
}

export interface CreateRuleResult {
  rule: Rule;
  /** Set when the new rule text exactly duplicates an existing active
   *  rule's normalized text — a soft signal the CALLER should surface
   *  as a prompt, never an auto-block (OQ1 scoping). */
  possibleDuplicateOf?: string;
}

export interface CreateRuleOptions {
  text: string;
  source: string;
  actor: string;
  /** Explicit supersede — retires the named rule id as part of THIS
   *  mutation (one create + one retire, two log rows, one file write). */
  supersedes?: string;
  now?: () => string;
}

/** Create a new standing rule (UAT-1). Refuses to write anything on
 *  budget overflow (T4: file byte-identical, no log row). */
export function createRule(agentDir: string, opts: CreateRuleOptions): CreateRuleResult {
  const now = opts.now ?? (() => new Date().toISOString());

  // Normalize + validate ONCE at ingestion (before any IO), so stored ==
  // rendered == parsed and no illegal char can survive to a false tamper.
  assertNoMarkers(opts.text, "text");
  assertNoMarkers(opts.source, "source");
  const text = flattenWhitespace(opts.text);
  const source = flattenWhitespace(opts.source);
  if (text.length === 0) {
    throw new InvalidRuleError("Rule text must not be empty.");
  }
  if (!SAFE_SOURCE_RE.test(source)) {
    throw new InvalidRuleError(
      "Rule source contains characters that would break the rules block " +
        "format — avoid a comma, parentheses, and `*`.",
    );
  }

  const full = readClaudeMd(agentDir);
  const { yours } = extractYours(full);
  const existing = parseRulesBlock(yours)?.rules ?? [];

  const contradiction = checkContradiction(text, existing);

  let active = existing;
  if (opts.supersedes) {
    active = active.filter((r) => r.id !== opts.supersedes);
  }

  const rule: Rule = {
    id: nextRuleId(active),
    text,
    source,
    created_at: now(),
  };
  const nextRules = [...active, rule];

  // Budget + file write FIRST — writeBlocksAndLog throws BudgetExceededError
  // before touching disk. Archiving the superseded rule only AFTER that
  // succeeds (MEDIUM fix): an over-budget `--supersedes` add must not leave a
  // "retired" archive entry orphaned while the rule stays active with no log
  // row. On the happy path this is one logical mutation, one file write.
  writeBlocksAndLog(agentDir, nextRules, {
    id: rule.id,
    action: "create",
    actor: opts.actor,
    source,
    ts: rule.created_at,
  });

  if (opts.supersedes) {
    // Archive the superseded rule as part of the same logical mutation.
    const superseded = existing.find((r) => r.id === opts.supersedes);
    if (superseded) appendArchiveEntry(agentDir, superseded, now(), rule.id);
  }

  return { rule, possibleDuplicateOf: contradiction.duplicateOf };
}

export interface RetireRuleOptions {
  actor: string;
  supersededBy?: string;
  now?: () => string;
}

/** Retire a rule: removed from the block, appended to the never-loaded
 *  archive with `status: retired` (UAT-2). Throws if the id is unknown. */
export function retireRule(
  agentDir: string,
  ruleId: string,
  opts: RetireRuleOptions,
): void {
  const now = opts.now ?? (() => new Date().toISOString());
  const full = readClaudeMd(agentDir);
  const { yours } = extractYours(full);
  const existing = parseRulesBlock(yours)?.rules ?? [];
  const target = existing.find((r) => r.id === ruleId);
  if (!target) {
    throw new Error(`No active rule with id "${ruleId}".`);
  }
  const remaining = existing.filter((r) => r.id !== ruleId);

  appendArchiveEntry(agentDir, target, now(), opts.supersededBy);

  writeBlocksAndLog(agentDir, remaining, {
    id: ruleId,
    action: "retire",
    actor: opts.actor,
    source: target.source,
    ts: now(),
  });
}

function appendArchiveEntry(
  agentDir: string,
  rule: Rule,
  retiredAt: string,
  supersededBy?: string,
): void {
  ensureMemoryDir(agentDir);
  const path = archivePath(agentDir);
  const before = existsSync(path)
    ? readFileSync(path, "utf-8")
    : "# Rules archive (never loaded — retired rules only, for audit)\n\n";
  const supersedeLine = supersededBy ? ` superseded-by: ${supersededBy}` : "";
  const entry =
    `## ${rule.id} (status: retired${supersedeLine})\n` +
    `- text: ${rule.text}\n` +
    `- source: ${rule.source}\n` +
    `- created_at: ${rule.created_at}\n` +
    `- retired_at: ${retiredAt}\n\n`;
  atomicWriteFileSync(path, before + entry, 0o600);
}

export interface EditYoursOptions {
  actor: string;
  now?: () => string;
}

/**
 * Write free-text content into the Yours section OUTSIDE any marker
 * block (UAT-3's "invited free-text editing" verb — the sanctioned
 * writer once the M3 deny is live, so the deny never orphans this
 * path). Refuses — throwing, file byte-identical — if the requested
 * span overlaps a `switchroom:rules`/`switchroom:index` marker block.
 */
export function editYoursContent(
  agentDir: string,
  newFreeText: string,
  opts: EditYoursOptions,
): void {
  if (
    newFreeText.includes(RULES_BLOCK_BEGIN) ||
    newFreeText.includes(RULES_BLOCK_END) ||
    newFreeText.includes(INDEX_BLOCK_BEGIN) ||
    newFreeText.includes(INDEX_BLOCK_END)
  ) {
    throw new MarkerBlockOverlapError();
  }
  const full = readClaudeMd(agentDir);
  const { managed, yours } = extractYours(full);

  // Preserve any existing marker blocks verbatim; replace only the
  // free-text portion (everything NOT inside a rules/index block).
  const rulesBlockText = (() => {
    const b = yours.indexOf(RULES_BLOCK_BEGIN);
    const e = yours.indexOf(RULES_BLOCK_END);
    return b !== -1 && e !== -1 ? yours.slice(b, e + RULES_BLOCK_END.length) : null;
  })();
  const indexBlockText = (() => {
    const b = yours.indexOf(INDEX_BLOCK_BEGIN);
    const e = yours.indexOf(INDEX_BLOCK_END);
    return b !== -1 && e !== -1 ? yours.slice(b, e + INDEX_BLOCK_END.length) : null;
  })();

  const blocks = [rulesBlockText, indexBlockText].filter((b): b is string => b !== null);
  const newYours = blocks.length > 0
    ? `${newFreeText.trimEnd()}\n\n${blocks.join("\n\n")}`
    : newFreeText.trimEnd();

  const composed = recompose(managed, newYours);
  atomicWriteFileSync(claudeMdPath(agentDir), composed, 0o644);

  const now = opts.now ?? (() => new Date().toISOString());
  appendMutationRow(agentDir, {
    id: "yours-edit",
    action: "edit-yours",
    actor: opts.actor,
    source: opts.actor,
    ts: now(),
    blockHash: computeSentinel(parseRulesBlock(newYours)?.rules ?? []).hash,
  });
}

/** List active rules (read-only, no mutation-log row). */
export function listRules(agentDir: string): Rule[] {
  const full = readClaudeMd(agentDir);
  const { yours } = extractYours(full);
  return parseRulesBlock(yours)?.rules ?? [];
}

/**
 * Regenerate the index block from a fresh model-name list. This is the
 * PRIMITIVE the host-side approved `mental_model_propose` create/delete
 * flow calls after a sanctioned model write (OQ5: this fleet's model
 * writes are operator-approved, not agent-initiated, so the actual
 * propose→create/delete wiring lives outside this module's file list;
 * doctor's daily diff is the backstop reconciler either way).
 */
export function regenerateIndexBlock(agentDir: string, modelNames: string[]): void {
  const full = readClaudeMd(agentDir);
  const { managed, yours } = extractYours(full);
  const indexBlock = renderIndexBlock(modelNames);
  const newYours = upsertMarkerBlock(yours, INDEX_BLOCK_BEGIN, INDEX_BLOCK_END, indexBlock);
  const composed = recompose(managed, newYours);
  atomicWriteFileSync(claudeMdPath(agentDir), composed, 0o644);
}
