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
 * aigw-provider-routing.js - Header-driven multi-target LLM routing (modeled after llm-routing).
 *
 * Modes (via policy property "mode"):
 *   validate      - Validates x-llm-provider (or llm-provider) header -> sets modelProvider
 *                   ("google" | "anthropic") before KVM-GetModelProviderConfig and RouteRules.
 *   google        - Prepares the OpenAI-compatible Vertex AI payload for gemini-3.5-flash
 *                   and resolves targetUrlTemplate from the Apigee KVM.
 *   anthropic_req - Mediates an OpenAI Chat Completions request into Vertex AI Model Garden's
 *                   Anthropic Messages API (:rawPredict) payload for claude-sonnet-5-5.
 *   anthropic_res - Mediates Anthropic's :rawPredict response (or Model Garden errors) back
 *                   into the standard OpenAI Chat Completions JSON shape.
 */
var mode = String(properties.mode || '');

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}

function parseJson(s) {
  if (!s) { return null; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function extractText(content) {
  if (typeof content === 'string') { return content; }
  if (content && content.length !== undefined && typeof content !== 'string') {
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var p = content[i];
      if (typeof p === 'string') { parts.push(p); }
      else if (p && typeof p.text === 'string') { parts.push(p.text); }
    }
    if (parts.length > 0) { return parts.join('\n'); }
  }
  return content ? JSON.stringify(content) : '';
}

var DEFAULT_GOOGLE_URL = 'https://__LLM_HOST__/v1/projects/__PROJECT_ID__/locations/__LLM_LOCATION__/endpoints/openapi/chat/completions';
var DEFAULT_GOOGLE_MODEL = '__ROUTING_GEMINI_MODEL__';
var DEFAULT_ANTHROPIC_URL = 'https://__ROUTING_CLAUDE_HOST__/v1/projects/__PROJECT_ID__/locations/__ROUTING_CLAUDE_LOCATION__/publishers/anthropic/models/__ROUTING_CLAUDE_MODEL__:rawPredict';
var DEFAULT_ANTHROPIC_MODEL = '__ROUTING_CLAUDE_MODEL__';

if (mode === 'validate') {
  var body = parseJson(v('request.content')) || {};
  if (body.messages && body.messages.length) {
    var lastMsg = body.messages[body.messages.length - 1];
    var promptText = extractText(lastMsg && lastMsg.content);
    if (promptText !== '') { context.setVariable('aigw.prompt', promptText); }
  }

  var raw = v('rawProvider');
  var providerHeader = 'x-llm-provider';
  if (raw === '') {
    raw = v('altProvider');
    if (raw !== '') { providerHeader = 'llm-provider'; }
  }
  if (raw === '') {
    raw = v('request.header.x-llm-provider');
    if (raw === '') {
      raw = v('request.header.llm-provider');
      if (raw !== '') { providerHeader = 'llm-provider'; }
    }
  }
  var provider = raw.replace(/^\s+|\s+$/g, '').toLowerCase();

  context.setVariable('aigw.provider_header', providerHeader);
  context.setVariable('aigw.routing', 'header:' + providerHeader);

  if (provider === '') {
    context.setVariable('aigw.invalid_provider', 'true');
    context.setVariable('aigw.provider_error_code', 'MISSING_LLM_PROVIDER');
    context.setVariable('aigw.provider_error_msg',
      "Falta el header x-llm-provider (alias: llm-provider). Envia 'x-llm-provider: google' (gemini-3.5-flash) o 'x-llm-provider: anthropic' (claude-sonnet-5-5 en Model Garden).");
    context.setVariable('aigw.route_reason', 'Rechazado: falta el header x-llm-provider / llm-provider');
  } else if (provider !== 'google' && provider !== 'anthropic') {
    var safeProv = provider.replace(/[^a-z0-9._-]/g, '').substring(0, 40);
    context.setVariable('aigw.invalid_provider', 'true');
    context.setVariable('aigw.llm_provider', safeProv);
    context.setVariable('aigw.provider_error_code', 'UNSUPPORTED_LLM_PROVIDER');
    context.setVariable('aigw.provider_error_msg',
      "Proveedor '" + safeProv + "' no soportado. Valores permitidos en x-llm-provider: 'google' (gemini-3.5-flash) o 'anthropic' (claude-sonnet-5-5).");
    context.setVariable('aigw.route_reason', "Rechazado: x-llm-provider '" + safeProv + "' no esta configurado en el KVM");
  } else {
    context.setVariable('modelProvider', provider);
    context.setVariable('aigw.llm_provider', provider);
  }
} else if (mode === 'google') {
  var gUrl = v('targetUrlTemplate') || DEFAULT_GOOGLE_URL;
  var gDefaultModel = v('providerDefaultModel') || DEFAULT_GOOGLE_MODEL;
  context.setVariable('targetUrlTemplate', gUrl);
  context.setVariable('target.copy.pathsuffix', false);

  var gBody = parseJson(v('request.content')) || {};
  var reqModel = String(gBody.model || '').replace(/^\s+|\s+$/g, '');
  var gModel = gDefaultModel;
  if (reqModel === 'gemini-3.5-flash') {
    gModel = 'google/gemini-3.5-flash';
  } else if (reqModel.indexOf('google/') === 0) {
    gModel = reqModel;
  }
  gBody.model = gModel;
  delete gBody.safe_prompt;
  if (!gBody.reasoning_effort) { gBody.reasoning_effort = 'minimal'; }
  if (!gBody.max_tokens || gBody.max_tokens < 1024) { gBody.max_tokens = 1024; }

  context.setVariable('request.content', JSON.stringify(gBody));
  context.setVariable('aigw.provider', 'Google Vertex AI');
  context.setVariable('aigw.model', gModel);
  context.setVariable('aigw.target_endpoint', 'google');
  context.setVariable('aigw.tier', 'google');
  context.setVariable('aigw.route_reason', 'Header ' + (v('aigw.provider_header') || 'x-llm-provider') + ': google -> TargetEndpoint google (' + gModel + ' via KVM)');
} else if (mode === 'anthropic_req') {
  var aUrl = v('targetUrlTemplate') || DEFAULT_ANTHROPIC_URL;
  var aDefaultModel = v('providerDefaultModel') || DEFAULT_ANTHROPIC_MODEL;

  var aBody = parseJson(v('request.content')) || {};
  var rawModel = String(aBody.model || '').replace(/^\s+|\s+$/g, '').replace(/^anthropic\//, '');
  var claudeModel = (rawModel.indexOf('claude-') === 0) ? rawModel : aDefaultModel;
  if (claudeModel !== aDefaultModel && aUrl.indexOf('/models/' + aDefaultModel + ':') >= 0) {
    aUrl = aUrl.replace('/models/' + aDefaultModel + ':', '/models/' + claudeModel + ':');
  }
  context.setVariable('targetUrlTemplate', aUrl);
  context.setVariable('target.copy.pathsuffix', false);

  var sysParts = [];
  var anthroMsgs = [];
  var inMsgs = aBody.messages || [];
  for (var m = 0; m < inMsgs.length; m++) {
    var msg = inMsgs[m];
    if (!msg) { continue; }
    var role = String(msg.role || 'user').toLowerCase();
    var txt = extractText(msg.content);
    if (role === 'system' || role === 'developer') {
      if (txt) { sysParts.push(txt); }
    } else {
      anthroMsgs.push({
        role: role === 'assistant' ? 'assistant' : 'user',
        content: txt
      });
    }
  }
  if (anthroMsgs.length === 0) {
    anthroMsgs.push({ role: 'user', content: 'Hola' });
  }

  var maxTok = parseInt(aBody.max_tokens, 10);
  if (isNaN(maxTok) || maxTok < 64) { maxTok = 1024; }
  var rawPredictPayload = {
    anthropic_version: 'vertex-2023-10-16',
    max_tokens: maxTok,
    messages: anthroMsgs
  };
  if (sysParts.length > 0) {
    rawPredictPayload.system = sysParts.join('\n\n');
  }
  // Claude 4.x/5.x rejects requests specifying both temperature and top_p simultaneously.
  if (typeof aBody.temperature === 'number') {
    rawPredictPayload.temperature = aBody.temperature;
  } else if (typeof aBody.top_p === 'number') {
    rawPredictPayload.top_p = aBody.top_p;
  }

  context.setVariable('request.content', JSON.stringify(rawPredictPayload));
  context.setVariable('aigw.provider', 'Anthropic (Model Garden)');
  context.setVariable('aigw.model', claudeModel);
  context.setVariable('aigw.target_endpoint', 'anthropic');
  context.setVariable('aigw.tier', 'anthropic');
  context.setVariable('aigw.route_reason', 'Header ' + (v('aigw.provider_header') || 'x-llm-provider') + ': anthropic -> TargetEndpoint anthropic (' + claudeModel + ' en Model Garden via KVM)');
} else if (mode === 'anthropic_res') {
  var status = parseInt(v('response.status.code') || '0', 10);
  var rawRes = v('response.content');
  var parsed = parseJson(rawRes);
  var servedModel = v('aigw.model') || DEFAULT_ANTHROPIC_MODEL;

  if (status === 200 && parsed && parsed.content) {
    var outText = '';
    for (var c = 0; c < parsed.content.length; c++) {
      var blk = parsed.content[c];
      if (blk && blk.type === 'text' && typeof blk.text === 'string') {
        outText += blk.text;
      }
    }
    var stop = String(parsed.stop_reason || 'end_turn');
    var finish = (stop === 'max_tokens') ? 'length' : 'stop';
    var inTok = (parsed.usage && typeof parsed.usage.input_tokens === 'number') ? parsed.usage.input_tokens : 0;
    var outTok = (parsed.usage && typeof parsed.usage.output_tokens === 'number') ? parsed.usage.output_tokens : 0;
    var actualModel = parsed.model ? String(parsed.model) : servedModel;

    var chatCompletion = {
      id: parsed.id || ('chatcmpl-' + v('messageid')),
      object: 'chat.completion',
      created: Math.floor(new Date().getTime() / 1000),
      model: actualModel,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: outText },
        finish_reason: finish
      }],
      usage: {
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: inTok + outTok
      }
    };
    context.setVariable('response.content', JSON.stringify(chatCompletion));
    context.setVariable('response.header.Content-Type', 'application/json');
  } else if ((status === 404 || status === 403) && rawRes.indexOf('publishers/anthropic/models/') >= 0) {
    var mgErr = {
      error: {
        type: 'model_garden_access',
        code: 'MODEL_GARDEN_NOT_ENABLED',
        status: status,
        proxy: v('apiproxy.name'),
        requestId: v('messageid'),
        message: 'Apigee enruto correctamente la llamada al TargetEndpoint "anthropic" (publishers/anthropic/models/' + servedModel + ':rawPredict via KVM), pero el proyecto __PROJECT_ID__ aun requiere habilitar el modelo de Anthropic por unica vez en Vertex AI Model Garden.',
        details: {
          llmProvider: 'anthropic',
          targetEndpoint: 'anthropic',
          model: servedModel,
          endpoint: 'publishers/anthropic/models/' + servedModel + ':rawPredict'
        }
      }
    };
    context.setVariable('response.content', JSON.stringify(mgErr));
    context.setVariable('response.header.Content-Type', 'application/json');
  } else if (status >= 400) {
    var upMsg = (parsed && parsed.error && parsed.error.message) ? parsed.error.message : rawRes.substring(0, 300);
    var upErr = {
      error: {
        type: 'upstream_error',
        code: 'ANTHROPIC_UPSTREAM_' + status,
        status: status,
        proxy: v('apiproxy.name'),
        requestId: v('messageid'),
        message: upMsg,
        details: {
          llmProvider: 'anthropic',
          targetEndpoint: 'anthropic',
          model: servedModel
        }
      }
    };
    context.setVariable('response.content', JSON.stringify(upErr));
    context.setVariable('response.header.Content-Type', 'application/json');
  }
}
