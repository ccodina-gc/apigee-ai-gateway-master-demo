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
# Step 5 (Optional) - Internal Google (*.corp.google.com) deployment:
#   1. Deploys ./frontend to an internal google.com GCP project (CORP_PROJECT_ID)
#      with Cloud Run IAM check ON (no public allUsers access, no Basic Auth passcode)
#      and grants roles/run.invoker to CORP_ALLOWED_MEMBER (default: domain:google.com).
#   2. Locks down the Argolis Cloud Run service (macro-project-512518) with
#      INTERNAL_RELAY_TOKEN so its public *.run.app URL stops serving the UI/invoke
#      and only relays Cloud Logging entries to the internal corp portal.
#
# Usage:
#   CORP_PROJECT_ID="<your-google.com-project>" ./scripts/05-corp-portal.sh
#
# To restore public/passcode standalone access on Argolis later:
#   ./scripts/04-portal.sh
# ---------------------------------------------------------------------------
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_env
require_cmds gcloud python3

[ -n "${CORP_PROJECT_ID:-}" ] || die "Set CORP_PROJECT_ID to an internal google.com GCP project (e.g. CORP_PROJECT_ID=my-goog-proj ./scripts/05-corp-portal.sh)"
if [ "${CORP_PROJECT_ID}" = "${PROJECT_ID}" ]; then
  die "CORP_PROJECT_ID (${CORP_PROJECT_ID}) must be an internal google.com GCP project, not the Argolis project (${PROJECT_ID})"
fi

[ -f "${BUILD_DIR}/credentials.env" ] || die "Missing ${BUILD_DIR}/credentials.env - run scripts/03-apigee.sh first"
# shellcheck source=/dev/null
source "${BUILD_DIR}/credentials.env"

# Detect Argolis (@*.altostrat.com) and Corp (@google.com) accounts in gcloud auth list
ALL_ACCOUNTS="$(gcloud auth list --format='value(account)' </dev/null 2>/dev/null || true)"
if [ -z "${ARGOLIS_ACCOUNT:-}" ]; then
  ARGOLIS_ACCOUNT="$(printf '%s\n' "${ALL_ACCOUNTS}" | grep -E '@.*\.altostrat\.com$' | head -n 1 || true)"
  [ -n "${ARGOLIS_ACCOUNT}" ] || ARGOLIS_ACCOUNT="$(gcloud config get-value account </dev/null 2>/dev/null || true)"
fi
if [ -z "${CORP_ACCOUNT:-}" ]; then
  CORP_ACCOUNT="$(printf '%s\n' "${ALL_ACCOUNTS}" | grep -E '@google\.com$' | head -n 1 || true)"
fi

[ -n "${ARGOLIS_ACCOUNT}" ] || die "Could not detect Argolis gcloud account. Set ARGOLIS_ACCOUNT=admin@..."
[ -n "${CORP_ACCOUNT}" ] || die "No @google.com account found in gcloud. Run first: gcloud auth login <tu-usuario>@google.com --no-activate"

log "Argolis project : ${PROJECT_ID} (account: ${ARGOLIS_ACCOUNT})"
log "Corp project    : ${CORP_PROJECT_ID} (account: ${CORP_ACCOUNT})"

# 1. Discover Argolis Cloud Run URL (used as authenticated Cloud Logging relay)
ARGOLIS_RUN_URL="$(gcloud run services describe "${PORTAL_SERVICE}" \
  --region "${PORTAL_REGION}" --project "${PROJECT_ID}" --account "${ARGOLIS_ACCOUNT}" \
  --format='value(status.url)' </dev/null 2>/dev/null || true)"
[ -n "${ARGOLIS_RUN_URL}" ] || die "Argolis service ${PORTAL_SERVICE} not found in ${PROJECT_ID}. Run ./scripts/04-portal.sh once first."

RELAY_TOKEN_FILE="${BUILD_DIR}/logs-relay-token.txt"
if [ ! -s "${RELAY_TOKEN_FILE}" ]; then
  python3 -c 'import secrets; print(secrets.token_hex(32))' >"${RELAY_TOKEN_FILE}"
  chmod 600 "${RELAY_TOKEN_FILE}"
fi
RELAY_TOKEN="$(cat "${RELAY_TOKEN_FILE}")"

# 2. Enable Cloud Run & build APIs + minimal SAs in the internal google.com project
log "Enabling Cloud Run & Cloud Build APIs in ${CORP_PROJECT_ID}"
gcloud services enable \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com \
  --project "${CORP_PROJECT_ID}" --account "${CORP_ACCOUNT}" --quiet </dev/null

CORP_PORTAL_SA="${PORTAL_SA_NAME}@${CORP_PROJECT_ID}.iam.gserviceaccount.com"
CORP_BUILD_SA="${BUILD_SA_NAME:-aigw-build-sa}@${CORP_PROJECT_ID}.iam.gserviceaccount.com"

for pair in "${PORTAL_SA_NAME}:AI Gateway Corp Portal SA" "${BUILD_SA_NAME:-aigw-build-sa}:AI Gateway Corp Build SA"; do
  sa_name="${pair%%:*}"
  sa_disp="${pair#*:}"
  sa_email="${sa_name}@${CORP_PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${sa_email}" --project "${CORP_PROJECT_ID}" --account "${CORP_ACCOUNT}" </dev/null >/dev/null 2>&1; then
    ok "Service account ${sa_email} exists"
  else
    log "Creating service account ${sa_email}"
    gcloud iam service-accounts create "${sa_name}" --display-name "${sa_disp}" \
      --project "${CORP_PROJECT_ID}" --account "${CORP_ACCOUNT}" </dev/null >/dev/null
    sleep 8
  fi
done

gcloud projects add-iam-policy-binding "${CORP_PROJECT_ID}" \
  --member "serviceAccount:${CORP_BUILD_SA}" --role "roles/run.builder" \
  --condition=None --account "${CORP_ACCOUNT}" --quiet </dev/null >/dev/null

# 3. Deploy portal to the internal google.com project (IAM-protected, no passcode)
CORP_ENV_VARS="APIGEE_HOST=${APIGEE_HOST},APIGEE_ENV=${APIGEE_ENV},PROJECT_ID=${PROJECT_ID},REGION=${REGION}"
CORP_ENV_VARS="${CORP_ENV_VARS},DEFAULT_MODEL=${MODEL_LITE},LOG_NAME=${LOG_NAME}"
CORP_ENV_VARS="${CORP_ENV_VARS},DEMO_API_KEY=${DEMO_API_KEY},GOLD_API_KEY=${GOLD_API_KEY}"
CORP_ENV_VARS="${CORP_ENV_VARS},PORTAL_PASSCODE="
CORP_ENV_VARS="${CORP_ENV_VARS},LOGS_RELAY_URL=${ARGOLIS_RUN_URL},LOGS_RELAY_TOKEN=${RELAY_TOKEN}"

log "Deploying internal portal ${CORP_PORTAL_SERVICE} in ${CORP_PROJECT_ID} (${CORP_REGION})"
gcloud run deploy "${CORP_PORTAL_SERVICE}" \
  --source "${ROOT_DIR}/frontend" \
  --region "${CORP_REGION}" \
  --project "${CORP_PROJECT_ID}" \
  --account "${CORP_ACCOUNT}" \
  --service-account "${CORP_PORTAL_SA}" \
  --build-service-account "projects/${CORP_PROJECT_ID}/serviceAccounts/${CORP_BUILD_SA}" \
  --set-env-vars "${CORP_ENV_VARS}" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 3 --timeout 300 \
  --invoker-iam-check \
  --no-allow-unauthenticated \
  --quiet </dev/null

log "Granting roles/run.invoker on ${CORP_PORTAL_SERVICE} to ${CORP_ALLOWED_MEMBER}"
gcloud run services add-iam-policy-binding "${CORP_PORTAL_SERVICE}" \
  --region "${CORP_REGION}" \
  --project "${CORP_PROJECT_ID}" \
  --account "${CORP_ACCOUNT}" \
  --member "${CORP_ALLOWED_MEMBER}" \
  --role "roles/run.invoker" \
  --quiet </dev/null >/dev/null || warn "Could not bind ${CORP_ALLOWED_MEMBER} automatically; check IAM in Cloud Console"

CORP_RUN_URL="$(gcloud run services describe "${CORP_PORTAL_SERVICE}" \
  --region "${CORP_REGION}" --project "${CORP_PROJECT_ID}" --account "${CORP_ACCOUNT}" \
  --format='value(status.url)' </dev/null)"
echo "${CORP_RUN_URL}" >"${BUILD_DIR}/corp-portal-url.txt"

# 4. Redeploy/lock down Argolis Cloud Run so public internet cannot open UI or invoke proxies
log "Locking down public Argolis service ${PORTAL_SERVICE} (${PROJECT_ID}) to log-relay-only mode"
ARGOLIS_ENV_VARS="APIGEE_HOST=${APIGEE_HOST},APIGEE_ENV=${APIGEE_ENV},PROJECT_ID=${PROJECT_ID},REGION=${REGION}"
ARGOLIS_ENV_VARS="${ARGOLIS_ENV_VARS},DEFAULT_MODEL=${MODEL_LITE},LOG_NAME=${LOG_NAME}"
ARGOLIS_ENV_VARS="${ARGOLIS_ENV_VARS},PORTAL_PASSCODE=,INTERNAL_RELAY_TOKEN=${RELAY_TOKEN}"

gcloud run deploy "${PORTAL_SERVICE}" \
  --source "${ROOT_DIR}/frontend" \
  --region "${PORTAL_REGION}" \
  --project "${PROJECT_ID}" \
  --account "${ARGOLIS_ACCOUNT}" \
  --service-account "${PORTAL_SA}" \
  --build-service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA}" \
  --set-env-vars "${ARGOLIS_ENV_VARS}" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 3 --timeout 300 \
  --no-invoker-iam-check \
  --quiet </dev/null

ok "Internal Cloud Run service deployed: ${CORP_RUN_URL}"
ok "Public Argolis URL (${ARGOLIS_RUN_URL}) is now locked down (403 to browsers, log relay only)"
log "Next: enable UberProxy / *.corp.google.com access on ${CORP_PORTAL_SERVICE} in project ${CORP_PROJECT_ID}"
