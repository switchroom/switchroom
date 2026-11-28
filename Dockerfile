ARG AGENT_IMAGE
ARG ONEPASSWORD_CLI_IMAGE=docker.io/1password/op@sha256:b0d7eebcb09bdc9d5862af91533e1851c968d4f969270c906f5da8c574f87e93
FROM ${ONEPASSWORD_CLI_IMAGE} AS onepassword_cli
FROM ${AGENT_IMAGE}

USER root

ARG GH_VERSION=2.106.0
ARG GH_LINUX_AMD64_SHA256=a476449fa9625413c54a3734eded62e9e480e49f421ff08e7f3b3879c059a033
ARG GH_LINUX_AMD64_ASSET_ID=793444853
ARG CLAUDE_ACP_PLUGIN_SOURCE=https://github.com/mvdbastos/hermes-acp-agents
ARG CLAUDE_ACP_PLUGIN_REVISION=0526610a3945cc376ac517b63ca358a5b838a2fc
ENV DISABLE_AUTOUPDATER=1

COPY --from=onepassword_cli --chmod=0755 /usr/local/bin/op /usr/local/bin/op
RUN test "$(/usr/local/bin/op --version)" = "2.42.0"
# Same pinned archive by two official GitHub routes: the REST asset API and the
# release download URL, which returned HTTP 503/504 for long stretches on
# 2026-11-08. CI passes its workflow token as the optional BuildKit secret
# github_token (mounted for this step only, never written to a layer) so the API
# route is not subject to the shared unauthenticated rate limit; local builds
# without it still work. A route counts only when its bytes match the pinned
# sha256, and the final check below is unconditional.
RUN --mount=type=secret,id=github_token,required=false set -eu; \
    archive="gh_${GH_VERSION}_linux_amd64.tar.gz"; \
    curl_auth=""; \
    if [ -s /run/secrets/github_token ]; then \
        curl_auth="/tmp/gh-api-auth.curl"; \
        (umask 077; printf 'header = "Authorization: Bearer %s"\n' "$(cat /run/secrets/github_token)" > "$curl_auth"); \
    fi; \
    set -x; \
    api_ok=0; \
    rm -f "/tmp/${archive}"; \
    if curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
           ${curl_auth:+--config "$curl_auth"} \
           -H 'Accept: application/octet-stream' -H 'X-GitHub-Api-Version: 2022-11-28' \
           "https://api.github.com/repos/cli/cli/releases/assets/${GH_LINUX_AMD64_ASSET_ID}" -o "/tmp/${archive}" \
       && printf '%s  %s\n' "${GH_LINUX_AMD64_SHA256}" "/tmp/${archive}" | sha256sum -c -; then \
        api_ok=1; \
    fi; \
    rm -f /tmp/gh-api-auth.curl; \
    if [ "$api_ok" != 1 ]; then \
        rm -f "/tmp/${archive}"; \
        curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 \
            "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}" -o "/tmp/${archive}"; \
    fi; \
    printf '%s  %s\n' "${GH_LINUX_AMD64_SHA256}" "/tmp/${archive}" | sha256sum -c -; \
    tar -xzf "/tmp/${archive}" -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
    rm -rf "/tmp/${archive}" "/tmp/gh_${GH_VERSION}_linux_amd64"; \
    test "$(gh --version | awk 'NR==1{print $3}')" = "${GH_VERSION}"
# Honcho tooling is owned by Fleet, independent of optional Agent extras.
# These hashed release locks use their reviewed cutoff instead of Agent
# source's older exclude-newer date; no other Agent packages are resolved.
COPY release/honcho-sdk-requirements.txt release/honcho-requirements.txt /tmp/honcho-locks/
RUN cd /opt/hermes \
    && UV="$(python3 -c 'import json; facts=json.load(open("/opt/hermes/tools/facts.json")); print("/opt/hermes/tools/"+facts["packages"]["uv"]["entry"]+"/uv")')" \
    && test -x "$UV" \
    && "$UV" pip install --exclude-newer 2026-11-13T00:00:00Z --python /opt/hermes/.venv/bin/python --no-deps --require-hashes -r /tmp/honcho-locks/honcho-sdk-requirements.txt \
    && "$UV" venv --python /opt/hermes/.venv/bin/python /opt/honcho-cli \
    && "$UV" pip install --exclude-newer 2026-11-13T00:00:00Z --python /opt/honcho-cli/bin/python --require-hashes -r /tmp/honcho-locks/honcho-requirements.txt \
    && ln -s /opt/honcho-cli/bin/honcho /usr/local/bin/honcho \
    && rm -rf /tmp/honcho-locks
COPY --chmod=0755 scripts/verify-honcho-runtime.py /opt/hermes-fleet/bin/verify-honcho-runtime.py
RUN /opt/hermes/.venv/bin/python /opt/hermes-fleet/bin/verify-honcho-runtime.py
RUN set -eux; \
    sha=5c7d24b32d275bce38daedbe81feaebc31393587; \
    archive=/tmp/honcho-plugin.tar.gz; \
    curl -fsSL --retry 3 "https://github.com/plastic-labs/honcho/archive/${sha}.tar.gz" -o "$archive"; \
    printf '%s  %s\n' "62193f2f98d8ae53b4fd7aab4162d312a918f27cdb214b1d7146884812c7b2d0" "$archive" | sha256sum -c -; \
    mkdir -p /tmp/honcho-plugin /opt/hermes/plugins/memory/honcho; \
    tar -xzf "$archive" -C /tmp/honcho-plugin; \
    cp -a "/tmp/honcho-plugin/honcho-${sha}/hermes-plugin-honcho/." /opt/hermes/plugins/memory/honcho/; \
    rm -rf "$archive" /tmp/honcho-plugin /opt/hermes/plugins/memory/honcho/tests; \
    test -f /opt/hermes/plugins/memory/honcho/__init__.py; \
    /opt/hermes/.venv/bin/python -c "from pathlib import Path; text=Path('/opt/hermes/plugins/memory/honcho/__init__.py').read_text(); assert 'MemoryProvider' in text or 'register_memory_provider' in text"
# HF-657: machine-generated gateway turns must never sync as the human's messages.
COPY scripts/patch-honcho-gateway-turn-filter.py /tmp/patch-honcho-gateway-turn-filter.py
RUN /opt/hermes/.venv/bin/python /tmp/patch-honcho-gateway-turn-filter.py /opt/hermes/plugins/memory/honcho/__init__.py \
    && /opt/hermes/.venv/bin/python -c "import py_compile; py_compile.compile('/opt/hermes/plugins/memory/honcho/__init__.py', doraise=True)" \
    && rm -f /tmp/patch-honcho-gateway-turn-filter.py
# The pinned plugin still imports two names from their pre-persistence homes; repoint them.
COPY scripts/patch-honcho-core-imports.py /tmp/patch-honcho-core-imports.py
RUN /opt/hermes/.venv/bin/python /tmp/patch-honcho-core-imports.py /opt/hermes/plugins/memory/honcho \
    && /opt/hermes/.venv/bin/python -m py_compile /opt/hermes/plugins/memory/honcho/__init__.py /opt/hermes/plugins/memory/honcho/client.py \
    && rm -f /tmp/patch-honcho-core-imports.py
# HF-757: profile environments resolve the SDK this image ships, and Kanban briefs are saved but never derived.
COPY release/honcho-sdk-requirements.txt /tmp/honcho-sdk-requirements.txt
COPY scripts/patch-honcho-sdk-floor.py scripts/patch-honcho-kanban-observation.py /tmp/
RUN /opt/hermes/.venv/bin/python /tmp/patch-honcho-sdk-floor.py /opt/hermes/plugins/memory/honcho /tmp/honcho-sdk-requirements.txt \
    && /opt/hermes/.venv/bin/python /tmp/patch-honcho-kanban-observation.py /opt/hermes/plugins/memory/honcho/__init__.py \
    && /opt/hermes/.venv/bin/python -m py_compile /opt/hermes/plugins/memory/honcho/__init__.py \
    && rm -f /tmp/honcho-sdk-requirements.txt /tmp/patch-honcho-sdk-floor.py /tmp/patch-honcho-kanban-observation.py
# The plugin imports Agent core modules at load time; fail the bake if the parent Agent lacks one.
COPY --chmod=0755 scripts/verify-honcho-plugin-core-seams.py /opt/hermes-fleet/bin/verify-honcho-plugin-core-seams.py
RUN /opt/hermes/.venv/bin/python /opt/hermes-fleet/bin/verify-honcho-plugin-core-seams.py /opt/hermes/plugins/memory/honcho /opt/hermes

# PM-managed tools (HF-856). PM's build API writes the pinned closure (versions come from PM's lock in
# the Agent parent) straight into the immutable store; a runtime ensure() would redirect missing tools
# into the /opt/data volume. cua-driver backs the computer_use toolset. pnpm is a required package in
# PM's lock: without it every agent reports "install out of sync (pnpm)". PM publishes facts.json as
# 0600; it is a non-secret inventory the runtime UID must read (never write) for native discovery.
# PM keeps its download cache and install state under HERMES_HOME. Run it against a throwaway build
# home: as root against /opt/data it leaves root-owned cache/installs that UID 1000 cannot write, so
# every hermes command then fails on boot ("install state is not writable").
RUN cd /opt/hermes && HERMES_HOME=/tmp/pm-build-home /opt/hermes/.venv/bin/python -c 'from pathlib import Path; from pm.build_operations import prepare_tools; from pm.store import current_target; prepare_tools(["chromium", "cua-driver", "pnpm"], out=Path("/opt/hermes/tools"), target=current_target())' \
    && rm -rf /tmp/pm-build-home \
    && chmod 0444 /opt/hermes/tools/facts.json \
    && test -z "$(find /opt/data -user 0 -print -quit)"

# Bot Desktop and browsers (HF-773). The upstream Bot Screen desktop packages (moved here from the
# private overlay, HF-550) plus Chromium, so every agent has a screen; nothing starts at
# boot. No xfce4 metapackage (screensaver/power/polkit). adwaita-icon-theme-legacy: Adwaita 48 ships
# only *-symbolic legacy names, so the dock's launchers rendered as blank squares without it.
# Camoufox's runtime libraries (libdbus-glib-1-2, libegl1), unzip for its release archive, a normal
# font set, and the en_AU.UTF-8 locale.
# chromium-l10n supplies en-GB.pak, the UI locale Chromium resolves en-AU to. Without it --lang=en-AU
# falls back to en-US and every page's Intl default formats dates month-first. A dpkg path filter keeps
# only en-GB and en-US of its ~117 MB of locale paks.
RUN printf '%s\n' 'path-exclude=/usr/lib/chromium/locales/*' \
      'path-include=/usr/lib/chromium/locales/en-GB.pak' 'path-include=/usr/lib/chromium/locales/en-US.pak' \
      > /etc/dpkg/dpkg.cfg.d/chromium-locales \
    && apt-get -o Acquire::Retries=3 update \
    && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      tigervnc-standalone-server xfce4-panel xfwm4 xfdesktop4 xfce4-settings xfce4-terminal \
      dbus-x11 at-spi2-core x11-xserver-utils x11-utils x11-xkb-utils xauth fonts-dejavu-core chromium chromium-l10n \
      adwaita-icon-theme-legacy \
      libdbus-glib-1-2 libegl1 unzip locales \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && sed -i 's/^# *\(en_AU.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && test "$(ls /usr/lib/chromium/locales | sort | tr '\n' ' ')" = 'en-GB.pak en-US.pak ' \
    && rm -rf /var/lib/apt/lists/*
# The dock's Browser launcher names internet-web-browser, which no installed theme ships
# (AdwaitaLegacy has only web-browser). Alias it to the Chromium icon that launcher opens;
# hicolor is every theme's fallback.
RUN for d in /usr/share/icons/hicolor/*/apps; do \
      if [ -f "$d/chromium.png" ]; then ln -sf chromium.png "$d/internet-web-browser.png"; fi; \
    done \
    && test -e /usr/share/icons/hicolor/48x48/apps/internet-web-browser.png \
    && gtk-update-icon-cache -f -q /usr/share/icons/hicolor
ENV LANG=en_AU.UTF-8 \
    LANGUAGE=en_AU:en \
    BH_TAB_MARKER=0

# Camoufox, pinned and attested (release/camoufox.lock.json), unpacked once into /opt/camoufox,
# never into the per-profile tool store. The release archive bundles its fonts and default addons;
# version.json (what the official camoufox package's fetcher writes beside a build) comes from the lock.
# The Sigstore build attestation is verified whenever the build has a GitHub token (CI always does);
# the bake verifier refuses an image whose marker does not say "verified".
COPY release/camoufox.lock.json /opt/hermes-fleet/release/camoufox.lock.json
COPY --chmod=0755 scripts/fetch-pinned-release-asset.sh /tmp/fetch-pinned-release-asset.sh
RUN --mount=type=secret,id=github_token,required=false set -eu; \
    lock=/opt/hermes-fleet/release/camoufox.lock.json; \
    field() { python3 -c 'import functools,json,sys; print(functools.reduce(lambda v, k: v[k], sys.argv[2].split("."), json.load(open(sys.argv[1]))["camoufox"]))' "$lock" "$1"; }; \
    repo=$(field repository); tag=$(field tag); asset=$(field asset); \
    archive=/tmp/camoufox.zip; \
    if [ -s /run/secrets/github_token ]; then GH_TOKEN="$(cat /run/secrets/github_token)"; export GH_TOKEN; fi; \
    /tmp/fetch-pinned-release-asset.sh "$repo" "$(field asset_id)" "$(field size)" "$(field sha256)" \
      "https://github.com/$repo/releases/download/$tag/$asset" "$archive"; \
    if [ -n "${GH_TOKEN:-}" ]; then \
      gh attestation verify "$archive" --repo "$repo" \
        --signer-workflow "$(field attestation.signer_workflow)" \
        --predicate-type "$(field attestation.predicate_type)" >/dev/null; \
      attested=verified; \
    else \
      echo "no GitHub token: Camoufox attestation not verified (local build)" >&2; attested=unverified-local-build; \
    fi; \
    unset GH_TOKEN; \
    mkdir -p /opt/camoufox; \
    unzip -q "$archive" -d /opt/camoufox; \
    rm -f "$archive" /tmp/fetch-pinned-release-asset.sh; \
    chmod -R a+rX,go-w /opt/camoufox; \
    test -x /opt/camoufox/camoufox-bin; \
    grep -qx "Version=$(field version)-$(field build)" /opt/camoufox/application.ini; \
    python3 -c 'import json,sys; l=json.load(open(sys.argv[1]))["camoufox"]; json.dump({"version": l["version"], "build": l["build"], "prerelease": False, "asset_id": l["asset_id"], "asset_size": l["size"], "sha256": l["sha256"], "interface": l["interface"]}, open("/opt/camoufox/version.json", "w")); print()' "$lock"; \
    chmod 0444 /opt/camoufox/version.json; \
    printf '{"sha256":"%s","attestation":"%s"}\n' "$(field sha256)" "$attested" > /opt/camoufox/.hermes-fleet-provenance.json; \
    chmod 0444 /opt/camoufox/.hermes-fleet-provenance.json; \
    for size in 16 32 48 64 128; do \
      install -D -m 0644 "/opt/camoufox/browser/chrome/icons/default/default${size}.png" \
        "/usr/share/icons/hicolor/${size}x${size}/apps/camoufox.png"; \
    done; \
    gtk-update-icon-cache -f -q /usr/share/icons/hicolor
# camofox-browser, the REST server the official camofox plugin drives: the integrity-pinned npm
# tarball (no repository fork) plus one registered downstream patch (release/camoufox.lock.json),
# installed from a committed lock with no install scripts. Telemetry and the default-addon download
# are disabled by the service, which also points it at /opt/camoufox. The official camoufox package
# generates fingerprints from fpgen's model, which it would download on first launch; it is baked
# here, sha256-checked against the pin fpgen-js ships and the lock, so a launch needs no network.
COPY release/camofox-browser/ /tmp/camofox-browser-release/
RUN set -eu; \
    lock=/opt/hermes-fleet/release/camoufox.lock.json; \
    field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["camofox_browser"][sys.argv[2]])' "$lock" "$1"; }; \
    tarball=/tmp/camofox-browser.tgz; \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 "$(field tarball)" -o "$tarball"; \
    python3 -c 'import base64,hashlib,sys; want=sys.argv[2]; got="sha512-"+base64.b64encode(hashlib.sha512(open(sys.argv[1],"rb").read()).digest()).decode(); sys.exit(0 if got==want else "camofox-browser tarball integrity mismatch: "+got)' "$tarball" "$(field integrity)"; \
    mkdir -p /opt/camofox-browser; \
    tar -xzf "$tarball" -C /opt/camofox-browser --strip-components=1 --no-same-owner; \
    cd /opt/camofox-browser; \
    git apply --whitespace=nowarn /tmp/camofox-browser-release/official-camoufox.patch; \
    cp /tmp/camofox-browser-release/package-lock.json package-lock.json; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    test "$(node -p 'require("./package.json").version')" = "$(field version)"; \
    test "$(node -p 'require("./node_modules/camoufox/package.json").version')" = "0.5.9"; \
    test ! -e node_modules/camoufox-js; \
    node --check server.js; \
    model() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["camofox_browser"]["fingerprint_model"][sys.argv[2]])' "$lock" "$1"; }; \
    test "$(node -p 'require("./node_modules/fpgen-js/package.json").version')" = "$(model package_version)"; \
    CAMOUFOX_FPGEN_DATA="$(model install_dir)" node --input-type=module -e 'const m = await import("fpgen-js"); const [sha, size, url] = process.argv.slice(1); if (m.MODEL_PIN.sha256 !== sha || m.MODEL_PIN.size !== Number(size) || m.MODEL_PIN.url !== url) throw new Error("fpgen-js model pin differs from the lock"); await m.ensureModel({ dir: process.env.CAMOUFOX_FPGEN_DATA });' "$(model sha256)" "$(model size)" "$(model url)"; \
    test "$(cat "$(model install_dir)/.pinned-model")" = "$(model sha256)"; \
    test -s "$(model install_dir)/values.dat"; \
    rm -rf "$(model install_dir)/.install.lock"; \
    rm -rf "$tarball" /tmp/camofox-browser-release /root/.npm; \
    chmod -R a+rX,go-w /opt/camofox-browser
COPY --chmod=0755 docker/camofox-browser/service-run /usr/local/lib/camofox-browser/service-run
COPY docker/s6-rc.d/camofox-browser/ /etc/s6-overlay/s6-rc.d/camofox-browser/
COPY docker/s6-rc.d/user/contents.d/camofox-browser /etc/s6-overlay/s6-rc.d/user/contents.d/camofox-browser
COPY --chmod=0755 scripts/verify-camoufox-runtime.py /opt/hermes-fleet/bin/verify-camoufox-runtime.py
RUN chmod 0755 /etc/s6-overlay/s6-rc.d/camofox-browser/run
# The camofox plugin reads CAMOFOX_URL from the process environment; it is not a secret. The access
# key is per container and lives in <HERMES_HOME>/camofox-browser/access-key. s6 waits up to 50 s at
# container stop (default 3 s) so the browser server can checkpoint its logins.
ENV CAMOFOX_URL=http://127.0.0.1:9377 \
    CAMOUFOX_FPGEN_DATA=/opt/camofox-browser/fpgen \
    S6_SERVICES_GRACETIME=50000

# Fleet plugins are mounted read-only by deployment, never baked into the image.
# Keep each absence check in a separate layer so deleting a prune fails the bake.
# Do not assert absence in a running gateway: the mount makes the path exist.
RUN rm -rf /opt/hermes/plugins/linear-agent \
    /opt/hermes/plugins/model-providers/claude-acp \
    /opt/hermes/plugins/kokoro-voice \
    /opt/hermes/plugins/browser-handoff \
    /opt/hermes/plugins/readonly-source \
    /opt/hermes/plugins/web/perplexity
RUN test ! -e /opt/hermes/plugins/linear-agent
RUN test ! -e /opt/hermes/plugins/model-providers/claude-acp
RUN test ! -e /opt/hermes/plugins/kokoro-voice
RUN test ! -e /opt/hermes/plugins/browser-handoff
RUN test ! -e /opt/hermes/plugins/readonly-source
RUN test ! -e /opt/hermes/plugins/web/perplexity
# The coding CLIs change most often, so they sit LAST among the heavy layers:
# a CLI-only change (package.json/package-lock.json or the version ARGs) rebuilds just this layer and
# the cheap provenance tail, and the apt desktop/Chromium, Camoufox, camofox-browser and Honcho
# layers above stay in the BuildKit/registry cache. Layer order: base OS (Agent parent) -> pinned
# desktop/browser runtimes -> Honcho -> pinned CLIs -> provenance stamp (HF-851). Main promotes
# the scanned PR image instead of rebuilding it, so the order mainly speeds up PR bakes.
ARG CLAUDE_CODE_VERSION=2.1.326
ARG CLAUDE_AGENT_ACP_VERSION=0.112.0
ARG CODEX_VERSION=0.172.0
ARG GROK_VERSION=1.0.92
COPY package.json package-lock.json /opt/coding-clis/
RUN npm ci --omit=dev --prefix /opt/coding-clis --ignore-scripts --no-audit --no-fund \
    && node /opt/coding-clis/node_modules/@anthropic-ai/claude-code/install.cjs \
    && node /opt/coding-clis/node_modules/opencode-ai/postinstall.mjs \
    && HOME=/tmp/coding-clis-build GROK_HOME=/opt/coding-clis/grok \
         node /opt/coding-clis/node_modules/@xai-official/grok/bin/postinstall.js \
    && ln -s /opt/coding-clis/node_modules/.bin/claude /usr/local/bin/claude \
    && ln -s /opt/coding-clis/node_modules/.bin/claude-agent-acp /usr/local/bin/claude-agent-acp \
    && ln -s /opt/coding-clis/node_modules/.bin/codex /usr/local/bin/codex \
    && ln -s /opt/coding-clis/grok/bin/grok /usr/local/bin/grok \
    && ln -s /opt/coding-clis/node_modules/.bin/opencode /usr/local/bin/opencode \
    && test "$(/usr/local/bin/claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)" \
    && test "$(node -p 'require("/opt/coding-clis/node_modules/@agentclientprotocol/claude-agent-acp/package.json").version')" = "${CLAUDE_AGENT_ACP_VERSION}" \
    && test "$(/usr/local/bin/codex --version)" = "codex-cli ${CODEX_VERSION}" \
    && test "$(/usr/local/bin/grok --version | awk '{print $2}')" = "${GROK_VERSION}" \
    && test -x /usr/local/bin/claude-agent-acp \
    && test -x /usr/local/bin/codex \
    && test -x /usr/local/bin/grok \
    && test -x /usr/local/bin/opencode
ENV CLAUDE_CODE_EXECUTABLE=/opt/coding-clis/node_modules/.bin/claude
COPY --chmod=0755 scripts/claude-acp-subscription /usr/local/bin/hermes-claude-acp-subscription
COPY --chmod=0755 scripts/tooling-policy-hook /opt/hermes/bin/tooling-policy-hook
# Per-profile tool lock reconcile (plan/apply/verify/audit), used by the persistent-agent-tools skill.
COPY --chmod=0755 scripts/hermes-tooling /opt/hermes/bin/hermes-tooling
# The headless 1Password CLI autolaunches a D-Bus session daemon that never exits. It leaks PIDs and
# keeps background-process supervisors waiting on a descendant forever, so jobs that call `op` never
# complete. An explicit unavailable bus stops the autolaunch; `op read` still works without it.
ENV DBUS_SESSION_BUS_ADDRESS=disabled:
# /etc/profile replaces PATH, so login shells (bash -lc, sub-agents, agent terminals) would lose
# hermes and hermes-tooling. The script also names /opt/data/bin, a profile-mounted directory that is
# absent at bake time.
COPY docker/profile.d/hermes-cli-path.sh /etc/profile.d/hermes-cli-path.sh
RUN test -s /etc/profile.d/hermes-cli-path.sh \
    && grep -q '/opt/data/bin' /etc/profile.d/hermes-cli-path.sh \
    && bash -lc 'command -v hermes && command -v hermes-tooling'
# Clears a Bot Screen browser lock left on the volume by an unclean stop. cont-init.d runs before s6
# starts any service; the Bot Screen itself only starts on demand, after this.
COPY --chmod=0755 scripts/bot-screen-stale-lock.py /etc/cont-init.d/017-bot-screen-stale-lock
# Agents work in /opt/data/workspace on the profile volume; keep the conventional /workspace path.
RUN rm -rf /workspace && ln -s /opt/data/workspace /workspace \
    && /opt/hermes/bin/hermes-tooling audit
COPY scripts/image_ref.py /opt/hermes-fleet/bin/image_ref.py
COPY --chmod=0755 scripts/verify-agent-image-ref.py /opt/hermes-fleet/bin/verify-agent-image-ref
COPY --chmod=0755 scripts/verify-runtime-dir.py /opt/hermes-fleet/bin/verify-runtime-dir.py
COPY contracts/ /opt/hermes-fleet/contracts/
ARG AGENT_IMAGE
ARG ONEPASSWORD_CLI_IMAGE
ARG FLEET_GIT_SHA=development
# Content identity (HF-851): the git tree the image was built from. A main commit and the PR head it
# squash-merged share it, so the exact scanned PR image can be promoted on main instead of rebuilt.
ARG FLEET_SOURCE_TREE=development
ARG FLEET_IMAGE_IDENTITY=local/hermes-fleet
ENV HERMES_FLEET_GIT_SHA=${FLEET_GIT_SHA} \
    HERMES_FLEET_SOURCE_TREE=${FLEET_SOURCE_TREE} \
    HERMES_FLEET_IMAGE_IDENTITY=${FLEET_IMAGE_IDENTITY} \
    HERMES_FLEET_AGENT_IMAGE=${AGENT_IMAGE} \
    HERMES_FLEET_ONEPASSWORD_CLI_IMAGE=${ONEPASSWORD_CLI_IMAGE} \
    HERMES_FLEET_CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    HERMES_FLEET_CLAUDE_AGENT_ACP_VERSION=${CLAUDE_AGENT_ACP_VERSION} \
    HERMES_FLEET_CODEX_VERSION=${CODEX_VERSION} \
    HERMES_FLEET_GROK_VERSION=${GROK_VERSION} \
    HERMES_FLEET_CLAUDE_ACP_PLUGIN_SOURCE=${CLAUDE_ACP_PLUGIN_SOURCE} \
    HERMES_FLEET_CLAUDE_ACP_PLUGIN_REVISION=${CLAUDE_ACP_PLUGIN_REVISION}
LABEL org.opencontainers.image.source="https://github.com/switchroom/switchroom" \
      org.opencontainers.image.revision="${FLEET_GIT_SHA}" \
      hermes-fleet.source-tree="${FLEET_SOURCE_TREE}" \
      org.opencontainers.image.base.name="${AGENT_IMAGE}"
RUN python3 -c 'import json, os, pathlib; marker = pathlib.Path("/etc/hermes-fleet/image-provenance.json"); marker.parent.mkdir(parents=True, exist_ok=True); marker.write_text(json.dumps({"schema": 1, "deployment_kind": "fleet_child_image", "image": os.environ["HERMES_FLEET_IMAGE_IDENTITY"], "revision": os.environ["HERMES_FLEET_GIT_SHA"], "tree": os.environ["HERMES_FLEET_SOURCE_TREE"], "parent_agent_image": os.environ["HERMES_FLEET_AGENT_IMAGE"], "onepassword_cli_image": os.environ["HERMES_FLEET_ONEPASSWORD_CLI_IMAGE"], "claude_code_version": os.environ["HERMES_FLEET_CLAUDE_CODE_VERSION"], "claude_agent_acp_version": os.environ["HERMES_FLEET_CLAUDE_AGENT_ACP_VERSION"], "codex_version": os.environ["HERMES_FLEET_CODEX_VERSION"], "grok_version": os.environ["HERMES_FLEET_GROK_VERSION"], "claude_acp_plugin_source": os.environ["HERMES_FLEET_CLAUDE_ACP_PLUGIN_SOURCE"], "claude_acp_plugin_revision": os.environ["HERMES_FLEET_CLAUDE_ACP_PLUGIN_REVISION"]}, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"); marker.chmod(0o444)'
# XDG_RUNTIME_DIR (inherited from the agent image) holds the Bot Desktop display-allocation lock and
# dbus state. The agent image bakes it root:root 0700 and fixes ownership in its root start hook, but
# this image starts as 1000, so that chown cannot run: bake it 1000:1000 0700 here, after every root
# step. It sits in world-writable /tmp under a predictable name, so refuse a symlink before and after,
# and drop any dbus state a build step left in it.
RUN groupmod -g 1000 hermes \
    && usermod -u 1000 -g 1000 hermes \
    && mkdir -p /run \
    && chown -R hermes:hermes /run \
    && test "${XDG_RUNTIME_DIR:-}" = /tmp/hermes-runtime \
    && test ! -L /tmp/hermes-runtime \
    && install -d -o 1000 -g 1000 -m 0700 /tmp/hermes-runtime \
    && rm -rf /tmp/hermes-runtime/dbus-1 \
    && test ! -L /tmp/hermes-runtime \
    && test "$(stat -c '%u:%g:%a' /tmp/hermes-runtime)" = 1000:1000:700
USER 1000:1000
