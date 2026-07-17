# Apply-time model bake vs. boot-time live config — architecture dig

**Repo HEAD analyzed:** `7729c67` — *"fix(errors): proxy-fallback 401 is an operator-only infra fault… (#3293)"* (2026-07-17 10:52 +1000)
**Working tree:** `~/work/repo` (freshly `git pull`ed to origin/main).

---

## Top line (for a CPO)

Today when the operator edits an agent's `model:` in `switchroom.yaml` and just restarts the
container, the agent silently launches the **old** model — while `/status` and the /model menu
report the **new** one. That split is real and load-bearing-free for the model field: the live
yaml is **already mounted read-only inside every agent container**, and the model resolver is a
**pure static function with no vault/network/ordering dependency**. So we *can* make "edit config +
restart" just take effect, like operators expect. The minimal safe change is ~15 lines of shell in
`start.sh.hbs` that resolve the configured default from the live yaml at boot, falling back to the
baked literal if the yaml is unreadable. Model **class** changes (Claude ⇄ non-Claude `sr-*`) still
want a full apply because they also touch the compose file — but Claude⇄Claude (opus/sonnet/haiku),
the operator's actual pain, needs nothing but the boot-time read.

---

## Q1 — Why is a full `apply` needed at all? What does it bake?

`switchroom apply` (`src/cli/apply.ts`) does five distinct things a `docker restart` does **not**:

| Artifact | Rendered where | Must be build-time? |
|---|---|---|
| **`start.sh`** (launcher, incl. `_EFFECTIVE_MODEL`) | `scaffoldAgent` → `profiles/_base/start.sh.hbs`; model injected at `scaffold.ts:3232` (`modelQ: shellSingleQuote(resolveMainModel(agentConfig.model))`) → template line `start.sh.hbs:1177` `_EFFECTIVE_MODEL={{{modelQ}}}` | **No** for the model value (see Q3). Yes for the script *structure*. |
| **`.mcp.json`** | `scaffold.ts` (SWITCHROOM_CONFIG etc., ~`3471`) | Mostly static paths; not the drift source. |
| **`settings.json`** (`settings.model` also = `resolveMainModel`, `scaffold.ts:4312` & `:6912`) | scaffold | **No** — duplicate of the same baked model; could be dropped/boot-resolved. |
| **`docker-compose.yml`** (service env, UID, volume mounts, **model-class routing** of `ANTHROPIC_BASE_URL` gated on `resolveMainModel(resolved.model)`, `compose.ts:862` → `emitAgentService`) | `write-compose.js` | **Partly yes** — only the *routing class* (Claude passthrough vs LiteLLM router) is compose-level. |
| **Vault key provisioning** (LiteLLM per-agent virtual key) + **UID alignment / chown** | apply.ts | **Yes** — genuinely host/privileged, one-time. |

A container **restart just re-execs the already-rendered `start.sh`** — it re-renders nothing. So
every field baked into that script (the model literal) is frozen until the next host-side apply.
That is the entire mechanism of the drift.

## Q2 — Why is the model baked instead of read live?

Git history shows the model bake is **incidental/legacy, not a load-bearing design decision.** The
model has been a `--model` literal in the launcher since long before the session-override machinery;
the churn on `start.sh.hbs` (`#2993 → #3042 → #3184 → #3277 → #3284`, `git log` on the template) is
**all about the `/model` *override* carrier** (`.session-model`), never about the *configured
default*, which has quietly stayed a scaffold-time literal the whole time.

`resolveMainModel` (`scaffold.ts:1364`) is the proof it isn't load-bearing:

```ts
export function resolveMainModel(model: string | undefined): string {
  if (model === undefined || model === "default") return SWITCHROOM_DEFAULT_MAIN_MODEL; // "claude-sonnet-5"
  return model;
}
```

Pure. No vault, no network, no ordering dependency, no bootstrap-before-gateway problem — the model
string is needed only at the final `exec claude --model` line, which is the **last** thing start.sh
does, long after the LiteLLM probe and env setup. There is **no** "model needed before the CLI
exists" constraint. The only genuinely build-time-coupled piece is the LiteLLM **routing class**
(Q1/Q4), and start.sh *already* re-derives that live (see Q3).

## Q3 — Why can't the yaml just be hot-loaded at boot? (What actually blocks it — spoiler: almost nothing)

**The live yaml is already there.** Every agent service bind-mounts it **read-only**:

- `compose.ts:1446 / :1628` → `- ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`
- `CONTAINER_CONFIG_PATH = "/state/config/switchroom.yaml"` (`compose.ts:975`), exported as
  `SWITCHROOM_CONFIG` into the service (`compose.ts:1401`) **and** re-exported by start.sh itself
  (`start.sh.hbs:520`).
- A `:ro` bind mount reflects host edits live — the operator's `switchroom.yaml` change is visible
  inside the container **the instant they save it**, no apply required.

**The CLI works in-container at boot.** start.sh already shells out to `switchroom vault get …` at
boot (`start.sh.hbs:100`, `:1063`) and it succeeds — so the `switchroom` binary + `SWITCHROOM_CONFIG`
are functional before the model line. The exact resolver `/status` uses,
`switchroom agent list --json`, computes the model via
`resolveAgentConfig(config.defaults, config.profiles, agentConfig)` then `resolved.model ?? default`
(`agent.ts:859-864`) — reading the mounted yaml, **no vault, no docker** needed for the model field
(model is always a plain string, never a `vault:` ref).

**What would it take for the model field:** in `start.sh.hbs`, before line 1177, attempt a live
resolve and fall back to the baked literal:

```sh
_BAKED_MODEL={{{modelQ}}}
_EFFECTIVE_MODEL="$_BAKED_MODEL"
if [ -r "$SWITCHROOM_CONFIG" ]; then
  _live="$(switchroom agent model "$SWITCHROOM_AGENT_NAME" 2>/dev/null | tr -d '[:space:]')"
  if printf '%s' "$_live" | grep -Eq '^[A-Za-z0-9][]A-Za-z0-9._[/-]{0,99}$'; then
    _EFFECTIVE_MODEL="$_live"
  fi
fi
```

(A tiny `switchroom agent model <name>` subcommand — or `agent list --json | jq` — is the one new
piece; the resolver already exists.) The existing session-override, invalidation, and sr-*/fable
repoint logic below it all keep working unchanged because they operate on `_EFFECTIVE_MODEL`.

**Failure modes, all already handled or trivial:**
- *yaml unreadable / partial write* → `[ -r ]` + shape-gate regex fall back to baked literal. Safe.
- *vault dependency* → none for the model field.
- *ordering/perf* → resolve happens at the end of boot; one extra sub-100ms CLI call.
- *`configuredDefaultAtWrite` compare* (`start.sh.hbs:1216,1260`) already exists to invalidate a
  stale `/model` override when the default changes — it composes cleanly with a live default.

## Q4 — Blast radius & risk

**Derives from `_EFFECTIVE_MODEL` (all keep working — they read the variable, not the literal):**
`--model`, `--fallback-model` (`fallbackModelQ`), effort routing, and the sr-*/fable
passthrough→router repoint (`start.sh.hbs:1386-1393`), which **already re-derives routing live at
boot** whenever LiteLLM is reachable.

**Must stay build-time:**
1. **compose-level model-class routing** — `ANTHROPIC_BASE_URL` passthrough (Claude) vs LiteLLM
   router (non-Claude `sr-*`) is chosen in `emitAgentService` from `resolveMainModel(resolved.model)`
   (`compose.ts:862`). Switching an agent **across** that class boundary changes the compose env, so
   it needs a compose regen (apply). **But** start.sh's boot repoint already covers the reachable
   case, so even this degrades gracefully rather than breaking.
2. **UID alignment / chown** and **LiteLLM virtual-key provisioning** — privileged, host-only,
   one-time; unaffected by model edits.
3. **The `start.sh` script structure itself** — template changes still need a re-render.

**Net risk of hot-loading the model default:** low, and strictly *narrowing* the drift. Worst case
(yaml unreadable) falls back to exactly today's behavior — the baked literal. There is no path where
boot-resolve is *less* safe than the status quo.

---

## Recommendation

**Yes — eliminate this drift class for the model field by boot-time live resolution.** Minimal safe change:

1. Add a thin `switchroom agent model <name>` (or reuse `agent list --json`) that prints the
   cascade-resolved default — the resolver already exists (`agent.ts:859`).
2. In `start.sh.hbs`, resolve `_EFFECTIVE_MODEL` from the **mounted live yaml** with the baked
   literal as fallback (snippet in Q3), *above* the existing override block. Do the same for
   `settings.json`'s `settings.model` or simply stop baking it.
3. Keep **compose/UID/vault** build-time. For a Claude⇄`sr-*` **class** switch, still require apply
   (the compose env changes) — but this is rare and already partially self-heals at boot.
4. **Whole-config hot-load** is a larger, separately-scoped follow-up (env blocks, tools, permissions
   also bake into settings.json/.mcp.json); the model field is the high-value, low-risk first slice
   and resolves the operator's actual pain.

**Locking test:** an integration test that (a) renders an agent with `model: opus`, (b) rewrites the
mounted `switchroom.yaml` to `model: sonnet` **without** re-running apply, (c) execs start.sh, and
(d) asserts the `exec claude … --model` line (capture via a stub `claude`) carries `sonnet`, i.e.
**launched model == live yaml model**. Add the negative: corrupt/absent yaml ⇒ launches the baked
literal.
