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
 * aigw-finalize.js (shared by every AI Gateway demo proxy)
 *
 * Runs at the end of the response flow (and in the DefaultFaultRule). It:
 *   1. derives demo metadata from the variables set by the AI policies
 *      (semantic cache, Model Armor, token limits, routing, circuit breaker, MCP),
 *   2. publishes it as x-aigw-* response headers (only non-empty values), and
 *   3. prepares the aigw.* variables used by the ML-Log MessageLogging policy.
 *
 * Policy properties:
 *   capability   - id of the demo capability (semantic-cache, model-armor, ...)
 *   readResponse - "false" for streaming / large responses (do not buffer the body)
 */
// Policy properties are java.lang.String in Apigee: convert before strict comparisons.
var capability = String(properties.capability || '');
var readResponse = String(properties.readResponse || 'true') !== 'false';
var streamHeader = String(properties.streamHeader || 'false') === 'true';

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}
function setVar(name, val) {
  if (val !== null && val !== undefined && String(val) !== '') {
    context.setVariable(name, String(val));
  }
}
function header(name, val) {
  if (val !== null && val !== undefined && String(val) !== '') {
    // "message" is the response in the response flow and the error message in fault rules.
    context.setVariable('message.header.' + name, String(val));
  }
}
function parseJson(s) {
  if (!s) { return null; }
  try { return JSON.parse(s); } catch (e) { return null; }
}
function truncate(s, n) {
  s = s ? String(s) : '';
  return s.length > n ? s.substring(0, n) + '...' : s;
}
function first(a, b) { return a !== '' ? a : b; }

context.setVariable('aigw.capability', capability);

// ---------------------------------------------------------------- request ----
var req = parseJson(v('request.content'));
if (req && req.messages && req.messages.length) {
  var last = req.messages[req.messages.length - 1];
  var content = last && last.content;
  if (content && typeof content !== 'string') { content = JSON.stringify(content); }
  if (v('aigw.prompt') === '') { setVar('aigw.prompt', content); }
  if (v('aigw.model') === '') { setVar('aigw.model', req.model); }
}
if (req && req.jsonrpc) {
  setVar('aigw.mcp.method', req.method);
  if (req.params && req.params.name) { setVar('aigw.mcp.tool', req.params.name); }
  if (req.params && req.params.arguments && req.params.arguments.query) {
    setVar('aigw.prompt', req.params.arguments.query);
  }
}

// --------------------------------------------------------------- response ----
var status = parseInt(first(v('message.status.code'), first(v('response.status.code'), '0')), 10);
context.setVariable('aigw.status', String(status));
var contentType = v('message.header.content-type').toLowerCase();
if (streamHeader) {
  context.setVariable('aigw.stream', contentType.indexOf('text/event-stream') >= 0 ? 'true' : 'false');
}
var res = (readResponse && contentType.indexOf('text/event-stream') < 0) ? parseJson(v('message.content')) : null;
if (res && res.choices && res.choices.length) {
  var msg = res.choices[0].message || {};
  setVar('aigw.response_preview', truncate(msg.content || '', 300));
  if (res.model) { context.setVariable('aigw.served_model', String(res.model)); }
}
if (res && res.usage) {
  setVar('aigw.usage.prompt', res.usage.prompt_tokens);
  setVar('aigw.usage.completion', res.usage.completion_tokens);
  setVar('aigw.usage.total', res.usage.total_tokens);
}
if (res && res.error) {
  setVar('aigw.error', res.error.message || res.error.code || JSON.stringify(res.error));
  setVar('aigw.error_type', res.error.type || (res.error.data && res.error.data.type) || '');
}
if (res && res.fault) {
  setVar('aigw.error', res.fault.faultstring || '');
  setVar('aigw.error_type', (res.fault.detail && res.fault.detail.errorcode) || '');
}

// --------------------------------------------------------- semantic cache ----
var cacheHit = v('SemanticCacheLookup.SCL-Lookup.cache_hit');
var sclFailed = v('SemanticCacheLookup.SCL-Lookup.failed') === 'true' || v('semanticcachelookup.SCL-Lookup.failed') === 'true';
var sclRan = cacheHit !== '' || v('SemanticCacheLookup.SCL-Lookup.user_prompt') !== '' || sclFailed;
if (sclRan) {
  context.setVariable('aigw.cache', cacheHit === 'true' ? 'HIT' : 'MISS');
  if (sclFailed && cacheHit !== 'true') { context.setVariable('aigw.cache_error', 'true'); }
  // Observed name on the runtime; the documented lowercase name is kept as a fallback.
  var measure = first(v('SemanticCacheLookup.SCL-Lookup.nearest_neighbor_measure'),
    v('semanticcache.lookup.SCL-Lookup.nearest_neighbor_measure'));
  if (measure !== '' && !isNaN(parseFloat(measure))) {
    context.setVariable('aigw.similarity', parseFloat(measure).toFixed(3));
  }
  if (cacheHit === 'true') { setVar('aigw.cache_key', v('SemanticCacheLookup.SCL-Lookup.matched_cache_key')); }
} else if (capability === 'gateway' && v('aigw.simulate') === 'primary') {
  context.setVariable('aigw.cache', 'BYPASS');   // simulated outage: cache skipped on purpose
}
if (v('aigw.cache') === 'HIT') {
  context.setVariable('aigw.tokens.charged', '0');
} else {
  setVar('aigw.tokens.charged', v('aigw.usage.total'));
}

// ----------------------------------------------------------- token limits ----
setVar('aigw.tokens.prompt_estimate', v('ratelimit.PTL-PromptRate.userPromptTokenCount'));
// LTQ-Enforce knows the plan limit (AI Product); LTQ-Count has the usage after this call.
// CountOnly reports Long.MAX as "allowed", so it is only used as a fallback when it is sane.
function num(name) { var x = parseFloat(v(name)); return isNaN(x) ? null : x; }
var MAX_SANE = 1e15;
var qUsed = num('ratelimit.LTQ-Count.used.count');
if (qUsed === null) { qUsed = num('ratelimit.LTQ-Enforce.used.count'); }
var qAllowed = num('ratelimit.LTQ-Enforce.allowed.count');
if (qAllowed === null || qAllowed >= MAX_SANE) {
  var qAllowed2 = num('ratelimit.LTQ-Count.allowed.count');
  qAllowed = (qAllowed2 !== null && qAllowed2 < MAX_SANE) ? qAllowed2 : null;
}
if (qUsed !== null) { context.setVariable('aigw.quota.used', String(qUsed)); }
if (qAllowed !== null) {
  context.setVariable('aigw.quota.allowed', String(qAllowed));
  if (qUsed !== null) { context.setVariable('aigw.quota.available', String(Math.max(0, qAllowed - qUsed))); }
}
var expiry = v('ratelimit.LTQ-Enforce.expiry.time') || v('ratelimit.LTQ-Count.expiry.time');
if (expiry !== '' && expiry !== '0' && expiry !== '-1') { setVar('aigw.quota.reset', expiry); }

// ---------------------------------------------------------------- outcome ----
var outcome = 'allowed';
if (v('aigw.armor.blocked_stage') !== '') { outcome = 'blocked'; }
else if (status === 429) { outcome = 'limited'; }
else if (status === 401 || status === 403) { outcome = 'denied'; }
else if (status >= 500) { outcome = 'error'; }
else if (status >= 400) { outcome = 'rejected'; }
context.setVariable('aigw.outcome', outcome);

var start = parseInt(v('client.received.start.timestamp') || '0', 10);
if (start > 0) { context.setVariable('aigw.latency_ms', String(new Date().getTime() - start)); }

// MCP Discovery: which MCP server answered (the fallback sets "fallback" itself).
if (capability === 'mcp-discovery' && v('aigw.mcp.server') === '' && v('target.received.end.timestamp') !== '') {
  context.setVariable('aigw.mcp.server', 'managed');
}

// Prompt as written to Cloud Logging (redacted when Model Armor found sensitive data)
if (v('aigw.armor.redact') === 'true') {
  context.setVariable('aigw.prompt_log', '[REDACTADO: Model Armor detect\u00f3 datos sensibles]');
} else {
  setVar('aigw.prompt_log', truncate(v('aigw.prompt'), 400));
}

// ------------------------------------------------------- response headers ----
header('x-aigw-request-id', v('messageid'));
header('x-aigw-proxy', v('apiproxy.name'));
header('x-aigw-capability', capability);
header('x-aigw-cache', v('aigw.cache'));
header('x-aigw-similarity', v('aigw.similarity'));
header('x-aigw-cache-error', v('aigw.cache_error'));
header('x-aigw-tokens-charged', v('aigw.tokens.charged'));
header('x-aigw-armor-prompt', v('aigw.armor.prompt'));
header('x-aigw-armor-response', v('aigw.armor.response'));
header('x-aigw-armor-filters', v('aigw.armor.filters'));
header('x-aigw-plan', v('aigw.plan'));
header('x-aigw-prompt-tokens', v('aigw.tokens.prompt_estimate'));
header('x-aigw-quota-used', v('aigw.quota.used'));
header('x-aigw-quota-allowed', v('aigw.quota.allowed'));
header('x-aigw-quota-available', v('aigw.quota.available'));
header('x-aigw-quota-reset', v('aigw.quota.reset'));
header('x-aigw-provider', v('aigw.provider'));
header('x-aigw-llm-provider', v('aigw.llm_provider'));
header('x-aigw-target', v('aigw.target_endpoint'));
header('x-aigw-model', first(v('aigw.served_model'), v('aigw.model')));
header('x-aigw-routing', v('aigw.routing'));
header('x-aigw-routed-model', v('aigw.routing') !== '' ? v('aigw.model') : '');
header('x-aigw-route-reason', v('aigw.route_reason'));
header('x-aigw-tier', v('aigw.tier'));
header('x-aigw-backend', v('aigw.backend'));
header('x-aigw-backend-region', v('aigw.backend_region'));
header('x-aigw-backend-model', v('aigw.backend_model'));
header('x-aigw-failover', v('aigw.failover'));
header('x-aigw-failover-reason', v('aigw.failover_reason'));
header('x-aigw-circuit', v('aigw.circuit'));
header('x-aigw-circuit-failures', v('aigw.circuit_failures'));
header('x-aigw-mcp-method', v('aigw.mcp.method'));
header('x-aigw-mcp-tool', v('aigw.mcp.tool'));
header('x-aigw-mcp-server', v('aigw.mcp.server'));
header('x-aigw-stream', v('aigw.stream'));
header('x-aigw-latency-ms', v('aigw.latency_ms'));

// ----------------------------------------------------------- Cloud Logging ----
// Compact JSON entry (only non-empty fields) written by ML-Log in the PostClientFlow.
var entry = {
  requestId: v('messageid'),
  proxy: v('apiproxy.name'),
  revision: v('apiproxy.revision'),
  capability: capability,
  environment: v('environment.name'),
  app: v('developer.app.name'),
  product: v('apiproduct.name'),
  clientIp: v('client.ip'),
  verb: v('request.verb'),
  path: first(v('proxy.basepath') + v('proxy.pathsuffix'), v('request.uri')),
  status: String(status),
  outcome: v('aigw.outcome'),
  latencyMs: v('aigw.latency_ms'),
  model: v('aigw.model'),
  servedModel: v('aigw.served_model'),
  provider: v('aigw.provider'),
  llmProvider: v('aigw.llm_provider'),
  targetEndpoint: v('aigw.target_endpoint'),
  routing: v('aigw.routing'),
  routeReason: v('aigw.route_reason'),
  tier: v('aigw.tier'),
  cache: v('aigw.cache'),
  similarity: v('aigw.similarity'),
  cacheKey: v('aigw.cache_key'),
  tokensCharged: v('aigw.tokens.charged'),
  armorPrompt: v('aigw.armor.prompt'),
  armorResponse: v('aigw.armor.response'),
  armorFilters: v('aigw.armor.filters'),
  promptTokens: v('aigw.tokens.prompt_estimate'),
  usagePromptTokens: v('aigw.usage.prompt'),
  usageCompletionTokens: v('aigw.usage.completion'),
  usageTotalTokens: v('aigw.usage.total'),
  plan: v('aigw.plan'),
  quotaUsed: v('aigw.quota.used'),
  quotaAllowed: v('aigw.quota.allowed'),
  backend: v('aigw.backend'),
  backendRegion: v('aigw.backend_region'),
  backendModel: v('aigw.backend_model'),
  failover: v('aigw.failover'),
  failoverReason: v('aigw.failover_reason'),
  circuit: v('aigw.circuit'),
  circuitFailures: v('aigw.circuit_failures'),
  mcpMethod: v('aigw.mcp.method'),
  mcpTool: v('aigw.mcp.tool'),
  mcpServer: v('aigw.mcp.server'),
  stream: v('aigw.stream'),
  prompt: v('aigw.prompt_log'),
  responsePreview: v('aigw.response_preview'),
  error: truncate(v('aigw.error'), 300),
  errorType: v('aigw.error_type')
};
var compact = {};
for (var k in entry) {
  if (entry.hasOwnProperty(k) && entry[k] !== '' && entry[k] !== null && entry[k] !== undefined) { compact[k] = entry[k]; }
}
context.setVariable('aigw.log_json', JSON.stringify(compact));
