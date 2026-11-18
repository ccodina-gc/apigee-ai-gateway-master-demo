#!/bin/bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# ---------------------------------------------------------------------------
# Step 3 - Apigee artifacts
#   * 10 API proxies (deployed with the proxy service account)
#   * API products (REST, AI Products Bronze/Gold, MCP tool products)
#   * Developer + 2 apps (portal = Bronze, gold = Gold)
# Writes .build/credentials.env (API keys used by the portal).
# Usage: 03-apigee.sh                 everything
#        03-apigee.sh proxy-name ...  only these proxies
#        03-apigee.sh --products      only products, developer and apps
# ---------------------------------------------------------------------------
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_env
require_cmds gcloud jq curl zip python3
get_token
mkdir -p "${BUILD_DIR}"

if [ -f "${BUILD_DIR}/vector-search.env" ]; then
  # shellcheck source=/dev/null
  source "${BUILD_DIR}/vector-search.env"
else
  warn "No .build/vector-search.env found: run scripts/02-vector-search.sh first (semantic cache will not work)."
fi

# Regenerate bundles from the generator (keeps shared policies in sync).
python3 "${ROOT_DIR}/apigee/generate_proxies.py" >/dev/null

ALL_PROXIES="aigw-mock-llm aigw-retail-api aigw-semantic-cache aigw-model-armor aigw-token-limits aigw-circuit-breaker aigw-llm-routing aigw-sse-mcp-bigquery aigw-gateway aigw-mcp-retail"
if [ "${1:-}" = "--products" ]; then
  PROXIES=""      # products, developer and apps only
  shift
else
  PROXIES="${*:-${ALL_PROXIES}}"
fi

for p in ${PROXIES}; do
  if [ "${p}" = "aigw-llm-routing" ]; then
    upsert_routing_kvm
  fi
  deploy_proxy "${p}"
done

# Products, developer and apps only on a full run (or with --products).
if [ $# -gt 0 ]; then
  ok "Done (proxies only)"
  exit 0
fi

log "API products"
for f in "${ROOT_DIR}"/apigee/products/*.json; do
  upsert_product "${f}"
done

DEV_EMAIL="aigw-demo@example.com"
api GET "${APIGEE_API}/${PROJECT_ID}/developers/${DEV_EMAIL}" >/dev/null
if ! is_2xx; then
  api POST "${APIGEE_API}/${PROJECT_ID}/developers" \
    "{\"email\":\"${DEV_EMAIL}\",\"firstName\":\"AI Gateway\",\"lastName\":\"Demo\",\"userName\":\"aigw-demo\"}" >/dev/null
  is_2xx || die "Developer creation failed (${HTTP_CODE})"
fi
ok "Developer ${DEV_EMAIL}"

# ensure_app NAME "product1 product2 ..." -> echoes the consumer key
ensure_app() {
  local app="$1" products="$2" prods_json resp key
  prods_json=$(printf '%s\n' ${products} | jq -R . | jq -sc .)
  resp=$(api GET "${APIGEE_API}/${PROJECT_ID}/developers/${DEV_EMAIL}/apps/${app}")
  if ! is_2xx; then
    resp=$(api POST "${APIGEE_API}/${PROJECT_ID}/developers/${DEV_EMAIL}/apps" \
      "{\"name\":\"${app}\",\"apiProducts\":${prods_json},\"attributes\":[{\"name\":\"DisplayName\",\"value\":\"${app}\"}]}")
    is_2xx || die "App ${app} creation failed (${HTTP_CODE}): ${resp}"
  fi
  key=$(echo "${resp}" | jq -r '.credentials[0].consumerKey')
  # Make sure the credential has every product (idempotent re-runs).
  api POST "${APIGEE_API}/${PROJECT_ID}/developers/${DEV_EMAIL}/apps/${app}/keys/${key}" \
    "{\"apiProducts\":${prods_json}}" >/dev/null || true
  echo "${key}"
}

DEMO_API_KEY=$(ensure_app "aigw-portal-app" "aigw-demo aigw-tokens-bronze aigw-mcp-retail aigw-mcp-bigquery")
ok "App aigw-portal-app (Bronze)"
GOLD_API_KEY=$(ensure_app "aigw-gold-app" "aigw-tokens-gold")
ok "App aigw-gold-app (Gold)"

cat >"${BUILD_DIR}/credentials.env" <<EOF
export DEMO_API_KEY="${DEMO_API_KEY}"
export GOLD_API_KEY="${GOLD_API_KEY}"
EOF
chmod 600 "${BUILD_DIR}/credentials.env"
ok "API keys saved in ${BUILD_DIR}/credentials.env"
