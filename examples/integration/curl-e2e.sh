#!/usr/bin/env sh
# Read-only end-to-end API smoke example. Requires curl and optionally jq.
set -eu

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
API_BASE_URL="${API_BASE_URL%/}"
AUTH_HEADER=""
if [ -n "${API_KEY:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${API_KEY}"
fi

get() {
  if [ -n "$AUTH_HEADER" ]; then
    curl --fail --silent --show-error -H "$AUTH_HEADER" "$API_BASE_URL$1"
  else
    curl --fail --silent --show-error "$API_BASE_URL$1"
  fi
}

echo '== health =='
get '/api/v1/health'
echo '\n== active network =='
get '/api/v1/network'
echo '\n== recent events =='
get '/api/v1/events?limit=5'

if [ -n "${CONTRACT_ID:-}" ]; then
  echo '\n== contract =='
  get "/api/v1/contracts/${CONTRACT_ID}"
fi
