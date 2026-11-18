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
# Apigee AI Gateway demo - full deployment
#   1. APIs, service accounts, IAM, Model Armor template
#   2. Vector Search (semantic cache) - first deployment takes ~20-30 min
#   3. Apigee proxies, API products, developer apps
#   4. Demo portal on Cloud Run
# Usage: source ./env.sh && ./deploy-all.sh
# ---------------------------------------------------------------------------
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=/dev/null
source "${DIR}/env.sh"

"${DIR}/scripts/01-prereqs.sh"
"${DIR}/scripts/02-vector-search.sh"
"${DIR}/scripts/03-apigee.sh"
"${DIR}/scripts/04-portal.sh"

echo ""
echo "=================================================================="
echo " Apigee AI Gateway demo deployed"
echo "=================================================================="
echo " Portal:      $(cat "${DIR}/.build/portal-url.txt" 2>/dev/null || echo '(see step 4 output)')"
echo " Passcode:    $(cat "${DIR}/.build/portal-passcode.txt" 2>/dev/null || echo '(PORTAL_PASSCODE in env.sh)') (any user name)"
echo " Apigee host: https://${APIGEE_HOST}"
echo " API keys:    ${DIR}/.build/credentials.env"
echo ""
echo " The semantic cache works once the Vector Search index finishes deploying"
echo " (check with: ./scripts/semantic-cache-index.sh status)."
