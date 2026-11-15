# Rolling agents onto a new image

`scripts/switchroom-rollout.py` moves the agents of one Docker Compose project onto one digest-pinned Fleet image, one agent at a time, with a chosen controller last. If an agent does not come back healthy, the runner puts that agent back on the image it was running and stops.

**Status: proven by unit tests with a fake Docker** (`tests/test_rollout_runner.py`) **and by one run on a disposable two-agent project of real containers**: a forward roll with the controller last, then a forced health failure that rolled the failed agent back and stopped ([starter-overlay-acceptance.md](starter-overlay-acceptance.md#rollout-runner)). It has not been used for a fleet upgrade.

Publishing an image does not authorise a rollout (see [image-release.md](image-release.md)). This runner is the deploy step, and it only ever reports what it did to the containers it touched.

## Run it

Run it on the Docker host, from outside any agent container. Pass the same project name and Compose files you use for `docker compose`.

```bash
# See the plan. Read-only: inspects containers, prints the order, writes nothing.
python3 scripts/switchroom-rollout.py \
  --project my-fleet --file compose.yaml \
  --image ghcr.io/mekenthompson/hermes-fleet-public@sha256:<64 hex> \
  --controller operator --dry-run

# Roll for real and keep a report.
python3 scripts/switchroom-rollout.py \
  --project my-fleet --file compose.yaml \
  --image ghcr.io/mekenthompson/hermes-fleet-public@sha256:<64 hex> \
  --controller operator --report rollout-report.json
```

| Option | Meaning |
| --- | --- |
| `--project` | Compose project name. Required. |
| `--file` / `-f` | Compose file, repeatable, in your usual order. Required for a real run. |
| `--image` | Target image. Must end in `@sha256:<64 lowercase hex>`; a tag alone is refused, including in dry-run. |
| `--service` | Agent service to roll, repeatable. Default: every service whose configured image is from the target image's repository, so sidecars on other images are left alone. |
| `--controller` | Service rolled last, for example the agent that asked for the rollout. Must be one of the selected services. |
| `--timeout` | Seconds to wait for each agent to become healthy. Default 300. |
| `--poll` | Seconds between health checks. Default 5. |
| `--no-pull` | Skip `docker pull`; the image must already be local. |
| `--report` | Where to write the JSON report. Default `./switchroom-rollout-<project>-<utc>.json`. |
| `--dry-run` | Print the plan and exit. |

Exit codes: `0` every selected agent is healthy on the target; `1` the rollout failed (the report says whether the failed agent was rolled back); `2` refused before any container was touched.

## What it does

1. Refuses a target that is not digest-pinned, an unknown service, a controller outside the selection, or an invalid project or service name.
2. Selects agents, skips any that are not running (a stopped agent is never started), and orders them alphabetically with the controller last.
3. Pulls the target (unless `--no-pull`) and refuses if any selected agent has no container healthcheck, either in Compose or in the image.
4. Records each agent's current image: a repository digest of the running image ID when one exists, otherwise the image ID itself. Both are immutable.
5. For each agent in turn: recreates only that service with `docker compose up --detach --no-deps --force-recreate --pull never -- <service>`, using a temporary override file that sets only that service's `image`. It then polls until the new container runs the target image ID and its healthcheck says `healthy`. `unhealthy`, `exited` or `dead` fail at once; anything else fails at the timeout. A Docker command that errors or times out while recreating or waiting counts as a failure of that agent. An agent already on the target image ID is left alone.
6. On the first failure it recreates that agent on its recorded previous image, waits for it to be healthy again, writes the report and exits `1`. Agents after it are listed as `not_started` and are never touched, so the controller is untouched whenever another agent fails.

One lock file per project, next to the report, stops two runners overlapping.

## The report

```json
{
  "schema": "switchroom-rollout/1",
  "status": "passed | failed | aborted",
  "image": "…@sha256:…",
  "image_id": "sha256:…",
  "controller": "operator",
  "order": ["worker", "operator"],
  "skipped": {"idle": "not running (exited)"},
  "previous_images": {"worker": {"image": "…@sha256:…", "image_id": "sha256:…"}},
  "agents": {"worker": {"ok": false, "reason": "…", "rollback": {"ok": true}}},
  "failed_agent": "worker",
  "rolled_back": true,
  "not_started": ["operator"]
}
```

A refusal (exit `2`) and a dry-run write no report.

`aborted` (exit `1`) means the runner itself hit an unexpected error rather than an agent failing. The report keeps everything recorded up to that point, including `previous_images` and, if an agent was mid-change, `in_flight` naming it. That agent may be on either image and was not rolled back; restore it from `previous_images`.

## What it guarantees

- Only a digest-pinned target is ever applied.
- One agent changes at a time, and only the agent named in that step (`--no-deps`).
- The controller goes last.
- A failed agent is put back on what it was actually running, not on whatever the Compose file says.
- The rollout stops at the first failure.
- It runs only `docker compose config`, `ps`, `up` for one named service, `docker container inspect`, `docker image inspect` and `docker image pull`, each as an argument list with no shell. It never runs `down`, `rm`, `--remove-orphans` or any volume, network or secret command, and never reads or writes secrets or agent state.

## What it does not do

- **It does not edit your Compose files.** After a passed rollout, update your own digest pin (for example `HERMES_FLEET_IMAGE` in `compose.example.yaml`), or a later plain `docker compose up` will move agents back to the old image.
- It does not judge whether an agent is *working*, only that its container healthcheck passes. The Fleet image does not declare a `HEALTHCHECK`, so you must add one in Compose; the runner refuses without it. Make it check something real, such as the gateway answering.
- It does not drain in-flight work before recreating an agent. Run it when agents are idle.
- It does not prove credentials, plugins, model access or chat delivery. Those are separate checks after the rollout.
- It does not roll back agents that already passed. Rollback is per-agent, for the one that failed. To undo a whole rollout, run it again with the previous digest as the target.
- If the rollback itself fails, including a Docker error during it, it reports `rolled_back: false`, stops and exits `1`; it does not retry or guess.
