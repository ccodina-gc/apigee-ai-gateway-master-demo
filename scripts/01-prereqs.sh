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
# Step 1 - Prerequisites
#   * Enables the required Google Cloud APIs
#   * Service account used by the Apigee proxies (+ IAM roles)
#   * Service account used by the Cloud Run portal (+ IAM roles)
#   * Model Armor template used by the Model Armor and Gateway proxies
# ---------------------------------------------------------------------------
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_env
require_cmds gcloud jq curl
get_token

log "Enabling APIs"
gcloud services enable apigee.googleapis.com aiplatform.googleapis.com modelarmor.googleapis.com \
  bigquery.googleapis.com logging.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com apihub.googleapis.com iam.googleapis.com \
  --project "${PROJECT_ID}" </dev/null
gcloud services enable anthropic-915.cloudpartnerservices.goog --project "${PROJECT_ID}" </dev/null 2>/dev/null || true
ok "APIs enabled"

# --- Proxy service account ---------------------------------------------------------
ensure_sa "${PROXY_SA_NAME}" "Apigee AI Gateway demo - proxies"
for role in \
  roles/aiplatform.user \
  roles/modelarmor.user \
  roles/modelarmor.viewer \
  roles/logging.logWriter \
  roles/bigquery.jobUser \
  roles/bigquery.dataViewer \
  roles/mcp.toolUser; do
  grant_project_role "serviceAccount:${PROXY_SA}" "${role}"
done

# --- Portal service account --------------------------------------------------------
ensure_sa "${PORTAL_SA_NAME}" "Apigee AI Gateway demo - portal (Cloud Run)"
grant_project_role "serviceAccount:${PORTAL_SA}" roles/logging.viewer

# --- MCP Discovery Proxy service account ----------------------------------------------
# The MCP quickstart deploys the MCP Discovery Proxy with a service account that has
# roles/apigee.admin (used by the managed MCP server provisioning). It is only used by
# aigw-mcp-retail, which calls no Google APIs.
ensure_sa "${MCP_SA_NAME}" "Apigee AI Gateway demo - MCP Discovery Proxy"
grant_project_role "serviceAccount:${MCP_SA}" roles/apigee.admin

# --- Portal build service account ------------------------------------------------------
# gcloud run deploy --source builds with this SA (the default compute SA may lack access).
ensure_sa "${BUILD_SA_NAME}" "Apigee AI Gateway demo - portal build"
grant_project_role "serviceAccount:${BUILD_SA}" roles/run.builder

# --- Model Armor template -----------------------------------------------------------
MA_API="https://modelarmor.${MODEL_ARMOR_LOCATION}.rep.googleapis.com/v1/projects/${PROJECT_ID}/locations/${MODEL_ARMOR_LOCATION}/templates"
TEMPLATE_BODY=$(cat <<'EOF'
{
  "filterConfig": {
    "raiSettings": {
      "raiFilters": [
        { "filterType": "HATE_SPEECH",       "confidenceLevel": "MEDIUM_AND_ABOVE" },
        { "filterType": "HARASSMENT",        "confidenceLevel": "MEDIUM_AND_ABOVE" },
        { "filterType": "SEXUALLY_EXPLICIT", "confidenceLevel": "MEDIUM_AND_ABOVE" },
        { "filterType": "DANGEROUS",         "confidenceLevel": "MEDIUM_AND_ABOVE" }
      ]
    },
    "piAndJailbreakFilterSettings": { "filterEnforcement": "ENABLED", "confidenceLevel": "LOW_AND_ABOVE" },
    "maliciousUriFilterSettings":   { "filterEnforcement": "ENABLED" },
    "sdpSettings": { "basicConfig": { "filterEnforcement": "ENABLED" } }
  },
  "templateMetadata": {
    "logSanitizeOperations": true,
    "multiLanguageDetection": { "enableMultiLanguageDetection": true }
  }
}
EOF
)

api GET "${MA_API}/${MODEL_ARMOR_TEMPLATE}" >/dev/null
if is_2xx; then
  log "Updating Model Armor template ${MODEL_ARMOR_TEMPLATE}"
  api PATCH "${MA_API}/${MODEL_ARMOR_TEMPLATE}?updateMask=filterConfig,templateMetadata" "${TEMPLATE_BODY}" >/dev/null
else
  log "Creating Model Armor template ${MODEL_ARMOR_TEMPLATE} (${MODEL_ARMOR_LOCATION})"
  api POST "${MA_API}?templateId=${MODEL_ARMOR_TEMPLATE}" "${TEMPLATE_BODY}" >/dev/null
fi
is_2xx && ok "Model Armor template projects/${PROJECT_ID}/locations/${MODEL_ARMOR_LOCATION}/templates/${MODEL_ARMOR_TEMPLATE}" \
  || die "Model Armor template failed (${HTTP_CODE})"
