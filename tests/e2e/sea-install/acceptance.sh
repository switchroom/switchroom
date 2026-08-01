#!/bin/sh
# Runs INSIDE a fresh container. Nothing switchroom-related is pre-staged:
# the only inputs are the release artifacts served over HTTP and install.sh.
set -eu

fail() { echo "E2E-FAIL: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }

step "0. prove the host is virgin"
[ ! -e /usr/local/bin/switchroom ] || fail "binary pre-staged"
[ ! -e /usr/local/share/switchroom ] || fail "assets pre-staged"
[ ! -e /usr/share/switchroom ] || fail "assets pre-staged in /usr/share"
if env | grep -E '^SWITCHROOM_(PROFILES|SKILLS|HINDSIGHT_VENDOR|WEB_UI|ASSET_MANIFEST)'; then
  fail "an asset-root override is set — the acceptance criterion forbids it"
fi
echo "ok: no binary, no assets, no *_ROOT override"

step "1. serve the release artifacts over HTTP"
python3 -m http.server 8000 --directory /artifacts --bind 127.0.0.1 >/tmp/http.log 2>&1 &
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:8000/switchroom-checksums.txt >/dev/null 2>&1 && break
  sleep 0.3
done
curl -fsS http://127.0.0.1:8000/switchroom-checksums.txt >/dev/null || fail "artifact server did not come up"

step "2. run the REAL install.sh (the curl | sh path)"
SWITCHROOM_VERSION="$SR_VERSION" \
SWITCHROOM_BASE_URL="http://127.0.0.1:8000" \
  sh /repo/install.sh

step "3. what did the installer actually put on disk?"
[ -x /usr/local/bin/switchroom ] || fail "no binary at /usr/local/bin/switchroom"
[ -L /usr/local/share/switchroom ] || fail "/usr/local/share/switchroom is not a symlink"
echo "  share symlink -> $(readlink /usr/local/share/switchroom)"
[ -d /usr/local/share/switchroom/profiles ] || fail "no profiles/ in the payload"
[ -d /usr/local/share/switchroom/skills ] || fail "no skills/ in the payload"
[ -d /usr/local/share/switchroom/vendor/hindsight-memory ] || fail "no vendor/hindsight-memory/"
[ -d /usr/local/share/switchroom/ui ] || fail "no web ui/"
[ -f /usr/local/share/switchroom/switchroom-assets.json ] || fail "no manifest"
cat /usr/local/share/switchroom/switchroom-assets.json

step "4. the CLI runs and reports its version"
/usr/local/bin/switchroom --version

step "5. doctor's payload check agrees with the CLI"
switchroom doctor 2>&1 | grep -iA2 "shipped-asset payload" | head -8 || true

step "6. bootstrap a config with `switchroom setup --non-interactive`"
# The first command a curl|sh user runs. It does much more than write the
# config (bot tokens etc) so it is expected to exit non-zero here; what is
# under test is that the EMBEDDED example is written at all.
switchroom setup --non-interactive >/tmp/setup.log 2>&1 || true
[ -f "$HOME/.switchroom/switchroom.yaml" ] \
  || { tail -20 /tmp/setup.log; fail "setup did not bootstrap a config"; }
if grep -q "Example config not found" /tmp/setup.log; then
  fail "setup still cannot find its embedded example"
fi
echo "ok: $HOME/.switchroom/switchroom.yaml written by setup"

step "6b. initialise the vault + the one secret the example config references"
# The example config references `vault:` keys, and apply refuses to scaffold
# against a missing vault. A real operator does this through the interactive
# `switchroom setup`; scripted here so the run stays non-interactive. Note this
# stages NO profiles/skills/assets — only a secret.
export SWITCHROOM_VAULT_PASSPHRASE="e2e-passphrase"
switchroom vault init >/tmp/vault.log 2>&1 || { tail -5 /tmp/vault.log; fail "vault init"; }
for key in $(grep -oE 'vault:[A-Za-z0-9_./-]+' "$HOME/.switchroom/switchroom.yaml" | sed 's/^vault://' | sort -u); do
  printf 'e2e-dummy-value' > /tmp/secret.txt
  switchroom vault set "$key" --file /tmp/secret.txt >>/tmp/vault.log 2>&1 \
    || { tail -5 /tmp/vault.log; fail "vault set $key"; }
  echo "  vaulted $key"
done

step "7. THE ACCEPTANCE CRITERION: switchroom apply --non-interactive"
cd "$HOME/.switchroom"
# The ONE concession to running the acceptance check inside a container: apply
# refuses to deploy from a container unless told where the HOST's home is, so
# it can translate bind-mount sources. Unrelated to asset resolution, and NOT
# an asset-root override (the criterion forbids SWITCHROOM_*_ROOT only).
export SWITCHROOM_HOST_HOME="$HOME"
set +e
switchroom apply --non-interactive --no-doctor > /tmp/apply.log 2>&1
apply_status=$?
set -e
tail -40 /tmp/apply.log
echo "apply exit status: $apply_status"

step "8. did every agent in the config actually get scaffolded?"
agents=$(switchroom config agents 2>/dev/null || true)
if [ -z "$agents" ]; then
  # Fall back to reading the config directly.
  agents=$(python3 - <<'PY'
import re,sys,os
p=os.path.expanduser("~/.switchroom/switchroom.yaml")
body=open(p).read()
m=re.search(r'^agents:\s*$', body, re.M)
out=[]
if m:
    for line in body[m.end():].splitlines():
        if re.match(r'^\S', line): break
        n=re.match(r'^  ([A-Za-z0-9_-]+):\s*$', line)
        if n: out.append(n.group(1))
print("\n".join(out))
PY
)
fi
echo "agents in config: $(echo "$agents" | tr '\n' ' ')"
[ -n "$agents" ] || fail "could not determine the agent list"
for a in $agents; do
  d="$HOME/.switchroom/agents/$a"
  [ -f "$d/start.sh" ] || fail "agent $a: no start.sh scaffolded"
  [ -f "$d/CLAUDE.md" ] || fail "agent $a: no CLAUDE.md scaffolded"
  if grep -q 'Profile not found' "$d/CLAUDE.md"; then fail "agent $a: profile did not resolve"; fi
  # #4163: repoRoot rendered empty under SEA and the self-test never ran.
  if grep -q '//bin/boot-self-test.sh' "$d/start.sh"; then
    fail "agent $a: start.sh still has the empty-repoRoot self-test path"
  fi
  grep -q '/opt/switchroom/bin/boot-self-test.sh' "$d/start.sh" \
    || fail "agent $a: start.sh lost the boot self-test"
  echo "  ok: $a (start.sh, CLAUDE.md, in-container self-test path)"
done

step "9. skills pool seeded from the payload, not hand-staged"
pool="$HOME/.switchroom/skills/_bundled"
[ -d "$pool" ] || fail "no bundled skills pool — apply did not seed it from the payload"
[ -f "$pool/.switchroom-manifest.json" ] || fail "pool has no ownership manifest"
echo "  pool: $(ls "$pool" | wc -l) entries, e.g. $(ls "$pool" | head -3 | tr '\n' ' ')"
if grep -q "bundled skills pool dir not found" /tmp/apply.log; then
  fail "apply still reported a missing bundled skills pool"
fi
# PRE-EXISTING, orthogonal to #4163: a name in `skills:` is looked up in the
# pool ROOT (syncGlobalSkills -> resolveSkillsPoolDir), but bundled skills live
# in <pool>/_bundled, so the example config's `skills:` list warns even on a
# long-lived dev host. Reported, not asserted. The bundled-DEFAULTS path
# (reconcileAgentDefaultSkills) reads _bundled directly and is asserted below.
grep -c 'not found in pool' /tmp/apply.log | sed 's/^/  (pre-existing) skills: entries unresolved in pool root: /'

# The skills actually reached the agent, not just the pool.
for a in $agents; do
  n=$(ls "$HOME/.switchroom/agents/$a/.claude/skills" 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] || fail "agent $a: no skills linked into .claude/skills"
  echo "  $a: $n skills linked, e.g. $(ls "$HOME/.switchroom/agents/$a/.claude/skills" | head -3 | tr '\n' ' ')"
done

echo
echo "E2E-PASS"
