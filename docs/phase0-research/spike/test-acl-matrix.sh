#!/usr/bin/env bash
# Phase 0 ACL matrix driver.
# Drives the spike against whatever Docker engine modes are available
# locally and emits structured rows the matrix doc consumes.
#
# rc convention: every per-test variable is 0 on PASS, nonzero on FAIL.
# That includes the hostile cross-mount test — `hostile_rc=0` means the
# kernel correctly blocked the cross-agent connect with EACCES (the
# agent-client returns 0 when all 4 of its internal tests pass, including
# the hostile cross-mount-attempt expecting EACCES). The driver tallies
# all per-test rcs at the end and exits nonzero if any failed, so an
# unattended Mac/Win operator sees real failures rather than a green-tee
# from `|| true`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${HERE}/results"
mkdir -p "$RESULTS_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

# Track every (env, test) pass/fail across all run_env invocations.
# The pipeline `{ ... } | tee` puts run_env in a subshell, so we persist
# results to a temp file (one line per record) instead of relying on
# in-process associative-array state.
TALLY_FILE="$(mktemp)"
trap 'rm -f "$TALLY_FILE"' EXIT
MATRIX_ENVS=()

record() {
  # record <env> <test> <rc>   (rc 0 = PASS, nonzero = FAIL)
  local env="$1" test="$2" rc="$3"
  printf '%s\t%s\t%s\n' "$env" "$test" "$rc" >> "$TALLY_FILE"
}

# Assert that the per-agent socket dir has mode 0700 owned by the right uid.
# Fast-fails on Mac virtiofs UID-collapse where everything appears as the
# host uid regardless of the chown call.
assert_dir_perms() {
  # assert_dir_perms <container> <agent> <expected_uid>
  local container="$1" agent="$2" expected_uid="$3"
  local out
  out=$(docker compose exec -T "$container" ls -la "/run/switchroom/broker/${agent}" 2>&1) || {
    echo "ASSERT FAIL: cannot ls /run/switchroom/broker/${agent} from $container"
    echo "$out"
    return 1
  }
  echo "$out"
  # Parent dir line is the entry whose name == "."
  local dot_line
  dot_line=$(echo "$out" | awk '$NF=="."{print; exit}')
  if [ -z "$dot_line" ]; then
    echo "ASSERT FAIL: no '.' line in ls output for ${agent} dir"
    return 1
  fi
  # Expect mode drwx------ (alpine ls prints `drwx------` for 0700).
  local mode_field
  mode_field=$(echo "$dot_line" | awk '{print $1}')
  if [ "$mode_field" != "drwx------" ]; then
    echo "ASSERT FAIL: ${agent} dir mode=$mode_field (want drwx------)"
    return 1
  fi
  # Owner is column 3. In alpine `ls -la` it's the numeric uid when the
  # name doesn't resolve, or the resolved name. We accept either the
  # numeric uid or the agent name.
  local owner_field
  owner_field=$(echo "$dot_line" | awk '{print $3}')
  if [ "$owner_field" != "$expected_uid" ] && [ "$owner_field" != "$agent" ]; then
    echo "ASSERT FAIL: ${agent} dir owner=$owner_field (want $expected_uid or $agent)"
    return 1
  fi
  return 0
}

run_env() {
  local env_label="$1"
  local docker_host="$2"   # may be empty for default
  local out="${RESULTS_DIR}/${env_label}-${TS}.log"

  echo "============================================================"
  echo "ENV: $env_label  DOCKER_HOST=${docker_host:-<default>}"
  echo "============================================================"
  {
    echo "## env=$env_label DOCKER_HOST=${docker_host:-<default>} at $TS"
    if [ -n "$docker_host" ]; then export DOCKER_HOST="$docker_host"; else unset DOCKER_HOST; fi

    echo "### docker version"
    docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' 2>&1 || true
    echo "### docker info security"
    docker info --format '{{.SecurityOptions}}' 2>&1 || true
    echo "### docker info rootless"
    docker info --format 'rootless={{.SecurityOptions}} cgroup={{.CgroupDriver}}/{{.CgroupVersion}}' 2>&1 || true

    cd "$HERE"

    echo "### compose down (clean slate)"
    docker compose --profile hostile down -v --remove-orphans 2>&1 || true

    echo "### compose build"
    if ! docker compose build 2>&1; then
      echo "RESULT: build-failed"
      record "$env_label" "build" 1
      return 1
    fi
    record "$env_label" "build" 0

    echo "### compose up -d (alice+bob+broker)"
    if ! docker compose up -d broker agent-alice agent-bob 2>&1; then
      echo "RESULT: up-failed"
      docker compose logs 2>&1 || true
      record "$env_label" "up" 1
      return 1
    fi
    record "$env_label" "up" 0

    # Give the broker a moment to bind sockets.
    sleep 2
    echo "### broker logs (post-start)"
    docker compose logs broker 2>&1 | tail -40

    echo "### >>> ASSERT dir mode/owner (alice)"
    if assert_dir_perms agent-alice alice 10001; then
      record "$env_label" "perms-alice" 0
    else
      record "$env_label" "perms-alice" 1
    fi
    echo "### >>> ASSERT dir mode/owner (bob)"
    if assert_dir_perms agent-bob bob 10002; then
      record "$env_label" "perms-bob" 0
    else
      record "$env_label" "perms-bob" 1
    fi

    echo "### >>> AGENT-ALICE CLIENT"
    docker compose exec -T agent-alice node /opt/agent/agent-client.mjs 2>&1
    local alice_rc=$?
    echo "### alice client exit=$alice_rc (0=PASS)"
    record "$env_label" "alice-client" "$alice_rc"

    echo "### >>> AGENT-BOB CLIENT"
    docker compose exec -T agent-bob node /opt/agent/agent-client.mjs 2>&1
    local bob_rc=$?
    echo "### bob client exit=$bob_rc (0=PASS)"
    record "$env_label" "bob-client" "$bob_rc"

    echo "### >>> TMUX INTERRUPT TEST (alice)"
    docker compose exec -T agent-alice /opt/agent/test-tmux-interrupt.sh 2>&1
    local tmux_rc=$?
    echo "### tmux test exit=$tmux_rc (0=PASS)"
    record "$env_label" "tmux-interrupt" "$tmux_rc"

    echo "### >>> CROSS-MOUNT (HOSTILE) TEST + bind/unlink/replace adversarial"
    # The hostile container cross-mounts BOTH socket dirs and runs
    # agent-client.mjs with HOSTILE=1, which switches the cross-mount
    # test to require EACCES (not ENOENT) and adds three adversarial
    # tests: bind() into other dir, unlink() other socket, open()-replace
    # other socket. All four must be blocked at the kernel by mode-0700
    # ownership of the dir/inode by the other agent's uid.
    if docker compose --profile hostile up -d agent-bob-misconfigured 2>&1; then
      sleep 1
      echo "### hostile container fs view"
      docker compose exec -T agent-bob-misconfigured ls -la /run/switchroom/broker 2>&1 || true
      docker compose exec -T agent-bob-misconfigured ls -la /run/switchroom/broker/alice 2>&1 || true
      echo "### hostile attempt: bob (10002) vs alice's dir (uid 10001 mode 0700)"
      docker compose exec -T agent-bob-misconfigured node /opt/agent/agent-client.mjs 2>&1
      local hostile_rc=$?
      echo "### hostile client exit=$hostile_rc (0=PASS, all adversarial tests blocked at kernel)"
      record "$env_label" "hostile-cross-mount" "$hostile_rc"
    else
      echo "### hostile up failed"
      record "$env_label" "hostile-cross-mount" 99
    fi

    echo "### >>> SAME-UID HOSTILE TWIN TEST (operator UID-collision misconfiguration)"
    # Spawn evil-twin (uid 10001, same as alice) and let it attack
    # alice's dir. Expected outcome: attacks SUCCEED — proving the
    # path-derived identity model assumes uid uniqueness across
    # services. The doctor check in Phase 1 must enforce this.
    if docker compose --profile hostile up -d agent-evil-twin 2>&1; then
      sleep 1
      echo "### evil-twin fs view (uid 10001 == alice's uid, can read alice's dir)"
      docker compose exec -T agent-evil-twin ls -la /run/switchroom/broker/alice 2>&1 || true
      echo "### evil-twin attack run (expects every attack to SUCCEED)"
      docker compose exec -T agent-evil-twin node /opt/agent/agent-client.mjs 2>&1
      local twin_rc=$?
      echo "### evil-twin client exit=$twin_rc (0=PASS — attacks succeeded as documented model assumption)"
      record "$env_label" "same-uid-twin-attacks-succeed" "$twin_rc"
      # Tear down before broker-restart so the unlink/replace damage is healed.
      docker compose --profile hostile stop agent-evil-twin 2>&1 | tail -5 || true
      docker compose --profile hostile rm -f agent-evil-twin 2>&1 | tail -5 || true
    else
      echo "### evil-twin up failed"
      record "$env_label" "same-uid-twin-attacks-succeed" 99
    fi

    echo "### >>> BROKER RESTART PERSISTENCE TEST"
    # The findings doc claims chown/chmod persist across broker restart
    # because they're applied to the named-volume contents. Exercise it:
    # stop just the broker, start it again, and re-run the alice client.
    # Sockets must come back, dir perms must still be 0700/uid 10001,
    # ACL must still resolve identity correctly.
    # Stop only the hostile container — keep alice/bob/broker network up.
    docker compose --profile hostile stop agent-bob-misconfigured 2>&1 | tail -5 || true
    docker compose --profile hostile rm -f agent-bob-misconfigured 2>&1 | tail -5 || true
    docker compose stop broker 2>&1 | tail -5
    sleep 1
    docker compose start broker 2>&1 | tail -5
    sleep 3
    echo "### broker logs (post-restart)"
    docker compose logs broker 2>&1 | tail -20
    echo "### >>> RE-ASSERT dir mode/owner (alice) after broker restart"
    if assert_dir_perms agent-alice alice 10001; then
      record "$env_label" "perms-alice-after-restart" 0
    else
      record "$env_label" "perms-alice-after-restart" 1
    fi
    echo "### >>> RE-RUN AGENT-ALICE CLIENT after broker restart"
    docker compose exec -T agent-alice node /opt/agent/agent-client.mjs 2>&1
    local restart_rc=$?
    echo "### alice client exit (post-restart)=$restart_rc (0=PASS)"
    record "$env_label" "alice-client-after-restart" "$restart_rc"

    echo "### compose down -v"
    docker compose --profile hostile down -v --remove-orphans 2>&1 || true

    echo "### SUMMARY env=$env_label alice_rc=$alice_rc bob_rc=$bob_rc tmux_rc=$tmux_rc hostile_rc=${hostile_rc:-99} twin_rc=${twin_rc:-99} restart_rc=$restart_rc"
  } 2>&1 | tee "$out"
  echo "log: $out"
}

# Discover which environments are reachable.
echo ">>> Phase 0 matrix run at $TS"
echo ">>> uname: $(uname -a)"
echo ">>> id: $(id)"
echo ">>> docker context ls"
docker context ls 2>&1 || true

# 1. Linux rootful (default).
MATRIX_ENVS+=("linux-rootful")
run_env "linux-rootful" ""

# 2. Linux rootless — only if a rootless context or systemd --user docker is present.
ROOTLESS_HOST=""
if systemctl --user is-active docker.service >/dev/null 2>&1; then
  ROOTLESS_HOST="unix:///run/user/$(id -u)/docker.sock"
elif [ -S "/run/user/$(id -u)/docker.sock" ]; then
  ROOTLESS_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
if [ -n "$ROOTLESS_HOST" ]; then
  MATRIX_ENVS+=("linux-rootless")
  run_env "linux-rootless" "$ROOTLESS_HOST"
else
  echo ">>> SKIP linux-rootless: no rootless docker socket detected at /run/user/$(id -u)/docker.sock"
fi

# Final tally — any nonzero rc is a real failure.
echo
echo "============================================================"
echo "FINAL TALLY"
echo "============================================================"
total=0
failed=0
for env in "${MATRIX_ENVS[@]}"; do
  echo "--- env=$env ---"
  while IFS=$'\t' read -r e test rc; do
    [ "$e" = "$env" ] || continue
    total=$((total+1))
    if [ "$rc" = "0" ]; then
      printf "  PASS  %s\n" "$test"
    else
      printf "  FAIL  %s (rc=%s)\n" "$test" "$rc"
      failed=$((failed+1))
    fi
  done < "$TALLY_FILE"
done
echo "------------------------------------------------------------"
echo "TOTAL: $total tests, $failed failures"
echo ">>> done. results in $RESULTS_DIR"
exit $failed
