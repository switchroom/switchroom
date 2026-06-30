---
artifact: cold-start TTFO — minimising time to first outbound after restart
serves: survive-reboots-and-real-life
advances-outcome: always-available
status: draft v1
---

# RFC — Cold-start TTFO

> Status: draft v1. Scoping cold-start latency optimization. Companion to `reference/vision.md` (always-on specialist exec-assistants) and the wedge-cluster JTBD ("agent feels continuous across restarts").

## Why this RFC

The vision is **always-on specialist exec-assistants**: agents that feel continuous, present, immediate. The wedge cluster of 2026-05-18→20 closed the 5-minute *correctness* failure mode (stranded inbound, silence-poke fallback firing). It did not close the *experience* failure mode: every agent restart imposes a multi-second blank window between the user's first message after restart and the model's first reply (Time To First Outbound, TTFO).

### What we measured (2026-05-21 baseline)

| Path component                        | Time on production agents       |
|---------------------------------------|---------------------------------|
| `start.sh` synchronous shell work     | ~2.0s common-case               |
| → `switchroom handoff <name>`         | ~0.9s (when fires)              |
| → `handoff-briefing.sh`               | 0s (not installed in containers)|
| → `switchroom workspace render --stable` | ~0.9s                       |
| Gateway boot + IPC register           | sub-second                      |
| Bridge sidecar boot + MCP connect     | sub-second                      |
| Claude session start                  | ~1-2s                           |
| **First-turn prefix-cache cold miss** | **~3-10s (dominant)**           |
| Total observed first-turn TTFO        | **5-13s consistently**          |

The post-v0.12.22 boot-wedge fix took the worst-case (and wedged) cases off the table. The remaining variance is dominated by Anthropic-side prefix-cache cold miss on a 14-18KB `--append-system-prompt` payload. The originally-cited "1.7s baseline TTFO" was for a *warm-cache trivial UAT*, not first-turn-after-restart.

### Why it matters

The "always-on" experience erodes most visibly during restart windows. Operators see it during `/update apply`, `/restart`, and after host-level container churn. The wedge-fix narrative ("we closed the 5-minute hang") fades when the next-step gap is still 5-13s. From a JTBD lens: *agent feels continuous across restarts* is degraded by every additional second.

## The problem

The cold-start TTFO has two layers:

1. **Pre-claude shell work in `start.sh`** (~2s). Three serialized `timeout` calls before `exec claude`: handoff summarizer, briefing assembler, workspace render. Switchroom-controllable.
2. **Claude-side cold prefix-cache** (~3-10s). Anthropic's prompt cache is warm only after the first turn. On a fresh session with a 14-18KB system-prompt prefix, the first turn pays full processing cost. Not directly switchroom-controllable, but indirectly addressable by changing what gets sent, when, and how.

## Architectural options

Four options ranked by blast radius. Each addresses layer 2 (the dominant cost); the modest wins in §3 address layer 1 separately.

### Option A — Prefix-cache warmup turn (lowest blast radius)

On bridge-up after restart, the gateway synthesizes a warmup `InboundMessage` (`text: "__WARMUP_PING__"`, `meta.source: "warmup"`) and delivers it to the just-registered bridge. Claude processes the warmup, paying the full cold-cache cost, and responds with `NO_REPLY` (existing sentinel; gateway already suppresses output). When the real user message arrives next, the prefix cache is warm.

**Pros**
- Single point of change (gateway `onClientRegistered`).
- Reuses existing `NO_REPLY` suppression (gateway.ts:5900).
- **Reuses cron's `meta.source` envelope** (`src/scheduler/dispatch.ts:174-199`). Tag the synthesized inbound with `meta.source: "warmup"` and the bridge / hindsight already know how to render and exclude non-user sources, the same contract cron rides today. No new envelope field, no new bridge protocol.
- Quota cost: ~1 OAuth turn per restart. Negligible (typical fleet sees < 10 restarts/day).
- Naturally debounceable.

**Cons**, confirmed by walking the codebase:
- **Progress card UX cost**: the warmup inbound triggers `handleInbound`'s 👀 reaction emission + stream-reply-handler's progress card. The 👀 reaction lands on a synthetic message and the card briefly appears in the agent's primary chat. NO_REPLY suppression unpins the card on turn end but the flash is visible.
- The cron-source path already handles parts of this (cron turns are rendered with `<channel source="cron">` framing). Reusing `meta.source="warmup"` collapses much of the UX-suppression work into "extend cron's handling for warmup" rather than new plumbing.
- Hindsight memory may capture the warmup turn; tag for memory-exclusion via the same source-discriminator path cron uses.

**Net**: 1-PR for the source-tagged version (much closer than originally estimated, thanks to the cron-envelope reuse). Estimated TTFO win: 4-8s on the FIRST user turn after restart, contingent on Anthropic prefix-cache TTL (~5 min) holding through the user's response window.

### Option B — Decouple claude from gateway restart

Today every gateway restart (`/restart`, `/update apply`, container recreate) restarts claude too. Decouple them: claude lives in its own long-running process, gateway sidecar restarts independently and reconnects via MCP. Claude's session and prefix-cache survive across gateway restarts.

**Pros**
- Highest payoff: most "restarts" become invisible to the user.
- Aligns with the resident-process model that desktop Claude Code already uses.

**Cons**
- Container architecture change. Today `start.sh` forks gateway + autoaccept + agent-scheduler as siblings then `exec`s into tmux/claude. Decoupling means either (a) two containers per agent (claude + gateway-sidecar), or (b) one container with a stricter PID 1 supervisor.
- MCP reconnect semantics. Claude Code's MCP client expects stable stdio; rebinding a stdio socket on the fly isn't a documented feature.
- Survival across `/update apply` is hard because the agent image itself changes; claude inside the old image would still need to be restarted to pick up new bundles. Decoupling buys us the gateway-only restart cases, not image-bump cases.

**Net**: 4-6 PR architectural change. Estimated TTFO win: near-100% elimination of gateway-only-restart cold-starts (probably 60-80% of operator-initiated restarts). Image bumps still pay full cost.

### Option C — Drop `--append-system-prompt`

Move all stable workspace content (AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md) out of `--append-system-prompt` and rely entirely on Claude Code's auto-loaded `CLAUDE.md` from cwd. The 14-18KB prefix shrinks to the dynamic handoff briefing only.

**Pros**
- Smaller cold-start prefix → less to process on cache miss.
- Claude Code's own caching of CLAUDE.md may be more aggressive than ours.
- Eliminates the `switchroom workspace render` shell call entirely (-0.9s).

**Cons**
- Behavior delta: today's `--append-system-prompt` content is *guaranteed* to land in the system prompt position; CLAUDE.md content's exact position in Claude Code's prompt assembly is not documented. May change first-turn behavior subtly.
- The handoff briefing (LLM-generated session summary from the Stop hook) still needs to land. Today it's appended after the workspace block in `--append-system-prompt`. If we drop that path, briefing needs a new injection point (UserPromptSubmit hook is the natural one).
- Behavior measurement requires holding all 9 agents constant and watching for regressions in agent quality. Not pure win.

**Net**: 2-PR change. TTFO win uncertain; depends on whether Claude Code caches CLAUDE.md better than we cache `--append-system-prompt`. Worth measuring first.

### Option D — Warm pool of pre-spawned claude processes

Maintain N hot-standby claude processes per agent slot. On restart, swap to a warm one. Restart cost becomes the swap cost, not the boot cost.

**Pros**
- Cold-start essentially zero for the user.

**Cons**
- RAM: each claude instance is ~500MB+ resident. Doubling instances doubles fleet RAM.
- Session slot consumption: Anthropic per-account session slots are finite. A pool that exceeds the OAuth quota fails immediately.
- Pool warming requires its own cold-start somewhere; we're moving cost, not eliminating it. The pool member's prefix-cache is cold until used.
- Complex lifecycle: when does a pool member retire? Recycle on schedule? On staleness?

**Net**: 5+ PR architectural change with ongoing infra cost. Likely not worth it for switchroom's scale.

## Recommendations

1. **Ship the measurement infrastructure**. Without per-line timestamps on `gateway-supervisor.log` (or equivalent OTel/PostHog spans), every optimization claim is unverifiable. Recommend either (a) in-gateway stderr monkey-patch that prepends `[YYYY-MM-DDTHH:MM:SS.mmm]` to every write, OR (b) an external host-side capture script that adds timestamps as it tails the per-agent log. Option (a) is more robust; (b) is faster to ship. **This can ship in parallel to an Option-A spike; it doesn't gate other work.**

2. **Pursue Option A (warmup turn) as the architectural fix**. By reusing cron's `meta.source` envelope (per the Pros above), this is closer to a 1-PR change than originally scoped. The OAuth quota cost is trivial. Lowest blast radius among the four options.

3. **Skip Option D (warm pool)**. RAM and session-slot costs don't justify the win.

4. **Treat Option B (decouple) as a future arc**, not a near-term ship. Worth its own RFC if Option A lands and the remaining cold-start gap still matters.

5. **Treat Option C (drop append-system-prompt) as a measurement-driven exploration**. Don't ship blind. Run a Claude Code prompt-assembly trace on one agent with `--append-system-prompt` and one without; measure first-turn TTFO; compare. Then decide.

## Modest layer-1 wins (independent of the architectural choice)

These can ship without an RFC if measurement supports them:

- **`hotReloadStable: true` as default**. Moves the ~12KB workspace content out of `--append-system-prompt` and into a per-turn UserPromptSubmit hook. Shrinks cold prefix. Schema's own description (`src/config/schema.ts:485`) warns of "5-10% per-turn latency/spend"; that's a steady-state cost, not a correctness risk. Ship measured-on-canary (test-harness for 24h with `runtime-metrics.jsonl` comparison). Blind fleet-wide is harsher than the risk warrants given the kill-switch is a 1-line config flip and 9 production agents would surface a regression within hours.
- **Parallelize `start.sh` handoff/briefing** with `&` and a final `wait`. Saves wall-clock if both calls fire (rare in production). ~0.5s expected win.
- **Pre-warm `workspace render --stable` output** at scaffold time. Cache the rendered bytes to a file; `start.sh` just `cat`s. -0.9s wall-clock.

## Open questions

1. Anthropic prefix-cache TTL. If it's < 60s, a warmup turn at restart-time may already be cold by the time the user messages. Need to measure or contact Anthropic for the documented value.
2. Whether `meta.source: "warmup"` should be a first-class envelope field or piggyback on existing `meta: Record<string, string>`. Affects scheduler / autoaccept / mcp-bridge protocol contracts.
3. Whether the warmup turn should be tagged for Hindsight exclusion (recommend yes) or written into the transcript as a system event (a la cron).
4. Multi-bridge-reconnect debounce window: gymbro churns ~6 reconnects per UAT cycle. Without debounce, every cycle would warm. With aggressive debounce (e.g., 5 min), a real restart's warmup gets correctly emitted. Recommend cooldown anchored on the most-recent OAuth API call timestamp, not on the warmup itself.
5. **Where does warmup dedup live?** Cron's fold-in (Phase 4, #890-#893) discovered that `meta.source`-tagged synthetic inbound interacts subtly with the per-agent scheduler's at-least-once boot replay (`SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN`). The dedup primitive there lives in `src/scheduler/dispatch.ts`'s scheduler-jsonl audit, not in the gateway. Should warmup dedup ride on the same audit log, or invent a separate cooldown store? Recommend riding the audit log: same observability, same disk format, one fewer concept to maintain.

## Success criteria (post-implementation, future PR)

- First-turn-after-restart TTFO falls from current 5-13s to **under 3s** for at least 80% of operator-initiated restarts.
- No regression on warm-cache trivial UAT (currently 1.77s): warmup must not slow steady-state.
- Quota burn under 1 extra turn per agent per day on the production fleet.
- Progress-card UX: no visible flash in user chats during warmup (this is the plumbing cost).

---

*Ground in `reference/vision.md` (always-on specialist exec-assistants), the wedge-cluster memos (`feedback_5min_restart_wedge_violates_vision.md`), and the v0.12.22 fix history (#1573).*
