# auth-broker-credential-plane — diagram spec

Status: new
Source of truth in code:
- `src/auth/broker/server.ts:1-14` — "sole writer of per-agent `<agentDir>/.claude/.credentials.json`", three peer classes (agent 0660→agent UID / consumer 0600 / operator 0600)
- `src/agents/compose.ts:978` — `switchroom-auth-broker:` singleton service (block ends ~1069): bind-presence healthcheck, `user "0:0"`, `cap_drop ALL` + `cap_add CHOWN/FOWNER/DAC_READ_SEARCH/DAC_OVERRIDE`, `--operator-uid` flag
- `src/auth/broker/server.ts` `socketPathToName` — path-as-identity (same as vault-broker `peercred.ts`)
- `src/auth/broker/google-provider.ts`, `anthropic-provider.ts` — refresh-loop owners
- `reference/rfcs/auth-broker.md` — design intent only (RFC = intent; the citations above are the shipped contract)

Headline: "One writer for every agent's OAuth credentials."
Footer:   "Replaces host-side fanout — the EACCES / last-write-wins bug class is gone by construction."

## Nodes

- `auth-broker` · root singleton, owns the OAuth refresh loop, holds fleet-wide `auth.active` · brass (focal)
- Three UDS listeners off the broker (small attached nodes):
  - agent socket · `/run/switchroom/auth-broker/<name>/sock` · mode 0660, chowned to `allocateAgentUid(name)`
  - operator socket · `/run/switchroom/auth-broker/operator/sock` · mode 0600, chowned to `--operator-uid` (host `switchroom auth …`)
  - consumer socket · mode 0600, chowned to `consumers[].uid` (default 0)
- `agent-<name> ✕ N` · each reads its own `<agentDir>/.claude/.credentials.json` at boot · dark card
- Contrast pair (small inset, the "before"):
  - OLD · host user fans out N copies → last-write-wins + EACCES (per-agent dirs owned by per-agent UIDs) · cord
  - NEW · broker writes one file per agent, keyed by that agent's active selection · teal

## Edges

- refresh loop → `auth-broker` state · "Anthropic + Google token refresh" · primary-flow
- `auth-broker` → each `agent-<name>` `.credentials.json` · "sole writer, chowned to agent UID" · primary-flow
- operator `switchroom auth use <label>` → operator socket → `auth-broker` · "flips fleet auth.active in one verb" · primary-flow
- `agent` → reads own `.credentials.json` at boot · leader

## Style notes

Inherits v3. Mirror the visual language of `runtime-topology`'s broker
cards so the two read as a set (`auth-broker` is the brass-highlighted
newest singleton in both). The OLD/NEW contrast inset uses cord→teal to
make "structurally impossible now" legible without prose.
