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
 * aigw-router.js - LLM routing for an OpenAI-compatible Chat Completions API.
 *
 * The client sends a *virtual* model name (or "auto"); Apigee resolves it to a real
 * model/provider and rewrites the request body. Routing strategies:
 *   explicit : model = gemini-flash-lite | gemini-flash | gemini-pro | <real id>
 *   auto     : model = "auto" or header x-aigw-routing: auto
 *              -> classifies the prompt (length + intent keywords) into
 *                 simple (economico), medio (balanceado) or complejo (premium).
 * Sets aigw.provider, aigw.model, aigw.routing, aigw.route_reason, aigw.tier.
 * Header values are kept ASCII on purpose (HTTP header safety).
 * Note: Gemini 3.8 Flash does not accept reasoning_effort "minimal" (HTTP 400), so it uses "low".
 */
var CATALOG = {
  'gemini-flash-lite': { model: '__MODEL_LITE__', provider: 'Google Gemini', tier: 'economico' },
  'gemini-flash': { model: '__MODEL_FLASH__', provider: 'Google Gemini', tier: 'balanceado', reasoning: 'low' },
  'gemini-pro': { model: '__MODEL_PRO__', provider: 'Google Gemini', tier: 'premium', reasoning: 'low' }
};

var COMPLEX = /(analiz|compar|paso a paso|estrategi|dise[n\u00f1]|arquitectur|evalu|riesgo|roadmap|planific|optimiz|c[o\u00f3]digo|detallad|pros y contras|ventajas y desventajas|justific|razon)/i;

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}

var body;
try { body = JSON.parse(v('request.content') || '{}'); } catch (e) { body = {}; }

var requested = String(body.model || 'auto');
var strategy = (v('request.header.x-aigw-routing').toLowerCase() === 'auto' || requested === 'auto') ? 'auto' : 'explicit';

var prompt = '';
if (body.messages && body.messages.length) {
  var lastMsg = body.messages[body.messages.length - 1];
  prompt = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content || '');
}

var key;
var reason;
if (strategy === 'auto') {
  var words = prompt.split(/\s+/).filter(function (w) { return w.length > 0; }).length;
  if (COMPLEX.test(prompt) || words > 45) {
    key = 'gemini-pro';
    reason = 'Tarea compleja (analisis o razonamiento): modelo premium';
  } else if (words <= 18) {
    key = 'gemini-flash-lite';
    reason = 'Pregunta simple: modelo liviano y de menor costo';
  } else {
    key = 'gemini-flash';
    reason = 'Complejidad media: modelo balanceado';
  }
} else if (CATALOG[requested]) {
  key = requested;
  reason = 'Modelo elegido por el cliente';
} else {
  // A real model id (e.g. google/gemini-3.5-flash-lite) is passed through.
  key = null;
  reason = 'Modelo real enviado por el cliente';
}

var route = key ? CATALOG[key] : { model: requested, provider: requested.indexOf('openai/') === 0 ? 'OpenAI (Model Garden)' : 'Google Gemini', tier: 'custom' };

body.model = route.model;
if (route.reasoning && !body.reasoning_effort) { body.reasoning_effort = route.reasoning; }
// Reasoning models spend part of max_tokens on thinking: keep a minimum budget for the answer.
if (route.reasoning && (!body.max_tokens || body.max_tokens < 1500)) { body.max_tokens = 1500; }

context.setVariable('request.content', JSON.stringify(body));
context.setVariable('aigw.model', route.model);
context.setVariable('aigw.provider', route.provider);
context.setVariable('aigw.tier', route.tier);
context.setVariable('aigw.routing', strategy);
context.setVariable('aigw.route_reason', reason);
context.setVariable('aigw.virtual_model', key || requested);
