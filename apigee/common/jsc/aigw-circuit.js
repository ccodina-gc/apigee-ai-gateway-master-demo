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
 * aigw-circuit.js - circuit breaker helpers (property "mode").
 *
 *   state    : after Q-CB-Check (Quota EnforceOnly). The circuit is OPEN when the
 *              primary failed >= threshold times in the rolling window.
 *   prepare  : the primary answered 429/5xx. Builds the fallback request body
 *              (aigw.fallback_body) for the secondary provider.
 *   complete : after the secondary answered. Marks the failover and recalculates the
 *              circuit state with the updated failure counter (Q-CB-Count).
 *   route-secondary : circuit OPEN, the request goes straight to the secondary target.
 *   normalize       : converts the secondary response (Anthropic Messages API) back into the
 *                     OpenAI Chat Completions shape, so the app never notices the provider change.
 *
 * The secondary provider is Claude (__MODEL_FALLBACK__) on Vertex AI Model Garden, called through
 * the Anthropic Messages API (:rawPredict): the OpenAI-style request is translated on the way in.
 */
// Policy properties are java.lang.String in Apigee: convert before strict comparisons.
var mode = String(properties.mode || 'state');
var THRESHOLD = parseInt(String(properties.threshold || '2'), 10);
var FALLBACK_MODEL = '__MODEL_FALLBACK__';
var FALLBACK_PROVIDER = 'Anthropic (Model Garden)';

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}

function parseJson(s) {
  if (!s) { return null; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function textOf(content) {
  if (typeof content === 'string') { return content; }
  if (content && content.length !== undefined) {
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var p = content[i];
      if (typeof p === 'string') { parts.push(p); } else if (p && typeof p.text === 'string') { parts.push(p.text); }
    }
    return parts.join('\n');
  }
  return content ? JSON.stringify(content) : '';
}

/** OpenAI Chat Completions request -> Anthropic Messages API payload (Vertex AI :rawPredict). */
function toAnthropic(raw) {
  var body = parseJson(raw) || {};
  var system = [];
  var messages = [];
  var inMsgs = body.messages || [];
  for (var i = 0; i < inMsgs.length; i++) {
    var m = inMsgs[i];
    if (!m) { continue; }
    var role = String(m.role || 'user').toLowerCase();
    var text = textOf(m.content);
    if (role === 'system' || role === 'developer') {
      if (text) { system.push(text); }
    } else if (text) {
      var r = role === 'assistant' ? 'assistant' : 'user';
      // The Messages API expects alternating roles: merge consecutive turns of the same role.
      if (messages.length && messages[messages.length - 1].role === r) {
        messages[messages.length - 1].content += '\n\n' + text;
      } else {
        messages.push({ role: r, content: text });
      }
    }
  }
  if (!messages.length || messages[0].role !== 'user') { messages.unshift({ role: 'user', content: 'Hola' }); }
  var maxTokens = parseInt(body.max_tokens || body.max_completion_tokens, 10);
  if (isNaN(maxTokens) || maxTokens < 256) { maxTokens = 1024; }
  var payload = { anthropic_version: 'vertex-2023-10-16', max_tokens: maxTokens, messages: messages };
  if (system.length) { payload.system = system.join('\n\n'); }
  // Claude rejects temperature and top_p together (and temperature > 1): forward only one.
  if (typeof body.temperature === 'number') {
    payload.temperature = Math.min(body.temperature, 1);
  } else if (typeof body.top_p === 'number') {
    payload.top_p = body.top_p;
  }
  return payload;
}

function markSecondary() {
  context.setVariable('aigw.backend', 'secondary');
  context.setVariable('aigw.backend_region', '__FALLBACK_LOCATION__');
  context.setVariable('aigw.backend_model', FALLBACK_MODEL);
  context.setVariable('aigw.served_model', FALLBACK_MODEL);
  context.setVariable('aigw.provider', FALLBACK_PROVIDER);
}

if (mode === 'state') {
  var failures = parseInt(v('ratelimit.Q-CB-Check.used.count') || '0', 10);
  context.setVariable('aigw.circuit', failures >= THRESHOLD ? 'OPEN' : 'CLOSED');
  context.setVariable('aigw.circuit_failures', String(failures));
} else if (mode === 'prepare') {
  context.setVariable('aigw.failover_needed', 'true');
  context.setVariable('aigw.fallback_body', JSON.stringify(toAnthropic(v('request.content'))));
  context.setVariable('aigw.primary_status', v('response.status.code'));
  context.setVariable('aigw.failover_reason', 'Primario respondio HTTP ' + v('response.status.code'));
} else if (mode === 'route-secondary') {
  // Circuit OPEN: the primary is paused, send the request straight to the fallback.
  context.setVariable('request.content', JSON.stringify(toAnthropic(v('request.content'))));
  context.setVariable('request.header.Content-Type', 'application/json');
  // The target URL is the full :rawPredict URL: do not append the proxy path suffix.
  context.setVariable('target.copy.pathsuffix', false);
  markSecondary();
  context.setVariable('aigw.failover', 'false');
  context.setVariable('aigw.failover_reason', 'Circuito abierto: primario en pausa');
} else if (mode === 'normalize') {
  var status = parseInt(v('response.status.code') || '0', 10);
  var raw = v('response.content');
  var res = parseJson(raw);
  if (res && res.type === 'message' && res.content) {
    var out = '';
    for (var c = 0; c < res.content.length; c++) {
      var blk = res.content[c];
      if (blk && blk.type === 'text' && typeof blk.text === 'string') { out += blk.text; }
    }
    var inTok = (res.usage && typeof res.usage.input_tokens === 'number') ? res.usage.input_tokens : 0;
    var outTok = (res.usage && typeof res.usage.output_tokens === 'number') ? res.usage.output_tokens : 0;
    context.setVariable('response.content', JSON.stringify({
      id: res.id || ('chatcmpl-' + v('messageid')),
      object: 'chat.completion',
      created: Math.floor(new Date().getTime() / 1000),
      model: res.model ? String(res.model) : FALLBACK_MODEL,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: out },
        finish_reason: res.stop_reason === 'max_tokens' ? 'length' : 'stop'
      }],
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }
    }));
    context.setVariable('response.header.Content-Type', 'application/json');
  } else if (status >= 400) {
    var e = res && (res.error || (res[0] && res[0].error));
    var detail = (e && e.message) ? String(e.message) : raw.substring(0, 300);
    context.setVariable('response.content', JSON.stringify({
      error: {
        type: 'upstream_error',
        code: 'FALLBACK_UPSTREAM_' + status,
        status: status,
        proxy: v('apiproxy.name'),
        requestId: v('messageid'),
        message: 'El fallback ' + FALLBACK_MODEL + ' (Anthropic, Model Garden) respondio HTTP ' + status + ': ' + detail,
        details: { backend: 'secondary', provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL }
      }
    }));
    context.setVariable('response.header.Content-Type', 'application/json');
  }
} else if (mode === 'complete') {
  var count = parseInt(v('ratelimit.Q-CB-Count.used.count') || '0', 10);
  markSecondary();
  context.setVariable('aigw.failover', 'true');
  if (count > 0) {
    context.setVariable('aigw.circuit_failures', String(count));
    context.setVariable('aigw.circuit', count >= THRESHOLD ? 'OPEN' : 'CLOSED');
  }
}
