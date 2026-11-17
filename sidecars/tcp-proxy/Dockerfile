# noVNC TCP proxy: socat forwarder, immutable base, non-root runtime.
FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

ARG VCS_REF
LABEL org.opencontainers.image.title="hermes-fleet-tcp-proxy" \
      org.opencontainers.image.description="Per-agent noVNC TCP forwarder (camofox:6080) for the browser sidecar fleet" \
      org.opencontainers.image.source="https://github.com/switchroom/switchroom" \
      org.opencontainers.image.revision="$VCS_REF"

RUN apk add --no-cache socat netcat-openbsd
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
USER nobody
EXPOSE 6080
ENTRYPOINT ["/entrypoint.sh"]
