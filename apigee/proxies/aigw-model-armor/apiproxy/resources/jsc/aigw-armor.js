/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * aigw-armor.js - turns the Model Armor result of SanitizeUserPrompt (SUP-Prompt) or
 * SanitizeModelResponse (SMR-Response) into a demo-friendly verdict.
 *
 * Property "stage": prompt | response
 * Sets:
 *   aigw.armor.<stage>         clean | blocked | error
 *   aigw.armor.filters         comma separated list of matched filters
 *   aigw.armor.filters_json    JSON array of matched filters
 *   aigw.armor.labels_json     JSON array of Spanish labels for the UI
 *   aigw.armor.findings_json   JSON object with per-filter details
 *   aigw.armor.message         Spanish message for the error body
 *   aigw.armor.blocked_stage   prompt | response (only when blocked)
 *   aigw.armor.redact          true when sensitive data was found in the prompt
 */
// Policy properties are java.lang.String in Apigee: convert before strict comparisons.
var stage = String(properties.stage || 'prompt') === 'response' ? 'response' : 'prompt';
var prefix = stage === 'prompt' ? 'SanitizeUserPrompt.SUP-Prompt.' : 'SanitizeModelResponse.SMR-Response.';

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}
function parseJson(s) {
  if (!s) { return null; }
  try { return JSON.parse(s); } catch (e) { return null; }
}
function isMatch(x) { return x === 'MATCH_FOUND'; }

var RAI_LABELS = {
  dangerous: 'Contenido peligroso',
  hate_speech: 'Discurso de odio',
  harassment: 'Acoso',
  sexually_explicit: 'Contenido sexual expl\u00edcito'
};
var SDP_LABELS = {
  CREDIT_CARD_NUMBER: 'tarjeta de cr\u00e9dito',
  US_SOCIAL_SECURITY_NUMBER: 'SSN',
  FINANCIAL_ACCOUNT_NUMBER: 'cuenta financiera',
  US_INDIVIDUAL_TAXPAYER_IDENTIFICATION_NUMBER: 'ITIN',
  GCP_CREDENTIALS: 'credenciales de Google Cloud',
  GCP_API_KEY: 'API key',
  PASSWORD: 'contrase\u00f1a'
};

// Order of the findings (the UI shows the first label as the main reason): highest Model Armor
// confidence first; deterministic detectors (URL, sensitive data, CSAM) count as HIGH; then the
// most specific filter wins the tie.
var PRIORITY = { malicious_uris: 0, sdp: 1, csam: 2, pi_and_jailbreak: 3, rai: 4 };
var CONFIDENCE = { HIGH: 0, MEDIUM_AND_ABOVE: 1, LOW_AND_ABOVE: 2 };
var entries = [];
var findings = {};

function add(filter, label, confidence) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].filter === filter && entries[i].label === (label || '')) { return; }
  }
  var conf = CONFIDENCE.hasOwnProperty(confidence) ? CONFIDENCE[confidence] : 1;
  if (filter === 'malicious_uris' || filter === 'sdp' || filter === 'csam') { conf = 0; }
  entries.push({ filter: filter, label: label || '', conf: conf, idx: entries.length });
}

// The policy exposes the raw Model Armor response; parse it for rich details.
var parsed = parseJson(v(prefix + 'responseFromModelArmor'));
var sr = parsed ? (parsed.sanitizationResult || parsed) : null;
var fr = sr ? sr.filterResults : null;

function inspect(key, r) {
  if (!r) { return; }
  if (r.piAndJailbreakFilterResult && isMatch(r.piAndJailbreakFilterResult.matchState)) {
    add('pi_and_jailbreak', 'Prompt injection / Jailbreak', r.piAndJailbreakFilterResult.confidenceLevel);
    findings.pi_and_jailbreak = { confidence: r.piAndJailbreakFilterResult.confidenceLevel || '' };
  }
  if (r.maliciousUriFilterResult && isMatch(r.maliciousUriFilterResult.matchState)) {
    add('malicious_uris', 'URL maliciosa');
    var uris = [];
    var items = r.maliciousUriFilterResult.maliciousUriMatchedItems || [];
    for (var i = 0; i < items.length; i++) { if (items[i].uri) { uris.push(items[i].uri); } }
    findings.malicious_uris = { uris: uris };
  }
  if (r.csamFilterFilterResult && isMatch(r.csamFilterFilterResult.matchState)) {
    add('csam', 'CSAM');
  }
  if (r.raiFilterResult && isMatch(r.raiFilterResult.matchState)) {
    var types = r.raiFilterResult.raiFilterTypeResults || {};
    var cats = [];
    for (var t in types) {
      if (types.hasOwnProperty(t) && types[t] && isMatch(types[t].matchState)) {
        cats.push(t);
        add('rai', RAI_LABELS[t] || ('IA responsable: ' + t), types[t].confidenceLevel);
      }
    }
    if (!cats.length) { add('rai', 'IA responsable'); }
    findings.rai = { categories: cats };
  }
  if (r.sdpFilterResult) {
    var ir = r.sdpFilterResult.inspectResult || {};
    if (isMatch(ir.matchState)) {
      var infoTypes = [];
      var f = ir.findings || [];
      for (var j = 0; j < f.length; j++) {
        if (f[j].infoType && infoTypes.indexOf(f[j].infoType) < 0) { infoTypes.push(f[j].infoType); }
      }
      var names = [];
      for (var k = 0; k < infoTypes.length; k++) { names.push(SDP_LABELS[infoTypes[k]] || infoTypes[k]); }
      add('sdp', 'Datos sensibles' + (names.length ? ' (' + names.join(', ') + ')' : ''));
      findings.sdp = { infoTypes: infoTypes };
    }
  }
}

if (fr) {
  if (fr.length !== undefined) {
    for (var a = 0; a < fr.length; a++) { inspect('', fr[a]); }
  } else {
    for (var key in fr) { if (fr.hasOwnProperty(key)) { inspect(key, fr[key]); } }
  }
}

// Fallback to the individual flow variables if the raw response was not available.
if (!entries.length) {
  if (isMatch(v(prefix + 'piAndJailbreakFilterResult.matchState'))) { add('pi_and_jailbreak', 'Prompt injection / Jailbreak'); }
  if (isMatch(v(prefix + 'sdpFilterResult.inspectResult.matchState'))) { add('sdp', 'Datos sensibles'); }
  if (isMatch(v(prefix + 'maliciousUriFilterResult.matchState'))) { add('malicious_uris', 'URL maliciosa'); }
  if (isMatch(v(prefix + 'raiFilterResult.matchState'))) { add('rai', 'IA responsable'); }
  if (isMatch(v(prefix + 'csamFilterFilterResult.matchState'))) { add('csam', 'CSAM'); }
}

function rank(e) { return e.conf * 100000 + (PRIORITY.hasOwnProperty(e.filter) ? PRIORITY[e.filter] : 9) * 1000 + e.idx; }
entries.sort(function (x, y) { return rank(x) - rank(y); });
var filters = [];
var labels = [];
for (var n = 0; n < entries.length; n++) {
  if (filters.indexOf(entries[n].filter) < 0) { filters.push(entries[n].filter); }
  if (entries[n].label && labels.indexOf(entries[n].label) < 0) { labels.push(entries[n].label); }
}

var matched = isMatch(v(prefix + 'filterMatchState')) || filters.length > 0;
var failed = v((stage === 'prompt' ? 'SanitizeUserPrompt.SUP-Prompt.' : 'SanitizeModelResponse.SMR-Response.') + 'failed') === 'true';
var verdict = matched ? 'blocked' : (failed ? 'error' : 'clean');

context.setVariable('aigw.armor.' + stage, verdict);

var all = v('aigw.armor.filters');
var merged = all ? all.split(',') : [];
for (var m = 0; m < filters.length; m++) { if (merged.indexOf(filters[m]) < 0) { merged.push(filters[m]); } }
if (merged.length) { context.setVariable('aigw.armor.filters', merged.join(',')); }

if (verdict === 'blocked') {
  context.setVariable('aigw.armor.blocked_stage', stage);
  context.setVariable('aigw.armor.filters_json', JSON.stringify(filters));
  context.setVariable('aigw.armor.labels_json', JSON.stringify(labels));
  context.setVariable('aigw.armor.findings_json', JSON.stringify(findings));
  var what = stage === 'prompt' ? 'el prompt' : 'la respuesta del modelo';
  context.setVariable('aigw.armor.message',
    'Model Armor bloque\u00f3 ' + what + ': ' + (labels.length ? labels.join(', ') : 'pol\u00edtica de seguridad') + '.');
  if (stage === 'prompt' && filters.indexOf('sdp') >= 0) { context.setVariable('aigw.armor.redact', 'true'); }
}
