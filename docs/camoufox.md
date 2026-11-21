# Camoufox on the Bot Desktop

Every agent container can run [Camoufox](https://github.com/daijro/camoufox), a Firefox build with
fingerprint protection, headed on its own Bot Desktop. Agents drive it with the official Nous
`camofox` plugin (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, ...).
Chromium `browser_exec` stays installed as the backup and for CDP-only work (`cdp()`, PDF printing,
`browser_dialog`, Google sign-in mode). The two browsers do not share logins.

## What the image ships

| Piece | Where | Pin |
| --- | --- | --- |
| Bot Desktop (Xvnc, Xfce panel and window manager), Chromium, fonts, `en_AU.UTF-8` | apt layer in `Dockerfile` | Debian archive |
| Camoufox 158.0.1-beta.41 | `/opt/camoufox` | `release/camoufox.lock.json`: asset id, size, sha256; Sigstore build attestation verified at bake time |
| camofox-browser 1.19.0 | `/opt/camofox-browser` | npm tarball integrity in the lock, `release/camofox-browser/package-lock.json`, one downstream patch |
| Service `camofox-browser` | s6 longrun, `docker/camofox-browser/service-run` | loopback `127.0.0.1:9377` |

The downstream patch (`release/camofox-browser/official-camoufox.patch`) moves camofox-browser from
`camoufox-js` (which stops at beta.31) to the maintainers' official `camoufox@0.5.9` npm package and
the browser it is stamped with. It is the same change offered upstream; drop it when camofox-browser
ships it. There is no repository fork.

## The service

- Binds `127.0.0.1` only and requires the per-container access key in
  `<HERMES_HOME>/camofox-browser/access-key` (0600, created on first start by whichever side starts
  first). The `camoufox-desktop` plugin hands the same key to the `camofox` plugin.
- Opens Camoufox headed (`CAMOFOX_INTERACTIVE=desktop`) on the Bot Desktop's display, read from
  `<HERMES_HOME>/bot-desktop/env`, and restarts itself if the screen comes back on another display.
- No telemetry: crash reports, Sentry and Prometheus are off; the default addon is not downloaded.
- Logins persist in `<HERMES_HOME>/camofox-browser/profiles`, on the profile volume, so they survive
  restarts and container recreates. camofox-browser writes them at a checkpoint: a graceful stop
  (SIGTERM; s6 waits up to 50 s), a session close, or the hand-back checkpoint below. A `kill -9`
  or an out-of-memory kill loses changes since the last checkpoint.
- A session never expires on idleness and a quiet window stays open for 8 hours, because a human
  may be using it. The browser itself starts on the first request and stops when no session is
  left, so an idle service costs about 40 MB.

## The plugins

`plugins/camofox` is the official plugin, vendored unmodified (`UPSTREAM.json`). `plugins/camoufox-desktop`
adds the Bot Desktop behaviour without patching it:

- While a human holds Take over, the camofox tools and `browser_vault` writes are refused, so the
  agent waits instead of typing over the human.
- A camofox call starts the screen when it is down (with `bot_desktop.auto_start`) and counts as
  desktop activity, so idle-stop does not close a window the agent is using.
- The first turn after the human hands back is told so, and the cookies are checkpointed then.
- A short system-prompt section steers the model: Camoufox first, Chromium for CDP-only jobs, and a
  CAPTCHA or challenge always goes to the human.
- The dock gets a Camoufox icon. It opens or raises the agent's own session (the same Camofox
  `userId` the agent uses), never a second browser.

Both plugins are mounted by the overlay; the bare image enables neither.

## Known limits

- A tab a human opens with Ctrl+T is not tracked by camofox-browser and is closed within a minute.
  Use links from the agent's page or the dock icon.
- The fingerprint is regenerated on every browser launch; cookies persist, the device fingerprint
  does not.
- Typing through `browser_type` fills fields at once; only cursor movement is humanised.
