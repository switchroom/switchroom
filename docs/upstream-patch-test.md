# Daily upstream patch test

If your overlay carries its own fixes to Hermes Agent, you want to know the
day upstream moves under them, not the day you try to upgrade.
`scripts/switchroom-upstream-patch-test.py` re-applies your patches, in order,
on the latest Hermes Agent upstream and runs the tests you name.
`.github/workflows/upstream-patch-test.yml` runs it every day.

**It cannot deploy.** It never commits, pushes, tags, pins an image, edits a
Compose file or starts a rollout. The workflow's token can only read the
repository, it passes no secret, and its only network access is fetching the
upstream commit. Moving agents onto a new upstream stays a separate, reviewed
step (see [rollout.md](rollout.md)).

**Status:** proven by unit tests on a synthetic local upstream
(`tests/test_upstream_patch_test.py`) and by runs against the real Hermes Agent
`main` with the synthetic patch set in `tests/fixtures/upstream-patches/`.

## The patch series

Patches live in your overlay repository next to a series file, for example
[`examples/overlay-repo/patches/series.json`](../examples/overlay-repo/patches/series.json):

```json
{
  "schema": "switchroom-upstream-patches/1",
  "upstream": {"repository": "https://github.com/NousResearch/hermes-agent.git", "ref": "main"},
  "patches": [
    {"id": "fix-gateway-retry", "file": "0001-fix-gateway-retry.patch",
     "outcome": "Gateway retries a dropped chat connection."}
  ],
  "tests": {
    "command": ["python3", "-m", "pytest", "-q", "tests/gateway/test_retry.py"],
    "when": "patched",
    "timeout_seconds": 1800
  }
}
```

| Key | Meaning |
| --- | --- |
| `upstream.repository` | `https://` git URL of the upstream. |
| `upstream.ref` | Branch to test against. The workflow can override it. |
| `patches` | In order. `file` is a `git format-patch` or `git diff` file inside the series directory. An empty list is fine. |
| `tests.command` | Argument list run in the patched tree, no shell. Empty means no tests. |
| `tests.when` | `patched` (default): run only when at least one patch was applied. `always`: also run on a clean upstream. |
| `tests.timeout_seconds` | Fails the run as `timeout` after this. |

Make a patch with `git format-patch -1 <commit> --stdout > patches/0001-name.patch`
from your Hermes Agent fork, then list it.

The test command runs upstream code plus your patches. It gets the runner's
environment **without** anything that looks like a credential
(`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*_KEY`, `*API_KEY*`, `GH_*`, `ACTIONS_*`
and similar), so even a careless test cannot read one. Install what the tests
need inside the command, for example
`["sh", "-c", "pip install -e . pytest && pytest -q tests/..."]` if you accept a shell there.

## What a run does

1. Resolves `refs/heads/<ref>` to one commit (or takes `--upstream-commit`).
2. Fetches only that commit (`--fetch-depth 1`; `0` fetches history, which
   helps three-way merges) into a throwaway directory.
3. For each patch in order:
   - applies cleanly: **applied**;
   - upstream already contains the change: **already upstream**, a candidate to retire;
   - otherwise tries a three-way merge: **applied** or **failed**. A failure
     stops the run; later patches are **not attempted**.
4. Runs `tests.command` in the patched tree when there is something to test.
5. Prints a JSON report (also `--report FILE`) and a Markdown summary
   (`--summary FILE`, or the GitHub job summary).

| Exit | Meaning |
| --- | --- |
| 0 | Every patch applied or is already upstream, and tests passed or were not needed |
| 1 | A patch failed, the tests failed or timed out, or upstream could not be fetched |
| 2 | Series or usage error |

### Zero patches

A fork with no patches gets `status: pass` and "nothing to re-apply". That is
the starter overlay's case. Set `tests.when` to `always` to keep testing the
clean upstream anyway.

## Run it locally

```bash
python3 scripts/switchroom-upstream-patch-test.py \
  --series ~/my-fleet-overlay/patches/series.json --report upstream-patch-test.json
```

Needs `git` and `python3`. It writes only to a temporary directory and the
report.

## Turn it on for your overlay

The starter overlay ships the workflow as an opt-in template,
[`examples/overlay-repo/ops-kit/upstream-patch-test.yml`](../examples/overlay-repo/ops-kit/upstream-patch-test.yml),
not as an active workflow. To opt in:

1. Copy it to `.github/workflows/upstream-patch-test.yml` in your overlay.
2. Set the repository variable `SWITCHROOM_FLEET_REVISION` to the full commit
   of `mekenthompson/hermes-fleet` whose script you want to run (the revision
   of the image you run is a good choice). The workflow refuses anything that
   is not a 40-character commit.
3. Run it once with **Run workflow** and read the job summary.

It runs daily at 19:41 UTC. A failure shows as a failed run; GitHub's own
notifications or a branch-status integration tell you.

This repository runs the same workflow every day on the starter series (zero
patches) and on the synthetic patch set, so the script itself is exercised on
the real upstream.

## What it does not do

- It does not rebase your fork, open pull requests or merge anything.
- It does not build or scan an image. A green run is evidence the patches
  still apply and pass their tests; it is not a release.
- It does not choose what to test. Name the tests that cover your patches.
