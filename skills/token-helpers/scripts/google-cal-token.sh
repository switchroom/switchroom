#!/usr/bin/env bash
# google-cal-token.sh — refresh a Google Calendar OAuth access token.
#
# Reads a refresh token, client_id, and client_secret from the
# Switchroom vault; POSTs to Google's OAuth endpoint; writes the new
# access token back to the vault; prints the access token to stdout.
#
# See skills/token-helpers/SKILL.md for env var overrides.

set -euo pipefail

REFRESH_KEY="${GOOGLE_CAL_REFRESH_TOKEN_KEY:-google-cal-refresh-token}"
ACCESS_KEY="${GOOGLE_CAL_ACCESS_TOKEN_KEY:-google-cal-access-token}"
CLIENT_ID_KEY="${GOOGLE_CAL_CLIENT_ID_KEY:-google-cal-client-id}"
CLIENT_SECRET_KEY="${GOOGLE_CAL_CLIENT_SECRET_KEY:-google-cal-client-secret}"
TOKEN_URL="${GOOGLE_OAUTH_TOKEN_URL:-https://oauth2.googleapis.com/token}"
SWITCHROOM_CLI="${SWITCHROOM_CLI:-switchroom}"

vault_get() {
  $SWITCHROOM_CLI vault get "$1"
}

vault_set() {
  local key="$1"
  $SWITCHROOM_CLI vault set "$key"
}

refresh_token=$(vault_get "$REFRESH_KEY") || {
  echo "ERROR: could not read vault key '$REFRESH_KEY'" >&2
  exit 1
}
client_id=$(vault_get "$CLIENT_ID_KEY") || {
  echo "ERROR: could not read vault key '$CLIENT_ID_KEY'" >&2
  exit 1
}
client_secret=$(vault_get "$CLIENT_SECRET_KEY") || {
  echo "ERROR: could not read vault key '$CLIENT_SECRET_KEY'" >&2
  exit 1
}

response=$(
  curl -sS -X POST "$TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "client_id=$client_id" \
    --data-urlencode "client_secret=$client_secret" \
    --data-urlencode "refresh_token=$refresh_token" \
    --data-urlencode "grant_type=refresh_token"
) || {
  echo "ERROR: OAuth POST to $TOKEN_URL failed" >&2
  exit 1
}

access_token=$(printf '%s' "$response" | jq -r '.access_token // empty')

if [ -z "$access_token" ]; then
  echo "ERROR: OAuth response did not include an access_token" >&2
  echo "Response: $response" >&2
  exit 1
fi

printf '%s' "$access_token" | vault_set "$ACCESS_KEY" >/dev/null
printf '%s\n' "$access_token"
