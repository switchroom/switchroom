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
PATTERN='\b(bot|lockedBot|ctx)\.api\.(sendMessage|sendPhoto|sendDocument|sendMediaGroup|sendAnimation|sendVideo|sendVoice|sendAudio|sendSticker|sendLocation|editMessageText|editMessageCaption|editMessageMedia|editMessageReplyMarkup|forwardMessage|forwardMessages|copyMessage|copyMessages|pinChatMessage|unpinChatMessage|unpinAllChatMessages|deleteMessage|deleteMessages)\b'

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

  # "Paired!" sendMessage to senderId (always a DM, bare). No thread_id.
  # Range bumped 2026-05 for #1122 PR1 telemetry insertions that shifted
  # lines down. Re-bumped 2026-05 post-RFC-H (auth-dashboard.ts removal
  # shifted ~3k lines up — callsite now near 979). Use generous windows.
  "telegram-plugin/gateway/gateway.ts:970-1030:Paired! sendMessage to DM senderId; no thread_id"

  # operator-event broadcast. The loop's `opts` is built without
  # `message_thread_id` (parse_mode + reply_markup only).
  # Range bumped 2026-05 for #1115 vault-approval-posture insertions
  # (~100 lines added to gateway).
  # Re-bumped 2026-05-15 for the auth-snapshot Format 2 PR's
  # `wouldFireFleetAutoFallback` synchronous-check insertion (~10
  # lines added between the modelUnavailable detection and the
  # broadcast loop).
  # Re-bumped 2026-05-15 for #1308 folder-picker handler (callsite now ~2331).
  # Re-bumped 2026-05-15 post-#1328 (/audit hostd) + #1329 (auth-ux
  # follow-ups) — broadcast loop now at ~2334 after combined drift.
  # Re-bumped 2026-05-19 for PR-1 of the callback-continuation series:
  # the +3-line builder-import block drifted the broadcast send to 2353
  # (just past the old 2350 ceiling). Widened end 2350 -> 2360; grep
  # confirms 2353 is the only raw call in 2351-2360.
  # Re-bumped 2026-05-19 for PR-3: import + TTL-sweep insertions drifted
  # the broadcast send +19 to 2371 (past 2360). End 2360 -> 2380; next
  # raw call is 2399 (outside), so no new un-allowlisted call enters.
  # Re-bumped 2026-05-19 for proactive context-compaction: +107 net
  # lines higher in the file drifted the broadcast send to 2475 (past
  # 2380). End 2380 -> 2520; check flags only 2475 in 2381-2694 (next
  # allowlist entry starts 2695), so no new un-allowlisted call enters.
  # Re-bumped 2026-05-19 for proactive-compaction notification: +150 net
  # lines higher drifted the broadcast send to 2625 (past 2520). End
  # 2520 -> 2680; check flags only 2625 in 2521-2694 (next allowlist
  # entry starts 2695), so no new un-allowlisted call enters.
  "telegram-plugin/gateway/gateway.ts:2250-2680:operator-event broadcast; no thread_id in opts"

  # permission-request keyboard send. opts only has reply_markup. No thread_id.
  # Range bumped 2026-05-13 for stuck-turn-recovery v2 cleanup expansion
  # (~100 lines total added around line 2510).
  # Range bumped 2026-05-15 for #1292 tool-aware silence-poke fallback
  # (~32 lines added in onSessionEvent + ctx threading).
  # Re-bumped 2026-05-15 for the auth-snapshot Format 2 PR: card-path
  # `willAutoFallback` branching added a few lines just above this
  # block, shifting the permission send down ~5 lines.
  # Re-bumped 2026-05-15 for the auth-ux follow-ups PR: auth:refresh
  # throttle map + reaper added ~8 lines above this block; runAutoFallbackCheck
  # deletion subtracted ~80 lines below — net shift varies between
  # local + CI grep (line counting drift); widened window to 2960.
  # Re-bumped 2026-05-15 for #1308 folder-picker handler integration.
  # Re-bumped 2026-05-15 for RFC E §4.2 PR-2C drive PreToolUse hook
  # (#1319) — added ~2 more lines above this block.
  # End 3000 -> 3010: feat/hostd-deterministic-status inserted the
  # inFlightUpdate var + the silence-fallback update-status branch
  # above this block; the permission-keyboard raw send moved to 3002.
  # Re-bumped 2026-05-19 for PR-3: the dispatchPermissionVerdict helper
  # (+~49 after line 2745) drifted the permission-request keyboard send
  # to 3069 (past 3010). End 3010 -> 3080; next raw call is 3209
  # (outside), so no new un-allowlisted call enters the margin.
  # Re-bumped 2026-05-19 for the silence-poke wedge-clear buffer
  # self-heal (+14 lines in onFrameworkFallback ~2746) drifted the
  # permission-request keyboard send 3072 -> 3086 (past 3080). End
  # 3080 -> 3100; next raw call is 3650 (far outside), so no new
  # un-allowlisted call enters the margin.
  "telegram-plugin/gateway/gateway.ts:2695-3100:permission-request keyboard; no thread_id"

  # reply chunk-loop fallback after robustApiCall threw THREAD_NOT_FOUND.
  # The caller dropped the thread; this raw sendMessage retries on the
  # main chat. Wrapping would re-enter the THREAD_NOT_FOUND throw on a
  # phantom second deletion.
  # Range bumped 2026-05-15 for #1292 tool-aware silence-poke fallback
  # (~32 lines added earlier in the file shift this band down).
  # Re-bumped 2026-05-15 for the auth-snapshot Format 2 PR
  # (insertions earlier in the file shifted the chunk-loop down).
  # Re-bumped 2026-05-15 post-Path-A-Cut-2 (drive-write IPC handler
  # added ~60 lines higher up; chunk-loop callsite shifted further to ~3451).
  # Re-bumped 2026-05-15 for #1308 folder-picker handler.
  # Re-bumped 2026-05-15 for #1345 (quota align): +2 lines inserted above
  # (quota-check import + a startBootCard wiring line) shifted the
  # unchanged callsite 3499 -> 3501, just past the old 3500 bound.
  # Re-bumped 2026-05-16 for the HTML→plaintext parse-reject fallback:
  # the sendChunkPlainText helper + restructured try/catch (~25 lines)
  # shifted the THREAD_NOT_FOUND raw send 3501 -> 3519. The new
  # sendChunkPlainText raw send (~3498) is the SAME intentional-raw
  # rationale — a terminal last-resort resend that must not re-enter
  # the retry/parse-mode policy that just rejected the payload.
  # End 3540 -> 3580: same insertion shifted the chunk-loop fallback
  # raw sends to 3545/3566.
  # Re-bumped 2026-05-19 for PR-3: +~49 drift moved the reply chunk-loop
  # raw sends to 3612/3633 (past 3580). End 3580 -> 3640; next raw call
  # is 3689 (outside), so no new un-allowlisted call enters the margin.
  # Re-bumped 2026-05-19 for the silence-poke wedge-clear buffer
  # self-heal (+14 lines ~2746) drifted the chunk-loop raw sends to
  # ~3636/3650 (3650 past 3640). End 3640 -> 3660; next raw call is
  # 10562 (far outside), so no new un-allowlisted call enters.
  # Re-bumped 2026-05-19 for the idle-drain fix: the +~30-line
  # opportunistic idle-drain block (~line 3274, inside this range)
  # drifted the chunk-loop raw send to 3692 (past 3660). End
  # 3660 -> 3700; next raw call is 10604 (far outside), so no new
  # un-allowlisted call enters the margin.
  # Re-bumped 2026-05-19 for proactive context-compaction: +107 net
  # lines higher in the file drifted the chunk-loop raw sends to
  # 3778/3799 (past 3700). End 3700 -> 3860; check flags only
  # 3778/3799 before the next allowlist entry (8100), so no new
  # un-allowlisted call enters the margin.
  # Re-bumped 2026-05-19 for proactive-compaction notification: +150 net
  # lines drifted the chunk-loop raw sends to 3928/3949 (past 3860). End
  # 3860 -> 4000; check flags only 3928/3949 before the next allowlist
  # entry (8100), so no new un-allowlisted call enters the margin.
  # Re-bumped 2026-05-19 for the durable-inbound-spool feature: the
  # ~40-line spool construct + boot-replay block (~3057) drifted the
  # chunk-loop raw sends to 4026/4047 (past 4000). End 4000 -> 4060;
  # check flags only 4026/4047 before the next entry (8100), so no new
  # un-allowlisted call enters the margin.
  # Re-bumped 2026-05-20 for the silence-poke turn-state purge fix:
  # the ~17-line purgeStaleTurnsForChat insertion (~3014) drifted the
  # chunk-loop raw send to 4067 (past 4060). End 4060 -> 4080; next
  # raw call is 11002 (far outside), no new un-allowlisted call enters.
  # Re-bumped 2026-05-20 (same-PR follow-up): the +~26-line
  # endCurrentTurnAtomic helper insertion (~1320) drifted the
  # chunk-loop raw send 4067 -> 4093 (past 4080). End 4080 -> 4100;
  # next raw call is 11028 (far outside), no new un-allowlisted call.
  "telegram-plugin/gateway/gateway.ts:3160-4100:reply chunk-loop THREAD_NOT_FOUND + plaintext-fallback raw sends (intentional)"

  # credit-watch notification. No thread_id (DM).
  # Range bumped 2026-05-13 for stuck-turn-recovery (#1136) v2 cleanup
  # (~100 lines) + gate-deny-log helper (~65 lines).
  "telegram-plugin/gateway/gateway.ts:8100-8400:credit-watch notify; no thread_id"

  # gateway.ts:9260-9490 — ctx.api.editMessageText for vault grant wizard
  # cards. Every callsite has `.catch(() => {})` — a THREAD_NOT_FOUND
  # is already swallowed there. Acceptable because the wizard messages
  # are tap-driven UI and a missed edit just leaves the previous state
  # visible (the user can re-tap).
  # Range bumped 2026-05-15 for the auth-snapshot Format 2 PR
  # (~180 lines added across handleAuthDashboardCallback +
  # fireFleetAutoFallback re-entry guard shifted the vault wizard
  # callsites further down).
  # Re-bumped 2026-05-15 post-Path-A-Cut-2 (drive-write IPC handler
  # added ~60 lines).
  # Re-bumped 2026-05-15 for the /audit hostd command insertion
  # (~85 lines added near line 8475 shifted the vault wizard callsites
  # further down past the prior 10100 ceiling).
  # Re-bumped 2026-05-15 for #1308 folder-picker handler integration.
  # Re-bumped 2026-05-17 for sec WS7-F2b (#1394): the /auth
  # operator-private gate inserted ~32 lines above bot.command("auth"),
  # shifting the vault-wizard callsites past the prior 10300 ceiling
  # (the flagged callsite moved 10270 -> 10302). End extended with
  # headroom; the inserted code uses switchroomReply (wrapped), so the
  # slightly-wider span introduces no un-allowlisted raw call.
  # Re-bumped 2026-05-18 for Fix B (#1497): the standing-ACL broker
  # short-circuit in executeVaultRequestAccess + performVaultAccessApproval
  # added ~60 lines above the wizard, drifting grantWizardStep3/Confirm's
  # editMessageText to 10358/10382 (past 10340). New ceiling stops before
  # executeGrantWizard (10408); inserted code uses listViaBroker (not a
  # raw bot.api call), so the wider span adds no un-allowlisted call.
  # End 10400 -> 10430: same insertion shifted the vault-wizard
  # editMessageText callsite to 10422.
  # Re-bumped 2026-05-19 for PR-1 of the callback-continuation series:
  # the ~+261-line vault_request_save wake-up insertions in
  # handleVaultRequestSaveCallback drifted the wizard editMessageText
  # callsites to 10446/10470 (past the old 10430 ceiling; 10423 still
  # inside). Widened end 10430 -> 10480; grep confirms only
  # 10423/10446/10470 are raw calls in 10431-10480 — all the same
  # already-.catch-swallowed wizard editMessageText sites, no new one.
  # Re-bumped 2026-05-19 for PR-2 of the callback-continuation series:
  # the ~+11-line normal-inbound sendToAgent+buffer rewrite (~line
  # 6987) drifted the wizard editMessageText callsites to
  # 10434/10457/10481 (10481 past the old 10480 ceiling). Widened end
  # 10480 -> 10490; grep confirms 10481 is the only raw call in
  # 10481-10540 — same already-.catch-swallowed wizard site, no new one.
  # Re-bumped 2026-05-19 for PR-3: +~49 drift moved the wizard
  # editMessageText sites to 10498/10521/10545 (past 10490). End
  # 10490 -> 10560; next raw call is 10698 (outside), so no new
  # un-allowlisted call enters the margin — same already-.catch-
  # swallowed wizard sites.
  # Re-bumped 2026-05-19 for the silence-poke wedge-clear buffer
  # self-heal (+14 lines ~2746) drifted the last wizard
  # editMessageText site to 10562 (past 10560). End 10560 -> 10580;
  # next raw call is 10698 (outside), so no new un-allowlisted call
  # enters — same already-.catch-swallowed wizard site.
  # Re-bumped 2026-05-19 for the idle-drain fix: the +~30-line
  # opportunistic idle-drain block (~3274) drifted the last wizard
  # editMessageText site to 10604 (past 10580). End 10580 -> 10620;
  # next raw call is 10698 (outside), so no new un-allowlisted call
  # enters — same already-.catch-swallowed wizard site.
  # Re-bumped 2026-05-19 for proactive context-compaction: +107 net
  # lines (perf import, maybeProactiveCompact + module state, onSession
  # event activeFile capture) drifted the three already-.catch-swallowed
  # wizard editMessageText sites to 10664/10687/10711 (past 10620). End
  # 10620 -> 10760; the next raw ctx.api call is 12579 (ctx.api.getFile,
  # far outside), so no new un-allowlisted call enters.
  # Re-bumped 2026-05-19 for proactive-compaction notification: +150 net
  # lines drifted the three wizard editMessageText sites to
  # 10814/10837/10861 (past 10760). End 10760 -> 10920; next raw
  # ctx.api call is still far outside (~12700+), so no new
  # un-allowlisted call enters.
  # Re-bumped 2026-05-19 for the durable-inbound-spool feature: the
  # ~40-line spool construct + boot-replay block (~3057) drifted the
  # vault-wizard editMessageText sites to 10935/10958/10982 (past
  # 10920). End 10920 -> 11000; next raw call is well outside, so no
  # new un-allowlisted call enters — same already-.catch-swallowed
  # wizard sites.
  # Re-bumped 2026-05-20 for the silence-poke turn-state purge fix:
  # the ~17-line purgeStaleTurnsForChat insertion (~3014) drifted the
  # last wizard editMessageText site to 11002 (past 11000). End
  # 11000 -> 11020; next raw call is well outside — same already-
  # .catch-swallowed wizard site, no new un-allowlisted call enters.
  # Re-bumped 2026-05-20 (same-PR follow-up): the +~26-line
  # endCurrentTurnAtomic helper insertion (~1320) drifted the last
  # wizard editMessageText site 11002 -> 11028 (past 11020). End
  # 11020 -> 11040; same already-.catch-swallowed wizard site, no
  # new un-allowlisted call enters.
  "telegram-plugin/gateway/gateway.ts:9340-11040:vault grant wizard ctx.api.editMessageText already has .catch swallow"

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
