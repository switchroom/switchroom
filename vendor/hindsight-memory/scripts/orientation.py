#!/usr/bin/env python3
"""SessionStart hook: Memory v2 M5 — orientation-at-boot (Surface B).

carve-M5.md §3. Injects the agent's cron-refreshed ``orientation`` mental
model into context at SessionStart AND re-seats it after every compaction —
"reflect once, serve from cache" (E-79), deterministically, zero tool call.

DARK BY DEFAULT (red-team kill switch). Entirely gated by
``memoryOrientationEnabled`` (default False — carve §4, same discipline as
M4's ``memoryPrefetchEnabled``). When off this hook is a hard no-op: it reads
config, sees the flag off, and exits BEFORE any bank resolve or network call.
The flag is per-agent — a stripped/absent value fails to OFF (fail-safe), so
an un-flipped agent boots exactly as pre-M5.

MATCHER-LESS (load-bearing, carve §1/§3). Registered with NO matcher, so it
fires on every SessionStart source — startup, resume, clear, fork AND compact.
The compact firing is the free deterministic post-compaction re-seat that
answers E-88 ("nothing re-seats orientation today"): the hook re-reads the
model from the engine each time, so a mid-session refresh is picked up at the
next compaction with no session restart. Do NOT add a matcher.

FAIL-SAFE INVARIANTS (all asserted in tests/test_orientation_hook.py):
  - Boot is NEVER blocked on the orientation read. Every failure path
    (server down, no model, read error, read timeout, degraded/undated
    model) degrades to a VISIBLE one-line cold notice + a refresh request,
    and exits 0. Never a silently memoryless boot, never a stale briefing
    presented as fresh.
  - A stale (1.5×–3× cadence) model is injected WITH a visible prefix; a
    degraded (>3×) or undated model is NOT injected — the cold notice is
    emitted instead. Thresholds are per-tier (carve §5), not a fixed 36h.

STDOUT CONTRACT. A SessionStart hook's stdout IS added to the model's context
(unlike PreCompact); we emit ``{"hookSpecificOutput":{"hookEventName":
"SessionStart","additionalContext": "…"}}``. Exit code is 0 ALWAYS — a
non-zero exit BLOCKS the turn in Claude Code, and orientation must degrade to
a notice, never a hard stop (same doctrine as rules-sentinel-hook.sh).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import orientation as orient
from lib.bank import derive_bank_id
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.daemon import get_api_url

#: Generous read-timeout for the model GET (carve §3). overlord's own-bank read
#: is ~270ms and klanker's ~4ms (m0/m5-0 probes), but the latency asymmetry is
#: unexplained and possibly bank-size-correlated, so leave headroom — and on a
#: timeout degrade to the cold notice, never a hung boot.
ORIENTATION_READ_TIMEOUT_S = 3


def _emit(additional_context: str) -> None:
    """Print the SessionStart additionalContext envelope to stdout."""
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": additional_context,
                }
            }
        )
    )


def enqueue_refresh(config: dict, bank_id: str, model_name: str) -> None:
    """Signal that ``bank_id``'s orientation model needs a background refresh.

    The cold/degraded path requests a refresh so a boot that found no usable
    briefing does not stay briefing-less indefinitely (carve §3-4). This is the
    SEAM the M5-C out-of-session tiered scheduler consumes; the scheduler is
    cadence-driven regardless, so this is a best-effort nudge, never a blocking
    dependency. Kept as a thin, override-able function so the cold-path tests
    can assert the OUTCOME ("a refresh was requested") without a live scheduler.

    Best-effort and total: any failure is swallowed — a boot must never fail
    because a refresh request could not be recorded.
    """
    debug_log(
        config,
        f"orientation cold/degraded on bank '{bank_id}' model "
        f"'{model_name}' — refresh requested",
    )
    try:
        state_dir = os.environ.get("HINDSIGHT_STATE_DIR") or os.path.join(
            os.path.expanduser("~"), ".hindsight"
        )
        os.makedirs(state_dir, exist_ok=True)
        marker = os.path.join(state_dir, "orientation-refresh-pending.jsonl")
        with open(marker, "a") as f:
            f.write(json.dumps({"bank_id": bank_id, "model": model_name}) + "\n")
    except Exception as e:  # noqa: BLE001 — best-effort, never breaks boot
        debug_log(config, f"orientation refresh-request write failed (ignored): {e}")


def _match_model(models: dict, name: str) -> dict | None:
    """Find the mental model whose ``name`` matches the configured orientation name."""
    items = models.get("items") if isinstance(models, dict) else None
    if not isinstance(items, list):
        return None
    for item in items:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def run(hook_input: dict, config: dict) -> None:
    """Core hook logic. Emits at most one additionalContext block; never raises."""
    if not config.get("memoryOrientationEnabled", False):
        debug_log(config, "memoryOrientationEnabled off — orientation no-op")
        return

    model_name = config.get("memoryOrientationModel", "orientation")
    cadence_hours = int(config.get("memoryOrientationCadenceHours", 48) or 48)
    bank_id = derive_bank_id(hook_input, config)

    def _dbg(*a):
        debug_log(config, *a)

    # Resolve the engine REST URL WITHOUT starting the daemon (too slow for
    # SessionStart). If the server is unreachable, degrade to the cold notice —
    # we cannot read the model, and boot must not block.
    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=False)
        client = HindsightClient(api_url, config.get("hindsightApiToken"))
    except (RuntimeError, ValueError) as e:
        debug_log(config, f"orientation: Hindsight unreachable ({e}) — cold notice")
        enqueue_refresh(config, bank_id, model_name)
        _emit(orient.cold_notice())
        return

    # Resolve the orientation model by NAME → id, then read its content +
    # freshness watermark. Any read error/timeout is a cold notice, not a hang.
    try:
        models = client.list_mental_models(bank_id, timeout=ORIENTATION_READ_TIMEOUT_S)
        match = _match_model(models, model_name)
    except Exception as e:  # noqa: BLE001 — degrade to cold, never block boot
        debug_log(config, f"orientation: list models failed ({e}) — cold notice")
        enqueue_refresh(config, bank_id, model_name)
        _emit(orient.cold_notice())
        return

    if not match or not match.get("id"):
        debug_log(config, f"orientation: no model named '{model_name}' — cold notice")
        enqueue_refresh(config, bank_id, model_name)
        _emit(orient.cold_notice())
        return

    try:
        full = client.get_mental_model(
            bank_id, match["id"], detail="full", timeout=ORIENTATION_READ_TIMEOUT_S
        )
    except Exception as e:  # noqa: BLE001 — includes urllib timeout
        debug_log(config, f"orientation: model read failed ({e}) — cold notice")
        enqueue_refresh(config, bank_id, model_name)
        _emit(orient.cold_notice())
        return

    content = (full or {}).get("content") or ""
    last_refreshed_at = (full or {}).get("last_refreshed_at")
    state, hours_ago = orient.classify_staleness(last_refreshed_at, cadence_hours)

    if not content.strip() or state in ("degraded", "unknown"):
        # Empty payload, or refreshed > 3× cadence ago / undated: never present
        # stale-as-fresh. Cold notice + refresh request (carve §5).
        debug_log(config, f"orientation: state={state}, empty={not content.strip()} — cold notice")
        enqueue_refresh(config, bank_id, model_name)
        _emit(orient.cold_notice())
        return

    debug_log(config, f"orientation: injecting (state={state}, {hours_ago}h ago)")
    _emit(orient.render_orientation(content, state, hours_ago))


def main():
    config = load_config()
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        hook_input = {}
    run(hook_input, config)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — a hook that exits non-zero blocks the turn
        print(f"[Hindsight] Orientation SessionStart error: {e}", file=sys.stderr)
    sys.exit(0)
