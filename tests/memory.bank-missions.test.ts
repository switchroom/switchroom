import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  updateBankMissions,
  DEFAULT_RETAIN_MISSION,
  SUPERSEDED_RETAIN_MISSIONS,
  isUpgradableRetainMission,
  decideRetainMissionUpgrade,
  fetchBankRetainMission,
  resolveBankMissionExtras,
  PROFILE_MEMORY_DEFAULTS,
  FLEET_DEFAULT_DISPOSITION,
  DEFAULT_OBSERVATIONS_MISSION,
  SUPERSEDED_OBSERVATIONS_MISSIONS,
  decideObservationsMissionUpgrade,
  fetchBankObservationsMission,
  type BankMissionExtras,
} from "../src/memory/hindsight.js";
import {
  reconcileAgent,
  scaffoldAgent,
  flushPendingBankOps,
  __resetPendingBankOpsForTests,
  __pendingBankOpsCountForTests,
} from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import { AgentMemorySchema } from "../src/config/schema.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/** Drive updateBankMissions with a two-call mock and return the update_bank args. */
async function captureUpdateBankArgs(
  missions: Parameters<typeof updateBankMissions>[2],
): Promise<Record<string, unknown>> {
  const mockFetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, headers: new Map() } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  const result = await updateBankMissions("http://test.local/mcp/", "test-bank", missions, {
    fetchImpl: mockFetch as any,
  });
  expect(result).toEqual({ ok: true });
  return JSON.parse(mockFetch.mock.calls[1][1].body).params.arguments;
}

// N2a (PR #3529 review): the in-flight bank-op registry is a module global.
// The scaffold/reconcile describes below start real chains, so without this
// every later test — notably "resolves immediately when nothing is in flight"
// — inherits the previous ones' entries.
beforeEach(() => {
  __resetPendingBankOpsForTests();
});

describe("DEFAULT_RETAIN_MISSION", () => {
  it("focuses extraction on durable, cross-conversation signal", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("durable facts");
    expect(DEFAULT_RETAIN_MISSION).toContain("still be true and useful weeks from now");
    // The 2026-07-29 live text moved the "user preferences ... ongoing projects
    // ... recurring commitments" opener into the DURABILITY GATE's named
    // classes. The same signals are still required, just named rather than
    // listed in prose.
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "- PREFERENCE — what the user likes, wants, or always does; a standing rule or correction.",
    );
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "- RELATIONSHIP — who a person is, what a project or tool is, and how they connect.",
    );
  });

  // Regression for the 2026-07-19 fleet review (REPORT.md finding B1):
  // live banks were dominated by transient in-flight task narration
  // ("P6 worker paused waiting on its PR") rather than durable facts.
  it("explicitly excludes in-flight workflow/process narration", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("In-flight workflow/process narration");
    expect(DEFAULT_RETAIN_MISSION).toContain("retain the outcome only once the task completes");
  });

  // Regression for the 2026-07-25 retain-noise pass. The extraction model is a
  // small local gpt-oss-20b: a general "ignore transient operational details"
  // principle did NOT stop it storing transcript traces, hindsight's own batch
  // failures (UUID inline), prompt restatements, or undated transient state.
  // Each bullet below corresponds to a unit actually found in a production bank.
  it("enumerates the concrete noise classes a small extraction model must drop", () => {
    // "The assistant used ToolSearch to query for hindsight bank statistics"
    expect(DEFAULT_RETAIN_MISSION).toContain("Agent tool-use traces");
    // "Batch retain operation with ID fcf86589-… failed, processing 1 item."
    expect(DEFAULT_RETAIN_MISSION).toMatch(/UUIDs/);
    expect(DEFAULT_RETAIN_MISSION).toMatch(/Hindsight's own errors, retries, backlogs, or internal state/);
    // "User wants to identify pending/failed consolidation…"
    expect(DEFAULT_RETAIN_MISSION).toContain("Restatements of the user's current request");
    // "User has no unread mail" — stored with no timestamp, recalls forever.
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /Transient state[\s\S]*unless[\s\S]*the fact is explicitly dated/,
    );
  });

  // The exclusions above are load-bearing but dangerous alone: an
  // exclusion-only mission made gpt-oss-20b return a degenerate/empty response
  // on chatty-but-real turns in the 6-window live sample. The positive
  // counterweight is what keeps genuine preferences flowing.
  it("keeps a positive counterweight so exclusions cannot starve extraction", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "A preference revealed by a request is durable",
    );
  });

  // Regression for the 2026-07-28 tool-exhaust pass. The 2026-07-25 mission
  // above was live on every bank and STILL leaked transcript exhaust — measured,
  // not argued: overlord's whole-shape tool-exhaust rate ran 1.12 / 1.18 / 0.69
  // units per 1k world+experience on 2026-07-25/-26/-27, above its 0.00-0.83 per
  // 1k the week before. In a 52-chunk A/B against the real extraction path and
  // the real local gpt-oss:20b, hand-labelling all 143 extracted facts, this
  // text cut tool exhaust from 42/84 (50.0%) to 12/59 (20.3%) while durable
  // facts went 42 -> 47. Each assertion below pins the part that earned that.
  it("gives the small extraction model a subject test and verbatim tool-result exemplars", () => {
    // The subject test. Every bullet is a special case of it, and it is what
    // generalizes to exhaust shapes nobody enumerated.
    expect(DEFAULT_RETAIN_MISSION).toContain("A TOOL RESULT IS NOT A FACT");
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /is the subject of this[\s\S]*candidate a file path/,
    );

    // Verbatim exemplars, each lifted from a unit the PREVIOUS mission let
    // through into a production bank — not invented ones.
    expect(DEFAULT_RETAIN_MISSION).toContain("File created successfully at /path/to/file");
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /A background command with ID bctz4yskm is running/,
    );
    expect(DEFAULT_RETAIN_MISSION).toMatch(/Async agent a745598ba84e71df1 was launched/);

    // The two shapes the 2026-07-25 mission had no bullet for at all.
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /Anything mentioning a path under \/tmp, a scratchpad directory, or a \.tmp file/,
    );
    expect(DEFAULT_RETAIN_MISSION).toContain("Slash commands the user typed");
  });

  // The 2026-07-25 revert finding (see the hindsight.ts header) stands and was
  // NOT re-litigated by the tool-exhaust pass: bullet 7 survives verbatim.
  // Without this, a future exhaust-focused reword could quietly reopen it.
  it("preserves the 2026-07-25 chatter bullet verbatim through the tool-exhaust pass", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "- Greetings, acknowledgements, and routine operational chatter.",
    );
  });

  // Regression for the 2026-07-29 live-text reconciliation. The text actually
  // running on the `klanker` and `overlord` banks was applied out-of-band
  // through the Hindsight REST config surface and never landed in the repo, so
  // the repo default and the fleet default had forked. These assertions pin the
  // parts of the live text that are NOT in any predecessor — if a future edit
  // drops them, the repo has forked from the fleet again.
  it("gates extraction on five named durable classes, not exclusions alone", () => {
    expect(DEFAULT_RETAIN_MISSION).toContain("DURABILITY GATE");
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /Emit a candidate ONLY if it is one of these five classes/,
    );
    for (const cls of ["PREFERENCE", "DECISION", "FINDING", "OUTCOME", "RELATIONSHIP"]) {
      expect(DEFAULT_RETAIN_MISSION).toContain(`- ${cls} —`);
    }
    // The gate is useless without a disposal instruction for a near-miss: the
    // 2026-07-25 finding is that this model rewords rather than drops.
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "If a candidate fits none of the five, it is not a memory. Drop it; do not reword it into one.",
    );
  });

  // The dominant residual noise class on the agent banks is the session
  // narrating its own orchestration: which worker was dispatched, which PR was
  // merged now. Those read as "decisions", so the DECISION class needs an
  // explicit carve-out or the gate admits them.
  it("excludes process/orchestration decisions from the DECISION class", () => {
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /A decision about the mechanics of the CURRENT task \(which worker to dispatch, which branch to rebase, which PR to merge now, what to do next\) is process narration, not a durable decision/,
    );
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /The act of delegating, dispatching, spawning, launching, steering or merging\n\s*work/,
    );
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "Record only what the work LEARNED or CHANGED.",
    );
  });

  it("requires each fact to stand alone once the transcript is gone", () => {
    expect(DEFAULT_RETAIN_MISSION).toMatch(/once this session is forgotten/);
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /Write each fact so it stands alone: name the thing, the number, and the date/,
    );
  });

  it("keeps the dated-transient bullet the predecessors earned", () => {
    // The 2026-07-25 finding — that dropping or narrowing an existing bullet
    // regressed extraction — still stands for this bullet.
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /Transient state[\s\S]*unless[\s\S]*the fact is explicitly dated/,
    );
  });

  // THE MERGE, asserted rather than assumed. The 2026-07-29 live text and the
  // outgoing 2026-07-28 default were SIBLINGS — both derived independently from
  // SUPERSEDED_RETAIN_MISSIONS[4] — so simply adopting the live text would have
  // DROPPED the volatile-state material. That material is the most on-target
  // section for the snapshot-written-as-timeless failure class, so the default
  // is the union: the live text verbatim, with the volatile-state bullet spliced
  // back in at its natural position. These assertions are what stop a future
  // "just take what's live" pass from silently regressing it again.
  it("carries the 2026-07-28 volatile-state bullet merged into the live text", () => {
    // The subject test, in the shape the 2026-07-28 A/B proved gpt-oss-20b
    // actually applies (a test on the CANDIDATE'S SUBJECT, not a category).
    expect(DEFAULT_RETAIN_MISSION).toContain("Volatile state written as a timeless assertion");
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /A version, count, size,\n\s*backlog, status, or any "X is running Y" \/ "X is at Y" \/ "X is currently Y"/,
    );
    expect(DEFAULT_RETAIN_MISSION).toMatch(/true only at the instant it was said/);
  });

  it("keeps the verbatim leaked-unit exemplars that earned the volatile bullet", () => {
    // Lifted from live bank content, not invented — the 2026-07-25 finding is
    // that this small model needs concrete negatives, and the 2026-07-28 A/B
    // is that they must be the ones that actually leaked.
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /Switchroom fleet is running image\n\s*version v0\.18\.19/,
    );
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /The switchroom repo is at \/path\/to\/fleet, version\n\s*v0\.19\.5/,
    );
    expect(DEFAULT_RETAIN_MISSION).toContain("pending consolidations");
  });

  it("keeps the date-inside-the-fact repair instruction, not only a prohibition", () => {
    // An exclusion-only bullet is the 2026-07-25 degenerate-extraction failure
    // mode. A claim worth keeping needs somewhere to go: date it inline.
    expect(DEFAULT_RETAIN_MISSION).toMatch(/put the date INSIDE the\n\s*fact text/);
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /"As of 2026-07-19 the fleet was running v0\.18\.19"/,
    );
    // And the reason, so the rule generalizes past the enumerated exemplars.
    expect(DEFAULT_RETAIN_MISSION).toMatch(
      /recalled forever as though it\n\s*were still true/,
    );
  });

  it("splices the volatile bullet in ABOVE the dated-transient one, not bolted on the end", () => {
    // Position is load-bearing: the 2026-07-28 pass put the stronger, concrete
    // bullet above the weaker general one deliberately, and both are kept (the
    // 2026-07-25 finding that removing bullets regresses extraction stands).
    const volatileAt = DEFAULT_RETAIN_MISSION.indexOf("- Volatile state written as");
    const transientAt = DEFAULT_RETAIN_MISSION.indexOf("- Transient state (unread counts");
    const restatementsAt = DEFAULT_RETAIN_MISSION.indexOf("- Restatements of the user's");
    expect(volatileAt).toBeGreaterThan(-1);
    expect(volatileAt).toBeGreaterThan(restatementsAt);
    expect(transientAt).toBeGreaterThan(volatileAt);
    // It lands inside NEVER extract, not after the closing instruction.
    expect(volatileAt).toBeLessThan(
      DEFAULT_RETAIN_MISSION.indexOf("If a candidate fact matches an exclusion"),
    );
  });

  // The 2026-07-29 merge is only honest if the live half is byte-identical.
  // This proves SUPERSEDED[7] is exactly SUPERSEDED[6] (the live text) with
  // exactly the volatile block inserted — no reword, no reorder, no quiet
  // tightening. Retargeted from DEFAULT_RETAIN_MISSION to SUPERSEDED[7] when
  // the 2026-08-02 own-synthesis pass shipped: the guarantee is about that
  // merge, which is now history, and history must stay provable.
  it("SUPERSEDED[7] is the live text verbatim plus exactly the volatile block, nothing else", () => {
    const liveText = SUPERSEDED_RETAIN_MISSIONS[6];
    expect(liveText).toHaveLength(3460);
    const priorDefault = SUPERSEDED_RETAIN_MISSIONS[5];
    const vStart = priorDefault.indexOf("- Volatile state written as a timeless assertion.");
    const vEnd = priorDefault.indexOf("- Transient state (unread counts");
    const block = priorDefault.slice(vStart, vEnd);
    expect(block).toHaveLength(742);
    const merged = SUPERSEDED_RETAIN_MISSIONS[7];
    // Removing the block from the merge yields the live text, unmodified.
    expect(merged.replace(block, "")).toBe(liveText);
    expect(merged).toHaveLength(liveText.length + block.length);
  });

  // 2026-08-02 own-synthesis pass. Same shape of proof as the merge test above:
  // the current default is the previous default with exactly ONE bullet added,
  // nothing else touched. This is what makes "additive, so the regression risk
  // is bounded to more-conservative extraction" a checkable claim rather than a
  // sentence in a comment.
  it("is the 2026-07-29 merge verbatim plus exactly the own-synthesis bullet", () => {
    const previous = SUPERSEDED_RETAIN_MISSIONS[7];
    const bStart = DEFAULT_RETAIN_MISSION.indexOf("- The assistant's own answers");
    const bEnd = DEFAULT_RETAIN_MISSION.indexOf("- Volatile state written as");
    expect(bStart).toBeGreaterThan(-1);
    expect(bEnd).toBeGreaterThan(bStart);
    const bullet = DEFAULT_RETAIN_MISSION.slice(bStart, bEnd);
    expect(DEFAULT_RETAIN_MISSION.replace(bullet, "")).toBe(previous);
    expect(DEFAULT_RETAIN_MISSION).toHaveLength(previous.length + bullet.length);
  });

  // The bullet has to actually land inside NEVER extract, and above the
  // volatile-state bullet (the 2026-07-25 finding that ordering and retention
  // of bullets matter stands). A bullet appended after the closing instruction
  // is not an exclusion, it is a footnote.
  it("places the own-synthesis bullet inside NEVER extract, above the volatile one", () => {
    const ownAt = DEFAULT_RETAIN_MISSION.indexOf("- The assistant's own answers");
    const restatementsAt = DEFAULT_RETAIN_MISSION.indexOf("- Restatements of the user's");
    const volatileAt = DEFAULT_RETAIN_MISSION.indexOf("- Volatile state written as");
    expect(ownAt).toBeGreaterThan(restatementsAt);
    expect(volatileAt).toBeGreaterThan(ownAt);
    expect(ownAt).toBeLessThan(
      DEFAULT_RETAIN_MISSION.indexOf("If a candidate fact matches an exclusion"),
    );
    // It carries the subject test, which is the part that generalises past the
    // enumerated claim types.
    expect(DEFAULT_RETAIN_MISSION).toContain(
      "does anything in this transcript support this claim OTHER",
    );
  });

  // Drift guard: the vendored plugin pushes settings.json's `retainMission`
  // through lib/bank.py ensure_bank_mission the first time it sees a bank, so
  // a divergence here means which mission shapes extraction depends on
  // scaffold-vs-plugin ordering. Same pattern as the MAX_DIRECTIVES guard.
  it("is pinned byte-for-byte to the vendored plugin's settings.json retainMission", () => {
    const settings = JSON.parse(
      readFileSync(
        resolve(__dirname, "..", "vendor", "hindsight-memory", "settings.json"),
        "utf-8",
      ),
    );
    expect(settings.retainMission).toBe(DEFAULT_RETAIN_MISSION);
  });
});

describe("scaffold seed wiring", () => {
  // Structural backstop for the 2026-07-25 re-review H1 fix. `switchroom
  // apply` re-scaffolds EVERY existing agent and never calls reconcile, so
  // NEITHER site may seed the default unconditionally: both must route through
  // decideRetainMissionUpgrade (via resolveRetainMissionPush), which refuses to
  // clobber a customized mission.
  //
  // N6 (PR #3529 review): the old form counted the literal
  // "?? DEFAULT_RETAIN_MISSION" (expect 0) and "await resolveRetainMissionPush("
  // (expect 2). That missed every other spelling of the same bug
  // (`x || DEFAULT_RETAIN_MISSION`, a ternary, a local alias) and broke on
  // benign refactors that merely move a call. The durable invariant is
  // stronger and spelling-independent: scaffold.ts must not USE the constant
  // at all — the only legitimate consumer is resolveRetainMissionPush, which
  // lives in src/memory/hindsight.ts. The behavioural proof of the decision
  // itself is the reconcileAgent and scaffoldAgent describes below, which
  // exercise the unset / superseded / customized / yaml-override / read-failure
  // branches at both real call sites; the fixed call count added nothing on top
  // of that, so it is dropped rather than re-encoded.
  it("never references DEFAULT_RETAIN_MISSION outside its import", () => {
    const scaffoldSource = readFileSync(
      resolve(__dirname, "..", "src", "agents", "scaffold.ts"),
      "utf-8",
    );
    const offenders = scaffoldSource
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      // Drop the import statement and comments — only executable references
      // to the constant can seed a mission.
      .filter(({ line }) => line.includes("DEFAULT_RETAIN_MISSION"))
      .filter(({ line }) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .filter(({ line }) => !/^\s*import\b/.test(line) && !line.includes('from "../memory/'))
      .map(({ line, n }) => `scaffold.ts:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});

// --- 2026-07-25 review finding 1: the mission upgrade must reach live banks ---

/**
 * The default this repo shipped from the 2026-07-28 volatile-state pass until
 * the 2026-07-29 live-text reconciliation, transcribed verbatim from the
 * outgoing literal. Named rather than inlined twice, but still a verbatim pin:
 * a byte-level edit here stops matching any bank that carries the text and
 * silently downgrades that bank to "customized, never upgrade".
 */
const OUTGOING_2026_07_28_DEFAULT =
  "Extract durable facts that will still be true and useful weeks from now: user preferences and standing rules, ongoing projects and recurring commitments, technical and architectural decisions with their rationale, and people/tool relationships. A preference revealed by a request is durable — record the preference (what the user likes, wants, or always does), not the request itself.\n" +
  "\n" +
  "A TOOL RESULT IS NOT A FACT. Before extracting, ask: is the subject of this\n" +
  "candidate a file path, a command/process/agent/session id, a temp directory, or\n" +
  "the location where some output was written? If yes, drop it — it is transcript\n" +
  "exhaust, not memory.\n" +
  "\n" +
  "NEVER extract:\n" +
  "- Tool results verbatim or paraphrased. Concretely, never produce a fact whose\n" +
  "  text resembles any of these: \"File created successfully at /path/to/file\",\n" +
  "  \"A background command with ID bctz4yskm is running, and its output will be\n" +
  "  written to /tmp/...\", \"Async agent a745598ba84e71df1 was launched successfully\n" +
  "  and is running in the background\", \"User executed a Bash command to sleep for\n" +
  "  200 seconds\", \"The assistant used grep to locate 'truncateSync' in src/foo.ts\".\n" +
  "- Anything mentioning a path under /tmp, a scratchpad directory, or a .tmp file.\n" +
  "- Agent tool-use traces or narration of what the assistant did (e.g. \"the\n" +
  "  assistant used X to query Y\", \"ran a search\", \"sent the message\").\n" +
  "- In-flight workflow/process narration (a sub-task started, paused, or is still\n" +
  "  running) — retain the outcome only once the task completes or a decision is made.\n" +
  "- Operation, request, batch, agent, command or session IDs, UUIDs, hashes, or error codes.\n" +
  "- Slash commands the user typed and their effects (e.g. \"User issued /clear to\n" +
  "  reset assistant state\").\n" +
  "- Hindsight's own errors, retries, backlogs, or internal state — the memory\n" +
  "  system's self-reports are not memories.\n" +
  "- Restatements of the user's current request or the task in progress.\n" +
  "- Volatile state written as a timeless assertion. A version, count, size,\n" +
  "  backlog, status, or any \"X is running Y\" / \"X is at Y\" / \"X is currently Y\"\n" +
  "  claim is true only at the instant it was said. Concretely, never produce a\n" +
  "  fact whose text resembles any of these: \"Switchroom fleet is running image\n" +
  "  version v0.18.19\", \"The switchroom repo is at /path/to/fleet, version\n" +
  "  v0.19.5\", \"Bank overlord has 43155 pending consolidations\", \"The build is\n" +
  "  currently green\". If the claim is worth keeping, put the date INSIDE the\n" +
  "  fact text (\"As of 2026-07-19 the fleet was running v0.18.19\"); if you\n" +
  "  cannot date it, drop it. An undated one is recalled forever as though it\n" +
  "  were still true, which is worse than not remembering it at all.\n" +
  "- Transient state (unread counts, build status, what is running right now) unless\n" +
  "  the fact is explicitly dated, in which case record it as a dated observation.\n" +
  "- Greetings, acknowledgements, and routine operational chatter.\n" +
  "\n" +
  "If a candidate fact matches an exclusion, drop it rather than rewording it. If\n" +
  "nothing durable remains, return an empty facts list.";

/**
 * The text read verbatim off the live `klanker` bank on 2026-07-29 — applied
 * out-of-band, never a repo default, and carried by `klanker` and `overlord`.
 * It is parent A of the current DEFAULT_RETAIN_MISSION (the merge), and it is a
 * verbatim pin for the same reason every other registry entry is: a byte-level
 * edit here stops matching those two banks and strands them as "customized".
 * The TRAILING NEWLINE is real and present on the bank — do not trim it.
 */
const LIVE_2026_07_29_TEXT =
  "Extract durable facts that will still be true and useful weeks from now, once this session is forgotten.\n" +
  "\n" +
  "DURABILITY GATE. Emit a candidate ONLY if it is one of these five classes:\n" +
  "- PREFERENCE — what the user likes, wants, or always does; a standing rule or correction.\n" +
  "- DECISION — a settled choice that changes how future work is done, including a choice NOT to do something. A decision about the mechanics of the CURRENT task (which worker to dispatch, which branch to rebase, which PR to merge now, what to do next) is process narration, not a durable decision — drop it unless it establishes a standing rule or permanently changes a system.\n" +
  "- FINDING — a root cause, a measurement, or verified behaviour of a system. Include the number.\n" +
  "- OUTCOME — a completed result that changed the world: what shipped, what a thing turned out to be. Not the act of shipping it.\n" +
  "- RELATIONSHIP — who a person is, what a project or tool is, and how they connect.\n" +
  "If a candidate fits none of the five, it is not a memory. Drop it; do not reword it into one.\n" +
  "\n" +
  "A preference revealed by a request is durable — record the preference (what the user likes, wants, or always does), not the request itself.\n" +
  "\n" +
  "A TOOL RESULT IS NOT A FACT. Before extracting, ask: is the subject of this\n" +
  "candidate a file path, a command/process/agent/session id, a temp directory, or\n" +
  "the location where some output was written? If yes, drop it — it is transcript\n" +
  "exhaust, not memory.\n" +
  "\n" +
  "NEVER extract:\n" +
  "- Tool results verbatim or paraphrased. Concretely, never produce a fact whose\n" +
  "  text resembles any of these: \"File created successfully at /path/to/file\",\n" +
  "  \"A background command with ID bctz4yskm is running, and its output will be\n" +
  "  written to /tmp/...\", \"Async agent a745598ba84e71df1 was launched successfully\n" +
  "  and is running in the background\", \"User executed a Bash command to sleep for\n" +
  "  200 seconds\", \"The assistant used grep to locate 'truncateSync' in src/foo.ts\".\n" +
  "- Anything mentioning a path under /tmp, a scratchpad directory, or a .tmp file.\n" +
  "- Agent tool-use traces or narration of what the assistant did (e.g. \"the\n" +
  "  assistant used X to query Y\", \"ran a search\", \"sent the message\").\n" +
  "- The act of delegating, dispatching, spawning, launching, steering or merging\n" +
  "  work — including when it succeeded. \"X was dispatched and completed\" is the\n" +
  "  session describing itself. Record only what the work LEARNED or CHANGED.\n" +
  "- In-flight workflow/process narration (a sub-task started, paused, or is still\n" +
  "  running) — retain the outcome only once the task completes or a decision is made.\n" +
  "- Operation, request, batch, agent, command or session IDs, UUIDs, hashes, or error codes.\n" +
  "- Slash commands the user typed and their effects (e.g. \"User issued /clear to\n" +
  "  reset assistant state\").\n" +
  "- Hindsight's own errors, retries, backlogs, or internal state — the memory\n" +
  "  system's self-reports are not memories.\n" +
  "- Restatements of the user's current request or the task in progress.\n" +
  "- Transient state (unread counts, build status, what is running right now) unless\n" +
  "  the fact is explicitly dated, in which case record it as a dated observation.\n" +
  "- Greetings, acknowledgements, and routine operational chatter.\n" +
  "\n" +
  "Write each fact so it stands alone: name the thing, the number, and the date. A\n" +
  "sentence that only makes sense while reading this transcript is not durable.\n" +
  "\n" +
  "If a candidate fact matches an exclusion, drop it rather than rewording it. If\n" +
  "nothing durable remains, return an empty facts list.\n";

/**
 * The volatile-state block, lifted verbatim out of the 2026-07-28 default.
 * Shared by the merge-mechanics test and {@link MERGED_2026_07_29_DEFAULT}.
 */
const VOLATILE_BLOCK = (() => {
  const vStart = OUTGOING_2026_07_28_DEFAULT.indexOf(
    "- Volatile state written as a timeless assertion.",
  );
  const vEnd = OUTGOING_2026_07_28_DEFAULT.indexOf("- Transient state (unread counts");
  return OUTGOING_2026_07_28_DEFAULT.slice(vStart, vEnd);
})();

/**
 * SUPERSEDED_RETAIN_MISSIONS[7] — the 2026-07-29 durability-gate MERGE, i.e.
 * the default this repo shipped immediately before the 2026-08-02
 * own-synthesis pass. DERIVED rather than transcribed a third time, from the
 * two verbatim pins it was assembled from: the live text with the volatile
 * block spliced in above the dated-transient bullet. Deriving it is stricter
 * than another transcription, not looser — it is fully determined by two pins
 * that are themselves byte-pinned, so it cannot drift independently of them.
 */
const MERGED_2026_07_29_DEFAULT = LIVE_2026_07_29_TEXT.replace(
  "- Transient state (unread counts",
  VOLATILE_BLOCK + "- Transient state (unread counts",
);

describe("SUPERSEDED_RETAIN_MISSIONS registry", () => {
  it("never contains the current default (that would make every apply a no-op decision)", () => {
    expect(SUPERSEDED_RETAIN_MISSIONS).not.toContain(DEFAULT_RETAIN_MISSION);
  });

  // L1 (2026-07-25 re-review): the registry is append-only by convention only
  // — pinning entry [2] alone let [0]/[1] be edited or reordered silently. An
  // edit to a historical entry stops matching the bank text it was written for
  // and silently downgrades that bank's mission to "customized, never upgrade".
  // Pin length + every entry verbatim: appending is a one-line test change,
  // editing or reordering is a deliberate, visible one.
  it("pins every historical entry verbatim and in order (append-only)", () => {
    expect(SUPERSEDED_RETAIN_MISSIONS).toEqual([
      // 3e028eeb3 (2026-05) — the vendored plugin's original settings.json
      // `retainMission`, pushed bank-side by lib/bank.py ensure_bank_mission.
      "Extract technical decisions, architectural choices, user preferences, project context, and people/tool relationships. Ignore routine greetings and transient operational details.",
      // d7c406994 (#458) — first switchroom-seeded DEFAULT_RETAIN_MISSION.
      "Extract user preferences, ongoing projects, recurring commitments, " +
        "important context, and durable facts that should help across future " +
        "conversations. Skip one-off chatter and temporary task noise.",
      // 9a9b7176c (#3418) — added the in-flight-narration carve-out. The text
      // every live bank was carrying as of 2026-07-25.
      "Extract user preferences, ongoing projects, recurring commitments, " +
        "important context, and durable facts that should help across future " +
        "conversations. Skip one-off chatter and temporary task noise, " +
        "including in-flight workflow/process narration (a sub-task started, " +
        "paused, or is still running) — only retain the outcome once a task " +
        "actually completes or a decision is made.",
      // (2026-07-25 retain-noise pass) — first mission to enumerate negative
      // exemplars. The text every live bank was carrying as of 2026-07-27, and
      // the A arm of the 2026-07-28 tool-exhaust A/B.
      "Extract durable facts that will still be true and useful weeks from now: " +
      "user preferences and standing rules, ongoing projects and recurring " +
      "commitments, technical and architectural decisions with their rationale, " +
      "and people/tool relationships. A preference revealed by a request is " +
      "durable — record the preference (what the user likes, wants, or always " +
      "does), not the request itself.\n\n" +
      "NEVER extract:\n" +
      "- Agent tool-use traces or narration of what the assistant did (e.g. " +
      '"the assistant used X to query Y", "ran a search", "sent the message").\n' +
      "- In-flight workflow/process narration (a sub-task started, paused, or is " +
      "still running) — retain the outcome only once the task completes or a " +
      "decision is made.\n" +
      "- Operation, request, batch or session IDs, UUIDs, hashes, or error codes.\n" +
      "- Hindsight's own errors, retries, backlogs, or internal state — the " +
      "memory system's self-reports are not memories.\n" +
      "- Restatements of the user's current request or the task in progress.\n" +
      "- Transient state (unread counts, build status, what is running right now) " +
      "unless the fact is explicitly dated, in which case record it as a dated " +
      "observation.\n" +
      "- Greetings, acknowledgements, and routine operational chatter.\n\n" +
      "If a candidate fact matches an exclusion, drop it rather than rewording " +
      "it. If nothing durable remains, return an empty facts list.",
      // (2026-07-28 tool-exhaust pass, #3878) — the A/B-selected arm B, and the
      // text every live bank was carrying when the volatile-state bullet landed.
      "Extract durable facts that will still be true and useful weeks from now: user preferences and standing rules, ongoing projects and recurring commitments, technical and architectural decisions with their rationale, and people/tool relationships. A preference revealed by a request is durable — record the preference (what the user likes, wants, or always does), not the request itself.\n" +
      "\n" +
      "A TOOL RESULT IS NOT A FACT. Before extracting, ask: is the subject of this\n" +
      "candidate a file path, a command/process/agent/session id, a temp directory, or\n" +
      "the location where some output was written? If yes, drop it — it is transcript\n" +
      "exhaust, not memory.\n" +
      "\n" +
      "NEVER extract:\n" +
      "- Tool results verbatim or paraphrased. Concretely, never produce a fact whose\n" +
      "  text resembles any of these: \"File created successfully at /path/to/file\",\n" +
      "  \"A background command with ID bctz4yskm is running, and its output will be\n" +
      "  written to /tmp/...\", \"Async agent a745598ba84e71df1 was launched successfully\n" +
      "  and is running in the background\", \"User executed a Bash command to sleep for\n" +
      "  200 seconds\", \"The assistant used grep to locate 'truncateSync' in src/foo.ts\".\n" +
      "- Anything mentioning a path under /tmp, a scratchpad directory, or a .tmp file.\n" +
      "- Agent tool-use traces or narration of what the assistant did (e.g. \"the\n" +
      "  assistant used X to query Y\", \"ran a search\", \"sent the message\").\n" +
      "- In-flight workflow/process narration (a sub-task started, paused, or is still\n" +
      "  running) — retain the outcome only once the task completes or a decision is made.\n" +
      "- Operation, request, batch, agent, command or session IDs, UUIDs, hashes, or error codes.\n" +
      "- Slash commands the user typed and their effects (e.g. \"User issued /clear to\n" +
      "  reset assistant state\").\n" +
      "- Hindsight's own errors, retries, backlogs, or internal state — the memory\n" +
      "  system's self-reports are not memories.\n" +
      "- Restatements of the user's current request or the task in progress.\n" +
      "- Transient state (unread counts, build status, what is running right now) unless\n" +
      "  the fact is explicitly dated, in which case record it as a dated observation.\n" +
      "- Greetings, acknowledgements, and routine operational chatter.\n" +
      "\n" +
      "If a candidate fact matches an exclusion, drop it rather than rewording it. If\n" +
      "nothing durable remains, return an empty facts list.",
      // (2026-07-28 volatile-state pass) — the default this repo shipped
      // immediately before the 2026-07-29 live-text reconciliation.
      OUTGOING_2026_07_28_DEFAULT,
      // (2026-07-29) — the out-of-band live text, parent A of the merge that
      // replaced it. Registered so `klanker` and `overlord`, which carry it,
      // are upgradable to the merged default rather than stranded on it.
      LIVE_2026_07_29_TEXT,
      // (2026-07-29 durability-gate merge) — the default this repo shipped
      // immediately before the 2026-08-02 own-synthesis pass. Registered so
      // every bank that converged on the merge is upgradable to the new text
      // rather than read as an operator customization.
      MERGED_2026_07_29_DEFAULT,
    ]);
    expect(SUPERSEDED_RETAIN_MISSIONS).toHaveLength(8);
  });

  // The whole point of appending: a bank still carrying a shipped default must
  // be UPGRADABLE, not mistaken for an operator customization that
  // `decideRetainMissionUpgrade` refuses to touch. Forgetting the append is
  // silent — those banks simply never get the new text.
  it("makes BOTH merge parents upgradable, and neither one the current default", () => {
    for (const parent of [OUTGOING_2026_07_28_DEFAULT, LIVE_2026_07_29_TEXT]) {
      expect(parent).toContain("A TOOL RESULT IS NOT A FACT");
      expect(isUpgradableRetainMission(parent)).toBe(true);
      // A parent is the PRIOR text, never the current one — a self-superseding
      // mission would make decideRetainMissionUpgrade oscillate forever.
      expect(parent).not.toBe(DEFAULT_RETAIN_MISSION);
    }
    // Each parent contributed the half the other lacked.
    expect(OUTGOING_2026_07_28_DEFAULT).toContain("Volatile state written as a timeless assertion");
    expect(OUTGOING_2026_07_28_DEFAULT).not.toContain("DURABILITY GATE");
    expect(LIVE_2026_07_29_TEXT).toContain("DURABILITY GATE");
    expect(LIVE_2026_07_29_TEXT).not.toContain("Volatile state written as a timeless assertion");
    // ...and the merged default carries both halves.
    expect(DEFAULT_RETAIN_MISSION).toContain("Volatile state written as a timeless assertion");
    expect(DEFAULT_RETAIN_MISSION).toContain("DURABILITY GATE");
    expect(isUpgradableRetainMission(DEFAULT_RETAIN_MISSION)).toBe(false);
  });

  // Outcome test for the 2026-07-29 defect: 21 of 29 live banks were stranded
  // on entry [3] because the text actually running on `klanker`/`overlord` was
  // never in the repo, so the guarded path had nothing to converge them TO.
  // These are the byte-equalities the convergence depends on.
  it("converges every stranded live bank on the merged default", () => {
    // 21 banks (assistant, carrie, clerk, finn, gamma, ...) — read live 2026-07-29.
    const stranded = SUPERSEDED_RETAIN_MISSIONS[3];
    expect(stranded).toHaveLength(1321);
    // 2 banks (klanker, overlord) — the out-of-band text this PR supersedes.
    expect(LIVE_2026_07_29_TEXT).toHaveLength(3460);
    for (const current of [stranded, LIVE_2026_07_29_TEXT]) {
      expect(decideRetainMissionUpgrade(undefined, current)).toEqual({
        action: "upgrade",
        mission: DEFAULT_RETAIN_MISSION,
      });
    }
    // The 2026-07-29 merge (live text + the 742-char volatile block) is now a
    // waypoint, not the destination: a bank that already converged on it must
    // ALSO be upgradable to the current default, or the 2026-08-02 own-synthesis
    // bullet never reaches the fleet.
    expect(MERGED_2026_07_29_DEFAULT).toHaveLength(4202);
    expect(decideRetainMissionUpgrade(undefined, MERGED_2026_07_29_DEFAULT)).toEqual({
      action: "upgrade",
      mission: DEFAULT_RETAIN_MISSION,
    });
  });

  it("carries the 2026-07-19 text every live bank was found holding on 2026-07-25", () => {
    // Read verbatim off the fleet REST config surface during the review.
    const live =
      "Extract user preferences, ongoing projects, recurring commitments, " +
      "important context, and durable facts that should help across future " +
      "conversations. Skip one-off chatter and temporary task noise, " +
      "including in-flight workflow/process narration (a sub-task started, " +
      "paused, or is still running) — only retain the outcome once a task " +
      "actually completes or a decision is made.";
    expect(SUPERSEDED_RETAIN_MISSIONS).toContain(live);
    expect(isUpgradableRetainMission(live)).toBe(true);
  });

  it("treats an unset mission as upgradable and a customized one as not", () => {
    expect(isUpgradableRetainMission(null)).toBe(true);
    expect(isUpgradableRetainMission("")).toBe(true);
    expect(isUpgradableRetainMission("   ")).toBe(true);
    expect(isUpgradableRetainMission("Only remember what Ken says about cricket.")).toBe(false);
    // A byte-level edit of a known default is a customization, not a default.
    expect(isUpgradableRetainMission(SUPERSEDED_RETAIN_MISSIONS[0] + " ")).toBe(false);
  });
});

describe("decideRetainMissionUpgrade", () => {
  it("upgrades a superseded default to the current one", () => {
    for (const old of SUPERSEDED_RETAIN_MISSIONS) {
      expect(decideRetainMissionUpgrade(undefined, old)).toEqual({
        action: "upgrade",
        mission: DEFAULT_RETAIN_MISSION,
      });
    }
  });

  it("leaves a customized mission alone", () => {
    expect(decideRetainMissionUpgrade(undefined, "hand-written mission")).toEqual({
      action: "none",
    });
  });

  // The rail that blocked the earlier unguarded-push design: on the 2026-07-29
  // fleet read, banks including `ken-profile` and `lisa-profile` carry
  // operator-curated missions, and an unconditional push would have replaced
  // them. Membership is byte-equality, so an UNKNOWN mission — including one
  // that is a near-miss of a known default — must never be upgraded.
  it("refuses to overwrite a bank holding an unknown mission", () => {
    const unknown = [
      "Only remember what Ken says about cricket.",
      // A hand-edit of the current default: one trailing space.
      DEFAULT_RETAIN_MISSION + " ",
      // A hand-edit of a superseded default: one trailing newline.
      SUPERSEDED_RETAIN_MISSIONS[3] + "\n",
      // A future default this build has never heard of.
      "Extract durable facts. SOME FUTURE GATE. Drop everything else.",
    ];
    for (const mission of unknown) {
      expect(decideRetainMissionUpgrade(undefined, mission)).toEqual({ action: "none" });
      expect(isUpgradableRetainMission(mission)).toBe(false);
    }
  });

  it("does nothing when the bank already carries the current default", () => {
    expect(decideRetainMissionUpgrade(undefined, DEFAULT_RETAIN_MISSION)).toEqual({
      action: "none",
    });
  });

  it("operator yaml wins outright, even over a customized bank mission", () => {
    expect(decideRetainMissionUpgrade("from yaml", "hand-written mission")).toEqual({
      action: "config",
      mission: "from yaml",
    });
  });
});

describe("fetchBankRetainMission", () => {
  it("reads config.retain_mission off the REST config surface (NOT MCP get_bank)", async () => {
    let seen = "";
    const fetchImpl = vi.fn(async (url: string) => {
      seen = url;
      return {
        ok: true,
        json: async () => ({ config: { retain_mission: "current text" } }),
      } as any;
    });
    const r = await fetchBankRetainMission("http://h:18888/mcp/", "a b", {
      fetchImpl: fetchImpl as any,
    });
    expect(seen).toBe("http://h:18888/v1/default/banks/a%20b/config");
    expect(r).toEqual({ ok: true, mission: "current text" });
  });

  it("returns mission null only when the key is present but null (genuinely unset)", async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, json: async () => ({ config: { retain_mission: null } }) }) as any,
    );
    expect(await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }))
      .toEqual({ ok: true, mission: null });
  });

  // M1 (2026-07-25 re-review): an unrecognised 200 body must NOT read as
  // "unset". isUpgradableRetainMission(null) is true, so the loose behaviour
  // would push the default over every customized mission fleet-wide the day
  // Hindsight renests or renames the field.
  it("reports failure — not 'unset' — when config is missing or the key is absent", async () => {
    const shapes = [
      {}, // no config at all
      { config: null }, // config explicitly null
      { config: {} }, // config present, retain_mission key absent
      { config: { retain_mission: 42 } }, // key present, wrong type
    ];
    for (const body of shapes) {
      const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => body }) as any);
      expect(
        await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }),
      ).toEqual({ ok: false, reason: "Unexpected shape" });
    }
  });

  it("reports failure rather than throwing on a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }) as any);
    expect(await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }))
      .toEqual({ ok: false, reason: "HTTP 503" });
  });
});

describe("decideObservationsMissionUpgrade", () => {
  it("seeds the fleet default onto an unset bank (the live fleet-wide state)", () => {
    // Verified live 2026-07-28: all 27 banks on switchroom-hindsight carried
    // observations_mission: null, so this is the case that actually fires.
    expect(decideObservationsMissionUpgrade(undefined, undefined, null)).toEqual({
      action: "upgrade",
      mission: DEFAULT_OBSERVATIONS_MISSION,
    });
  });

  it("treats a whitespace-only mission as unset", () => {
    expect(decideObservationsMissionUpgrade(undefined, undefined, "   ")).toEqual({
      action: "upgrade",
      mission: DEFAULT_OBSERVATIONS_MISSION,
    });
  });

  it("never clobbers an operator hand-edit", () => {
    expect(
      decideObservationsMissionUpgrade(undefined, undefined, "only track cricket scores"),
    ).toEqual({ action: "none" });
  });

  it("is a no-op once the bank already carries the current default", () => {
    expect(
      decideObservationsMissionUpgrade(undefined, undefined, DEFAULT_OBSERVATIONS_MISSION),
    ).toEqual({ action: "none" });
  });

  it("operator yaml wins outright, even over a hand-edited bank value", () => {
    expect(
      decideObservationsMissionUpgrade("from yaml", "profile text", "hand-written"),
    ).toEqual({ action: "config", mission: "from yaml" });
  });

  it("a profiled agent gets its PROFILE mission, not the generic fleet default", () => {
    const profile = PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission!;
    expect(decideObservationsMissionUpgrade(undefined, profile, null)).toEqual({
      action: "upgrade",
      mission: profile,
    });
  });

  it("upgrades a bank already holding the generic default to its profile mission", () => {
    // Ordering hazard: an agent scaffolded before its profile was assigned
    // carries the generic default. That is switchroom-authored text, so it must
    // stay upgradable rather than being frozen as if a human wrote it.
    const profile = PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission!;
    expect(
      decideObservationsMissionUpgrade(undefined, profile, DEFAULT_OBSERVATIONS_MISSION),
    ).toEqual({ action: "upgrade", mission: profile });
  });

  it("upgrades every superseded default to the current one", () => {
    for (const old of SUPERSEDED_OBSERVATIONS_MISSIONS) {
      expect(decideObservationsMissionUpgrade(undefined, undefined, old)).toEqual({
        action: "upgrade",
        mission: DEFAULT_OBSERVATIONS_MISSION,
      });
    }
  });
});

describe("SUPERSEDED_OBSERVATIONS_MISSIONS registry", () => {
  it("never contains the current default (that would make the no-op case an upgrade)", () => {
    expect(SUPERSEDED_OBSERVATIONS_MISSIONS).not.toContain(DEFAULT_OBSERVATIONS_MISSION);
  });

  it("carries the RETIRED health-coach profile default, so those banks stay upgradable", () => {
    // The original one-line health-coach mission. It is no longer the profile
    // default (rewritten in consolidation voice), so it must be listed here or
    // a bank still carrying it would be mistaken for an operator hand-edit.
    expect(SUPERSEDED_OBSERVATIONS_MISSIONS).toContain(
      "Synthesise the person's wellbeing patterns, motivations, and emotional " +
        "context — how habits, setbacks, and encouragement connect over time.",
    );
    expect(SUPERSEDED_OBSERVATIONS_MISSIONS).not.toContain(
      PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission,
    );
  });
});

/**
 * Per-profile `observations_mission` defaults.
 *
 * These assert the properties that make a consolidation mission correct for its
 * profile — not merely that some string is present. The ephemeral-override
 * assertions are the load-bearing ones: the engine's `_DECISION_GUIDE` says
 * "Purely ephemeral facts → omit them unless the MISSION explicitly targets
 * such data" (`prompts.py:90`, verified 2026-07-28 against
 * `ghcr.io/switchroom/switchroom-hindsight:v0.19.26`). For an engineering or
 * assistant bank the operational state IS the durable knowledge, so the mission
 * must override that rule AND ask for the date inline, since a consolidated
 * observation is otherwise a timeless assertion. For a coaching bank the same
 * override would be wrong, and its absence is asserted rather than assumed.
 */
describe("PROFILE_MEMORY_DEFAULTS observations missions", () => {
  const profilesDir = resolve(import.meta.dirname, "../profiles");
  const builtInProfiles = readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);

  it("covers every built-in profile except `default` (which takes the fleet default)", () => {
    expect(builtInProfiles.length).toBeGreaterThan(1);
    for (const profile of builtInProfiles) {
      if (profile === "default") {
        // A `default` entry would only duplicate DEFAULT_OBSERVATIONS_MISSION.
        expect(PROFILE_MEMORY_DEFAULTS[profile]?.observations_mission).toBeUndefined();
        continue;
      }
      expect(
        PROFILE_MEMORY_DEFAULTS[profile]?.observations_mission,
        `profile "${profile}" has no observations_mission default`,
      ).toBeTruthy();
    }
  });

  it("keeps every mission inside the per-batch prompt budget", () => {
    // Rides the per-request user message of every consolidation batch,
    // uncached. ~1700 chars ≈ 400 tokens, the order of the unconditional
    // _PROCESSING_RULES block it sits beside.
    for (const [profile, defaults] of Object.entries(PROFILE_MEMORY_DEFAULTS)) {
      const mission = defaults.observations_mission;
      if (!mission) continue;
      expect(mission.length, `${profile} mission is ${mission.length} chars`).toBeLessThanOrEqual(
        1700,
      );
    }
  });

  it("writes in consolidation terms: every mission steers observation granularity", () => {
    // The engine delegates aggregation to the mission, so a mission that only
    // lists topics leaves the most consequential knob unset.
    for (const [profile, defaults] of Object.entries(PROFILE_MEMORY_DEFAULTS)) {
      const mission = defaults.observations_mission;
      if (!mission) continue;
      expect(mission, `${profile} mission says nothing about granularity`).toMatch(
        /Granularity: one observation per/,
      );
      expect(mission, `${profile} mission says nothing about aggregating`).toMatch(/[Aa]ggregate/);
    }
  });

  it("overrides the engine's ephemeral-omit rule ONLY where operational state is the knowledge", () => {
    for (const profile of ["coding", "executive-assistant"]) {
      const mission = PROFILE_MEMORY_DEFAULTS[profile].observations_mission!;
      expect(mission, `${profile} must override the ephemeral-omit rule`).toMatch(
        /IS durable knowledge here, not ephemeral chatter/,
      );
      expect(mission, `${profile} must say not to drop it as ephemeral`).toMatch(
        /[Dd]o not drop (them|it) as ephemeral/,
      );
      // Consolidated observations are timeless assertions; without an inline
      // date a later reader cannot judge staleness.
      expect(mission, `${profile} must ask for the date inline`).toMatch(
        /embed the date inside the observation text/,
      );
    }

    // A single day's reading genuinely IS ephemeral for a coaching bank — the
    // durable unit is the pattern. Carrying the ops override here would be the
    // one-size-fits-all failure this per-profile split exists to avoid.
    const coach = PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission!;
    expect(coach).not.toMatch(/not ephemeral chatter/);
    expect(coach).not.toMatch(/[Dd]o not drop (them|it) as ephemeral/);
    expect(coach).toMatch(/is evidence, not an observation/);
  });

  it("never contradicts the PROCESSING RULES it outranks (says nothing about merge-vs-create)", () => {
    // The MISSION takes priority over the PROCESSING RULES, so a mission that
    // opined on UPDATE-vs-CREATE could silently disable the engine's dedup.
    for (const [profile, defaults] of Object.entries(PROFILE_MEMORY_DEFAULTS)) {
      const mission = defaults.observations_mission;
      if (!mission) continue;
      expect(mission, `${profile} mission touches merge mechanics`).not.toMatch(
        /\bUPDATE\b|\bCREATE\b|\bDELETE\b/,
      );
    }
  });
});

/**
 * Never-clobber, across profiles.
 *
 * The four live banks carrying hand-authored observations missions (verified
 * 2026-07-28 via `GET /v1/default/banks/<id>/config`: 1691, 1667, 1594 and
 * 1565 chars) are why this matters — shipping profile defaults must not put a
 * single one of them at risk. The fixture reproduces their shape.
 */
describe("observations_mission never-clobber under profile defaults", () => {
  const HAND_AUTHORED =
    "You consolidate the memory of an agent working directly with the operator.\n\n" +
    "Retain durably:\n- Fleet and infrastructure state, and WHY each is set as it is.\n" +
    "- Investigations and their findings, including negative results.\n";

  it("leaves an operator hand-authored mission alone under EVERY profile default", () => {
    for (const defaults of [...Object.values(PROFILE_MEMORY_DEFAULTS), {} as BankMissionExtras]) {
      expect(
        decideObservationsMissionUpgrade(undefined, defaults.observations_mission, HAND_AUTHORED),
      ).toEqual({ action: "none" });
    }
  });

  it("upgrades an UNSET bank to its profile mission, not the fleet default", () => {
    for (const [profile, defaults] of Object.entries(PROFILE_MEMORY_DEFAULTS)) {
      const mission = defaults.observations_mission;
      if (!mission) continue;
      expect(decideObservationsMissionUpgrade(undefined, mission, null), profile).toEqual({
        action: "upgrade",
        mission,
      });
    }
  });

  it("frees a bank left holding another profile's mission after an `extends` change", () => {
    // Ordering hazard, mirrored from the generic-default case: an agent moved
    // OFF `extends: coding` still carries the coding mission. That is
    // switchroom-authored text, so it must stay upgradable rather than freezing
    // there forever as if a human had written it.
    const coding = PROFILE_MEMORY_DEFAULTS.coding.observations_mission!;
    expect(decideObservationsMissionUpgrade(undefined, undefined, coding)).toEqual({
      action: "upgrade",
      mission: DEFAULT_OBSERVATIONS_MISSION,
    });
    const coach = PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission!;
    expect(decideObservationsMissionUpgrade(undefined, coach, coding)).toEqual({
      action: "upgrade",
      mission: coach,
    });
  });

  it("is a no-op once a profiled bank already carries its own profile mission", () => {
    const coding = PROFILE_MEMORY_DEFAULTS.coding.observations_mission!;
    expect(decideObservationsMissionUpgrade(undefined, coding, coding)).toEqual({
      action: "none",
    });
  });
});

describe("fetchBankObservationsMission", () => {
  it("reads config.observations_mission off the same REST config surface", async () => {
    let seen = "";
    const fetchImpl = vi.fn(async (url: string) => {
      seen = url;
      return {
        ok: true,
        json: async () => ({ config: { observations_mission: "current text" } }),
      } as any;
    });
    const r = await fetchBankObservationsMission("http://h:18888/mcp/", "a b", {
      fetchImpl: fetchImpl as any,
    });
    expect(seen).toBe("http://h:18888/v1/default/banks/a%20b/config");
    expect(r).toEqual({ ok: true, mission: "current text" });
  });

  it("reports failure — not 'unset' — on an unrecognised body", async () => {
    // Same M1 posture as retain: null reads as upgradable, so an unrecognised
    // shape must never be flattened to null or a rename upstream would push the
    // default over every customized mission fleet-wide.
    const shapes = [
      {},
      { config: null },
      { config: { retain_mission: "x" } }, // observations_mission key absent
      { config: { observations_mission: 42 } },
    ];
    for (const body of shapes) {
      const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => body }) as any);
      expect(
        await fetchBankObservationsMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }),
      ).toEqual({ ok: false, reason: "Unexpected shape" });
    }
  });

  it("does not confuse the two fields — a null retain_mission is not a null observations_mission", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({
            config: { retain_mission: null, observations_mission: "obs text" },
          }),
        }) as any,
    );
    expect(
      await fetchBankObservationsMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }),
    ).toEqual({ ok: true, mission: "obs text" });
    expect(
      await fetchBankRetainMission("http://h/mcp/", "b", { fetchImpl: fetchImpl as any }),
    ).toEqual({ ok: true, mission: null });
  });
});

/**
 * End-to-end outcome test for review finding 1.
 *
 * The headline of the original PR — a rewritten DEFAULT_RETAIN_MISSION —
 * reached NO existing agent, because `reconcileAgent` pushed `retain_mission`
 * only when the operator had set one in yaml. These tests drive the real
 * `reconcileAgent` against a stubbed Hindsight and assert what actually goes
 * out on the wire.
 *
 * Verified to bite (2026-07-25):
 *  - reverting `src/agents/scaffold.ts` to the pre-fix reconcile block fails
 *    "PUSHES the current default…" (no retain_mission on the wire at all).
 *  - making `decideRetainMissionUpgrade` push unconditionally — the naive
 *    version of this fix — fails "does NOT clobber…". That test cannot fail
 *    on the pre-fix code (which pushed nothing); its job is to pin the guard
 *    that makes the new push safe.
 */
describe("reconcileAgent — retain_mission upgrade on existing banks", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  /**
   * Stub Hindsight: MCP create_bank/update_bank succeed, and the REST config
   * endpoint reports `currentMission`. Resolves with the update_bank args once
   * the fire-and-forget mission push lands (reconcile does not await it).
   */
  function stubHindsight(
    currentMission: string | null,
    config: AgentConfig,
  ): Promise<Record<string, unknown>> {
    // Scaffold FIRST, memory disabled, so the fresh-agent seed path issues no
    // Hindsight traffic that could be mistaken for the reconcile push.
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-retain-mission-"));
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    let resolveArgs: (a: Record<string, unknown>) => void;
    const seen = new Promise<Record<string, unknown>>((r) => (resolveArgs = r));
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        return {
          ok: true,
          json: async () => ({ config: { retain_mission: currentMission } }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") {
        resolveArgs(body.params.arguments as Record<string, unknown>);
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;
    return seen;
  }

  function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      ...overrides,
    } as AgentConfig;
  }

  /**
   * Scaffold the agent dir with memory DISABLED (so the fresh-agent seed path
   * issues no Hindsight traffic and cannot be mistaken for the reconcile
   * push), then reconcile with the hindsight-enabled config.
   */
  function runReconcile(config: AgentConfig) {
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
  }

  it("PUSHES the current default when the bank holds a superseded default", async () => {
    const config = makeAgentConfig();
    const seen = stubHindsight(
      SUPERSEDED_RETAIN_MISSIONS[SUPERSEDED_RETAIN_MISSIONS.length - 1],
      config,
    );
    runReconcile(config);
    const args = await seen;
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe(
      DEFAULT_RETAIN_MISSION,
    );
  }, 15_000);

  it("does NOT clobber an operator-customized bank mission", async () => {
    const config = makeAgentConfig({ memory: { reflect_mission: "persona" } } as Partial<AgentConfig>);
    const seen = stubHindsight("Remember only what Ken says about cricket.", config);
    runReconcile(config);
    const args = await seen;
    expect(args.config_updates).toBeDefined();
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBeUndefined();
  }, 15_000);

  it("pushes the operator's yaml retain_mission verbatim when set", async () => {
    const config = makeAgentConfig({
      memory: { retain_mission: "operator text" },
    } as Partial<AgentConfig>);
    const seen = stubHindsight(SUPERSEDED_RETAIN_MISSIONS[0], config);
    runReconcile(config);
    const args = await seen;
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe("operator text");
  }, 15_000);
});

/**
 * End-to-end outcome tests for the observations_mission seed.
 *
 * `switchroom apply` calls `scaffoldAgent` for every agent on every run, so
 * scaffold — not reconcile — is the path that actually reaches live banks.
 * These drive the real `scaffoldAgent` against a stubbed Hindsight and assert
 * what goes out on the wire.
 *
 * Verified to bite: with the `resolveObservationsMissionPush` call removed from
 * scaffold (i.e. the pre-change code, where observations_mission rode
 * `resolveBankMissionExtras` and resolved to nothing for `extends: default`),
 * "seeds the fleet default onto a bank with none" fails with the received value
 * `undefined` — which is exactly the live fleet state measured on 2026-07-28.
 */
describe("scaffoldAgent — observations_mission seed", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  beforeEach(() => {
    __resetPendingBankOpsForTests();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  /**
   * Stub Hindsight with a config surface that carries BOTH mission keys, so the
   * observations reader sees a recognised shape. Resolves with the update_bank
   * arguments once the fire-and-forget push lands.
   */
  function runScaffold(
    currentObservations: string | null,
    config: AgentConfig,
    updateBankCalls: Record<string, unknown>[] = [],
    /**
     * The bank's live disposition. Defaults to a bank already carrying the
     * fleet floor, so the disposition half is a no-op and these tests stay
     * about the mission under test; pass `{}` to model a bank that has none.
     */
    currentDisposition: Record<string, number> = {
      disposition_skepticism: FLEET_DEFAULT_DISPOSITION.skepticism as number,
    },
  ): Promise<Record<string, unknown>> {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-obs-mission-"));
    let resolveArgs: (a: Record<string, unknown>) => void;
    const seen = new Promise<Record<string, unknown>>((r) => (resolveArgs = r));
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        return {
          ok: true,
          json: async () => ({
            config: {
              // Already current, so the retain half is a no-op and cannot be
              // confused with the observations push under test.
              retain_mission: DEFAULT_RETAIN_MISSION,
              observations_mission: currentObservations,
              ...currentDisposition,
            },
          }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") {
        updateBankCalls.push(body.params.arguments as Record<string, unknown>);
        resolveArgs(body.params.arguments as Record<string, unknown>);
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    return seen;
  }

  function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      ...overrides,
    } as AgentConfig;
  }

  it("seeds the fleet default onto a bank with none", async () => {
    const config = makeAgentConfig();
    const seen = runScaffold(null, config);
    const args = await seen;
    expect((args.config_updates as Record<string, unknown>).observations_mission).toBe(
      DEFAULT_OBSERVATIONS_MISSION,
    );
  }, 15_000);

  it("does NOT clobber an operator hand-edited observations_mission", async () => {
    // Both managed missions are left alone here (retain is already current,
    // observations is hand-edited), so `missions` is empty and the emptiness
    // guard suppresses update_bank entirely. Asserting "no update_bank call"
    // is therefore the strongest available statement of "nothing was clobbered".
    const config = makeAgentConfig();
    const calls: Record<string, unknown>[] = [];
    runScaffold("only track cricket scores", config, calls);
    await flushPendingBankOps(10_000);
    expect(calls).toEqual([]);
  }, 15_000);

  it("pushes the operator's yaml observations_mission verbatim when set", async () => {
    const config = makeAgentConfig({
      memory: { observations_mission: "operator obs text" },
    } as Partial<AgentConfig>);
    const seen = runScaffold(null, config);
    const args = await seen;
    expect((args.config_updates as Record<string, unknown>).observations_mission).toBe(
      "operator obs text",
    );
  }, 15_000);

  // The outcome the per-profile defaults exist for: a bank on a profile that
  // HAS an observations default must end up carrying that profile's mission on
  // the wire, not the generic fleet default. Verified to bite by deleting
  // `observations_mission` from PROFILE_MEMORY_DEFAULTS.coding — the received
  // value falls back to DEFAULT_OBSERVATIONS_MISSION and this fails.
  it("seeds the PROFILE mission onto a profiled agent's bank", async () => {
    const config = makeAgentConfig({ extends: "coding" });
    const args = await runScaffold(null, config);
    expect((args.config_updates as Record<string, unknown>).observations_mission).toBe(
      PROFILE_MEMORY_DEFAULTS.coding.observations_mission,
    );
  }, 15_000);

  // Option-B decoupling: an agent on the `default` PERSONA profile opts its
  // bank into the `coding` MEMORY bundle via `memory.profile`. BOTH halves must
  // key off the resolved memory profile — the observations_mission AND the
  // disposition — or an opt-in gets a half-applied bundle. Verified to bite:
  // reverting scaffold's `resolveMemoryProfile(agentConfig)` back to
  // `agentConfig.extends ?? DEFAULT_PROFILE` resolves the profile to `default`,
  // so the observations_mission falls back to the fleet default and the coding
  // disposition disappears from the wire — both assertions below fail.
  it("keys BOTH observations_mission and disposition off memory.profile, not extends", async () => {
    const config = makeAgentConfig({
      extends: "default",
      memory: { profile: "coding" },
    } as Partial<AgentConfig>);
    // A bank with NO disposition yet, so all three traits are genuinely on the
    // wire rather than suppressed as already-current.
    const args = await runScaffold(null, config, [], {});
    const updates = args.config_updates as Record<string, unknown>;
    // Observations: the coding profile mission, not the generic fleet default.
    expect(updates.observations_mission).toBe(
      PROFILE_MEMORY_DEFAULTS.coding.observations_mission,
    );
    // Disposition: the coding profile's flattened traits, not the engine default.
    expect(updates.disposition_skepticism).toBe(4);
    expect(updates.disposition_literalism).toBe(5);
    expect(updates.disposition_empathy).toBe(2);
  }, 15_000);

  it("upgrades a profiled agent's bank off the generic fleet default", async () => {
    const config = makeAgentConfig({ extends: "executive-assistant" });
    const args = await runScaffold(DEFAULT_OBSERVATIONS_MISSION, config);
    expect((args.config_updates as Record<string, unknown>).observations_mission).toBe(
      PROFILE_MEMORY_DEFAULTS["executive-assistant"].observations_mission,
    );
  }, 15_000);

  it("still leaves a hand-authored mission alone on a PROFILED agent", async () => {
    const config = makeAgentConfig({ extends: "health-coach" });
    const calls: Record<string, unknown>[] = [];
    runScaffold("You consolidate the memory of a coach. Retain durably: …", config, calls);
    await flushPendingBankOps(10_000);
    expect(
      calls.some(
        (c) => (c.config_updates as Record<string, unknown> | undefined)?.observations_mission,
      ),
    ).toBe(false);
  }, 15_000);
});

/**
 * End-to-end outcome test for the 2026-07-25 RE-review finding H1.
 *
 * `switchroom apply` calls `scaffoldAgent` for EVERY agent on every run — it
 * never calls `reconcileAgent` (src/cli/apply.ts:1512). So the reconcile-side
 * guard above was unreachable on the path operators actually run: scaffold
 * pushed `retain_mission: userRetainMission ?? DEFAULT_RETAIN_MISSION`
 * unconditionally, clobbering a customized mission on an existing bank.
 *
 * These tests drive the real `scaffoldAgent` with hindsight ENABLED against a
 * stubbed Hindsight and assert what goes out on the wire.
 *
 * Verified to bite (2026-07-25): with scaffold's unconditional
 * `?? DEFAULT_RETAIN_MISSION` seed restored, "does NOT clobber…" fails with
 * the received value being DEFAULT_RETAIN_MISSION.
 */
describe("scaffoldAgent — retain_mission against an existing bank", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  /**
   * Stub Hindsight and run a scaffold of an ALREADY-SCAFFOLDED agent dir (the
   * `switchroom apply` shape: apply re-scaffolds every existing agent). The
   * first scaffold runs with memory disabled so it issues no Hindsight traffic
   * that could be mistaken for the second one's push.
   *
   * `readOk: false` simulates the REST config read failing (a transient
   * Hindsight hiccup) — the branch that must NOT clobber.
   */
  function runScaffoldOnExisting(
    config: AgentConfig,
    currentMission: string | null,
    opts: { readOk?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-scaffold-retain-"));
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    let resolveArgs: (a: Record<string, unknown>) => void;
    const seen = new Promise<Record<string, unknown>>((r) => (resolveArgs = r));
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        if (opts.readOk === false) return { ok: false, status: 503 } as any;
        return {
          ok: true,
          json: async () => ({ config: { retain_mission: currentMission } }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") {
        resolveArgs(body.params.arguments as Record<string, unknown>);
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    return seen;
  }

  function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      ...overrides,
    } as AgentConfig;
  }

  it("does NOT clobber an operator-customized bank mission on re-scaffold", async () => {
    const config = makeAgentConfig({
      memory: { reflect_mission: "persona" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, "CUSTOM operator mission");
    expect(args.config_updates).toBeDefined();
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBeUndefined();
  }, 15_000);

  it("UPGRADES a bank still carrying a superseded default", async () => {
    const config = makeAgentConfig();
    const args = await runScaffoldOnExisting(
      config,
      SUPERSEDED_RETAIN_MISSIONS[SUPERSEDED_RETAIN_MISSIONS.length - 1],
    );
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe(
      DEFAULT_RETAIN_MISSION,
    );
  }, 15_000);

  it("seeds the default into a genuinely fresh bank (mission unset)", async () => {
    const config = makeAgentConfig();
    const args = await runScaffoldOnExisting(config, null);
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe(
      DEFAULT_RETAIN_MISSION,
    );
  }, 15_000);

  it("pushes the operator's yaml retain_mission verbatim, over a customized bank", async () => {
    const config = makeAgentConfig({
      memory: { retain_mission: "operator text" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, "CUSTOM operator mission");
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe("operator text");
  }, 15_000);

  // L3: the read-failure branches. A transient Hindsight hiccup must never be
  // read as "unset" (which isUpgradableRetainMission treats as upgradable).
  it("read fails + no yaml mission → pushes NO retain_mission", async () => {
    const config = makeAgentConfig({
      memory: { reflect_mission: "persona" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, null, { readOk: false });
    expect(args.config_updates).toBeDefined();
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBeUndefined();
  }, 15_000);

  it("read fails + yaml mission set → still pushes the config mission", async () => {
    const config = makeAgentConfig({
      memory: { retain_mission: "operator text" },
    } as Partial<AgentConfig>);
    const args = await runScaffoldOnExisting(config, null, { readOk: false });
    expect((args.config_updates as Record<string, unknown>).retain_mission).toBe("operator text");
  }, 15_000);

  /**
   * N1 (PR #3529 review): post-upgrade steady state is "nothing to update" —
   * the `default` profile contributes no mission extras, the bank carries a
   * customized retain_mission, and no bank_mission is configured. The scaffold
   * site used to fire `update_bank` with `{}` anyway (two HTTP round-trips per
   * agent per apply) and print a green success line for a call that changed
   * nothing. Reconcile already guarded on emptiness; scaffold now does too.
   */
  function runScaffoldNoOp(config: AgentConfig): Promise<{
    updateBankCalls: number;
    logs: string[];
  }> {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-scaffold-noop-"));
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    let updateBankCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith("/config")) {
        return {
          ok: true,
          json: async () => ({
            config: {
              retain_mission: "CUSTOM operator mission",
              // Steady state: the bank already carries the fleet disposition
              // floor, so "nothing to update" really is nothing.
              disposition_skepticism: FLEET_DEFAULT_DISPOSITION.skepticism,
            },
          }),
        } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") updateBankCalls += 1;
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    return flushPendingBankOps(10_000).then(() => {
      logSpy.mockRestore();
      return { updateBankCalls, logs };
    });
  }

  it("sends NO update_bank when there is nothing to update", async () => {
    const { updateBankCalls } = await runScaffoldNoOp(makeAgentConfig());
    expect(updateBankCalls).toBe(0);
  }, 15_000);

  it("prints no 'Bank missions updated' line when nothing was updated", async () => {
    const { logs } = await runScaffoldNoOp(makeAgentConfig());
    expect(logs.some((l) => l.includes("Bank missions updated"))).toBe(false);
  }, 15_000);

  it("still updates (and says so) when the profile contributes mission extras", async () => {
    const config = makeAgentConfig({
      memory: { reflect_mission: "persona" },
    } as Partial<AgentConfig>);
    const { updateBankCalls, logs } = await runScaffoldNoOp(config);
    expect(updateBankCalls).toBe(1);
    expect(logs.some((l) => l.includes("Bank missions updated"))).toBe(true);
  }, 15_000);
});

/**
 * L2 (2026-07-25 re-review): scaffold/reconcile start their bank-op chain
 * fire-and-forget because both functions are synchronous. Node normally drains
 * it, but `runApply` hard-`process.exit()`s (codes 4/5/6) in vault phases that
 * run AFTER the scaffold loop, which would truncate an in-flight push — and
 * the new retain-mission read widened that window. `flushPendingBankOps` makes
 * the drain deterministic; apply awaits it right after the scaffold loop.
 */
describe("flushPendingBankOps", () => {
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
    memory: { backend: "hindsight", config: { url: "http://hindsight.test/mcp/" } },
  } as unknown as SwitchroomConfig;

  const realFetch = globalThis.fetch;
  let tmpDir = "";

  afterEach(async () => {
    await flushPendingBankOps(5_000);
    globalThis.fetch = realFetch;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  it("resolves immediately when nothing is in flight", async () => {
    // The beforeEach reset guarantees the registry really is empty, so a zero
    // budget is a genuine discriminator: only the size===0 early return can
    // return true here. With a leftover chain this would resolve false.
    expect(__pendingBankOpsCountForTests()).toBe(0);
    expect(await flushPendingBankOps(0)).toBe(true);
  });

  // N2b: entries must self-evict on settle, otherwise a long-lived process
  // (setup / agent / doctor / rename / the reconcile bridge all push, none
  // flush) grows the registry by one promise per scaffold, forever.
  it("drops settled chains without anyone calling the flush", async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-evict-"));
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith("/config")) {
        return { ok: true, json: async () => ({ config: { retain_mission: null } }) } as any;
      }
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;

    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    expect(__pendingBankOpsCountForTests()).toBe(1);

    const deadline = Date.now() + 10_000;
    while (__pendingBankOpsCountForTests() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(__pendingBankOpsCountForTests()).toBe(0);
  }, 20_000);

  it("waits for the mission push a synchronous scaffold left in flight", async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-flush-"));
    let updatePushed = false;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      // A slow Hindsight: every call takes a beat, so the push is genuinely
      // still in flight when scaffoldAgent returns.
      await new Promise((r) => setTimeout(r, 20));
      if (u.endsWith("/config")) {
        return { ok: true, json: async () => ({ config: { retain_mission: null } }) } as any;
      }
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body?.params?.name === "update_bank") updatePushed = true;
      return {
        ok: true,
        headers: new Map(),
        text: async () => JSON.stringify({ result: { isError: false, content: [] } }),
      } as any;
    }) as any;

    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    // scaffoldAgent is synchronous: the push has NOT landed on return.
    expect(updatePushed).toBe(false);

    expect(await flushPendingBankOps(10_000)).toBe(true);
    // After the flush it has — this is exactly what apply's exit paths needed.
    expect(updatePushed).toBe(true);
  }, 20_000);

  it("returns false rather than hanging when the chain outlives the deadline", async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "switchroom-flush-slow-"));
    globalThis.fetch = (async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      return { ok: true, headers: new Map(), json: async () => ({ config: { retain_mission: null } }), text: async () => "{}" } as any;
    }) as any;

    const config = { extends: "default", topic_name: "T", schedule: [] } as unknown as AgentConfig;
    scaffoldAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    expect(await flushPendingBankOps(50)).toBe(false);
  }, 20_000);
});

describe("updateBankMissions", () => {
  it("calls update_bank with both missions when provided", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      {
        bank_mission: "Test bank mission",
        retain_mission: "Test retain mission",
      },
      { fetchImpl: mockFetch as any, timeoutMs: 5000 }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Check initialize call
    const initCall = mockFetch.mock.calls[0];
    expect(initCall[0]).toBe("http://test.local/mcp/");
    const initBody = JSON.parse(initCall[1].body);
    expect(initBody.method).toBe("initialize");

    // Check tools/call update_bank
    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.method).toBe("tools/call");
    expect(toolBody.params.name).toBe("update_bank");
    // retain_mission is NOT a top-level update_bank arg (the server silently
    // drops it) — it is a config field routed through config_updates.
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Test bank mission",
      config_updates: { retain_mission: "Test retain mission" },
    });
  });

  it("omits config_updates when only bank_mission is set (no retain_mission)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map([["mcp-session-id", "test-session"]]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Only bank mission" },
      { fetchImpl: mockFetch as any }
    );

    const toolCall = mockFetch.mock.calls[1];
    const toolBody = JSON.parse(toolCall[1].body);
    expect(toolBody.params.arguments).toEqual({
      bank_id: "test-bank",
      mission: "Only bank mission",
    });
  });

  it("returns error when Hindsight returns 5xx", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: false, reason: "HTTP 500" });
  });

  it("returns error on timeout", async () => {
    const mockFetch = vi.fn().mockImplementation((_url: any, init: any) => {
      return new Promise((resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        const timer = setTimeout(
          () => resolve({ ok: true, headers: new Map() } as any),
          10000
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any, timeoutMs: 100 }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Timeout");
  });

  it("tolerates a stateless server (no mcp-session-id) and proceeds without the header", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Map(), // stateless: no mcp-session-id
      } as any)
      .mockResolvedValueOnce({
        ok: true,
      } as any);

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const toolHeaders = mockFetch.mock.calls[1][1].headers;
    expect("mcp-session-id" in toolHeaders).toBe(false);
  });

  it("returns error on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

    const result = await updateBankMissions(
      "http://test.local/mcp/",
      "test-bank",
      { bank_mission: "Test" },
      { fetchImpl: mockFetch as any }
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Network error");
  });

  // --- Phase 2: reflect_mission / observations_mission / disposition ---

  it("routes reflect_mission + observations_mission through config_updates", async () => {
    const args = await captureUpdateBankArgs({
      reflect_mission: "You are a legal analyst.",
      observations_mission: "Synthesise obligations and risks.",
    });
    // reflect_mission is explicit → NO top-level `mission` (they target the
    // same engine field; explicit reflect_mission wins deterministically).
    expect(args).toEqual({
      bank_id: "test-bank",
      config_updates: {
        reflect_mission: "You are a legal analyst.",
        observations_mission: "Synthesise obligations and risks.",
      },
    });
    expect("mission" in args).toBe(false);
  });

  it("flattens disposition to disposition_* integer config fields", async () => {
    const args = await captureUpdateBankArgs({
      disposition: { skepticism: 4, literalism: 5, empathy: 2 },
    });
    expect(args.config_updates).toEqual({
      disposition_skepticism: 4,
      disposition_literalism: 5,
      disposition_empathy: 2,
    });
  });

  it("omits unset disposition traits from config_updates", async () => {
    const args = await captureUpdateBankArgs({ disposition: { empathy: 5 } });
    expect(args.config_updates).toEqual({ disposition_empathy: 5 });
  });

  it("keeps the legacy top-level mission route for a bare bank_mission", async () => {
    const args = await captureUpdateBankArgs({ bank_mission: "Persona X" });
    expect(args).toEqual({ bank_id: "test-bank", mission: "Persona X" });
  });

  it("reflect_mission wins over bank_mission (drops the top-level mission)", async () => {
    const args = await captureUpdateBankArgs({
      bank_mission: "legacy persona",
      reflect_mission: "explicit persona",
    });
    expect("mission" in args).toBe(false);
    expect(args.config_updates).toEqual({ reflect_mission: "explicit persona" });
  });

  it("omits config_updates entirely when only a bank_mission is set", async () => {
    const args = await captureUpdateBankArgs({ bank_mission: "just persona" });
    expect("config_updates" in args).toBe(false);
  });
});

describe("resolveBankMissionExtras", () => {
  it("returns built-in profile defaults when config is empty", () => {
    expect(resolveBankMissionExtras(undefined, "health-coach")).toEqual({
      disposition: { skepticism: 2, literalism: 2, empathy: 5 },
      observations_mission: PROFILE_MEMORY_DEFAULTS["health-coach"].observations_mission,
    });
  });

  it("returns no MISSIONS for a profile without defaults — only the fleet disposition floor", () => {
    // Was `{}` before the fleet-wide disposition floor. The floor is the ONLY
    // thing a profile-less, config-less agent now gets: no mission text is
    // invented for it, which is what this test has always guarded.
    expect(resolveBankMissionExtras(undefined, "default")).toEqual({
      disposition: FLEET_DEFAULT_DISPOSITION,
    });
    expect(resolveBankMissionExtras({}, "some-unknown-profile")).toEqual({
      disposition: FLEET_DEFAULT_DISPOSITION,
    });
  });

  it("merges disposition per-key: config trait overrides, others inherit profile", () => {
    const extras = resolveBankMissionExtras({ disposition: { empathy: 1 } }, "health-coach");
    expect(extras.disposition).toEqual({ skepticism: 2, literalism: 2, empathy: 1 });
  });

  it("config observations_mission overrides the profile default wholesale", () => {
    const extras = resolveBankMissionExtras(
      { observations_mission: "custom" },
      "health-coach",
    );
    expect(extras.observations_mission).toBe("custom");
  });

  it("passes reflect_mission straight through (no profile default for it)", () => {
    const extras = resolveBankMissionExtras({ reflect_mission: "hi" }, "coding");
    expect(extras.reflect_mission).toBe("hi");
    // coding still contributes its disposition default
    expect(extras.disposition).toEqual({ skepticism: 4, literalism: 5, empathy: 2 });
  });
});

describe("AgentMemorySchema — Phase 2 fields", () => {
  it("accepts reflect_mission, observations_mission, and in-range disposition", () => {
    const parsed = AgentMemorySchema.parse({
      collection: "b",
      reflect_mission: "r",
      observations_mission: "o",
      disposition: { skepticism: 1, literalism: 3, empathy: 5 },
    });
    expect(parsed.disposition).toEqual({ skepticism: 1, literalism: 3, empathy: 5 });
  });

  it("rejects disposition traits outside 1-5", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { empathy: 6 } }),
    ).toThrow();
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { skepticism: 0 } }),
    ).toThrow();
  });

  it("rejects non-integer disposition traits", () => {
    expect(() =>
      AgentMemorySchema.parse({ collection: "b", disposition: { literalism: 2.5 } }),
    ).toThrow();
  });
});
