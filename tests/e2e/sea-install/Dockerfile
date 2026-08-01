FROM debian:bookworm-slim
# curl/tar/gzip: what install.sh needs. python3: the local artifact server.
RUN apt-get update -qq && apt-get install -y -qq \
      curl ca-certificates python3 tar gzip docker.io \
  && rm -rf /var/lib/apt/lists/*
# The compose v2 plugin. `switchroom apply` runs a compose-v2 preflight, and a
# host WITHOUT it (and without a vault) fingerprints as an AGENT container via
# isInAgentContainer and refuses the per-agent scaffold. The preflight only
# runs `docker compose version`; no daemon is contacted.
RUN mkdir -p /usr/libexec/docker/cli-plugins \
 && curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose \
      https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
 && chmod +x /usr/libexec/docker/cli-plugins/docker-compose \
 && docker compose version
