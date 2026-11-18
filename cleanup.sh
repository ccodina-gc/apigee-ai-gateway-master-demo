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
# Removes EVERYTHING created by deploy-all.sh (only aigw-* resources):
#   Cloud Run portal, Apigee apps/developer/products/proxies, Vector Search
#   (deployed index, endpoint, index), Model Armor template, service accounts.
# Other proxies / products in the Apigee org are not touched.
# Usage: source ./env.sh && ./cleanup.sh [--yes]
# ---------------------------------------------------------------------------
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
source "${DIR}/scripts/lib.sh"
load_env
require_cmds gcloud jq curl
get_token

if [ "${1:-}" != "--yes" ]; then
  echo "This deletes all the aigw-* demo resources in project ${PROJECT_ID} (Apigee env ${APIGEE_ENV})."
  read -r -p "Continue? [y/N] " answer
  case "${answer}" in y|Y|yes|YES) ;; *) echo "Cancelled"; exit 0 ;; esac
fi

ORG="${APIGEE_API}/${PROJECT_ID}"
DEV_EMAIL="aigw-demo@example.com"
PROXIES="aigw-mcp-retail aigw-gateway aigw-sse-mcp-bigquery aigw-llm-routing aigw-circuit-breaker aigw-token-limits aigw-model-armor aigw-semantic-cache aigw-retail-api aigw-mock-llm"
PRODUCTS="aigw-demo aigw-tokens-bronze aigw-tokens-gold aigw-mcp-retail aigw-mcp-bigquery"

# --- Cloud Run portal ---------------------------------------------------------------
log "Cloud Run service ${PORTAL_SERVICE}"
gcloud run services delete "${PORTAL_SERVICE}" --region "${PORTAL_REGION}" --project "${PROJECT_ID}" \
  --quiet </dev/null >/dev/null 2>&1 && ok "Deleted" || warn "Not found / already deleted"

# --- Apigee: apps, developer, products ----------------------------------------------
for app in aigw-portal-app aigw-gold-app; do
  api DELETE "${ORG}/developers/${DEV_EMAIL}/apps/${app}" >/dev/null
  is_2xx && ok "App ${app} deleted" || warn "App ${app} not found (${HTTP_CODE})"
done
api DELETE "${ORG}/developers/${DEV_EMAIL}" >/dev/null
is_2xx && ok "Developer ${DEV_EMAIL} deleted" || warn "Developer not found (${HTTP_CODE})"
for p in ${PRODUCTS}; do
  api DELETE "${ORG}/apiproducts/${p}" >/dev/null
  is_2xx && ok "Product ${p} deleted" || warn "Product ${p} not found (${HTTP_CODE})"
done

# --- Apigee: proxies (undeploy every revision, then delete) -------------------------
for p in ${PROXIES}; do
  deps=$(api GET "${ORG}/environments/${APIGEE_ENV}/apis/${p}/deployments")
  for rev in $(echo "${deps}" | jq -r '.deployments[]?.revision' 2>/dev/null); do
    api DELETE "${ORG}/environments/${APIGEE_ENV}/apis/${p}/revisions/${rev}/deployments" >/dev/null
    is_2xx && ok "Undeployed ${p} rev ${rev}" || warn "Could not undeploy ${p} rev ${rev} (${HTTP_CODE})"
  done
done
sleep 10
for p in ${PROXIES}; do
  for i in 1 2 3 4 5 6; do
    api DELETE "${ORG}/apis/${p}" >/dev/null
    if is_2xx; then ok "Proxy ${p} deleted"; break; fi
    if [ "${HTTP_CODE}" = "404" ]; then warn "Proxy ${p} not found"; break; fi
    sleep 10   # still undeploying
  done
done

api DELETE "${ORG}/environments/${APIGEE_ENV}/keyvaluemaps/${ROUTING_KVM_NAME}" >/dev/null
is_2xx && ok "KVM ${ROUTING_KVM_NAME} deleted" || warn "KVM ${ROUTING_KVM_NAME} not found (${HTTP_CODE})"

# --- Vector Search (semantic cache) --------------------------------------------------
if [ -f "${BUILD_DIR}/vector-search.env" ]; then
  # shellcheck source=/dev/null
  source "${BUILD_DIR}/vector-search.env"
fi
AIP="https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}"
EP_ID="${VS_INDEX_ENDPOINT_ID:-$(api GET "${AIP}/indexEndpoints" | jq -r --arg n "${VS_ENDPOINT_NAME}" '.indexEndpoints[]? | select(.displayName==$n) | .name | split("/") | last' | head -1)}"
IDX_ID="${VS_INDEX_ID:-$(api GET "${AIP}/indexes" | jq -r --arg n "${VS_INDEX_NAME}" '.indexes[]? | select(.displayName==$n) | .name | split("/") | last' | head -1)}"
if [ -n "${EP_ID}" ]; then
  log "Undeploying index ${VS_DEPLOYED_INDEX_ID} (a few minutes)"
  gcloud ai index-endpoints undeploy-index "${EP_ID}" --deployed-index-id="${VS_DEPLOYED_INDEX_ID}" \
    --region="${REGION}" --project="${PROJECT_ID}" </dev/null >/dev/null 2>&1 && ok "Undeployed" || warn "Index was not deployed"
  gcloud ai index-endpoints delete "${EP_ID}" --region="${REGION}" --project="${PROJECT_ID}" --quiet \
    </dev/null >/dev/null 2>&1 && ok "Index endpoint ${EP_ID} deleted" || warn "Could not delete endpoint ${EP_ID}"
fi
if [ -n "${IDX_ID}" ]; then
  gcloud ai indexes delete "${IDX_ID}" --region="${REGION}" --project="${PROJECT_ID}" --quiet \
    </dev/null >/dev/null 2>&1 && ok "Index ${IDX_ID} deleted" || warn "Could not delete index ${IDX_ID}"
fi

# --- Model Armor template --------------------------------------------------------------
MA_API="https://modelarmor.${MODEL_ARMOR_LOCATION}.rep.googleapis.com/v1/projects/${PROJECT_ID}/locations/${MODEL_ARMOR_LOCATION}/templates"
api DELETE "${MA_API}/${MODEL_ARMOR_TEMPLATE}" >/dev/null
is_2xx && ok "Model Armor template ${MODEL_ARMOR_TEMPLATE} deleted" || warn "Template not found (${HTTP_CODE})"

# --- Service accounts (remove project bindings first) --------------------------------
for sa in "${PROXY_SA}" "${PORTAL_SA}" "${MCP_SA}" "${BUILD_SA}"; do
  for role in $(gcloud projects get-iam-policy "${PROJECT_ID}" --flatten="bindings[].members" \
      --filter="bindings.members:serviceAccount:${sa}" --format="value(bindings.role)" </dev/null 2>/dev/null); do
    gcloud projects remove-iam-policy-binding "${PROJECT_ID}" --member "serviceAccount:${sa}" --role "${role}" \
      --condition=None --quiet </dev/null >/dev/null 2>&1 || true
  done
  gcloud iam service-accounts delete "${sa}" --project "${PROJECT_ID}" --quiet </dev/null >/dev/null 2>&1 \
    && ok "Service account ${sa} deleted" || warn "Service account ${sa} not found"
done

rm -rf "${BUILD_DIR}"
ok "Cleanup finished"
