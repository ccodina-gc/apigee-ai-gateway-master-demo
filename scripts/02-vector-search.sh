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
# Step 2 - Vertex AI Vector Search for the semantic cache.
#   * Index (768 dims, dot product, brute force, streaming updates)
#   * Public index endpoint
#   * Deployed index (smallest machine). The first deployment takes ~20-30 min,
#     so this step starts it and returns; run with "--wait" to block until ready.
# Writes .build/vector-search.env (consumed by step 3).
# ---------------------------------------------------------------------------
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_env
require_cmds gcloud jq curl
get_token
mkdir -p "${BUILD_DIR}"

WAIT="false"
[ "${1:-}" = "--wait" ] && WAIT="true"

AIP="https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}"

find_index_id() {
  api GET "${AIP}/indexes" | jq -r --arg n "${VS_INDEX_NAME}" \
    '.indexes[]? | select(.displayName==$n) | .name | split("/") | last' | head -1
}
find_endpoint_json() {
  api GET "${AIP}/indexEndpoints" | jq -c --arg n "${VS_ENDPOINT_NAME}" \
    '.indexEndpoints[]? | select(.displayName==$n)' | head -1
}

# 1. Index -------------------------------------------------------------------
INDEX_ID="$(find_index_id)"
if [ -z "${INDEX_ID}" ]; then
  log "Creating Vector Search index ${VS_INDEX_NAME} (${EMBEDDINGS_DIMENSIONS} dims)"
  BODY=$(jq -n --arg n "${VS_INDEX_NAME}" --argjson d "${EMBEDDINGS_DIMENSIONS}" '{
    displayName: $n,
    description: "Apigee AI Gateway demo - semantic cache",
    metadata: { config: {
      dimensions: $d,
      approximateNeighborsCount: 10,
      distanceMeasureType: "DOT_PRODUCT_DISTANCE",
      featureNormType: "NONE",
      algorithmConfig: { bruteForceConfig: {} },
      shardSize: "SHARD_SIZE_SMALL"
    }},
    indexUpdateMethod: "STREAM_UPDATE"
  }')
  api POST "${AIP}/indexes" "${BODY}" >/dev/null
  is_2xx || die "Index creation failed (${HTTP_CODE})"
  for i in $(seq 1 60); do
    INDEX_ID="$(find_index_id)"; [ -n "${INDEX_ID}" ] && break; sleep 10
  done
  [ -n "${INDEX_ID}" ] || die "Index not visible yet; re-run this step in a few minutes."
fi
ok "Index ${VS_INDEX_NAME} = ${INDEX_ID}"

# 2. Public endpoint ------------------------------------------------------------
EP_JSON="$(find_endpoint_json)"
if [ -z "${EP_JSON}" ]; then
  log "Creating public index endpoint ${VS_ENDPOINT_NAME} (a few minutes)"
  gcloud ai index-endpoints create --display-name="${VS_ENDPOINT_NAME}" \
    --public-endpoint-enabled --region="${REGION}" --project="${PROJECT_ID}" </dev/null
  EP_JSON="$(find_endpoint_json)"
fi
ENDPOINT_ID=$(echo "${EP_JSON}" | jq -r '.name | split("/") | last')
PUBLIC_DOMAIN=$(echo "${EP_JSON}" | jq -r '.publicEndpointDomainName // empty')
[ -n "${ENDPOINT_ID}" ] || die "Index endpoint not found"
ok "Endpoint ${VS_ENDPOINT_NAME} = ${ENDPOINT_ID} (${PUBLIC_DOMAIN})"

# 3. Deploy the index -------------------------------------------------------------
DEPLOYED=$(echo "${EP_JSON}" | jq -r --arg d "${VS_DEPLOYED_INDEX_ID}" '.deployedIndexes[]? | select(.id==$d) | .id')
if [ -z "${DEPLOYED}" ]; then
  log "Deploying index to the endpoint (${VS_MACHINE_TYPE}); this takes ~20-30 minutes"
  gcloud ai index-endpoints deploy-index "${ENDPOINT_ID}" \
    --deployed-index-id="${VS_DEPLOYED_INDEX_ID}" --display-name="${VS_DEPLOYED_INDEX_ID}" \
    --index="${INDEX_ID}" --machine-type="${VS_MACHINE_TYPE}" \
    --min-replica-count=1 --max-replica-count=1 \
    --region="${REGION}" --project="${PROJECT_ID}" </dev/null 2>&1 | tail -3 || true
else
  ok "Index already deployed as ${VS_DEPLOYED_INDEX_ID}"
fi

cat >"${BUILD_DIR}/vector-search.env" <<EOF
export VS_INDEX_ID="${INDEX_ID}"
export VS_INDEX_ENDPOINT_ID="${ENDPOINT_ID}"
export VS_PUBLIC_DOMAIN="${PUBLIC_DOMAIN}"
EOF
ok "Saved ${BUILD_DIR}/vector-search.env"

# 4. Optional wait ----------------------------------------------------------------
if [ "${WAIT}" = "true" ]; then
  log "Waiting for the deployed index to be ready"
  for i in $(seq 1 120); do
    STATE=$(api GET "${AIP}/indexEndpoints/${ENDPOINT_ID}" | jq -r --arg d "${VS_DEPLOYED_INDEX_ID}" \
      '[.deployedIndexes[]? | select(.id==$d)] | length')
    if [ "${STATE}" = "1" ]; then ok "Deployed index ready"; exit 0; fi
    sleep 30
  done
  warn "Deployed index not ready yet"
fi
