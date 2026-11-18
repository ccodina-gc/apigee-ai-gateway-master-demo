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
# Cost saver for the semantic cache: the deployed Vector Search index is the only
# component billed per hour while idle.
#   status : show whether the index is deployed
#   pause  : undeploy the index (semantic cache stops; everything else keeps working)
#   resume : deploy it again (~20-30 min)
# ---------------------------------------------------------------------------
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_env
require_cmds gcloud jq curl
get_token

[ -f "${BUILD_DIR}/vector-search.env" ] || die "Run scripts/02-vector-search.sh first"
# shellcheck source=/dev/null
source "${BUILD_DIR}/vector-search.env"
AIP="https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}"

deployed() {
  api GET "${AIP}/indexEndpoints/${VS_INDEX_ENDPOINT_ID}" | jq -r --arg d "${VS_DEPLOYED_INDEX_ID}" \
    '[.deployedIndexes[]? | select(.id==$d)] | length'
}

case "${1:-status}" in
  status)
    if [ "$(deployed)" = "1" ]; then ok "Index deployed (${VS_DEPLOYED_INDEX_ID}) - semantic cache ON"; else warn "Index not deployed - semantic cache OFF"; fi
    ;;
  pause)
    log "Undeploying ${VS_DEPLOYED_INDEX_ID} from endpoint ${VS_INDEX_ENDPOINT_ID}"
    gcloud ai index-endpoints undeploy-index "${VS_INDEX_ENDPOINT_ID}" --deployed-index-id="${VS_DEPLOYED_INDEX_ID}" \
      --region="${REGION}" --project="${PROJECT_ID}" </dev/null
    ok "Paused"
    ;;
  resume)
    "$(dirname "$0")/02-vector-search.sh"
    ;;
  *)
    die "Usage: $0 status|pause|resume"
    ;;
esac
