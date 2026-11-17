# REST lock-proxy: stdlib-only, immutable base, non-root runtime.
FROM python:3.13-alpine@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a

ARG VCS_REF
LABEL org.opencontainers.image.title="hermes-fleet-rest-lock-proxy" \
      org.opencontainers.image.description="REST takeover lock proxy returning HTTP 423 while locked" \
      org.opencontainers.image.source="https://github.com/switchroom/switchroom" \
      org.opencontainers.image.revision="$VCS_REF"

WORKDIR /app
COPY lock_proxy.py entrypoint.py /app/
USER 65532:65532
EXPOSE 9377
ENTRYPOINT ["python3", "/app/entrypoint.py"]
