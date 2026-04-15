#!/usr/bin/env bash
# ms-graph-token.sh — refresh a Microsoft Graph OAuth access token.
#
# Reads a refresh token and client_id (plus an optional client_secret
# for confidential clients) from the Switchroom vault, POSTs to the
# Microsoft v2.0 token endpoint against the `common` tenant, writes
# the new access token back to the vault, and prints it to stdout.
#
# See skills/token-helpers/SKILL.md for env var overrides.

set -euo pipefail

REFRESH_KEY="${MS_GRAPH_REFRESH_TOKEN_KEY:-ms-graph-refresh-token}"
ACCESS_KEY="${MS_GRAPH_ACCESS_TOKEN_KEY:-ms-graph-access-token}"
CLIENT_ID_KEY="${MS_GRAPH_CLIENT_ID_KEY:-ms-graph-client-id}"
CLIENT_SECRET_KEY="${MS_GRAPH_CLIENT_SECRET_KEY:-ms-graph-client-secret}"
SCOPE="${MS_GRAPH_SCOPE:-https://graph.microsoft.com/.default offline_access}"
TOKEN_URL="${MS_OAUTH_TOKEN_URL:-https://login.microsoftonline.com/common/oauth2/v2.0/token}"
SWITCHROOM_CLI="${SWITCHROOM_CLI:-switchroom}"

vault_get() {
  $SWITCHROOM_CLI vault get "$1"
}

vault_get_optional() {
  $SWITCHROOM_CLI vault get "$1" 2>/dev/null || true
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
client_secret=$(vault_get_optional "$CLIENT_SECRET_KEY")

curl_args=(
  -sS -X POST "$TOKEN_URL"
  -H "Content-Type: application/x-www-form-urlencoded"
  --data-urlencode "client_id=$client_id"
  --data-urlencode "refresh_token=$refresh_token"
  --data-urlencode "grant_type=refresh_token"
  --data-urlencode "scope=$SCOPE"
)
if [ -n "$client_secret" ]; then
  curl_args+=(--data-urlencode "client_secret=$client_secret")
fi

response=$(curl "${curl_args[@]}") || {
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
