#!/usr/bin/env bash
# Staging probe: does the restore RPC exist on the Supabase project?
# Prints one of: RPC_MISSING (404) | RPC_PRESENT (4xx = exists, bad args/auth) | HTTP_<code>
set -u
cd "$(dirname "$0")/.."
KEY=$(grep -o 'VITE_SUPABASE_ANON_KEY=.*' .env | head -1 | cut -d= -f2 | tr -d '\r')
URL=$(grep -o 'VITE_SUPABASE_URL=.*' .env | head -1 | cut -d= -f2 | tr -d '\r')
CODE=$(curl -s -o /tmp/rpc_probe.json -w '%{http_code}' -X POST \
  "$URL/rest/v1/rpc/restore_workspace_backup" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{}' --max-time 20)
echo "HTTP_CODE=$CODE"
if [ "$CODE" = "404" ]; then
  echo "RPC_MISSING"
else
  echo "RPC_PRESENT (or auth/arg error — function resolved)"
  cat /tmp/rpc_probe.json
fi
