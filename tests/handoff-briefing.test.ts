/**
 * Tests for the handoff-briefing assembler (bin/handoff-briefing.sh) and
 * the schema default change (resume_mode defaults to 'handoff').
 *
 * These tests cover:
 *   - Schema: resume_mode parsed default is 'handoff'
 *   - scaffold: start.sh template with handoff mode does NOT contain --continue
 *   - scaffold: start.sh template with continue mode DOES contain --continue
 *   - Briefing assembler: combines all three sources, gracefully degrades if any missing
 *   - Briefing assembler: empty-state produces empty briefing rather than crashing
 *   - Migration warning: fires once when auto-detected without explicit setting;
 *                        suppressed after marker file is created
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import { SessionContinuitySchema } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

// ── Schema default ──────────────────────────────────────────────────────────────

describe("schema: resume_mode default", () => {
  it("SessionContinuitySchema accepts 'handoff' as a valid value", () => {
    const result = SessionContinuitySchema.safeParse({ resume_mode: "handoff" });
    expect(result.success).toBe(true);
  });

  it("SessionContinuitySchema accepts 'auto', 'continue', 'none' for migration", () => {
    for (const mode of ["auto", "continue", "none"] as const) {
      const result = SessionContinuitySchema.safeParse({ resume_mode: mode });
      expect(result.success).toBe(true);
    }
  });

  it("scaffold defaults resume_mode to 'handoff' when not explicitly set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "handoff-schema-"));
    try {
      const result = scaffoldAgent(
        "default-mode-agent",
        makeAgentConfig(),
        tmp,
        telegramConfig,
      );
      const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
      expect(startSh).toContain('SWITCHROOM_RESUME_MODE="handoff"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── start.sh mode behaviours ────────────────────────────────────────────────────

describe("scaffold: start.sh resume mode behaviours", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-scaffold-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handoff mode (default) does NOT contain --continue in CONTINUE_FLAG assignment", () => {
    const result = scaffoldAgent(
      "handoff-default",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('SWITCHROOM_RESUME_MODE="handoff"');
    // In handoff/none mode the auto/continue case branches are omitted entirely
    // so CONTINUE_FLAG="--continue" never appears in the rendered script (#377).
    expect(startSh).not.toContain('CONTINUE_FLAG="--continue"');
    expect(startSh).not.toMatch(/case "\$SWITCHROOM_RESUME_MODE" in/);
  });

  it("explicit continue mode DOES pass --continue (regression guard for opt-in)", () => {
    const result = scaffoldAgent(
      "continue-explicit",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('SWITCHROOM_RESUME_MODE="continue"');
    expect(startSh).toContain('CONTINUE_FLAG="--continue"');
  });

  it("explicit auto mode still generates size-check branch and --continue path", () => {
    const result = scaffoldAgent(
      "auto-explicit",
      makeAgentConfig({
        session_continuity: { resume_mode: "auto" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('SWITCHROOM_RESUME_MODE="auto"');
    expect(startSh).toContain('CONTINUE_FLAG="--continue"');
    expect(startSh).toMatch(/SWITCHROOM_RESUME_MAX_BYTES/);
  });

  it("force-fresh (.force-fresh-session) overrides handoff mode and clears CONTINUE_FLAG", () => {
    // The /reset and /new commands write .force-fresh-session, which must
    // override any resume mode including 'continue'. This is a regression guard.
    const result = scaffoldAgent(
      "force-fresh-test",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The force-fresh block must always be present regardless of resume_mode
    expect(startSh).toContain(".force-fresh-session");
    expect(startSh).toContain('CONTINUE_FLAG=""');
    expect(startSh).toContain("_FORCE_FRESH=1");
  });

  it("/new and /reset force fresh session even in continue mode (start.sh structure check)", () => {
    // In continue mode start.sh should still have the .force-fresh-session override
    // block that unconditionally clears CONTINUE_FLAG.
    const result = scaffoldAgent(
      "reset-override-test",
      makeAgentConfig({
        session_continuity: { resume_mode: "continue" },
      } as Partial<AgentConfig>),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // The CONTINUE_FLAG-clearing force-fresh CONSUME block (inner pass)
    // appears AFTER the resume-mode case block. Anchor on its unique
    // `_FORCE_FRESH=0` sentinel rather than the first `.force-fresh-session`
    // string: the OUTER pass now ALSO references `.force-fresh-session`
    // earlier, where it snapshots the marker into SWITCHROOM_FORCE_FRESH
    // before the gateway fork (env-keyed briefing suppression — see
    // scaffold.gateway-env-order.test.ts). That outer reference does NOT
    // clear CONTINUE_FLAG, so it must not be what this structure check finds.
    const caseIdx = startSh.indexOf('case "$SWITCHROOM_RESUME_MODE" in');
    const forceFreshIdx = startSh.indexOf("_FORCE_FRESH=0");
    expect(caseIdx).toBeGreaterThan(-1);
    expect(forceFreshIdx).toBeGreaterThan(caseIdx);
    // Force-fresh clears CONTINUE_FLAG unconditionally
    const forceFreshBlock = startSh.slice(forceFreshIdx);
    expect(forceFreshBlock).toContain('CONTINUE_FLAG=""');
  });

  it("rebuilds a stale handoff briefing and consumes the sidecars (#2790)", () => {
    // A clean shutdown leaves a non-empty .handoff.md; a later hard crash never
    // refreshes it. The boot gate must therefore rebuild when the newest session
    // JSONL is newer than .handoff.md — not merely when .handoff.md is empty —
    // and must consume the sidecars after injection so they can't be re-served.
    const result = scaffoldAgent(
      "stale-handoff-test",
      makeAgentConfig(),
      tmpDir,
      telegramConfig,
    );
    const startSh = readFileSync(join(result.agentDir, "start.sh"), "utf-8");
    // Staleness guard: compare JSONL mtime against .handoff.md mtime, not just -s.
    expect(startSh).toContain("_HANDOFF_STALE=1");
    expect(startSh).toMatch(/_JSONL_MOD.*-gt.*_HANDOFF_MOD|"\$_JSONL_MOD" -gt "\$_HANDOFF_MOD"/);
    // The old empty-only gate must be gone.
    expect(startSh).not.toContain('if [ ! -s "$HANDOFF_FILE" ]; then\n  _LATEST_JSONL=');
    // Sidecars are consumed after injection so a later crash can't re-serve them.
    expect(startSh).toContain('rm -f "$HANDOFF_BRIEFING_FILE" "$HANDOFF_FILE"');
  });
});

// ── Briefing assembler script ───────────────────────────────────────────────────

const HANDOFF_BRIEFING_SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "../bin/handoff-briefing.sh",
);

/** Returns today's date as YYYY-MM-DD in local time, matching `date +%Y-%m-%d` in bash. */
function localDateString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// YYYY-MM-DD for "now" as observed in the given IANA timezone (en-CA yields
// ISO-ordered date parts). Matches what `TZ=<zone> date +%Y-%m-%d` prints.
function dateInZone(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Two real IANA zones whose local clocks are 25h apart (UTC+14 vs UTC-11), so
// their calendar dates ALWAYS differ by exactly one day — at every instant,
// independent of the runner's wall clock. This gives a *deterministic* (not
// luck-of-the-date) UTC/local date-divergence window: agentZone is a full day
// ahead of procZone, always.
const AGENT_ZONE = "Pacific/Kiritimati"; // UTC+14 — the agent's SWITCHROOM_TIMEZONE
const PROC_ZONE = "Pacific/Midway"; //     UTC-11 — the process TZ (what un-TZ'd `date` reads)

/**
 * "Today" exactly as handoff-briefing.sh will compute it — run the SAME
 * `date +%Y-%m-%d` the script runs (bin/handoff-briefing.sh `TODAY=`),
 * under the EXACT env the script will receive. Tests that pin or delete
 * TZ/SWITCHROOM_TIMEZONE in the child env MUST name the daily-memory file
 * with this (not `localDateString()`, which uses the vitest process TZ):
 * a UTC runner between 14:00–24:00 UTC is already "tomorrow" in
 * Australia/Melbourne, so the two dates disagree and the script finds no
 * daily memory — the pre-existing date-boundary flake in this file.
 */
function scriptDateString(env: NodeJS.ProcessEnv): string {
  const r = spawnSync("bash", ["-c", "date +%Y-%m-%d"], { env, timeout: 5_000 });
  return r.stdout.toString().trim();
}

describe("handoff-briefing.sh assembler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-briefing-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("script exists and is executable", () => {
    expect(existsSync(HANDOFF_BRIEFING_SCRIPT)).toBe(true);
    // Check it's executable by running it with --stdout in empty-state (should produce empty output)
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    // Should exit 0 (empty state = no output = exit 0)
    expect(result.status).toBe(0);
  });

  it("empty state: produces empty briefing and exits 0", () => {
    // No telegram DB, no hindsight, no daily memory — should produce nothing
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: join(tmpDir, "telegram"),
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("");
  });

  it("daily memory: injects today's daily memory file when present", () => {
    // Create a fake daily memory file for today
    const today = localDateString(); // YYYY-MM-DD in local time (matches bash `date +%Y-%m-%d`)
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Worked on handoff feature\n- PR review pending\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("Today's memory");
    expect(output).toContain("Worked on handoff feature");
    expect(output).toContain("PR review pending");
  });

  it("daily memory: skips gracefully when memory dir is absent", () => {
    // No memory/ directory at all
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString().trim()).toBe("");
  });

  it("writes output to .handoff-briefing.md when not in stdout mode", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Daily note for file output test\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const outputFile = join(tmpDir, ".handoff-briefing.md");
    expect(existsSync(outputFile)).toBe(true);
    const content = readFileSync(outputFile, "utf-8");
    expect(content).toContain("Daily note for file output test");
  });

  it("includes restart timestamp header when any source has content", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Some content\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("You just restarted at");
    expect(output).toContain("Previous session ended via:");
  });

  it("renders the restart timestamp in LOCAL am/pm — never a UTC Z instant (deterministic-local-time)", () => {
    // Regression guard for the resume-turn UTC vector: the "You just restarted
    // at …" line is injected into the resume-turn system prompt, so its time
    // must be local am/pm, NOT the old `date -u +%Y-%m-%dT%H:%M:%SZ`. Nothing
    // guarded this before, which is how it slipped past the first pass.
    //
    // The script runs under TZ=Australia/Melbourne, so "today" (and the
    // daily-memory filename it looks for) must be derived under THAT zone —
    // not the runner's process TZ. A UTC CI runner after 14:00 UTC is
    // already tomorrow in Melbourne; using localDateString() here made the
    // script find no daily memory and the regex match null (date-boundary
    // flake, pre-existing from #3275). Derive it under the child's exact env.
    const env = {
      ...process.env,
      AGENT_DIR: tmpDir,
      TELEGRAM_STATE_DIR: "",
      HINDSIGHT_API_URL: "",
      HINDSIGHT_BANK_ID: "",
      WORKSPACE_DIR: tmpDir,
      SWITCHROOM_TIMEZONE: "Australia/Melbourne",
      TZ: "Australia/Melbourne",
    };
    const today = scriptDateString(env);
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Restart-time guard\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env,
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    // Extract the timestamp between "restarted at " and ". Previous session".
    const m = output.match(/You just restarted at (.+?)\. Previous session ended via:/);
    expect(m).not.toBeNull();
    const stamp = m![1];
    // Local am/pm shape with a zone abbrev: e.g. "Thursday 2026-07-16 04:09 PM AEST".
    expect(stamp).toMatch(/ (?:AM|PM) [A-Za-z]{2,5}$/);
    // The banned forms: bare "HH:MM UTC" wall clock and ISO trailing-Z.
    expect(stamp).not.toMatch(/\d{1,2}:\d{2}(?::\d{2})?\s*UTC/);
    expect(stamp).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(stamp.endsWith("Z")).toBe(false);
    expect(stamp).not.toContain("UTC");
  });

  it("resolves TODAY (daily-memory lookup) in the agent's LOCAL zone, not UTC — date-boundary regression", () => {
    // Regression for the un-TZ'd `TODAY=$(date +%Y-%m-%d)` at bin/handoff-briefing.sh:139.
    // TODAY keys the memory/${TODAY}.md lookup. The agent's SWITCHROOM_TIMEZONE
    // (AGENT_ZONE, UTC+14) is a full calendar day AHEAD of the process TZ
    // (PROC_ZONE, UTC-11) at every instant. We write the daily file under the
    // agent-LOCAL date. Old code reads the process TZ → PROC_ZONE date → looks up
    // the WRONG (day-behind) file → miss → drops the whole restart header. Fixed
    // code applies the SWITCHROOM_TIMEZONE cascade → AGENT_ZONE date → hit.
    const agentDate = dateInZone(AGENT_ZONE);
    const procDate = dateInZone(PROC_ZONE);
    expect(agentDate).not.toBe(procDate); // deterministic: 25h apart ⇒ always different days

    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    // File named for the agent's LOCAL date only — NOT the process-TZ date.
    writeFileSync(join(memDir, `${agentDate}.md`), "- Local-date daily memory\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
        // Agent's local zone via SWITCHROOM_TIMEZONE; process TZ a full day behind
        // so the OLD un-TZ'd `date` resolves to the wrong day and misses the file.
        SWITCHROOM_TIMEZONE: AGENT_ZONE,
        TZ: PROC_ZONE,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    // The daily memory (and therefore the restart header) must be present because
    // TODAY resolved to the agent-LOCAL date the file was written under.
    expect(output).toContain("Local-date daily memory");
    expect(output).toContain(`Today's memory (${agentDate})`);
    expect(output).toContain("You just restarted at");
  });

  it("restart timestamp falls back to am/pm even with no timezone configured (no UTC 24h form)", () => {
    const env = {
      ...process.env,
      AGENT_DIR: tmpDir,
      TELEGRAM_STATE_DIR: "",
      HINDSIGHT_API_URL: "",
      HINDSIGHT_BANK_ID: "",
      WORKSPACE_DIR: tmpDir,
    } as NodeJS.ProcessEnv;
    delete env.SWITCHROOM_TIMEZONE;
    delete env.TZ;

    // With TZ deleted, the child bash falls back to the SYSTEM zone, which
    // may differ from the vitest process's TZ env — derive "today" under the
    // child's env (same date-boundary rationale as the Melbourne test above).
    const today = scriptDateString(env);
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Restart-time fallback guard\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env,
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    const m = output.match(/You just restarted at (.+?)\. Previous session ended via:/);
    expect(m).not.toBeNull();
    // am/pm form even in the UTC fallback — never the old "%Y-%m-%d %H:%M:%S UTC" 24h shape.
    expect(m![1]).toMatch(/ (?:AM|PM) /);
    expect(m![1]).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it("hindsight skipped gracefully when API URL is empty", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Hindsight skip test\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "testbank",
        WORKSPACE_DIR: tmpDir,
      },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    // Should have daily content but no Hindsight section
    expect(output).toContain("Hindsight skip test");
    expect(output).not.toContain("Hindsight recall");
  });

  it("hindsight skipped gracefully when API is unreachable", () => {
    const today = localDateString();
    const memDir = join(tmpDir, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), "- Unreachable hindsight test\n", "utf-8");

    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: "",
        // Point to a non-existent port — should timeout quickly and continue
        HINDSIGHT_API_URL: "http://127.0.0.1:19999",
        HINDSIGHT_BANK_ID: "testbank",
        WORKSPACE_DIR: tmpDir,
        HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT: "1",
      },
      timeout: 15_000,
    });
    expect(result.status).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("Unreachable hindsight test");
  });
});

// ── Recent-conversation chat/thread scoping ─────────────────────────────────────
//
// The scope resolver in bin/handoff-briefing.sh picks a SINGLE surface for the
// "Recent conversation" section so a forum/group agent's multi-topic history.db
// doesn't pollute reorientation with unrelated threads. These tests seed a real
// history.db — the EXACT gateway schema (telegram-plugin/history.ts `messages`
// table) — via python3's stdlib sqlite3 (the same engine the script reads it
// back with, so no bun:sqlite → the suite stays in the vitest pass) and assert
// which messages land in the output. Each asserts the OUTCOME (which texts
// appear), so a regression in the scoping SQL would fail them.

interface SeedRow {
  chat_id: string;
  thread_id: number | null;
  message_id: number;
  role: "user" | "assistant";
  user?: string | null;
  ts: number;
  text: string;
}

/**
 * Create + populate a history.db matching the gateway's `messages` schema
 * (chat_id TEXT, thread_id INTEGER NULL, message_id INTEGER, role, user, ts,
 * text, …) under `<stateDir>/history.db`, using python3 stdlib sqlite3. Pass
 * an empty `rows` array to create the table with zero rows (the "empty DB but
 * file exists" case).
 */
function seedHistoryDb(stateDir: string, rows: SeedRow[]): string {
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, "history.db");
  const py = `
import sys, json, sqlite3
db = sys.argv[1]
rows = json.loads(sys.argv[2])
c = sqlite3.connect(db)
c.execute(
    "CREATE TABLE IF NOT EXISTS messages ("
    "chat_id TEXT NOT NULL, thread_id INTEGER, message_id INTEGER NOT NULL, "
    "role TEXT NOT NULL, user TEXT, user_id TEXT, ts INTEGER NOT NULL, "
    "text TEXT NOT NULL, attachment_kind TEXT, group_id INTEGER, "
    "reply_to_message_id INTEGER, reply_to_text TEXT, "
    "PRIMARY KEY (chat_id, thread_id, message_id))"
)
for r in rows:
    c.execute(
        "INSERT INTO messages(chat_id,thread_id,message_id,role,user,user_id,ts,text) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (r["chat_id"], r.get("thread_id"), r["message_id"], r["role"],
         r.get("user"), None, r["ts"], r["text"]),
    )
c.commit()
c.close()
`;
  const res = spawnSync("python3", ["-c", py, dbPath, JSON.stringify(rows)], {
    timeout: 10_000,
  });
  if (res.status !== 0) {
    throw new Error(`seedHistoryDb failed: ${res.stderr?.toString() ?? ""}`);
  }
  return dbPath;
}

describe("handoff-briefing.sh recent-conversation scoping", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-scope-"));
    stateDir = join(tmpDir, "telegram");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run the assembler in --stdout mode with the given scope env, return stdout. */
  function runBriefing(
    scopeEnv: Record<string, string> = {},
  ): { status: number | null; output: string } {
    const result = spawnSync("bash", [HANDOFF_BRIEFING_SCRIPT, "--stdout"], {
      env: {
        ...process.env,
        AGENT_DIR: tmpDir,
        TELEGRAM_STATE_DIR: stateDir,
        HINDSIGHT_API_URL: "",
        HINDSIGHT_BANK_ID: "",
        WORKSPACE_DIR: tmpDir,
        ...scopeEnv,
      },
      timeout: 10_000,
    });
    return { status: result.status, output: result.stdout.toString() };
  }

  // A fixture spanning two chats and, within chatA, two numbered threads plus a
  // NULL-thread (general/DM) row. ts values make chatB the most-recently-active
  // surface overall, and chatA/thread5 the most recent WITHIN chatA.
  const FIXTURE: SeedRow[] = [
    { chat_id: "chatA", thread_id: 5, message_id: 1, role: "user", user: "alice", ts: 1000, text: "MSG-A-T5-user" },
    { chat_id: "chatA", thread_id: 5, message_id: 2, role: "assistant", ts: 1001, text: "MSG-A-T5-bot" },
    { chat_id: "chatA", thread_id: 9, message_id: 3, role: "user", user: "alice", ts: 900, text: "MSG-A-T9-user" },
    { chat_id: "chatA", thread_id: null, message_id: 4, role: "user", user: "alice", ts: 950, text: "MSG-A-NULL-user" },
    { chat_id: "chatB", thread_id: null, message_id: 5, role: "user", user: "bob", ts: 2000, text: "MSG-B-NULL-user" },
  ];

  const ALL_MARKERS = [
    "MSG-A-T5-user",
    "MSG-A-T5-bot",
    "MSG-A-T9-user",
    "MSG-A-NULL-user",
    "MSG-B-NULL-user",
  ];

  /** Assert ONLY the expected markers appear in the recent-conversation output. */
  function expectOnly(output: string, expected: string[]): void {
    for (const m of expected) expect(output).toContain(m);
    for (const m of ALL_MARKERS) {
      if (!expected.includes(m)) expect(output).not.toContain(m);
    }
  }

  it("env-target scoping: PENDING_CHAT_ID + numbered PENDING_THREAD_ID selects only that chat+thread", () => {
    seedHistoryDb(stateDir, FIXTURE);
    const { status, output } = runBriefing({
      SWITCHROOM_PENDING_CHAT_ID: "chatA",
      SWITCHROOM_PENDING_THREAD_ID: "5",
    });
    expect(status).toBe(0);
    expect(output).toContain("Recent conversation");
    // Only chatA/thread5 rows — never thread9, the NULL thread, or chatB.
    expectOnly(output, ["MSG-A-T5-user", "MSG-A-T5-bot"]);
  });

  it("db-latest derivation: with no env target, the single most-recently-active (chat,thread) surface wins", () => {
    seedHistoryDb(stateDir, FIXTURE);
    // No SWITCHROOM_PENDING_* → python derives db-latest. chatB/NULL (ts=2000)
    // is the most recent surface, so only its rows appear.
    const { status, output } = runBriefing();
    expect(status).toBe(0);
    expectOnly(output, ["MSG-B-NULL-user"]);
  });

  it("db-latest derivation scopes to the exact thread, excluding other threads of the SAME chat", () => {
    // Drop chatB so the most-recently-active surface is chatA/thread5 (ts=1001).
    // db-latest must scope to thread5 only — not chatA/thread9 or chatA/NULL.
    const noB = FIXTURE.filter((r) => r.chat_id !== "chatB");
    seedHistoryDb(stateDir, noB);
    const { status, output } = runBriefing();
    expect(status).toBe(0);
    expectOnly(output, ["MSG-A-T5-user", "MSG-A-T5-bot"]);
  });

  it("tri-state thread: PENDING_THREAD_ID='NULL' scopes to thread_id IS NULL (excludes numbered threads)", () => {
    seedHistoryDb(stateDir, FIXTURE);
    const { status, output } = runBriefing({
      SWITCHROOM_PENDING_CHAT_ID: "chatA",
      SWITCHROOM_PENDING_THREAD_ID: "NULL",
    });
    expect(status).toBe(0);
    // Only the NULL-thread row of chatA — NOT the numbered-thread rows.
    expectOnly(output, ["MSG-A-NULL-user"]);
  });

  it("tri-state thread: numbered PENDING_THREAD_ID scopes to that thread (excludes the NULL-thread rows)", () => {
    seedHistoryDb(stateDir, FIXTURE);
    const { status, output } = runBriefing({
      SWITCHROOM_PENDING_CHAT_ID: "chatA",
      SWITCHROOM_PENDING_THREAD_ID: "9",
    });
    expect(status).toBe(0);
    expectOnly(output, ["MSG-A-T9-user"]);
  });

  it("empty PENDING_THREAD_ID (unknown) falls back to chat-only scope (all threads of the chat)", () => {
    // The backward-compatible fallback: an OLD gateway (or genuinely-unknown
    // thread) emits an empty thread var → chat-only scope pulls every thread of
    // chatA (thread5, thread9, NULL) but never chatB.
    seedHistoryDb(stateDir, FIXTURE);
    const { status, output } = runBriefing({
      SWITCHROOM_PENDING_CHAT_ID: "chatA",
      SWITCHROOM_PENDING_THREAD_ID: "",
    });
    expect(status).toBe(0);
    expectOnly(output, ["MSG-A-T5-user", "MSG-A-T5-bot", "MSG-A-T9-user", "MSG-A-NULL-user"]);
  });

  it("env-target-with-zero-rows fallback: a stale env chat absent from the DB falls back to db-latest", () => {
    // Rotated/fresh DB: the pending-turn chat has no rows. Instead of silently
    // emitting an empty section, the resolver falls through to db-latest
    // (chatB/NULL, ts=2000).
    seedHistoryDb(stateDir, FIXTURE);
    const { status, output } = runBriefing({
      SWITCHROOM_PENDING_CHAT_ID: "chatGONE",
      SWITCHROOM_PENDING_THREAD_ID: "3",
    });
    expect(status).toBe(0);
    expect(output).toContain("Recent conversation");
    expectOnly(output, ["MSG-B-NULL-user"]);
  });

  it("empty DB (table exists, zero rows): no crash, no recent-conversation section, exit 0", () => {
    seedHistoryDb(stateDir, []);
    const { status, output } = runBriefing({
      SWITCHROOM_PENDING_CHAT_ID: "chatA",
      SWITCHROOM_PENDING_THREAD_ID: "5",
    });
    expect(status).toBe(0);
    expect(output).not.toContain("Recent conversation");
    expect(output.trim()).toBe("");
  });
});

// ── Migration warning ───────────────────────────────────────────────────────────

describe("reconcileAgent: migration warning for auto → handoff default change", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "handoff-migration-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMinimalAgentDir(name: string, baseDir: string): string {
    const agentDir = join(baseDir, name);
    mkdirSync(join(agentDir, ".claude"), { recursive: true });
    mkdirSync(join(agentDir, "telegram"), { recursive: true });
    mkdirSync(join(agentDir, "memory"), { recursive: true });
    // Write a minimal settings.json so reconcile doesn't error
    writeFileSync(
      join(agentDir, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: [], deny: [] },
        hooks: {},
      }),
      "utf-8",
    );
    return agentDir;
  }

  it("migration marker file does not exist before first reconcile", () => {
    const agentDir = makeMinimalAgentDir("warn-agent", tmpDir);
    const markerPath = join(agentDir, ".resume-mode-migration-warned");
    expect(existsSync(markerPath)).toBe(false);
  });

  it("marker file is created after reconcile when no explicit resume_mode", () => {
    const agentName = "warn-agent-2";
    makeMinimalAgentDir(agentName, tmpDir);

    const agentConfig = makeAgentConfig(); // no session_continuity.resume_mode
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    // Capture console.warn to avoid polluting test output
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // reconcile may error on missing files — that's ok for this test
    } finally {
      console.warn = origWarn;
    }

    const markerPath = join(tmpDir, agentName, ".resume-mode-migration-warned");
    expect(existsSync(markerPath)).toBe(true);
  });

  it("migration warning fires when no explicit resume_mode and no marker file", () => {
    const agentName = "warn-agent-3";
    makeMinimalAgentDir(agentName, tmpDir);

    const agentConfig = makeAgentConfig(); // no session_continuity.resume_mode
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // ignore reconcile errors — we only care about the warning
    } finally {
      console.warn = origWarn;
    }

    const warnText = warns.join("\n");
    expect(warnText).toContain("resume_mode default changed");
    expect(warnText).toContain("handoff");
    expect(warnText).toContain("#362");
  });

  it("migration warning is suppressed when marker file already exists", () => {
    const agentName = "warn-agent-4";
    const agentDir = makeMinimalAgentDir(agentName, tmpDir);

    // Pre-create the marker file
    const markerPath = join(agentDir, ".resume-mode-migration-warned");
    writeFileSync(markerPath, "already warned\n", "utf-8");

    const agentConfig = makeAgentConfig(); // no session_continuity.resume_mode
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // ignore reconcile errors
    } finally {
      console.warn = origWarn;
    }

    const warnText = warns.join("\n");
    expect(warnText).not.toContain("resume_mode default changed");
  });

  it("no migration warning when resume_mode is explicitly set in config", () => {
    const agentName = "warn-agent-5";
    makeMinimalAgentDir(agentName, tmpDir);

    const agentConfig = makeAgentConfig({
      session_continuity: { resume_mode: "handoff" },
    });
    const switchroomConfig: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: tmpDir },
      telegram: telegramConfig,
      agents: { [agentName]: agentConfig },
    } as SwitchroomConfig;

    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args.join(" "));

    try {
      reconcileAgent(agentName, agentConfig, tmpDir, telegramConfig, switchroomConfig);
    } catch {
      // ignore reconcile errors
    } finally {
      console.warn = origWarn;
    }

    const warnText = warns.join("\n");
    expect(warnText).not.toContain("resume_mode default changed");
  });
});
