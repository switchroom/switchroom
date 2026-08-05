#!/usr/bin/env python3
"""SessionStart hook: health check + durability drain/reconcile.

Fires once when a Claude Code session begins (startup / compact / clear).
This is the Claude Code equivalent of Openclaw's service.start() — verify
the server is reachable early, then do the durability work that a prior
session's abrupt death may have skipped: drain SessionEnd-queued retains
(#1071) and reconcile un-committed transcript turns (#3244).

Runs ASYNC (``"async": true`` in hooks/hooks.json), for a reason specific
to THIS hook: it injects NO additionalContext — every return path is a
pure side effect — so nothing in the session depends on it finishing
before the first prompt, and losing async's dropped context costs us
nothing here (unlike recall.py, which must stay synchronous to inject).

Why async matters: drain and reconcile each carry an independent
wall-clock budget (``HINDSIGHT_DRAIN_BUDGET_S`` / ``HINDSIGHT_RECONCILE_BUDGET_S``,
4s each) plus a Mode-1 health probe (~2s). Those budgets were each sized
against the old synchronous 5s SessionStart timeout in ISOLATION, but they
STACK on one hook: drain(4s) + reconcile(4s, added later in #3244) +
probe(2s) routinely overran 5s, so the hook was SIGKILLed mid-drain on a
large share of firings (see the fleet-wide ``hook_cancelled`` transcript
attachments) — truncating exactly the durability work it exists to do,
and growing the pending-retains backlog it was meant to clear. Async
detaches it from the SessionStart critical path so the bounded, resumable
drain/reconcile can run to completion instead of being cut off. Both are
crash-safe under an eventual reap anyway: drain holds an ``fcntl.flock``
the kernel releases on death and re-queues unsent entries, and reconcile
is idempotent and resumes any over-budget remainder on the next boot.

Keeping the drain here (rather than deferring wholly to the hindsight-drain
sidecar) is deliberate: that sidecar is only CONDITIONALLY started — its
own "NOT STARTED" branch in start.sh notes that when it is absent the
memory queue is drained ONLY at session boot — so this hook stays the
backlog path for agents without the sidecar. reconcile_tail has no sidecar
equivalent at all and lives only here.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.daemon import get_api_url, prestart_daemon_background


#: Marker every version-skew warning carries, so log scrapers and tests
#: match one stable string rather than the prose around it.
SKEW_MARKER = "PARTIAL PLUGIN ROLLOUT"


def _warn_version_skew(module: str, err: BaseException, config: dict, cost: str) -> None:
    """Report an import-level version skew LOUDLY, on stderr (#3599 R4-Lc).

    The plugin tree deploys as loose files under ``scripts/``, and this repo
    removes symbols across versions — ``pending.delete_entry``, whose last
    importer was ``drain_pending``, was removed in #3599 itself. A PARTIAL
    rollout (new ``lib/pending.py`` beside an old ``drain_pending.py``)
    therefore raises ``ImportError`` at the hook's import line.

    Before this guard that landed in a bare ``except Exception`` and went to
    ``debug_log``, which is off by default: the durability machinery would
    stop and nothing would say so. A backlog then grows until ``switchroom
    doctor`` notices it — and doctor names the QUEUE, not the cause. This
    turns a silent deploy fault into an every-boot stderr line naming the
    module, the missing symbol and the fix.

    Deliberately not keyed to ``delete_entry`` or to a version number: any
    import-level skew in this tree has the same cause and the same fix, so
    the check generalises to removals that have not happened yet. A version
    stamp would need bumping to stay true; this cannot go stale.

    Never raises and never re-raises — a skew must not take SessionStart
    down on top of everything else.
    """
    print(
        f"[Hindsight] SessionStart: cannot import {module} ({err}). "
        f"{SKEW_MARKER} — the files under the plugin's scripts/ are from "
        f"different versions. {cost} until this is fixed. Re-deploy the "
        f"plugin tree WHOLE (all of scripts/, never individual files).",
        file=sys.stderr,
    )
    try:
        debug_log(config, f"{module} import failed (version skew): {err}")
    except Exception:
        pass


def main():
    config = load_config()

    if not config.get("autoRecall") and not config.get("autoRetain"):
        debug_log(config, "Both autoRecall and autoRetain disabled, skipping session start")
        return

    # Consume stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        hook_input = {}

    debug_log(config, f"SessionStart hook, source: {hook_input.get('source', 'unknown')}")

    # Try to resolve API URL (health check). Don't start daemon here —
    # that's too slow for session start. Just check if server is reachable.
    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=False)
        client = HindsightClient(api_url, config.get("hindsightApiToken"))
        debug_log(config, f"Hindsight server reachable at {api_url}")
    except (RuntimeError, ValueError) as e:
        # Server not running — kick off background pre-start so it's ready
        # by the time the first recall or retain hook fires. Skip the
        # drain here: with no server to talk to, every retry would just
        # bump attempt counters and burn the SessionStart budget.
        debug_log(config, f"Hindsight not running, initiating background pre-start: {e}")
        prestart_daemon_background(config, debug_fn=_dbg)
        return

    # Mode 1 (external hindsightApiUrl) reachability gate (#1094 item 1).
    # get_api_url() returns the external URL WITHOUT probing it, so an
    # external server that's down would otherwise slip past the guard
    # above and let the drain run against nothing — bumping attempt
    # counters on healthy entries until the stall guard trips. Modes 2/3
    # already gate via _check_health inside get_api_url, so only Mode 1
    # needs an explicit probe here. On failure, skip the drain and return
    # (no local daemon to pre-start in Mode 1 — the external server is the
    # operator's responsibility); queued entries stay for the next session.
    # Single bounded attempt (retries=1, timeout=2): the default 3-retry
    # health_check against a HUNG (timing-out) server would cost ~10s
    # (3*2s timeouts + 2*2s sleeps) — worse than the attempt-counter
    # bumps this gate prevents, and over the 5s SessionStart hook budget.
    # Worst-case probe cost here is ~2s.
    if config.get("hindsightApiUrl") and not client.health_check(timeout=2, retries=1):
        debug_log(
            config,
            f"External Hindsight at {api_url} unreachable, skipping drain",
        )
        return

    # Drain any retains that session_end.py queued on failure (#1071).
    # Bounded by HINDSIGHT_DRAIN_BUDGET_S so a slow upstream can't pin
    # the SessionStart hook. The drain is best-effort — failures stay
    # queued for the next session, dead entries surface via
    # `switchroom doctor`.
    try:
        from drain_pending import drain as drain_pending_retains

        drain_pending_retains(config)
    except ImportError as e:
        _warn_version_skew("drain_pending", e, config, "Queued retains will NOT be replayed")
    except Exception as e:
        # Never let the drain break session start. Issue sink picks
        # this up via run-hook.sh — see exit-code path in __main__.
        debug_log(config, f"drain_pending unexpected error (ignored): {e}")

    # Boot reconciliation (switchroom #3244): AFTER the drain, diff the durable
    # per-session watermark against the on-disk transcript tail and recover any
    # un-committed human turns an abrupt session death (SIGKILL / OOM /
    # watchdog) skipped — the drain only replays what SessionEnd managed to
    # enqueue, which an abrupt kill never runs. This is the load-bearing
    # guarantee; it is naturally cheap (skips sessions with no gap) and bounded
    # (lookback / turn-cap / wall-clock budget, each enqueuing its remainder).
    try:
        from reconcile_tail import reconcile as reconcile_tail

        reconcile_tail(config, hook_input=hook_input)
    except ImportError as e:
        _warn_version_skew(
            "reconcile_tail", e, config, "Un-committed turns will NOT be recovered"
        )
    except Exception as e:
        debug_log(config, f"reconcile_tail unexpected error (ignored): {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[Hindsight] SessionStart error: {e}", file=sys.stderr)
        sys.exit(0)
