ARG AGENT_IMAGE
ARG ONEPASSWORD_CLI_IMAGE=docker.io/1password/op@sha256:b0d7eebcb09bdc9d5862af91533e1851c968d4f969270c906f5da8c574f87e93
FROM ${ONEPASSWORD_CLI_IMAGE} AS onepassword_cli
FROM ${AGENT_IMAGE}

USER root

ARG GH_VERSION=2.104.0
ARG GH_LINUX_AMD64_SHA256=98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e
ARG GH_LINUX_AMD64_ASSET_ID=740718892
ARG CLAUDE_CODE_VERSION=2.1.323
ARG CLAUDE_AGENT_ACP_VERSION=0.106.0
ARG CODEX_VERSION=0.167.2
ARG GROK_VERSION=1.0.77
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
COPY --chmod=0755 scripts/tooling-policy-hook /opt/hermes/bin/tooling-policy-hook
COPY scripts/image_ref.py /opt/hermes-fleet/bin/image_ref.py
COPY --chmod=0755 scripts/verify-agent-image-ref.py /opt/hermes-fleet/bin/verify-agent-image-ref
COPY contracts/ /opt/hermes-fleet/contracts/
ARG AGENT_IMAGE
ARG ONEPASSWORD_CLI_IMAGE
ARG FLEET_GIT_SHA=development
ARG FLEET_IMAGE_IDENTITY=local/hermes-fleet
ENV HERMES_FLEET_GIT_SHA=${FLEET_GIT_SHA} \
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
      org.opencontainers.image.base.name="${AGENT_IMAGE}"
RUN python3 -c 'import json, os, pathlib; marker = pathlib.Path("/etc/hermes-fleet/image-provenance.json"); marker.parent.mkdir(parents=True, exist_ok=True); marker.write_text(json.dumps({"schema": 1, "deployment_kind": "fleet_child_image", "image": os.environ["HERMES_FLEET_IMAGE_IDENTITY"], "revision": os.environ["HERMES_FLEET_GIT_SHA"], "parent_agent_image": os.environ["HERMES_FLEET_AGENT_IMAGE"], "onepassword_cli_image": os.environ["HERMES_FLEET_ONEPASSWORD_CLI_IMAGE"], "claude_code_version": os.environ["HERMES_FLEET_CLAUDE_CODE_VERSION"], "claude_agent_acp_version": os.environ["HERMES_FLEET_CLAUDE_AGENT_ACP_VERSION"], "codex_version": os.environ["HERMES_FLEET_CODEX_VERSION"], "grok_version": os.environ["HERMES_FLEET_GROK_VERSION"], "claude_acp_plugin_source": os.environ["HERMES_FLEET_CLAUDE_ACP_PLUGIN_SOURCE"], "claude_acp_plugin_revision": os.environ["HERMES_FLEET_CLAUDE_ACP_PLUGIN_REVISION"]}, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8"); marker.chmod(0o444)'
RUN groupmod -g 1000 hermes \
    && usermod -u 1000 -g 1000 hermes \
    && mkdir -p /run \
    && chown -R hermes:hermes /run
USER 1000:1000
