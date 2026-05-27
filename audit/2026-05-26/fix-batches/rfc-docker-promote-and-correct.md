# Fix batch: promote rfc-docker-multi-container from Draft to Shipped and fix stale body claims

**Scope:** `reference/rfc-docker-multi-container.md` only.
**Verdict pattern:** rfc-status-wrong (1), drift-major (6).
**Estimated edits:** medium (~30 lines across frontmatter + body sections).

## Findings in this batch

### Finding 1 -- rfc-docker-multi-container:c1

- **File:** `reference/rfc-docker-multi-container.md` L3
- **Quote:** `status: Draft`
- **Verdict:** rfc-status-wrong
- **Proposed action:** update-frontmatter
- **Proposed text:** Change `status: Draft` to `status: Shipped` (or `status: Historical` if preserving as a pure design record). The body already says "This RFC is shipped" at L11-L24.
- **Evidence:** `src/agents/compose.ts` L1-L24 -- fully implemented compose generator; `docker/Dockerfile.agent` exists. RFC body at L11-L24 explicitly says "This RFC is shipped. v0.7.0 is the docker-only release."
- **Rationale:** Frontmatter contradicts the body. Any tooling or reader consulting the frontmatter status gets the wrong answer.

### Finding 2 -- rfc-docker-multi-container:c2

- **File:** `reference/rfc-docker-multi-container.md` L19-L21
- **Quote:** "Four published GHCR images (`switchroom-base`, `switchroom-agent`, `switchroom-broker`, `switchroom-kernel`)"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace with "Seven published GHCR images (`switchroom-base`, `switchroom-agent`, `switchroom-broker`, `switchroom-kernel`, `switchroom-auth-broker`, `switchroom-hostd`, `switchroom-hindsight`)".
- **Evidence:** `src/agents/compose.ts` L354-L356 -- `emitImageOrBuild` called for broker, kernel, auth-broker, agent; `docker/Dockerfile.hostd`, `docker/Dockerfile.auth-broker`, `docker/Dockerfile.hindsight` all exist.
- **Rationale:** Image count grew from 4 to 7 as auth-broker, hostd, and hindsight were added post-RFC.

### Finding 3 -- rfc-docker-multi-container:c3

- **File:** `reference/rfc-docker-multi-container.md` L172-L173
- **Quote:** "Per-agent UIDs are allocated deterministically from the agent name at compose-generation time (e.g. `1100 + stable_hash(agent_name) % 800`, collision-checked across the fleet)."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace with: "Per-agent UIDs are allocated deterministically in the range 10001..10999 (`AGENT_UID_MIN`/`AGENT_UID_MAX` in `src/agents/compose.ts`), collision-checked across the fleet."
- **Evidence:** `src/agents/compose.ts` L36-L37 -- `AGENT_UID_MIN = 10001; AGENT_UID_MAX = 10999`.
- **Rationale:** The range and base value in the RFC body are completely different from what shipped.

### Finding 4 -- rfc-docker-multi-container:c4 and c10

- **File:** `reference/rfc-docker-multi-container.md` L162-L170 (socket directory layout + UID examples)
- **Quote:** `user: "1100:1100"`, `user: "1101:1101"`, `user: "1102:1102"`
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace uid:gid examples 1100/1101/1102 with the actual 10001-10999 range, e.g. "uid:gid 10001:10001 (deterministic hash of agent name)".
- **Evidence:** `src/agents/compose.ts` L36-L37; `src/vault/broker/peercred.ts` L143 -- `socketPathToAgent` confirms the path-as-identity design shipped correctly.
- **Rationale:** UID examples throughout the socket directory layout section are from the original design, not what shipped.

### Finding 5 -- rfc-docker-multi-container:c5

- **File:** `reference/rfc-docker-multi-container.md` L263-L266
- **Quote:** `image: ghcr.io/switchroom/agent:0.7.0` and compose skeleton showing `version: "3.9"`
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Remove `version: "3.9"` from the compose skeleton -- Docker Compose v2+ does not use or emit this field. The actual compose generator starts directly with `name: switchroom` then `services:`. Update the image tag example from `0.7.0` to `:latest` or a variable placeholder.
- **Evidence:** `src/agents/compose.ts` L767-L782 -- emits `name: switchroom` then `services:` with no `version:` field.
- **Rationale:** The `version:` field is obsolete in Compose v2. Using it misleads operators who copy this skeleton.

### Finding 6 -- rfc-docker-multi-container:c6

- **File:** `reference/rfc-docker-multi-container.md` L330
- **Quote:** "`switchroom reconcile` regenerates this whole file from `switchroom.yaml`"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Replace "`switchroom reconcile` regenerates this whole file" with "`switchroom apply` regenerates this whole file".
- **Evidence:** `src/cli/apply.ts` L2 -- "`switchroom apply` -- reconcile fleet to switchroom.yaml." The compose generator header comment mentions `switchroom reconcile` as a future alias, but the actual CLI verb is `switchroom apply`.
- **Rationale:** Minor verb drift. The canonical operator command is `switchroom apply`.

### Finding 7 -- rfc-docker-multi-container:c7

- **File:** `reference/rfc-docker-multi-container.md` L141-L149
- **Quote:** "tini (PID 1) / tmux (daemonised) / start.sh / claude --continue / MCP child: telegram gateway (telegram-plugin/server.ts)"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Update the process tree to: `tini (PID 1) -> start.sh -> (forks gateway sidecar + autoaccept-poll + agent-scheduler) -> exec tmux -> bash -> claude --continue`. The gateway is a supervised sidecar sibling launched before tmux, not an MCP child of claude.
- **Evidence:** `profiles/_base/start.sh.hbs` L104-L108 -- `_switchroom_supervise gateway ... bun "$_gateway_bundle" &` confirms the gateway as a sidecar. CLAUDE.md confirms: "tini -> start.sh -> (forks gateway + autoaccept-poll + agent-scheduler, then re-execs into tmux)."
- **Rationale:** This is a meaningful architectural difference. The RFC shows the gateway as an MCP child (inside claude's process tree); the implementation has it as an independent supervised process launched before tmux.

## Out of scope for this batch

- Edits to CLAUDE.md for the architecture description -- already accurate in CLAUDE.md, no change needed.
