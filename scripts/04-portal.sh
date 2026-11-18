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
# Step 4 - Demo portal on Cloud Run (built from ./frontend with Cloud Build).
# Uses the API keys created in step 3 (.build/credentials.env).
# Access: public URL (--no-invoker-iam-check, works with Domain Restricted Sharing)
# protected with Basic Auth (any user + passcode). PORTAL_PASSCODE in env.sh:
#   auto (default) = generated once and saved in .build/portal-passcode.txt
#   off            = no passcode (anyone with the URL can spend LLM tokens!)
#   <value>        = that passcode
# ---------------------------------------------------------------------------
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_env
require_cmds gcloud python3

[ -f "${BUILD_DIR}/credentials.env" ] || die "Missing ${BUILD_DIR}/credentials.env - run scripts/03-apigee.sh first"
# shellcheck source=/dev/null
source "${BUILD_DIR}/credentials.env"

PASSFILE="${BUILD_DIR}/portal-passcode.txt"
case "${PORTAL_PASSCODE:-auto}" in
  auto)
    if [ ! -s "${PASSFILE}" ]; then
      python3 -c 'import secrets,string; a=string.ascii_lowercase+string.digits; print("aigw-" + "".join(secrets.choice(a) for _ in range(8)))' >"${PASSFILE}"
      chmod 600 "${PASSFILE}"
    fi
    PASSCODE="$(cat "${PASSFILE}")" ;;
  off|none) PASSCODE="" ;;
  *) PASSCODE="${PORTAL_PASSCODE}" ;;
esac

ENV_VARS="APIGEE_HOST=${APIGEE_HOST},APIGEE_ENV=${APIGEE_ENV},PROJECT_ID=${PROJECT_ID},REGION=${REGION}"
ENV_VARS="${ENV_VARS},DEFAULT_MODEL=${MODEL_LITE},LOG_NAME=${LOG_NAME}"
ENV_VARS="${ENV_VARS},DEMO_API_KEY=${DEMO_API_KEY},GOLD_API_KEY=${GOLD_API_KEY}"
ENV_VARS="${ENV_VARS},PORTAL_PASSCODE=${PASSCODE}"

log "Deploying Cloud Run service ${PORTAL_SERVICE} (${PORTAL_REGION}) from ./frontend"
gcloud run deploy "${PORTAL_SERVICE}" \
  --source "${ROOT_DIR}/frontend" \
  --region "${PORTAL_REGION}" \
  --project "${PROJECT_ID}" \
  --service-account "${PORTAL_SA}" \
  --build-service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --set-env-vars "${ENV_VARS}" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 3 --timeout 300 \
  --no-invoker-iam-check \
  --quiet </dev/null

URL=$(gcloud run services describe "${PORTAL_SERVICE}" --region "${PORTAL_REGION}" \
  --project "${PROJECT_ID}" --format='value(status.url)' </dev/null)
ok "Portal: ${URL}"
if [ -n "${PASSCODE}" ]; then ok "Passcode: ${PASSCODE} (any user name)"; fi
echo "${URL}" >"${BUILD_DIR}/portal-url.txt"
