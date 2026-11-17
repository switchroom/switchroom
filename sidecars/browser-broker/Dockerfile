# Canonical, per-agent browser-handoff broker.
FROM python:3.13.15-alpine3.24@sha256:7415fbc3c9e4979cc717d92377ab2bc7b2b4a2af1ac03cc52b5f3f88efedaf3a

ARG VCS_REF
LABEL org.opencontainers.image.title="hermes-fleet-browser-broker" \
      org.opencontainers.image.description="Canonical agent-isolated browser handoff broker" \
      org.opencontainers.image.source="https://github.com/switchroom/switchroom" \
      org.opencontainers.image.revision="$VCS_REF"

WORKDIR /
# Both dependencies have wheels for the pinned CPython/Alpine platform. Refuse
# mutable source builds and their compiler toolchain.
RUN python3 -m pip install --no-cache-dir --only-binary=:all: PyJWT==2.13.0 cryptography==50.0.1
COPY origin.py origin_routing.py public_config.py rfb_filter.py rollout_contract.py session_policy.py ux.py /
USER 65532:65532
EXPOSE 9131 9134
CMD ["python3", "-u", "/origin.py"]
