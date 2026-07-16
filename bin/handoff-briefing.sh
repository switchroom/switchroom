#!/bin/bash
# handoff-briefing.sh — Assemble a context briefing for fresh-session handoff.
#
# Invoked by start.sh in 'handoff' mode instead of writing a .handoff-briefing.md
# from the previous session (which relies on the Stop hook summarizer). This
# script assembles a lighter-weight briefing from three sources:
#
#   1. Last 20 Telegram messages from the plugin SQLite history DB
#      ($TELEGRAM_STATE_DIR/history.db). Requires python3 + sqlite3 stdlib.
#
#   2. Hindsight recall results for "what was happening recently?"
#      via $HINDSIGHT_API_URL/v1/default/banks/$HINDSIGHT_BANK_ID/memories/recall
#      Requires curl + jq. Skipped gracefully if Hindsight is unreachable.
#
#   3. Today's daily memory from $WORKSPACE_DIR/memory/YYYY-MM-DD.md
#      Skipped if missing.
#
# Output is written to $AGENT_DIR/.handoff-briefing.md (or stdout if
# HANDOFF_BRIEFING_STDOUT=1 is set). start.sh injects this into
# --append-system-prompt.
#
# Graceful degradation: each source is attempted independently. Failure of
# any single source produces empty output for that section rather than
# crashing the whole briefing. A completely empty briefing (all sources
# missing) writes nothing so start.sh skips the --append-system-prompt arg.
#
# Prerequisites:
#   - python3 (stdlib sqlite3) — for Telegram history DB
#   - curl, jq                — for Hindsight recall (optional)
#   - TELEGRAM_STATE_DIR      — points to the plugin state dir containing history.db
#   - HINDSIGHT_API_URL       — base URL for Hindsight (optional)
#   - HINDSIGHT_BANK_ID       — bank/collection name (optional)
#   - WORKSPACE_DIR or AGENT_DIR — to locate memory/YYYY-MM-DD.md
#   - AGENT_DIR               — output destination (if HANDOFF_BRIEFING_STDOUT!=1)
#
# Usage:
#   handoff-briefing.sh [--stdout]
#
# The --stdout flag overrides HANDOFF_BRIEFING_STDOUT=1.

set -u

# ── Configuration ──────────────────────────────────────────────────────────────
TELEGRAM_STATE="${TELEGRAM_STATE_DIR:-}"
HINDSIGHT_URL="${HINDSIGHT_API_URL:-}"
HINDSIGHT_BANK="${HINDSIGHT_BANK_ID:-}"
AGENT_DIR="${AGENT_DIR:-}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$AGENT_DIR}"
MAX_MESSAGES="${HANDOFF_BRIEFING_MAX_MESSAGES:-20}"
HINDSIGHT_TIMEOUT="${HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT:-4}"

# Determine output mode
STDOUT_MODE=0
if [ "${HANDOFF_BRIEFING_STDOUT:-}" = "1" ] || [ "${1:-}" = "--stdout" ]; then
  STDOUT_MODE=1
fi

# ── Source 1: Recent Telegram messages ─────────────────────────────────────────
TELEGRAM_SECTION=""
if [ -n "$TELEGRAM_STATE" ] && [ -d "$TELEGRAM_STATE" ]; then
  HISTORY_DB="$TELEGRAM_STATE/history.db"
  if [ -f "$HISTORY_DB" ] && command -v python3 >/dev/null 2>&1; then
    # Use python3's stdlib sqlite3 — no bun:sqlite, no extra deps.
    # Query the most recent $MAX_MESSAGES rows ordered by ts DESC, then
    # reverse for chronological display. We skip system messages (role NULL).
    TELEGRAM_ROWS=$(python3 - "$HISTORY_DB" "$MAX_MESSAGES" 2>/dev/null <<'PYEOF'
import sys, sqlite3, datetime

db_path = sys.argv[1]
limit = int(sys.argv[2])

try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    # Fetch most recent rows; reverse for chronological output.
    cur.execute(
        """
        SELECT role, user, ts, text
        FROM messages
        WHERE role IN ('user', 'assistant')
        ORDER BY ts DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = list(reversed(cur.fetchall()))
    conn.close()
    for row in rows:
        ts_str = datetime.datetime.fromtimestamp(row["ts"]).strftime("%Y-%m-%d %H:%M")
        role = row["role"]
        label = row["user"] if role == "user" and row["user"] else role
        # Truncate long messages to keep the briefing concise
        text = row["text"] or ""
        if len(text) > 600:
            text = text[:600] + "… [truncated]"
        # Escape any literal backslash to keep the shell echo safe
        text = text.replace("\\", "\\\\")
        print(f"[{ts_str}] {label}: {text}")
except Exception as e:
    sys.stderr.write(f"handoff-briefing: sqlite query failed: {e}\n")
    sys.exit(0)
PYEOF
)
    if [ -n "$TELEGRAM_ROWS" ]; then
      TELEGRAM_SECTION="## Recent conversation (last $MAX_MESSAGES messages)

$TELEGRAM_ROWS"
    fi
  fi
fi

# ── Source 2: Hindsight recall ──────────────────────────────────────────────────
HINDSIGHT_SECTION=""
if [ -n "$HINDSIGHT_URL" ] && [ -n "$HINDSIGHT_BANK" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  RECALL_QUERY="what was happening recently in our conversation?"
  RECALL_RESPONSE=$(curl -sf -m "$HINDSIGHT_TIMEOUT" -X POST \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg q "$RECALL_QUERY" --argjson m 800 '{query: $q, max_tokens: $m}')" \
    "${HINDSIGHT_URL%/}/v1/default/banks/${HINDSIGHT_BANK}/memories/recall" 2>/dev/null)
  if [ -n "$RECALL_RESPONSE" ]; then
    RECALL_TEXT=$(printf '%s' "$RECALL_RESPONSE" | jq -r '
      if .results == null or (.results | length) == 0 then
        empty
      else
        (.results | map("- " + (.text // "(no text)") + (if .timestamp then " (" + .timestamp + ")" else "" end)) | join("\n"))
      end
    ' 2>/dev/null)
    if [ -n "$RECALL_TEXT" ]; then
      HINDSIGHT_SECTION="## Hindsight recall (recent context)

$RECALL_TEXT"
    fi
  fi
fi

# ── Source 3: Today's daily memory ─────────────────────────────────────────────
# Resolve "today" in the agent's LOCAL time — NOT the process default (UTC on
# most hosts/CI). TODAY keys the daily-memory lookup (memory/${TODAY}.md); using
# UTC here would look up the wrong day's file during the window where the local
# date is ahead of/behind UTC, silently dropping today's memory. Same
# SWITCHROOM_TIMEZONE → TZ → UTC cascade the restart-timestamp render below uses.
_TZ_VAL="${SWITCHROOM_TIMEZONE:-${TZ:-UTC}}"
DAILY_SECTION=""
TODAY=$(TZ="$_TZ_VAL" date +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d 2>/dev/null || true)
if [ -n "$TODAY" ] && [ -n "$WORKSPACE_DIR" ]; then
  DAILY_FILE="$WORKSPACE_DIR/memory/${TODAY}.md"
  if [ -f "$DAILY_FILE" ] && [ -s "$DAILY_FILE" ]; then
    DAILY_CONTENT=$(cat "$DAILY_FILE")
    if [ -n "$DAILY_CONTENT" ]; then
      DAILY_SECTION="## Today's memory (${TODAY})

$DAILY_CONTENT"
    fi
  fi
fi

# ── Assemble briefing ───────────────────────────────────────────────────────────
# Restart timestamp — model-facing: it lands in the resume-turn system prompt
# via --append-system-prompt ("You just restarted at …"). Render the agent's
# LOCAL am/pm wall clock, NOT UTC, so the restart turn never sees a competing
# UTC "now" (the whole point of the deterministic-local-time work). Same
# SWITCHROOM_TIMEZONE → TZ → UTC cascade and `%A %Y-%m-%d %I:%M %p %Z` am/pm
# format the UserPromptSubmit local-time hook (bin/timezone-hook.sh) uses.
# (_TZ_VAL is computed once above, in the daily-memory section.)
TIMESTAMP=$(TZ="$_TZ_VAL" date '+%A %Y-%m-%d %I:%M %p %Z' 2>/dev/null || date '+%A %Y-%m-%d %I:%M %p %Z')

# Determine restart reason if available
RESTART_REASON="unknown"
if [ -n "$AGENT_DIR" ] && [ -f "$AGENT_DIR/.restart-reason" ]; then
  RESTART_REASON=$(cat "$AGENT_DIR/.restart-reason" 2>/dev/null | head -1 | tr -d '\r\n')
fi
# Also check SWITCHROOM_PENDING_ENDED_VIA if set by start.sh
if [ -n "${SWITCHROOM_PENDING_ENDED_VIA:-}" ]; then
  RESTART_REASON="$SWITCHROOM_PENDING_ENDED_VIA"
fi

# Build the briefing body
SECTIONS=""
for section in "$TELEGRAM_SECTION" "$HINDSIGHT_SECTION" "$DAILY_SECTION"; do
  if [ -n "$section" ]; then
    if [ -n "$SECTIONS" ]; then
      SECTIONS="$SECTIONS

---

$section"
    else
      SECTIONS="$section"
    fi
  fi
done

# Empty briefing — nothing to inject
if [ -z "$SECTIONS" ]; then
  exit 0
fi

BRIEFING="You just restarted at ${TIMESTAMP}. Previous session ended via: ${RESTART_REASON}. Consult this briefing before responding.

---

${SECTIONS}"

# ── Output ──────────────────────────────────────────────────────────────────────
if [ "$STDOUT_MODE" = "1" ]; then
  printf '%s\n' "$BRIEFING"
else
  if [ -z "$AGENT_DIR" ]; then
    # Fallback: write to stdout if AGENT_DIR is not set
    printf '%s\n' "$BRIEFING"
    exit 0
  fi
  OUTPUT_FILE="$AGENT_DIR/.handoff-briefing.md"
  OUTPUT_TMP="${OUTPUT_FILE}.tmp.$$"
  printf '%s\n' "$BRIEFING" > "$OUTPUT_TMP" && mv -f "$OUTPUT_TMP" "$OUTPUT_FILE"
fi

exit 0
