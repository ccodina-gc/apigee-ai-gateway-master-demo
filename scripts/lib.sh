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
# Shared helpers for the AI Gateway demo scripts.
# Compatible with the bash 3.2 that ships with macOS (no namerefs, no mapfile).
# ---------------------------------------------------------------------------

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(cd "${LIB_DIR}/.." >/dev/null 2>&1 && pwd)"
BUILD_DIR="${ROOT_DIR}/.build"
APIGEE_API="https://apigee.googleapis.com/v1/organizations"

# Colors (only when writing to a terminal)
if [ -t 1 ]; then
  C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_OFF=$'\033[0m'
else
  C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""
fi

log()  { printf '%s==>%s %s\n' "${C_BLUE}" "${C_OFF}" "$*"; }
ok()   { printf '%s ok%s %s\n' "${C_GREEN}" "${C_OFF}" "$*"; }
warn() { printf '%s !!%s %s\n' "${C_YELLOW}" "${C_OFF}" "$*" >&2; }
die()  { printf '%s xx%s %s\n' "${C_RED}" "${C_OFF}" "$*" >&2; exit 1; }

load_env() {
  if [ -z "${PROJECT_ID:-}" ] || [ -z "${APIGEE_ENV:-}" ]; then
    # shellcheck source=/dev/null
    source "${ROOT_DIR}/env.sh"
  fi
  local v
  for v in PROJECT_ID PROJECT_NUMBER APIGEE_ENV APIGEE_HOST REGION; do
    [ -n "${!v:-}" ] || die "Missing variable ${v}. Run: source ./env.sh"
  done
  PROXY_SA="${PROXY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  PORTAL_SA="${PORTAL_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  MCP_SA="${MCP_SA_NAME:-aigw-mcp-sa}@${PROJECT_ID}.iam.gserviceaccount.com"
  BUILD_SA="${BUILD_SA_NAME:-aigw-build-sa}@${PROJECT_ID}.iam.gserviceaccount.com"
  ROUTING_GEMINI_MODEL="${ROUTING_GEMINI_MODEL:-google/gemini-3.5-flash}"
  ROUTING_CLAUDE_MODEL="${ROUTING_CLAUDE_MODEL:-claude-sonnet-5-5}"
  ROUTING_CLAUDE_LOCATION="${ROUTING_CLAUDE_LOCATION:-global}"
  ROUTING_KVM_NAME="${ROUTING_KVM_NAME:-aigw-llm-routing-config}"
  if [ "${ROUTING_CLAUDE_LOCATION}" = "global" ]; then ROUTING_CLAUDE_HOST="aiplatform.googleapis.com"; else ROUTING_CLAUDE_HOST="${ROUTING_CLAUDE_LOCATION}-aiplatform.googleapis.com"; fi
  export PROXY_SA PORTAL_SA MCP_SA BUILD_SA ROUTING_GEMINI_MODEL ROUTING_CLAUDE_MODEL ROUTING_CLAUDE_LOCATION ROUTING_CLAUDE_HOST ROUTING_KVM_NAME
}

require_cmds() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "Required command not found: $c"
  done
}

# Access token: prefer ADC (works better with context-aware access), fall back to gcloud user.
get_token() {
  if [ -z "${TOKEN:-}" ]; then
    TOKEN="$(gcloud auth application-default print-access-token </dev/null 2>/dev/null || true)"
    if [ -z "${TOKEN}" ]; then
      TOKEN="$(gcloud auth print-access-token </dev/null 2>/dev/null || true)"
    fi
    [ -n "${TOKEN}" ] || die "Could not get an access token. Run: gcloud auth login && gcloud auth application-default login"
  fi
  export TOKEN
}

# api METHOD URL [JSON_BODY]  -> prints body. The HTTP status is kept in a temp file so
# is_2xx also works when api() runs inside a $(...) subshell.
API_CODE_FILE="${TMPDIR:-/tmp}/aigw-api-code.$$"
api() {
  local method="$1" url="$2" data="${3:-}" out code
  out="$(mktemp)"
  if [ -n "${data}" ]; then
    code=$(curl -sS -o "${out}" -w '%{http_code}' -X "${method}" \
      -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      -H "x-goog-user-project: ${PROJECT_ID}" \
      --data "${data}" "${url}" || echo "000")
  else
    code=$(curl -sS -o "${out}" -w '%{http_code}' -X "${method}" \
      -H "Authorization: Bearer ${TOKEN}" -H "x-goog-user-project: ${PROJECT_ID}" "${url}" || echo "000")
  fi
  echo "${code}" >"${API_CODE_FILE}"
  HTTP_CODE="${code}"
  cat "${out}"
  rm -f "${out}"
}

is_2xx() {
  HTTP_CODE="$(cat "${API_CODE_FILE}" 2>/dev/null || echo 000)"
  case "${HTTP_CODE}" in 2*) return 0 ;; *) return 1 ;; esac
}

# Portable in-place sed
sedi() {
  if [ "$(uname)" = "Darwin" ]; then sed -i '' "$@"; else sed -i "$@"; fi
}

ensure_sa() {
  local name="$1" display="$2" email="${1}@${PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "${email}" --project "${PROJECT_ID}" </dev/null >/dev/null 2>&1; then
    ok "Service account ${email} exists"
  else
    log "Creating service account ${email}"
    gcloud iam service-accounts create "${name}" --display-name "${display}" \
      --project "${PROJECT_ID}" </dev/null >/dev/null
    sleep 8
  fi
}

grant_project_role() {
  local member="$1" role="$2"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member "${member}" \
    --role "${role}" --condition=None --quiet </dev/null >/dev/null 2>&1 \
    && ok "  ${role} -> ${member}" || warn "  could not grant ${role} to ${member}"
}

# Render a proxy (template tokens __VAR__) into .build/proxies/<name>/apiproxy
render_proxy() {
  local name="$1" src="${ROOT_DIR}/apigee/proxies/$1" dst="${BUILD_DIR}/proxies/$1"
  [ -d "${src}/apiproxy" ] || die "Proxy source not found: ${src}"
  rm -rf "${dst}" && mkdir -p "${dst}"
  cp -R "${src}/apiproxy" "${dst}/"
  local f
  find "${dst}/apiproxy" -type f \( -name '*.xml' -o -name '*.js' -o -name '*.yaml' -o -name '*.json' -o -name '*.properties' \) | while read -r f; do
    sedi \
      -e "s|__PROJECT_ID__|${PROJECT_ID}|g" \
      -e "s|__PROJECT_NUMBER__|${PROJECT_NUMBER}|g" \
      -e "s|__REGION__|${REGION}|g" \
      -e "s|__APIGEE_HOST__|${APIGEE_HOST}|g" \
      -e "s|__LLM_LOCATION__|${LLM_LOCATION}|g" \
      -e "s|__LLM_HOST__|${LLM_HOST}|g" \
      -e "s|__FALLBACK_HOST__|${FALLBACK_HOST}|g" \
      -e "s|__MODEL_LITE__|${MODEL_LITE}|g" \
      -e "s|__MODEL_FLASH__|${MODEL_FLASH}|g" \
      -e "s|__MODEL_PRO__|${MODEL_PRO}|g" \
      -e "s|__MODEL_FALLBACK__|${MODEL_FALLBACK}|g" \
      -e "s|__FALLBACK_LOCATION__|${FALLBACK_LOCATION}|g" \
      -e "s|__ROUTING_GEMINI_MODEL__|${ROUTING_GEMINI_MODEL}|g" \
      -e "s|__ROUTING_CLAUDE_MODEL__|${ROUTING_CLAUDE_MODEL}|g" \
      -e "s|__ROUTING_CLAUDE_LOCATION__|${ROUTING_CLAUDE_LOCATION}|g" \
      -e "s|__ROUTING_CLAUDE_HOST__|${ROUTING_CLAUDE_HOST}|g" \
      -e "s|__ROUTING_KVM_NAME__|${ROUTING_KVM_NAME}|g" \
      -e "s|__MODEL_ARMOR_LOCATION__|${MODEL_ARMOR_LOCATION}|g" \
      -e "s|__MODEL_ARMOR_TEMPLATE__|${MODEL_ARMOR_TEMPLATE}|g" \
      -e "s|__EMBEDDINGS_MODEL__|${EMBEDDINGS_MODEL}|g" \
      -e "s|__VS_PUBLIC_DOMAIN__|${VS_PUBLIC_DOMAIN:-vector-search-not-ready.invalid}|g" \
      -e "s|__VS_INDEX_ENDPOINT_ID__|${VS_INDEX_ENDPOINT_ID:-0}|g" \
      -e "s|__VS_INDEX_ID__|${VS_INDEX_ID:-0}|g" \
      -e "s|__VS_DEPLOYED_INDEX_ID__|${VS_DEPLOYED_INDEX_ID}|g" \
      -e "s|__SEMANTIC_CACHE_THRESHOLD__|${SEMANTIC_CACHE_THRESHOLD}|g" \
      -e "s|__SEMANTIC_CACHE_TTL_SEC__|${SEMANTIC_CACHE_TTL_SEC}|g" \
      -e "s|__LOG_NAME__|${LOG_NAME}|g" \
      "${f}"
  done
  echo "${dst}"
}

# Create or update the environment KVM used by aigw-llm-routing (provider -> targetUrl, defaultModel)
upsert_routing_kvm() {
  local tpl="${ROOT_DIR}/apigee/kvm/aigw-llm-routing-config.json" rendered base kvms entry k v resp
  [ -f "${tpl}" ] || die "Missing KVM template: ${tpl}"
  rendered=$(sed \
    -e "s|__PROJECT_ID__|${PROJECT_ID}|g" \
    -e "s|__LLM_LOCATION__|${LLM_LOCATION}|g" \
    -e "s|__LLM_HOST__|${LLM_HOST}|g" \
    -e "s|__ROUTING_GEMINI_MODEL__|${ROUTING_GEMINI_MODEL}|g" \
    -e "s|__ROUTING_CLAUDE_MODEL__|${ROUTING_CLAUDE_MODEL}|g" \
    -e "s|__ROUTING_CLAUDE_LOCATION__|${ROUTING_CLAUDE_LOCATION}|g" \
    -e "s|__ROUTING_CLAUDE_HOST__|${ROUTING_CLAUDE_HOST}|g" \
    -e "s|__ROUTING_KVM_NAME__|${ROUTING_KVM_NAME}|g" \
    "${tpl}")
  base="${APIGEE_API}/${PROJECT_ID}/environments/${APIGEE_ENV}/keyvaluemaps"
  kvms=$(api GET "${base}")
  if ! echo "${kvms}" | jq -e --arg n "${ROUTING_KVM_NAME}" 'index($n) != null' >/dev/null 2>&1; then
    log "Creating Apigee KVM ${ROUTING_KVM_NAME} in ${APIGEE_ENV}"
    resp=$(api POST "${base}" "{\"name\":\"${ROUTING_KVM_NAME}\",\"encrypted\":true}")
    is_2xx || die "KVM ${ROUTING_KVM_NAME} creation failed (${HTTP_CODE}): ${resp}"
  fi
  echo "${rendered}" | jq -c '.keyValueEntries[]' | while read -r entry; do
    k=$(echo "${entry}" | jq -r '.name')
    api GET "${base}/${ROUTING_KVM_NAME}/entries/${k}" >/dev/null
    if is_2xx; then
      resp=$(api PUT "${base}/${ROUTING_KVM_NAME}/entries/${k}" "${entry}")
    else
      resp=$(api POST "${base}/${ROUTING_KVM_NAME}/entries" "${entry}")
    fi
    is_2xx || die "KVM entry ${k} upsert failed (${HTTP_CODE}): ${resp}"
  done
  ok "Apigee KVM ${ROUTING_KVM_NAME} updated (${ROUTING_GEMINI_MODEL} / ${ROUTING_CLAUDE_MODEL})"
}

# Import a rendered proxy bundle and deploy it with the proxy service account
# (the MCP Discovery Proxy uses its own service account, see env.sh).
deploy_proxy() {
  local name="$1" dir zip rev resp sa="${PROXY_SA}"
  [ "${name}" = "aigw-mcp-retail" ] && sa="${MCP_SA}"
  dir="$(render_proxy "${name}")"
  zip="${BUILD_DIR}/${name}.zip"
  rm -f "${zip}"
  (cd "${dir}" && zip -qr "${zip}" apiproxy)
  log "Importing proxy ${name}"
  resp=$(curl -sS -X POST -H "Authorization: Bearer ${TOKEN}" \
    -F "file=@${zip};type=application/octet-stream" \
    "${APIGEE_API}/${PROJECT_ID}/apis?name=${name}&action=import")
  rev=$(echo "${resp}" | jq -r '.revision // empty')
  [ -n "${rev}" ] || die "Import of ${name} failed: ${resp}"
  log "Deploying ${name} rev ${rev} to ${APIGEE_ENV}"
  resp=$(api POST "${APIGEE_API}/${PROJECT_ID}/environments/${APIGEE_ENV}/apis/${name}/revisions/${rev}/deployments?override=true&serviceAccount=${sa}")
  is_2xx || die "Deploy of ${name} failed (${HTTP_CODE}): ${resp}"
  wait_deployment "${name}" "${rev}"
}

wait_deployment() {
  local name="$1" rev="$2" i state resp
  for i in $(seq 1 60); do
    resp=$(api GET "${APIGEE_API}/${PROJECT_ID}/environments/${APIGEE_ENV}/apis/${name}/revisions/${rev}/deployments")
    state=$(echo "${resp}" | jq -r '.state // empty')
    case "${state}" in
      READY) ok "${name} rev ${rev} deployed"; return 0 ;;
      ERROR) die "Deployment error for ${name}: $(echo "${resp}" | jq -c '.errors // .')" ;;
    esac
    sleep 5
  done
  warn "${name} rev ${rev} still ${state:-PROGRESSING}; continuing"
}

# Create or update an API product from a JSON file (templated with __VARS__).
upsert_product() {
  local file="$1" name body resp
  body=$(sed -e "s|__APIGEE_ENV__|${APIGEE_ENV}|g" -e "s|__MODEL_LITE__|${MODEL_LITE}|g" "${file}")
  name=$(echo "${body}" | jq -r '.name')
  api GET "${APIGEE_API}/${PROJECT_ID}/apiproducts/${name}" >/dev/null
  if is_2xx; then
    resp=$(api PUT "${APIGEE_API}/${PROJECT_ID}/apiproducts/${name}" "${body}")
  else
    resp=$(api POST "${APIGEE_API}/${PROJECT_ID}/apiproducts" "${body}")
  fi
  is_2xx && ok "API product ${name}" || die "API product ${name} failed (${HTTP_CODE}): ${resp}"
}
