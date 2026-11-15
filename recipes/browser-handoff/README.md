# Recipe: browser handoff

Opt-in. Gives one agent (`ops` in the starter overlay) its own Camofox browser,
and lets a person take over that same browser through a VNC viewer on the
host's loopback interface, for example to sign in or solve a challenge the
agent cannot.

Nothing changes for an agent, or a deployment, that does not layer
[`compose.browser-handoff.yaml`](compose.browser-handoff.yaml).

## What it adds

| Service | Image | Networks | Published |
| --- | --- | --- | --- |
| `ops-browser` | `ghcr.io/mekenthompson/hermes-fleet-camofox@sha256:641a2799…` (Camofox `v1.18.1`, Camoufox `152.0.4-beta.30`) | `ops-browser`, `ops-browser-viewer`, `ops-browser-egress` | nothing |
| `ops-browser-vnc` | `ghcr.io/mekenthompson/hermes-fleet-tcp-proxy@sha256:1b12d297…` | `ops-browser-viewer`, `ops-browser-vnc-ingress` | `127.0.0.1:${OPS_BROWSER_VNC_PORT:-6080}` only |

The `ops` agent joins `ops-browser` and gets `CAMOFOX_URL=http://ops-browser:9377`.

Isolation rules, enforced by `tests/test_recipes.py`:

- `ops-browser` and `ops-browser-viewer` are `internal`. Only `ops` joins
  `ops-browser`; the worker, and any agent that does not opt in, cannot
  resolve or reach the browser.
- Every Camofox route except `/health` needs the bearer key
  (`CAMOFOX_ACCESS_KEY`). The viewer needs `VNC_PASSWORD`. Without
  `secrets/ops-browser.env` Compose refuses to start the browser.
- The VNC forwarder is the only service on `ops-browser-vnc-ingress`, which
  is not internal only because Docker publishes ports from non-internal
  networks. The bind is `127.0.0.1`. To view from another machine, use an SSH
  tunnel (`ssh -L 6080:127.0.0.1:6080 <host>`); never widen the bind.
- `ops-browser-egress` lets the browser load the web. No agent joins it.
- No host networking, privileged mode or Docker socket. Both images are
  pinned by digest.

One browser is one cookie jar. To give a second agent a browser, copy the
three services and two internal networks under new names; never point two
agents at the same browser.

## Turn it on

From the overlay directory:

```bash
umask 077
key=$(openssl rand -hex 24)
printf 'CAMOFOX_API_KEY=%s\nCAMOFOX_ACCESS_KEY=%s\nVNC_PASSWORD=%s\n' \
  "$key" "$key" "$(openssl rand -hex 4)" > secrets/ops-browser.env
printf 'CAMOFOX_API_KEY=%s\n' "$key" >> secrets/ops.env

docker compose -f compose.yaml -f compose.sidecars.yaml \
  -f vendor/hermes-fleet/recipes/browser-handoff/compose.browser-handoff.yaml config -q
docker compose -f compose.yaml -f compose.sidecars.yaml \
  -f vendor/hermes-fleet/recipes/browser-handoff/compose.browser-handoff.yaml up -d
```

`VNC_PASSWORD` is at most 8 characters: that is the VNC protocol's limit.
Keep `secrets/` out of git (the overlay's `.gitignore` already does).

Hermes drives Camofox through its `camofox` plugin, which left Hermes core
and installs from the plugin catalog. With `CAMOFOX_URL` set, the gateway
installs it at start when `security.allow_lazy_installs` allows that;
otherwise run `hermes plugins install camofox` in the agent. The browser
tools then come from the `camofox` toolset.

## Hand the browser to a person

1. Open `http://127.0.0.1:6080/vnc.html` on the host (or through your SSH
   tunnel) and connect with `VNC_PASSWORD`. You see the agent's own browser.
2. Do what the agent asked: sign in, approve, solve. Tell the agent in chat
   when you are done.
3. Close the viewer. The browser keeps its cookies in the `ops-browser-profile`
   volume.

The upstream idle reapers count only REST calls, so a person at the viewer
would look idle. The recipe sets `TAB_INACTIVITY_MS`, `SESSION_TIMEOUT_MS` and
`BROWSER_IDLE_TIMEOUT_MS` to the largest value upstream accepts; `0` would not
mean "never".

This recipe does not lock the agent out while a person is at the viewer, and
does not publish the viewer on a public origin. Both need the browser broker
and REST lock proxy (`sidecars/browser-broker`, `sidecars/rest-lock-proxy`)
with an authenticated public origin, which stays a separate per-deployment
decision.

## Turn it off

Drop the `-f …compose.browser-handoff.yaml` file and run `up -d` again, then
`docker compose … rm -sf ops-browser ops-browser-vnc`. Remove
`CAMOFOX_API_KEY` from `secrets/ops.env`. The profile volume stays until you
remove it.

## Offline deployments

Camoufox downloads its default uBlock Origin add-on at launch. A browser with
no egress network cannot, and retries before giving up. Set
`CAMOFOX_DISABLE_DEFAULT_ADDONS: "1"` on `ops-browser` in that case.

## Proof

[docs/opt-in-recipes-acceptance.md](../../docs/opt-in-recipes-acceptance.md#browser-handoff)
records the synthetic run and what it did not prove.
