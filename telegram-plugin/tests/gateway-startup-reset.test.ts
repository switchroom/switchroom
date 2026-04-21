import { describe, it, expect, vi } from "vitest";
import { clearStaleTelegramPollingState } from "../startup-reset";

/**
 * Regression guard for the 409 Conflict loop seen on 2026-04-21.
 *
 * Incident: klanker's gateway died with systemd result=timeout at 16:35
 * while holding an active long-poll on Telegram's side. Every subsequent
 * gateway startup raced that orphaned slot on getUpdates and got back
 * 409 Conflict indefinitely. Grammy's retry backoff didn't break out of
 * the loop; the gateway polled, failed, retried, polled, failed for
 * roughly two hours until someone manually called deleteWebhook.
 *
 * Fix: call deleteWebhook(drop_pending_updates=true) unconditionally at
 * gateway startup, before grammy starts polling.
 *
 * These tests pin that behaviour so we don't accidentally remove the
 * call during a future refactor and reintroduce the silent-respawn
 * anti-pattern from reference/restart-and-know-what-im-running.md.
 */

describe("clearStaleTelegramPollingState", () => {
  it("calls deleteWebhook with drop_pending_updates: true", async () => {
    const deleteWebhook = vi.fn().mockResolvedValue(true);
    const api = { deleteWebhook };

    await clearStaleTelegramPollingState(api);

    expect(deleteWebhook).toHaveBeenCalledTimes(1);
    expect(deleteWebhook).toHaveBeenCalledWith({ drop_pending_updates: true });
  });

  it("does not throw if deleteWebhook fails (best-effort)", async () => {
    const deleteWebhook = vi.fn().mockRejectedValue(new Error("network down"));
    const api = { deleteWebhook };

    // Should complete without throwing so the startup loop can carry on
    // and fall back to grammy's built-in 409 handling.
    await expect(clearStaleTelegramPollingState(api)).resolves.toBeUndefined();
    expect(deleteWebhook).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when called multiple times", async () => {
    const deleteWebhook = vi.fn().mockResolvedValue(true);
    const api = { deleteWebhook };

    await clearStaleTelegramPollingState(api);
    await clearStaleTelegramPollingState(api);
    await clearStaleTelegramPollingState(api);

    expect(deleteWebhook).toHaveBeenCalledTimes(3);
    // Every call uses the same args \u2014 no state accumulation.
    for (const call of deleteWebhook.mock.calls) {
      expect(call[0]).toEqual({ drop_pending_updates: true });
    }
  });

  it("forwards the rejection reason to stderr as a log line (not throwing)", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const deleteWebhook = vi.fn().mockRejectedValue(new Error("test-only: simulated 429"));
    const api = { deleteWebhook };

    await clearStaleTelegramPollingState(api);

    expect(stderrWrite).toHaveBeenCalled();
    const logged = stderrWrite.mock.calls.map(c => String(c[0])).join("\n");
    expect(logged).toMatch(/deleteWebhook.*failed/);
    expect(logged).toMatch(/simulated 429/);

    stderrWrite.mockRestore();
  });
});
