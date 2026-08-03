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
# Hindsight is the only network hop; cap it at 3s so it finishes well inside
# start.sh's outer `timeout 10` kill budget (was 4s under a 5s outer, which
# left almost no margin — a slow recall could be SIGKILLed mid-write). Local
# SQLite + daily-memory reads are sub-second, so 3s is the whole network cost.
HINDSIGHT_TIMEOUT="${HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT:-3}"

# Chat/thread scope for the recent-conversation section (#continuity). A
# forum/group agent's history.db holds messages from many topics; an unscoped
# "last 20" briefing pollutes the reorientation with unrelated threads. Prefer
# the surface that was mid-turn when the prior session ended (exported by
# start.sh from the pending-turn env on an interrupted boot); otherwise the
# python fallback derives the single most-recently-active (chat_id, thread_id)
# surface straight from the DB. Empty ⇒ let python derive it.
TARGET_CHAT_ID="${SWITCHROOM_PENDING_CHAT_ID:-}"
TARGET_THREAD_ID="${SWITCHROOM_PENDING_THREAD_ID:-}"

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
    # Query the most recent $MAX_MESSAGES rows for the ACTIVE surface only
    # (chat/thread-scoped, see above), ordered by ts DESC, then reverse for
    # chronological display. We skip system messages (role NULL). The scope
    # source is logged to stderr for boot diagnostics.
    # python stderr is NOT suppressed: the script's only stderr output is the
    # intentional scope breadcrumb + a single graceful line on any caught error
    # (every DB path is wrapped in try/except → sys.exit(0)). start.sh runs this
    # under `2>/dev/null`, so the breadcrumb is a debug/manual-run diagnostic.
    TELEGRAM_ROWS=$(python3 - "$HISTORY_DB" "$MAX_MESSAGES" "$TARGET_CHAT_ID" "$TARGET_THREAD_ID" <<'PYEOF'
import sys, sqlite3, datetime

db_path = sys.argv[1]
limit = int(sys.argv[2])
target_chat = sys.argv[3] if len(sys.argv) > 3 else ""
target_thread = sys.argv[4] if len(sys.argv) > 4 else ""

try:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Resolve the surface to scope to.
    #  - explicit env target (pending-turn chat/thread) wins;
    #  - else derive the single most-recently-active (chat_id, thread_id).
    # thread is tri-state: a real value, NULL (DM / general), or unknown.
    scope_chat = None
    scope_thread = None          # int thread id
    scope_thread_known = False   # True once we know the exact thread (incl. NULL)
    scope_thread_is_null = False # True when the surface's thread is NULL
    scope_source = "unscoped"

    if target_chat:
        scope_chat = target_chat
        scope_source = "env"
        if target_thread != "":
            try:
                scope_thread = int(target_thread)
                scope_thread_known = True
            except ValueError:
                scope_thread = None  # unparseable → chat-only scope
        # else: chat-only scope (all threads of the chat)
    else:
        cur.execute(
            """
            SELECT chat_id, thread_id
            FROM messages
            WHERE role IN ('user', 'assistant')
            ORDER BY ts DESC
            LIMIT 1
            """
        )
        latest = cur.fetchone()
        if latest is not None:
            scope_chat = latest["chat_id"]
            scope_source = "db-latest"
            scope_thread_known = True
            if latest["thread_id"] is None:
                scope_thread_is_null = True
            else:
                scope_thread = latest["thread_id"]

    if scope_chat is None:
        # Empty DB (nothing to scope) — nothing to show.
        sys.stderr.write("handoff-briefing: no messages to scope; empty section\n")
        sys.exit(0)

    where = ["role IN ('user', 'assistant')", "chat_id = ?"]
    params = [scope_chat]
    if scope_thread_known:
        if scope_thread_is_null:
            where.append("thread_id IS NULL")
        else:
            where.append("thread_id = ?")
            params.append(scope_thread)
    params.append(limit)

    sys.stderr.write(
        "handoff-briefing: scoping recent conversation to chat=%s thread=%s (source=%s)\n"
        % (scope_chat, "NULL" if scope_thread_is_null else (scope_thread if scope_thread_known else "any"), scope_source)
    )

    cur.execute(
        "SELECT role, user, ts, text FROM messages WHERE "
        + " AND ".join(where)
        + " ORDER BY ts DESC LIMIT ?",
        params,
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

# ── Header (cheap, no network) — computed early so the recent-conversation
# section can be flushed to disk BEFORE the slow Hindsight hop. ──────────────
# Restart timestamp — model-facing: it lands in the resume-turn system prompt
# via --append-system-prompt ("You just restarted at …"). Render the agent's
# LOCAL am/pm wall clock, NOT UTC, so the restart turn never sees a competing
# UTC "now". Same SWITCHROOM_TIMEZONE → TZ → UTC cascade the daily section uses.
_TZ_VAL="${SWITCHROOM_TIMEZONE:-${TZ:-UTC}}"
TIMESTAMP=$(TZ="$_TZ_VAL" date '+%A %Y-%m-%d %I:%M %p %Z' 2>/dev/null || date '+%A %Y-%m-%d %I:%M %p %Z')
RESTART_REASON="unknown"
if [ -n "$AGENT_DIR" ] && [ -f "$AGENT_DIR/.restart-reason" ]; then
  RESTART_REASON=$(cat "$AGENT_DIR/.restart-reason" 2>/dev/null | head -1 | tr -d '\r\n')
fi
if [ -n "${SWITCHROOM_PENDING_ENDED_VIA:-}" ]; then
  RESTART_REASON="$SWITCHROOM_PENDING_ENDED_VIA"
fi
BRIEFING_HEADER="You just restarted at ${TIMESTAMP}. Previous session ended via: ${RESTART_REASON}. Consult this briefing before responding."

# Resolve the output destination up front (file mode only).
OUTPUT_FILE=""
OUTPUT_TMP=""
if [ "$STDOUT_MODE" != "1" ] && [ -n "$AGENT_DIR" ]; then
  OUTPUT_FILE="$AGENT_DIR/.handoff-briefing.md"
  OUTPUT_TMP="${OUTPUT_FILE}.tmp.$$"
fi

# Incremental emit (#continuity). Sections are flushed to the output file as
# each source resolves — the recent-conversation section (the highest-value,
# always-local part) is written BEFORE the network-bound Hindsight hop. So a
# late-stage SIGKILL (e.g. start.sh's outer `timeout`) mid-Hindsight still
# leaves the recent conversation on disk instead of nothing. The first flush
# writes header+section atomically via tmp+mv; later sections append. In
# stdout/no-AGENT_DIR mode we buffer and print once at the end instead.
FILE_STARTED=0
STDOUT_BUFFER=""
emit_section() {
  # $1 = section content (assumed non-empty)
  section="$1"
  if [ -n "$OUTPUT_FILE" ]; then
    if [ "$FILE_STARTED" = "0" ]; then
      # First section: header + divider + section, written atomically.
      printf '%s\n\n---\n\n%s' "$BRIEFING_HEADER" "$section" > "$OUTPUT_TMP" \
        && mv -f "$OUTPUT_TMP" "$OUTPUT_FILE"
      FILE_STARTED=1
    else
      printf '\n\n---\n\n%s' "$section" >> "$OUTPUT_FILE"
    fi
  else
    if [ -z "$STDOUT_BUFFER" ]; then
      STDOUT_BUFFER="$section"
    else
      STDOUT_BUFFER="$STDOUT_BUFFER

---

$section"
    fi
  fi
}

# Flush the recent-conversation section NOW, before Hindsight.
if [ -n "$TELEGRAM_SECTION" ]; then
  emit_section "$TELEGRAM_SECTION"
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
if [ -n "$HINDSIGHT_SECTION" ]; then
  emit_section "$HINDSIGHT_SECTION"
fi

# ── Source 3: Today's daily memory ─────────────────────────────────────────────
# TODAY keys the daily-memory lookup (memory/${TODAY}.md) in the agent's LOCAL
# time (_TZ_VAL, resolved in the header block above) — NOT the process default
# (UTC on most hosts/CI). Using UTC here would look up the wrong day's file
# during the window where the local date is ahead of/behind UTC, silently
# dropping today's memory.
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
if [ -n "$DAILY_SECTION" ]; then
  emit_section "$DAILY_SECTION"
fi

# ── Finalize ────────────────────────────────────────────────────────────────────
# Every section was flushed as it resolved (emit_section). Here we only close
# out the chosen sink. An all-empty briefing wrote nothing — leave it that way
# so start.sh skips the --append-system-prompt arg.
if [ -n "$OUTPUT_FILE" ]; then
  # File mode. FILE_STARTED=1 means at least one section was written atomically
  # (header+first) with the rest appended; add the trailing newline the
  # single-shot writer used to emit. If nothing was written, no file exists.
  if [ "$FILE_STARTED" = "1" ]; then
    printf '\n' >> "$OUTPUT_FILE"
  fi
else
  # stdout / no-AGENT_DIR mode — buffered; print the whole briefing once.
  if [ -n "$STDOUT_BUFFER" ]; then
    printf '%s\n\n---\n\n%s\n' "$BRIEFING_HEADER" "$STDOUT_BUFFER"
  fi
fi

exit 0
