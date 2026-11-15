# Package-manager adapters

Adapters sit behind the scope table in `SKILL.md`. Do not add a manager until a real lock needs
it.

## Python (`uv`)

- One-off: `uvx --from 'example-package==1.2.3' example-command`
- Project: `uv sync --frozen` in the repository that owns the lockfile
- Profile: a Python virtualenv entry in the profile lock, applied by the deployment's reconciler
- Prefer wheels. A source build that needs compilers is an image change.
- Not allowed: bare `pip install`, `pip install --user`, `uv tool install`.

## Node

- One-off: `npx --yes 'example-cli@1.2.3'`
- Project: `npm ci` or `pnpm install --frozen-lockfile`
- Profile: a committed `package.json` and lockfile referenced from the profile lock, installed
  with `npm ci --ignore-scripts`. Lifecycle scripts are not an escape hatch.
- Not allowed: `npm install -g`.

## Checksummed binary

- Exact HTTPS URL, version, architecture and SHA-256.
- Install into a profile-owned bin directory, never into image-owned paths.
- Never `latest`, never `curl | sh`.

## Escalate to an image change

The dependency needs system libraries, a compiler, a browser, a shared runtime, or one version
identity across every agent. Do not `apt install` inside an agent.

## Escalate to a sidecar

The dependency is a daemon, database, queue, GPU runtime or anything that owns a port.

## Unknown manager

Stop. Record the manager, its official lock mechanism, target directory, verify command and
uninstall path, and request an adapter. Do not improvise.
