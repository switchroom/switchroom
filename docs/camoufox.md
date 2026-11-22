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
the browser it is stamped with. The same change lives on the `official-camoufox` branch of the fork
[mekenthompson/camofox-browser](https://github.com/mekenthompson/camofox-browser) and is offered
upstream as [jo-inc/camofox-browser#15715](https://github.com/jo-inc/camofox-browser/pull/15715).
The image installs the published npm release plus this patch, not the fork. Once a camofox-browser
release includes the change, the patch and the Dockerfile steps that apply it go away.

Debian packages (the desktop, Chromium, fonts, runtime libraries) are not version-pinned: they come
from the digest-pinned parent's Debian release and are covered by the image scans, like the rest of
the apt layer. Everything fetched from outside Debian is pinned by digest.

## The service

- Binds `127.0.0.1` only and requires the per-container access key in
  `<HERMES_HOME>/camofox-browser/access-key` (0600, created on first start by whichever side starts
  first). The `camoufox-desktop` plugin hands the same key to the `camofox` plugin.
- Opens Camoufox headed (`CAMOFOX_INTERACTIVE=desktop`) on the Bot Desktop's display, read from
  `<HERMES_HOME>/bot-desktop/env`. The server runs only while that display's X server is up: while
  the screen is stopped (idle-stop, or not yet started after a container start) the service waits,
  and it stops the server when the screen stops or comes back on another display. A camofox tool
  call starts the screen and waits for the server. A REST client outside Hermes (a CLI, a cron
  script) must start the screen first, or it gets connection refused.
- No telemetry: crash reports, Sentry and Prometheus are off; the default addon is not downloaded.
- Logins persist in `<HERMES_HOME>/camofox-browser/profiles`, on the profile volume, so they survive
  restarts and container recreates. camofox-browser writes them at a checkpoint: a graceful stop
  (SIGTERM), a session close, the hand-back checkpoint, and the plugin's periodic checkpoint
  below. A `kill -9`, an out-of-memory kill or a Bot Desktop stop (the browser dies with its
  display) loses changes since the last checkpoint.
- Graceful stop needs time on both sides. Inside the container s6 waits up to 50 s
  (`S6_SERVICES_GRACETIME`) and the server gives itself 40 s. Outside it, Docker's default stop
  timeout is 10 s before SIGKILL, so give the agent service `stop_grace_period: 60s` or more (the
  example compose files do). With the default 10 s, logins since the last checkpoint can be lost.
- If the state directory cannot be written (a read-only or not-yet-owned volume), the service waits
  30 s before s6 retries it, instead of restarting every second. An empty or short access key is
  replaced on the next start; the plugin picks the new key up on the next tool call.
- A session never expires on idleness and a quiet window stays open for 8 hours, because a human
  may be using it. The browser itself starts on the first request (about 4 s) and, because sessions
  do not expire, runs until the Bot Desktop stops (`bot_desktop.idle_stop_minutes`). Measured: about
  0.6 GB for the browser with a few light pages, plus about 0.2 GB per heavy news page, on top of
  about 0.15 GB for Node and 0.16 GB for the desktop.

## The plugins

`plugins/camofox` is the official plugin, vendored unmodified (`UPSTREAM.json`). `plugins/camoufox-desktop`
adds the Bot Desktop behaviour without patching it:

- While a human holds Take over, the camofox tools and `browser_vault` writes are refused, so the
  agent waits instead of typing over the human.
- A camofox call starts the screen when it is down (with `bot_desktop.auto_start`) and counts as
  desktop activity, so idle-stop does not close a window the agent is using. The hook waits at most
  15 s for the screen (Hermes fails a tool call closed when a hook overruns its 30 s limit); a slower
  start carries on in the background and the tool waits for the browser itself.
- The fence is checked when each call starts. A human who takes over during a call that has already
  started sees that one call finish; the next one is refused.
- The first turn after the human hands back is told so, and the cookies are checkpointed then.
- While the screen is in use (its `activity` stamp is under two intervals old), the agent's session
  is checkpointed every 5 minutes (`CAMOFOX_CHECKPOINT_SECONDS`, `0` turns it off), so idle-stop,
  which comes long after the last use, does not lose a login. One process per profile does this.
- If the lease cannot be read, the camofox tools are refused (`screen_control_unknown`) rather than
  risk typing over a human; Chromium `browser_exec` still works.
- Password fields stay out of the model's context. The Camofox snapshot prints every input's value,
  and the camofox plugin only scrubs vault values and token-like text, so a password a human typed
  during Take over would otherwise show up in the next snapshot. After `browser_navigate`,
  `browser_snapshot`, `browser_console`, `browser_vision` and `browser_get_images`, the plugin asks
  each of the agent's tabs for the values of its password fields (`type=password`, or `autocomplete`
  `current-password` / `new-password`, including open shadow roots and same-origin frames) and
  removes them from the output and from the stored full-snapshot file. It fails closed: if the scan
  cannot run, every textbox value in the snapshot is masked and a `browser_console` result is
  withheld; if the page has a frame of another origin, textbox values inside the snapshot's iframe
  sections are masked. This runs as `tool_execution` middleware (no hook timeout to fail open on).
  `scripts/camoufox-password-smoke.py` proves it on a live agent: a throwaway identity, a password
  typed with XTest key events on the Bot Desktop, then the three read tools through the real
  middleware chain (`--plugin-b64` tests a candidate before it is delivered).
- A short system-prompt section steers the model: Camoufox first, Chromium for CDP-only jobs, and a
  CAPTCHA or challenge always goes to the human.
- The dock gets a Camoufox icon. It opens or raises the agent's own session (the same Camofox
  `userId` the agent uses), never a second browser.

Both plugins are mounted by the overlay; the bare image enables neither.

## Known limits

Measured on a live agent after the first rollout:

- A tab or window a human opens with Ctrl+T or Ctrl+N is outside the agent's cookie jar: it is a
  separate, empty browser context that is not checkpointed, and the agent cannot see it. Logins
  made there are lost. Use the dock icon, or links and popups from the agent's own pages (those are
  tracked and share the agent's logins).
- JavaScript dialogs (`alert`, `confirm`, `prompt`) are dismissed at once and never shown, even
  when a human clicks: `confirm()` returns false. A site that needs a confirmation cannot be
  completed in Camoufox; use Chromium `browser_exec` (`browser_dialog`).
- The fingerprint (screen size, canvas, WebGL renderer) is regenerated on every browser launch,
  so a site sees a different device after each Bot Desktop restart; cookies persist. The window is
  also a few pixels wider than the reported screen under the Xfce frame.
- `navigator.language` stayed `en-US` while `Intl` followed the container locale (`en_AU.UTF-8`)
  and time zone, an incoherence some bot checks look at. Since then `service-run` gives the browser
  the container's own pair, so the two should agree; that is not yet re-measured on a live agent.
  The locale comes from `LC_ALL`, else `LANG`, without its charset or modifier (`en_AU.UTF-8`
  becomes `en-AU`; `C` and `POSIX` count as unset). The time zone comes from `TZ` (a leading `:`
  is dropped), else `/etc/timezone`, and must name a file under `/usr/share/zoneinfo` (the image's
  tzdata): a POSIX value such as `AEST-10` would stop camofox-browser starting, so it is dropped
  with one line in the service log. The pair is passed only when both resolve; otherwise neither
  is, and the browser keeps its own default. Set `CAMOFOX_LOCALE` and `CAMOFOX_TIMEZONE` to choose
  the pair explicitly; set both, because camofox-browser refuses to start with only one. Keep the
  time zone consistent with where the agent's traffic exits.
- Typing through `browser_type` fills fields at once; only cursor movement is humanised (a click
  moves the pointer along a curved path for about half a second).
- An interactive Cloudflare Turnstile widget waits at "Verify you are human"; that is the human's
  step. A plain Cloudflare challenge page passed on its own in testing.
- File chooser and downloads: a human can use the file picker in the window; the agent's tools
  have no upload or download tool (the server has the routes).
