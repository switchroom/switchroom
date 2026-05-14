# auth-broker drift recovery

The `switchroom-auth-broker` container is the **sole writer** of every
`~/.switchroom/accounts/<label>/credentials.json` (RFC H §4.4). It
records the sha256 of every file it writes in
`~/.switchroom/state/auth-broker/sha-index.json` and, on boot, verifies
that every file on disk matches its recorded sha.

A mismatch is a hard error. The broker logs
`DRIFT_DETECTED <label>` and exits with code 1. The compose
healthcheck on `switchroom-auth-broker` fails. Agents declared with
`depends_on: switchroom-auth-broker: { condition: service_healthy }`
sit in the `created` state until the broker recovers.

This doc is the recovery procedure.

## Symptoms

```
$ docker compose -p switchroom logs switchroom-auth-broker --tail 20
... DRIFT_DETECTED me@example.com on-disk sha=2c8a... index sha=ab12...
... auth-broker boot aborting on drift; recover with `switchroom auth add --replace`

$ docker compose -p switchroom ps
NAME                            STATUS
switchroom-auth-broker          Restarting (1) … unhealthy
switchroom-ziggy                Created
switchroom-lawgpt               Created
...
```

`/auth show` from a Telegram chat returns "broker unreachable."
`switchroom auth list` returns the same.

## Causes

The mismatch can come from any path that wrote credentials behind
the broker:

1. **`claude setup-token` run by the operator on the host.** The
   most common cause — the operator OAuths into an Anthropic
   account "manually" against the same path the broker owns. The
   new file is structurally valid but the broker didn't write it
   and its sha doesn't match the index.
2. **A backup-restore that lays down a credentials file older than
   the broker's last-recorded sha** (e.g. restoring
   `~/.switchroom/` from yesterday's tarball).
3. **A manual edit** (`vi ~/.switchroom/accounts/<label>/credentials.json`)
   — rarely intentional, sometimes accidental during incident triage.
4. **Ownership flip via `chown`** that rewrote no bytes but bumped
   the file's metadata in a way that confused a previous broker
   version (newer broker versions sha the *bytes* not stat info, so
   this is no longer a cause as of v0.8.0 — listed for completeness).
5. **The sha index itself got corrupted** —
   `~/.switchroom/state/auth-broker/sha-index.json` was
   accidentally deleted, truncated, or mismerged. The broker
   refuses to start with a missing index in the presence of
   on-disk credentials.

## Recovery

### Path A — the on-disk file is correct (you ran `claude setup-token` directly)

Tell the broker that the on-disk bytes are authoritative:

```bash
# From any host shell:
switchroom auth add me@example.com --replace --from-credentials \
  ~/.switchroom/accounts/me@example.com/credentials.json
```

`--replace` is required when the label already exists. The CLI
calls the broker's `add-account` verb with `replace: true`. The
broker:
1. Re-shas the file you pointed at.
2. Updates the sha index entry.
3. Restarts cleanly.

Wait for `switchroom-auth-broker` healthcheck to pass, then agents
boot.

### Path B — the on-disk file is wrong (the index was the source of truth)

If you know the on-disk file is the corrupted one (e.g. a
botched restore overlaid old creds), the procedure is:
1. Remove the bad on-disk file:
   ```bash
   trash ~/.switchroom/accounts/me@example.com/credentials.json
   ```
2. Re-add the account via OAuth:
   ```bash
   switchroom auth add me@example.com --from-oauth
   ```
3. The broker writes the fresh credentials and the new sha. Index
   and disk are consistent again.

Note this loses whatever quota state / refresh history was on the
old file (the broker re-establishes it on next refresh tick;
quota.json is preserved separately so exhausted-until marks
survive).

### Path C — the sha index is the problem

If `~/.switchroom/state/auth-broker/sha-index.json` is missing or
corrupted but the credentials files are themselves correct:

```bash
# Inspect what's there:
docker compose -p switchroom logs switchroom-auth-broker --tail 50

# If the index is the only issue, removing it forces the broker
# to re-build from scratch against the current on-disk files:
trash ~/.switchroom/state/auth-broker/sha-index.json

# Restart:
docker compose -p switchroom restart switchroom-auth-broker
```

The broker treats a missing index as "first boot" and seeds it
from the current files (no drift check on the very first boot
since there's nothing to compare against). On the next refresh
tick, the recorded shas update.

⚠ This path *erases* the broker's "I wrote these bytes" assertion,
so it should be the last resort. Path A is preferable when the
fresh on-disk bytes came from `claude setup-token` and you trust
them.

## After recovery

Once the broker is healthy:

```bash
switchroom auth list                  # sanity-check the fleet view
switchroom auth show ziggy            # spot-check one agent

# If agents are stuck in "created" state because they timed out
# waiting for the broker, recreate them:
switchroom apply
```

## Preventing future drift

- Use `switchroom auth add <label>` for OAuth flows, not
  `claude setup-token` directly. The former goes through the
  broker; the latter doesn't.
- For backups: restore `~/.switchroom/accounts/` and
  `~/.switchroom/state/auth-broker/sha-index.json` as a pair, or
  not at all. The two files are a unit.
- If you must edit a credentials file by hand (debugging,
  recovery), follow up with `auth add --replace` so the index
  matches.

## Why hard-error and not warn-and-continue?

Drift detection is a binary signal: either the broker is the sole
writer (and the assertion holds the line) or it isn't (and the
"single writer / many readers" guarantee falls apart). Warning
and continuing on drift would land us in the "polite mirror"
middle ground that has the *cost* of sole-writer semantics
(operator has to think about who wrote what) without the
*benefit* (no race against external writers). The hard error is
the deliberate trade.

The operator runbook above keeps the recovery cheap.
