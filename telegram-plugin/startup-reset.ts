/**
 * Clear stale Telegram polling state on gateway startup.
 *
 * The Telegram Bot API tracks one active long-poll session per bot
 * token. If the previous gateway process crashed mid-poll (e.g. systemd
 * killed it with SIGKILL after a start-timeout, which is exactly what
 * happened to klanker on 2026-04-21 at 16:35 AEST), the API-side slot
 * can remain occupied for several minutes. The new gateway then races
 * that orphan on every getUpdates call and gets back a 409 Conflict
 * ("terminated by other getUpdates request"). Grammy retries with
 * backoff but the loop can persist for hours.
 *
 * deleteWebhook is a no-op when no webhook is configured but it also
 * invalidates any active long-poll claim. Combined with
 * drop_pending_updates, it gives us a clean slate regardless of how
 * the previous process died. Safe to call on every startup — it's
 * idempotent and has no user-visible side effects beyond clearing the
 * (probably-empty) pending-updates queue.
 *
 * Reference: reference/restart-and-know-what-im-running.md — "silent
 * respawn. Agent comes back and the user has to guess whether it's
 * the same agent." A gateway stuck in a 409 loop is exactly that
 * failure mode.
 *
 * Lives in a separate module (not gateway.ts) so the test file can
 * import it without firing gateway.ts's top-level IIFE that starts
 * the bot.
 */

export interface DeleteWebhookCapable {
  deleteWebhook: (opts: { drop_pending_updates: boolean }) => Promise<unknown>;
}

export async function clearStaleTelegramPollingState(
  api: DeleteWebhookCapable,
): Promise<void> {
  try {
    await api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    // Best-effort — if deleteWebhook fails the runner will still start
    // and grammy's built-in 409 handling kicks in. Log so we can
    // diagnose if this becomes a recurring failure.
    process.stderr.write(`telegram gateway: deleteWebhook on startup failed: ${err}\n`);
  }
}
