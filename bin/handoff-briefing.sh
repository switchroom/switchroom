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
#   handoff-briefing.sh [--stdout] [--lean]
#
# The --stdout flag overrides HANDOFF_BRIEFING_STDOUT=1.
#
# LEAN MODE (--lean, alias --mode=compaction)
# -------------------------------------------
# The compaction re-seat path (bin/working-state-reload-hook.sh, wired as the
# SessionStart(compact) hook) invokes this script with --lean so BOTH legacy-
# and gateway-briefing agents share ONE assembler at the compaction boundary —
# no copy of the sqlite/recall logic lives in the hook. Lean mode differs from
# the boot briefing in three deliberate ways:
#
#   1. It emits ONLY the recent-Telegram-tail + Hindsight-recall sections.
#      Daily-memory (Source 3) and the "You just restarted at …" header are
#      SKIPPED. Rationale is token duplication, not latency: Claude Code's
#      native compaction summary already preserves the recent turns, so
#      re-injecting the full boot briefing on every compaction of a long
#      session partially triples coverage.
#   2. It IGNORES the SWITCHROOM_PENDING_* env (boot-time pending-turn scope).
#      Those name the surface that was mid-turn at the PREVIOUS boot; at a
#      compaction hours into a live session they are stale and would brief the
#      WRONG chat surface. Lean mode zeroes them so the python scoper derives
#      the single most-recently-active (chat_id, thread_id) straight from the
#      DB (scope_source=db-latest).
#   3. It forces stdout and never touches AGENT_DIR (no output file), so it is
#      safe to call from the hook regardless of whether AGENT_DIR is exported.

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
# left almost no margin — a slow recall could be killed mid-write). Local
# SQLite + daily-memory reads are sub-second, so 3s is the whole network cost.
HINDSIGHT_TIMEOUT="${HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT:-3}"

# Chat/thread scope for the recent-conversation section (#continuity). A
# forum/group agent's history.db holds messages from many topics; an unscoped
# "last 20" briefing pollutes the reorientation with unrelated threads. Prefer
# the surface that was mid-turn when the prior session ended (exported by
# start.sh from the pending-turn env on an interrupted boot); otherwise the
# python fallback derives the single most-recently-active (chat_id, thread_id)
# surface straight from the DB. Empty chat ⇒ let python derive it.
#
# TARGET_THREAD_ID is tri-state: a numbered thread scopes to that topic; the
# literal sentinel `NULL` means the surface's thread is genuinely NULL (a DM /
# forum General topic) and scopes with `thread_id IS NULL`; empty means the
# thread is UNKNOWN and falls back to chat-only scope (all threads). The
# pending-turn env writer emits `NULL` when it knows the interrupted turn's
# thread was null, so a General-topic interrupt reboots correctly scoped
# instead of pulling in every other topic's messages.
TARGET_CHAT_ID="${SWITCHROOM_PENDING_CHAT_ID:-}"
TARGET_THREAD_ID="${SWITCHROOM_PENDING_THREAD_ID:-}"

# Determine output + lean mode. Parse every arg (order-independent) so
# `--lean`, `--stdout`, or both, work regardless of position.
STDOUT_MODE=0
LEAN_MODE=0
for _arg in "$@"; do
  case "$_arg" in
    --stdout) STDOUT_MODE=1 ;;
    --lean|--mode=compaction) LEAN_MODE=1 ;;
    *) : ;;
  esac
done
if [ "${HANDOFF_BRIEFING_STDOUT:-}" = "1" ]; then
  STDOUT_MODE=1
fi

# Lean (compaction) mode: force stdout, and ZERO the pending-turn env scope so
# the python scoper falls through to db-latest (see LEAN MODE note in header).
# This is the load-bearing correctness fix for a mid-session compaction: the
# SWITCHROOM_PENDING_* surface is the previous boot's, not the currently-active
# chat. Clearing them here (not in the hook) keeps the single scoping code path.
if [ "$LEAN_MODE" = "1" ]; then
  STDOUT_MODE=1
  TARGET_CHAT_ID=""
  TARGET_THREAD_ID=""
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
from urllib.parse import quote

db_path = sys.argv[1]
limit = int(sys.argv[2])
target_chat = sys.argv[3] if len(sys.argv) > 3 else ""
target_thread = sys.argv[4] if len(sys.argv) > 4 else ""

try:
    # READ-ONLY, ALWAYS. `sqlite3.connect(path)` defaults to READ-WRITE, which
    # makes this briefing assembler a writer on the gateway's live WAL DB. A
    # read-write connection that closes as the LAST connection runs SQLite's
    # checkpoint-and-delete path and UNLINKS `history.db-wal` / `-shm` — and
    # this script runs at agent boot, precisely when the gateway is down or
    # starting and this process IS the last connection. Any handle still
    # mapped to those inodes then writes into deleted files: every INSERT
    # reports success and every row is gone at the next restart (the
    # `/proc/<pid>/fd/N -> history.db-wal (deleted)` signature that #4595
    # sweeps for after the fact).
    #
    # `mode=ro` removes that primitive entirely: a read-only connection cannot
    # checkpoint and cannot unlink a sidecar. It still reads a WAL database
    # correctly in every boot state we care about — sidecars present, `-shm`
    # absent, and `-shm` absent with an unwritable directory (SQLite falls back
    # to a heap wal-index rather than failing). Every statement below is a
    # SELECT or a PRAGMA table_info, so nothing here needs write access.
    #
    # The path is percent-encoded: a `?` or `#` in the state dir would
    # otherwise be parsed as the URI's query/fragment delimiter and silently
    # truncate the filename.
    conn = sqlite3.connect("file:" + quote(db_path) + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Probe ONCE whether this history DB carries the native-reply columns
    # (reply_to_message_id / reply_to_text, added with issue #119). A DB
    # predating them would raise OperationalError on the extended SELECT and,
    # via the outer `except → sys.exit(0)`, silently drop the ENTIRE
    # Telegram-history section. Detect the columns explicitly here and degrade
    # to the legacy column list (skipping the antecedent render) rather than
    # swallowing a real query failure. The outer try/except still catches
    # genuine errors — this only distinguishes "columns absent" from those.
    cur.execute("PRAGMA table_info(messages)")
    _msg_cols = {r[1] for r in cur.fetchall()}
    has_reply_cols = "reply_to_message_id" in _msg_cols and "reply_to_text" in _msg_cols

    # Resolve the surface to scope to.
    #  - explicit env target (pending-turn chat/thread) wins — UNLESS that chat
    #    has zero rows (rotated/fresh DB), in which case we fall through to
    #    db-latest so a stale env target doesn't yield an empty section;
    #  - else derive the single most-recently-active (chat_id, thread_id).
    # thread is tri-state: a real value, NULL (DM / general), or unknown.
    #  - target_thread == "NULL" (sentinel from start.sh / pending-turn-env)
    #    means the surface's thread is GENUINELY NULL (DM / general topic) —
    #    scope with `thread_id IS NULL`, do NOT pull in numbered-thread rows.
    #  - target_thread == "" (empty) means UNKNOWN — chat-only scope (all
    #    threads), the safe backward-compatible fallback.
    scope_chat = None
    scope_thread = None          # int thread id
    scope_thread_known = False   # True once we know the exact thread (incl. NULL)
    scope_thread_is_null = False # True when the surface's thread is NULL
    scope_source = "unscoped"

    def _chat_has_rows(chat_id):
        cur.execute(
            "SELECT 1 FROM messages WHERE role IN ('user', 'assistant') "
            "AND chat_id = ? LIMIT 1",
            [chat_id],
        )
        return cur.fetchone() is not None

    def _derive_db_latest():
        # The single most-recently-active (chat_id, thread_id) surface.
        cur.execute(
            """
            SELECT chat_id, thread_id
            FROM messages
            WHERE role IN ('user', 'assistant')
            ORDER BY ts DESC
            LIMIT 1
            """
        )
        return cur.fetchone()

    # Env target — accept it only when its chat actually has rows (2b). A
    # rotated/fresh DB can leave a pending-turn chat with no persisted
    # messages; scoping to it would silently emit an empty section, so we
    # fall through to db-latest instead.
    if target_chat and _chat_has_rows(target_chat):
        scope_chat = target_chat
        scope_source = "env"
        if target_thread == "NULL":
            scope_thread_is_null = True
            scope_thread_known = True
        elif target_thread != "":
            try:
                scope_thread = int(target_thread)
                scope_thread_known = True
            except ValueError:
                scope_thread = None  # unparseable → chat-only scope
        # else: unknown thread → chat-only scope (all threads of the chat)

    if scope_chat is None:
        latest = _derive_db_latest()
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

    select_cols = "role, user, ts, text"
    if has_reply_cols:
        select_cols += ", reply_to_message_id, reply_to_text"
    cur.execute(
        "SELECT " + select_cols + " FROM messages WHERE "
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
        # Reply antecedent (issue #119 native reply). recordInbound persists
        # reply_to_message_id/reply_to_text — the latter recovered from the
        # history buffer even when the reply target was the bot's OWN message
        # (Telegram omits its text on the live update). Surfacing it as an
        # indented "↪ replying to" line carries the antecedent STRUCTURE into
        # the post-reset briefing, so a fresh session reading this transcript
        # knows what "this"/"that" in the reply refers to instead of guessing.
        # Without it the flat dump loses the thread of any native reply.
        print(f"[{ts_str}] {label}: {text}")
        if not has_reply_cols:
            # Legacy DB (pre-#119): no reply columns were selected, so the
            # antecedent render is skipped entirely. The history section still
            # renders every message above — just without "↪ replying to" lines.
            continue
        reply_id = row["reply_to_message_id"]
        reply_text = row["reply_to_text"]
        if reply_text is not None and reply_text != "":
            rt = reply_text
            if len(rt) > 200:
                rt = rt[:200] + "…"
            rt = rt.replace("\\", "\\\\").replace("\n", " ")
            print(f"       ↪ replying to: {rt}")
        elif reply_id is not None:
            # Antecedent known by id only (text unavailable — reply target had
            # no text, or predates the reply_to_text buffer backfill).
            print(f"       ↪ replying to message #{reply_id}")
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
# late-stage kill (e.g. start.sh's outer `timeout`, SIGTERM by default) mid-Hindsight still
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
# Lean/compaction mode SKIPS daily memory (token duplication — the native
# summary already carries recent context; see LEAN MODE note in header).
if [ "$LEAN_MODE" != "1" ] && [ -n "$TODAY" ] && [ -n "$WORKSPACE_DIR" ]; then
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
    if [ "$LEAN_MODE" = "1" ]; then
      # Lean/compaction: no "You just restarted at …" boot header — this is a
      # mid-conversation compaction, not a restart, and the hook emits its own
      # <compact-recovery> framing. Print only the assembled sections.
      printf '%s\n' "$STDOUT_BUFFER"
    else
      printf '%s\n\n---\n\n%s\n' "$BRIEFING_HEADER" "$STDOUT_BUFFER"
    fi
  fi
fi

exit 0
