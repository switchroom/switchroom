"""Configuration management for Hindsight plugin.

Loads settings from settings.json (plugin defaults) merged with environment
variable overrides. Full config schema matching Openclaw's 30+ options.
"""

import json
import os
import sys

DEFAULTS = {
    # Recall
    "autoRecall": True,
    # Switchroom default: "low" — vector search only, no LLM reranking.
    # Cuts the recall hook latency from ~5s (mid budget) to ~1-2s (low).
    # Operators who want richer recall can set HINDSIGHT_RECALL_BUDGET=mid
    # via per-agent env or write `recallBudget: "mid"` into the user
    # config file. Forensics on real klanker turns showed mid-budget
    # recall was ~5s of wall-clock latency dominated by the LLM filter
    # pass; for chat-pattern agents the vector hits alone are fine and
    # the 5s is the second-largest contributor to perceived dead air
    # (after the model TTFT).
    "recallBudget": "low",
    "recallMaxTokens": 1024,
    # Switchroom-local: cap on the number of memories injected into the
    # `<hindsight_memories>` block, regardless of token budget. Plugin v0.4.0
    # exposes `recallTopK` only in the Openclaw integration, not the
    # Claude Code integration, so we slice client-side in recall.py before
    # formatting. Set to 0 (or any non-positive value) to disable the cap
    # and inject everything Hindsight returns.
    "recallMaxMemories": 12,
    # Switchroom-local: minimum lexical (Jaccard) overlap between the
    # user's query terms and a memory's text terms. Memories below this
    # threshold are dropped before formatting. 0.0 disables the gate
    # (current behaviour: inject everything Hindsight returns up to the
    # count cap). NOTE: Hindsight's HTTP recall API DOES return per-result
    # relevance scores (`scores.final`, plus `.semantic`/`.keyword`/
    # `.reranker`) — verified at runtime — and recall.py now reads and
    # sorts the merged set by `scores.final`. This Jaccard gate is a
    # separate lexical-overlap quality filter layered on top — see #475.
    "recallMinOverlap": 0.0,
    "recallTypes": ["world", "experience"],
    # Switchroom-local: when True (default; Ken-approved ON) recall biases
    # toward synthesized `observation`-tier facts. Escape hatch: pin off via
    # `recallPreferObservations: false` in the user config — read in recall.py.
    "recallPreferObservations": True,
    # Switchroom #2848 Stage B/C — deterministic directive capture.
    # When on (switchroom default; pinned true in the copied plugin
    # settings.json by applyHindsightSettingsOverrides), TWO deterministic
    # hooks share this knob:
    #   * Stage B (recall.py, UserPromptSubmit): regex-detects correction /
    #     standing-rule-shaped inbound and appends a terse advisory to the
    #     turn's additionalContext telling the model to persist the rule with
    #     create_directive if it IS durable.
    #   * Stage C (directive_verify.py, Stop): after the turn, re-checks the
    #     human turn against a HIGH-PRECISION durable-rule regex and, if the
    #     model recorded no create_directive call, blocks the stop ONCE to
    #     re-prompt capture (closes the "model ignored the nudge" gap).
    # Both are pure detection — no model callsite, no silent hook-side write;
    # the model authors the directive in-session (chat-legible). Operators opt
    # out per-agent via memory.directive_capture_nudge=false →
    # HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE (disables BOTH hooks).
    "directiveCaptureNudge": True,
    # Switchroom #2873/#2903 Fix 6.2 — the BLOCKING half (Stage C
    # directive_verify.py Stop hook) split out from the advisory nudge. When
    # True (default) the verifier may block the stop once to re-prompt capture;
    # when False the Stage B nudge still fires but the Stop hook NEVER blocks
    # (advisory-only mode). Lets an operator keep the gentle nudge while dropping
    # the more intrusive block. Gated UNDER directiveCaptureNudge: turning the
    # nudge off disables both regardless of this knob. Operators opt out
    # per-agent via memory.directive_capture_verify=false →
    # HINDSIGHT_DIRECTIVE_CAPTURE_VERIFY.
    "directiveCaptureVerify": True,
    "recallContextTurns": 1,
    "recallMaxQueryChars": 800,
    "recallRoles": ["user", "assistant"],
    # Upstream 962140eef — optional recall tag filters passed through to the
    # recall API, plus per-additional-bank overrides keyed by bank ID.
    "recallTags": [],
    "recallTagsMatch": "any",
    "recallTagGroups": None,
    "recallAdditionalBankFilters": {},
    "recallPromptPreamble": (
        "Relevant memories from past conversations (prioritize recent when "
        "conflicting). Only use memories that are directly useful to continue "
        "this conversation; ignore the rest:"
    ),
    # Retain
    "autoRetain": True,
    "retainMode": "full-session",
    "retainRoles": ["user", "assistant"],
    "retainEveryNTurns": 10,
    "retainOverlapTurns": 2,
    "retainToolCalls": True,
    "retainContext": "claude-code",
    "retainTags": [],
    "retainMetadata": {},
    # Switchroom #3244 — boot reconciliation of un-committed transcript tails.
    # On by default; the load-bearing recovery for work an abrupt session death
    # (SIGKILL/OOM/watchdog) skipped. Disable per-agent via
    # HINDSIGHT_RECONCILE_ON_START=false. reconcile_tail.py also honours the
    # HINDSIGHT_RECONCILE_{LOOKBACK_H,MAX_TURNS,BUDGET_S} bounds (read directly).
    "reconcileOnStart": True,
    "recallAdditionalBanks": [],
    # Connection
    "hindsightApiUrl": None,
    "hindsightApiToken": None,
    "apiPort": 9077,
    "daemonIdleTimeout": 0,
    "embedVersion": "latest",
    "embedPackagePath": None,
    # Upstream 55ef70679 — optional global HTTP request timeout override
    # (seconds). None = keep each call's own default. NOTE: switchroom's
    # recall.py deliberately does NOT wire this override into its client —
    # recall carries its own 8s hook-budget timeout (see recall.py). This
    # mainly benefits retain's 15s timeout on slow/loaded servers.
    "requestTimeoutSeconds": None,
    # Bank
    "bankId": None,
    "bankIdPrefix": "",
    "dynamicBankId": False,
    "dynamicBankGranularity": ["agent", "project"],
    "bankMission": "",
    "retainMission": None,
    "agentName": "claude-code",
    # LLM (for daemon mode)
    "llmProvider": None,
    "llmModel": None,
    "llmApiKeyEnv": None,
    # Misc
    "debug": False,
}

# Map env var names to config keys and their types
ENV_OVERRIDES = {
    "HINDSIGHT_API_URL": ("hindsightApiUrl", str),
    "HINDSIGHT_API_TOKEN": ("hindsightApiToken", str),
    "HINDSIGHT_BANK_ID": ("bankId", str),
    "HINDSIGHT_AGENT_NAME": ("agentName", str),
    "HINDSIGHT_AUTO_RECALL": ("autoRecall", bool),
    "HINDSIGHT_AUTO_RETAIN": ("autoRetain", bool),
    "HINDSIGHT_RETAIN_MODE": ("retainMode", str),
    # Switchroom #3244 — boot reconciliation on/off (default on).
    "HINDSIGHT_RECONCILE_ON_START": ("reconcileOnStart", bool),
    "HINDSIGHT_RECALL_BUDGET": ("recallBudget", str),
    "HINDSIGHT_RECALL_MAX_TOKENS": ("recallMaxTokens", int),
    # Switchroom-local: count cap. Set by start.sh from
    # agents.<name>.memory.recall.max_memories (cascading through
    # defaults.memory.recall.max_memories) when present in switchroom.yaml.
    "HINDSIGHT_RECALL_MAX_MEMORIES": ("recallMaxMemories", int),
    # Switchroom-local: lexical-overlap threshold (#475). Float in
    # [0.0, 1.0]. Set by start.sh from agents.<name>.memory.recall.min_overlap
    # (cascading through defaults). 0.0 = off (current behaviour).
    "HINDSIGHT_RECALL_MIN_OVERLAP": ("recallMinOverlap", float),
    # Switchroom-local: recall fact types (comma-separated). Set by start.sh
    # from agents.<name>.memory.recall.types only when the operator overrode
    # the switchroom default (world,experience,observation) — i.e. the
    # opt-out path for the synthesized `observation` tier.
    "HINDSIGHT_RECALL_TYPES": ("recallTypes", list),
    # Switchroom-local: trivial-turn recall skip (Phase 6a). Set by start.sh
    # from agents.<name>.memory.recall.skip_trivial only on override; the
    # switchroom default is on (recall.py falls back to True).
    "HINDSIGHT_RECALL_SKIP_TRIVIAL": ("recallSkipTrivial", bool),
    # Switchroom #2848 Stage B: directive-capture nudge on/off. Set by
    # start.sh from agents.<name>.memory.directive_capture_nudge only when
    # the operator overrode it; the switchroom default is on (settings.json
    # pins true; recall.py falls back to True).
    "HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE": ("directiveCaptureNudge", bool),
    # Switchroom #2873/#2903 Fix 6.2: the Stage C block on/off, independent of
    # the Stage B nudge. Set by start.sh from
    # agents.<name>.memory.directive_capture_verify only when the operator
    # overrode it; the switchroom default is on.
    "HINDSIGHT_DIRECTIVE_CAPTURE_VERIFY": ("directiveCaptureVerify", bool),
    "HINDSIGHT_RECALL_MAX_QUERY_CHARS": ("recallMaxQueryChars", int),
    "HINDSIGHT_RECALL_CONTEXT_TURNS": ("recallContextTurns", int),
    # Upstream 962140eef — recall tag filters. The tags env var accepts JSON
    # or a comma-separated list; the others must be JSON.
    "HINDSIGHT_RECALL_TAGS": ("recallTags", list),
    "HINDSIGHT_RECALL_TAGS_MATCH": ("recallTagsMatch", str),
    "HINDSIGHT_RECALL_TAG_GROUPS": ("recallTagGroups", dict),
    "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS": ("recallAdditionalBankFilters", dict),
    "HINDSIGHT_API_PORT": ("apiPort", int),
    "HINDSIGHT_DAEMON_IDLE_TIMEOUT": ("daemonIdleTimeout", int),
    # Upstream 55ef70679 — global request timeout override.
    "HINDSIGHT_REQUEST_TIMEOUT_SECONDS": ("requestTimeoutSeconds", int),
    "HINDSIGHT_EMBED_VERSION": ("embedVersion", str),
    "HINDSIGHT_EMBED_PACKAGE_PATH": ("embedPackagePath", str),
    "HINDSIGHT_DYNAMIC_BANK_ID": ("dynamicBankId", bool),
    "HINDSIGHT_BANK_MISSION": ("bankMission", str),
    "HINDSIGHT_LLM_PROVIDER": ("llmProvider", str),
    "HINDSIGHT_LLM_MODEL": ("llmModel", str),
    "HINDSIGHT_DEBUG": ("debug", bool),
}


def _cast_env(value: str, typ):
    """Cast environment variable string to target type. Returns None on failure."""
    try:
        if typ is bool:
            return value.lower() in ("true", "1", "yes")
        if typ is int:
            return int(value)
        if typ is float:
            return float(value)
        if typ is list:
            # JSON list first (upstream 962140eef). A value that parses as
            # JSON but is NOT a list (e.g. `42`, `"x"`, `{}`) is a config
            # mistake, not a comma-separated string — return None so the
            # default is kept (matches upstream; fail-open). Only values
            # that don't parse as JSON at all take the comma-split path.
            try:
                parsed = json.loads(value)
            except ValueError:
                if value.lstrip().startswith(("[", "{")):
                    # Looks like intended JSON but doesn't parse —
                    # malformed config, not a comma list. Keep default.
                    return None
                # Comma-separated → list of trimmed, non-empty strings.
                return [t.strip() for t in value.split(",") if t.strip()]
            return parsed if isinstance(parsed, list) else None
        if typ is dict:
            # JSON only (dict or list accepted — tag_groups may be a list).
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list)):
                return parsed
            return None
        return value
    except (ValueError, AttributeError):
        return None


def _load_settings_file(path: str, config: dict) -> None:
    """Merge a settings.json file into config in-place. Silently skips if missing."""
    if not os.path.exists(path):
        return
    try:
        with open(path) as f:
            file_config = json.load(f)
        config.update({k: v for k, v in file_config.items() if v is not None})
    except (json.JSONDecodeError, OSError) as e:
        debug_log(config, f"Failed to load {path}: {e}")


def load_config() -> dict:
    """Load plugin configuration from settings.json + env overrides.

    Loading order (later entries win):
      1. Built-in defaults
      2. Plugin default settings.json  (CLAUDE_PLUGIN_ROOT/settings.json)
      3. User config                   (~/.hindsight/claude-code.json)
      4. Environment variable overrides

    ~/.hindsight/claude-code.json is the recommended place to configure the
    plugin — same convention as ~/.openclaw/openclaw.json. It is stable across
    plugin updates and marketplace changes.
    """
    config = dict(DEFAULTS)

    # 1. Plugin default settings.json (ships with the plugin, version-specific path)
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
    if not plugin_root:
        plugin_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _load_settings_file(os.path.join(plugin_root, "settings.json"), config)

    # 2. User config — stable, version-independent, matches openclaw convention
    user_config_path = os.path.join(os.path.expanduser("~"), ".hindsight", "claude-code.json")
    _load_settings_file(user_config_path, config)

    # Apply environment variable overrides
    for env_name, (key, typ) in ENV_OVERRIDES.items():
        val = os.environ.get(env_name)
        if val is not None:
            cast_val = _cast_env(val, typ)
            if cast_val is not None:
                config[key] = cast_val

    return config


def debug_log(config: dict, *args):
    """Log to stderr if debug mode is enabled."""
    if config.get("debug"):
        print("[Hindsight]", *args, file=sys.stderr)
