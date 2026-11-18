# Downstream patches

Build-time changes the Fleet image makes to third-party source it does not own.
Each entry says what is patched, which upstream report tracks the real fix, and
when the patch comes out. A patch whose removal condition is met should be
removed in its own small PR.

## Honcho plugin: repoint two Hermes core imports

- **Patch:** `scripts/patch-honcho-core-imports.py`, run by the `Dockerfile`
  right after the pinned `plastic-labs/honcho` plugin is copied in. Tests:
  `tests/test_honcho_core_imports.py`.
- **Why:** Hermes Agent's storage refactor removed two names the plugin imports
  when it loads. On current Hermes the plugin fails with `ImportError` and Honcho
  memory is off.

  | Plugin file | Old import | Current home |
  | --- | --- | --- |
  | `__init__.py` | `agent.skill_commands.extract_user_instruction_from_skill_message` | `session_rules.turns.extract_user_instruction_from_skill_message` (same signature) |
  | `client.py` | `hermes_state_common.TITLE_SOURCE_DERIVED`, `TITLE_SOURCE_LLM` | `persistence.conversation.sessions.TitleSource.DERIVED` / `.LLM` (string values `"derived"` and `"llm"`, unchanged) |

- **Upstream:** [plastic-labs/honcho#1615](https://github.com/plastic-labs/honcho/issues/1615).
  Plugin PRs there are limited to maintainers, so the issue is the tracking
  point. Checked on 2026-11-18: plugin `main` (ccec469, plugin 1.2.0) still
  fails against Hermes Agent `main` (f7e2898) and loads with this patch applied.
- **Remove when** the plugin revision pinned in the `Dockerfile` imports both
  names from their current homes, or falls back to them. Then delete the script,
  its `Dockerfile` step, its test and its entry in
  `scripts/fleet-image-change-scope.py`. The plugin core-seam check that runs
  after it (`scripts/verify-honcho-plugin-core-seams.py`) stays, and is what
  proves the new pin loads.
- **Pin-bump check:** the script fails the bake when an old import line is gone,
  which forces this review. It matches by substring, so an upstream fix that
  keeps the old import as an indented fallback (`try:` new path,
  `except ImportError:` old path) still matches and gets patched instead of
  failing. When bumping the plugin pin, read both import sites by hand, not just
  the bake result.
