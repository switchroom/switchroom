#!/usr/bin/env bash
# Guard against raw `bot.api.*` / `lockedBot.api.*` / `ctx.api.*` Telegram
# outbound calls outside the standard retry policy.
#
# #1075 root cause: only the reply chunk loop was routing sends through
# `retryApiCall` / `robustApiCall`. Boot card, issues card, progress
# pin/unpin, answer-stream adapter, "agent restarting" notices, etc.
# called `bot.api.sendMessage|editMessageText|pin|...` directly. When
# a user deleted a forum topic mid-flight, Telegram returned
# `THREAD_NOT_FOUND` and the GrammyError bubbled to crash the gateway.
#
# This guard fails CI if a NEW raw call lands outside the allowlist.
# The allowlist is a small set of file:line ranges with a comment
# explaining why each entry is exempt (typically: the call is the
# adapter callback INSIDE a `robustApiCall(...)` invocation, so the
# regex match is a false positive).
#
# Exemption options
# -----------------
# A raw call can be exempted in two ways:
#
# (A) Inline marker (PREFERRED — added 2026-05-20):
#     Put `// allow-raw-bot-api: <reason>` on the line IMMEDIATELY
#     preceding the raw call. Reason is required. Markers don't drift
#     when surrounding code shifts, unlike the line-range allowlist below.
#
# (B) Line-range ALLOWLIST entry (legacy):
#     `path:start-end:reason`. A match at any line >= start AND <= end
#     in `path` is skipped. Every gateway.ts insertion drifts these
#     ranges (see the bump trail in the gateway.ts entries below), so
#     prefer (A) for new exemptions.
#
# To add an exemption:
#   1. Confirm the raw call IS already inside a retry wrapper, OR
#   2. The call is a legitimate fire-and-forget (e.g. early-ack 👀
#      reaction) that does NOT pass `message_thread_id` and therefore
#      cannot trigger THREAD_NOT_FOUND, OR
#   3. The call is intentionally raw because wrapping would re-enter a
#      bug (e.g. the THREAD_NOT_FOUND chunk-loop fallback).
#
# If none hold: don't exempt. Wrap the call instead.

set -euo pipefail

cd "$(dirname "$0")/.."

# Patterns that are real telegram-API outbound calls — sends, edits,
# pins, deletes, forwards. Reactions / chat actions / callback answers
# do NOT take `message_thread_id` so they're not in the THREAD_NOT_FOUND
# blast radius and we skip them. answerCallbackQuery is also excluded
# for the same reason.
#
# SCOPE, stated precisely (switchroom#4599). This pattern is anchored on
# `\.api\.`. It therefore covers `bot.api.X` / `lockedBot.api.X` /
# `ctx.api.X` and NOTHING ELSE — in particular it can never match
# `ctx.reply(` or `ctx.replyWithRichMessage(`, which is how every
# slash-command card (`/usage`, `/model`, `/auth`, `/approvals`, `/start`,
# `/help`) reaches Telegram via `switchroomReply`. Do not read a green run
# of this guard as "every outbound send transits `robustApiCall`": that
# claim was written into `gateway/system-message-observer.ts` and was false
# from the day it merged (measured: agent overlord, message id 20938 — a
# `/usage` card that left no history row, so a native reply to it resolved
# to an id with no text). The context-send family has its own ratchet,
# `scripts/check-ctx-send-wrapping.mjs`.
#
# `sendRichMessage` / `sendRichMessageDraft` (Bot API 10.1) were missing
# from the verb list below until #4599 added them.
PATTERN='\b(bot|lockedBot|ctx)\.api\.(sendRichMessage|sendRichMessageDraft|sendMessage|sendPhoto|sendDocument|sendMediaGroup|sendAnimation|sendVideo|sendVoice|sendAudio|sendSticker|sendLocation|editMessageText|editMessageCaption|editMessageMedia|editMessageReplyMarkup|forwardMessage|forwardMessages|copyMessage|copyMessages|pinChatMessage|unpinChatMessage|unpinAllChatMessages|deleteMessage|deleteMessages)\b'

# Files we scan. retry-api-call.ts is the definition of the wrapper so
# excluded; tests directories use the API directly to assert call shape.
# uat/scenarios/ uses mtcute (not bot.api), and gateway-secret-detect/
# bot-api harness tests intentionally call raw API.
ROOTS=(telegram-plugin)

# Allowlist entries — path:start-end:reason
# Lines OUTSIDE these ranges that match PATTERN will fail the check.
# Keep the list short. Add a one-line reason for every entry.
ALLOWLIST=(
  # retry-api-call.ts: the file that defines the wrapper.
  "telegram-plugin/retry-api-call.ts:1-9999:wrapper definition"

  # foreman.ts:1066,1084 — DM `sendMessage` (no thread_id passed). Cannot
  # trigger THREAD_NOT_FOUND. No wrapping needed; allowlisted to avoid
  # noise. Range widened post-RFC-H (auth-dashboard.ts removal shifted
  # lines up; keep the window generous so further small shifts don't
  # cascade through this allowlist).
  "telegram-plugin/foreman/foreman.ts:1050-1170:DM sendMessage in setup/create-agent flow recovery — no thread_id"

  # slot-banner-driver.ts — ALL calls target args.ownerChatId (a DM).
  # No thread_id. THREAD_NOT_FOUND impossible by construction.
  "telegram-plugin/slot-banner-driver.ts:1-9999:slot-banner targets DM ownerChatId; no thread_id"

  # auto-fallback-dispatcher.ts:55 — DM sendMessage to ownerChatId. No thread_id.
  "telegram-plugin/auto-fallback-dispatcher.ts:1-9999:DM ownerChatId; no thread_id"

  # boot-card.ts and issues-card.ts: these MODULES receive a bot adapter
  # via DI. The gateway wires those adapters through robustApiCall (see
  # wrapBootCardApi / wrapIssuesCardApi). Inside the card modules, the
  # `bot.sendMessage(...)` callsites are NOT `bot.api.*` — the pattern
  # above doesn't match them, so no allowlist entry needed.

  # stream-controller.ts: every `bot.api.*` here is the inner callback of
  # a `retry(...)` wrapper (the file's own retry parameter is wired to
  # robustApiCall in gateway.ts). Confirmed via grep — each call is on
  # the line after a `() => bot.api.*` arrow inside `retry(...)`.
  "telegram-plugin/stream-controller.ts:1-9999:every bot.api.* call is inside a retry(...) closure"

  # Tests files — bot.api.* is the mock object the harness exposes.
  # Not a runtime call.
  "telegram-plugin/tests/.*:1-9999:test mock callsites"

  # README + comment docs.
  "telegram-plugin/README.md:1-9999:documentation"
)

is_allowlisted() {
  local file="$1" line="$2"
  for entry in "${ALLOWLIST[@]}"; do
    local pattern="${entry%%:*}"
    local rest="${entry#*:}"
    local range="${rest%%:*}"
    local start="${range%%-*}"
    local end="${range##*-}"
    # Pattern match supports glob (e.g. tests/.*).
    if [[ "$file" =~ ^${pattern}$ ]]; then
      if (( line >= start && line <= end )); then
        return 0
      fi
    fi
  done
  return 1
}

# Inline-marker exemption: `// allow-raw-bot-api: <reason>` on the line
# IMMEDIATELY preceding the raw call. Reason (at least one non-whitespace
# char after the colon) is required. Drift-proof — moves with the code.
is_inline_marked() {
  local file="$1" line="$2"
  local prev_line=$(( line - 1 ))
  if (( prev_line < 1 )); then
    return 1
  fi
  local prev_text
  prev_text="$(sed -n "${prev_line}p" "$file" 2>/dev/null || true)"
  if [[ "$prev_text" =~ //[[:space:]]*allow-raw-bot-api:[[:space:]]*[^[:space:]] ]]; then
    return 0
  fi
  return 1
}

violations=0
violation_lines=()

for root in "${ROOTS[@]}"; do
  while IFS= read -r match; do
    file="${match%%:*}"
    rest="${match#*:}"
    line="${rest%%:*}"
    text="${rest#*:}"

    # Skip comment-only matches (// or * line).
    trimmed="$(echo "$text" | sed -E 's/^[[:space:]]+//')"
    if [[ "$trimmed" == "//"* || "$trimmed" == "*"* || "$trimmed" == "/*"* ]]; then
      continue
    fi
    # Skip lines that look like they're inside a wrapped closure.
    # Look 10 lines back AND 1 line forward for the wrapper-call name.
    # Cheap but covers the common shape:
    #   robustApiCall(\n  () =>\n    bot.api.sendMessage(...),\n  ...)
    # where the regex hits the inner line but the wrapper is +/- a few
    # lines away. False positives here just shift the load to the
    # allowlist, which is fine.
    ctx_start=$(( line - 10 < 1 ? 1 : line - 10 ))
    ctx_end=$(( line + 1 ))
    ctx=$(sed -n "${ctx_start},${ctx_end}p" "$file" 2>/dev/null || true)
    if echo "$ctx" | grep -qE '\b(robustApiCall|swallowingApiCall|retryWithThreadFallback|createRetryApiCall|createSwallowingRetryApiCall)\b' ; then
      # Additional guard: the wrapper call must precede the bot.api call
      # in the snippet, i.e. we're actually INSIDE the closure, not just
      # *near* an unrelated wrapper. Check by finding the line number of
      # the wrapper-name match relative to the bot.api hit. Skip lines
      # that are pure comments (the wrapper might be name-checked in a
      # JSDoc above an unrelated section).
      wrapper_line=$(echo "$ctx" | grep -nE '^\s*[^/*]*\b(robustApiCall|swallowingApiCall|retryWithThreadFallback)\b' | head -1 | cut -d: -f1 || true)
      bot_line_in_ctx=$(( line - ctx_start + 1 ))
      if [[ -n "${wrapper_line:-}" ]] && (( wrapper_line <= bot_line_in_ctx )); then
        continue
      fi
    fi

    if is_inline_marked "$file" "$line"; then
      continue
    fi

    if is_allowlisted "$file" "$line"; then
      continue
    fi

    violations=$((violations + 1))
    violation_lines+=("$file:$line: $trimmed")
  done < <(grep -rEn --include='*.ts' --include='*.mts' --include='*.cts' --exclude-dir=dist --exclude-dir=node_modules "$PATTERN" "$root" 2>/dev/null || true)
done

if (( violations > 0 )); then
  echo "check-bot-api-wrapping: ${violations} raw bot.api.* call(s) outside the retry policy:" >&2
  printf '  %s\n' "${violation_lines[@]}" >&2
  echo "" >&2
  echo "Fix options:" >&2
  echo "  (1) Wrap the call in robustApiCall / swallowingApiCall, or use" >&2
  echo "      retryWithThreadFallback if you need the deleted-thread fallback." >&2
  echo "  (2) Add an inline marker on the line IMMEDIATELY preceding the call:" >&2
  echo "      // allow-raw-bot-api: <reason>" >&2
  echo "      (preferred — drift-proof, no allowlist edits required)" >&2
  echo "  (3) Add an ALLOWLIST entry in scripts/check-bot-api-wrapping.sh" >&2
  echo "      (legacy — line ranges drift when surrounding code shifts)." >&2
  echo "See #1075 for context." >&2
  exit 1
fi

echo "check-bot-api-wrapping: clean (no raw bot.api.* calls outside the retry policy)"
