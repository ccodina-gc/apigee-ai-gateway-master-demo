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
 * aigw-sse.js - runs in the EventFlow for every Server-Sent Event.
 * Counts events and keeps a short preview of the streamed text (OpenAI chunks:
 * choices[0].delta.content) plus the usage of the final chunk, for Cloud Logging.
 * The event itself is forwarded to the client untouched (no buffering).
 */
function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}

var count = parseInt(v('aigw.sse_events') || '0', 10) + 1;
context.setVariable('aigw.sse_events', String(count));

var raw = v('response.event.current.content');
var lines = raw.split('\n');
for (var i = 0; i < lines.length; i++) {
  var line = lines[i].replace(/^data:\s?/, '').trim();
  if (!line || line === '[DONE]' || line.charAt(0) !== '{') { continue; }
  try {
    var j = JSON.parse(line);
    var c = j.choices && j.choices[0];
    var delta = c && c.delta && c.delta.content;
    if (delta) {
      var acc = v('aigw.stream_text');
      if (acc.length < 400) { context.setVariable('aigw.stream_text', acc + delta); }
    }
    if (j.usage && j.usage.total_tokens) {
      context.setVariable('aigw.usage.prompt', String(j.usage.prompt_tokens || ''));
      context.setVariable('aigw.usage.completion', String(j.usage.completion_tokens || ''));
      context.setVariable('aigw.usage.total', String(j.usage.total_tokens));
    }
    if (j.model) { context.setVariable('aigw.served_model', String(j.model)); }
    if (j.jsonrpc && j.result) { context.setVariable('aigw.mcp.result_events', String(count)); }
  } catch (e) {
    // Non JSON event: ignore.
  }
}

// JS-Finalize built aigw.log_json before the stream started: refresh it with SSE stats.
var logJson = v('aigw.log_json');
if (logJson) {
  try {
    var entry = JSON.parse(logJson);
    entry.sseEvents = String(count);
    if (v('aigw.stream_text')) { entry.responsePreview = v('aigw.stream_text'); }
    if (v('aigw.usage.total')) { entry.usageTotalTokens = v('aigw.usage.total'); }
    if (v('aigw.served_model')) { entry.servedModel = v('aigw.served_model'); }
    context.setVariable('aigw.log_json', JSON.stringify(entry));
  } catch (e2) {
    // keep the original entry
  }
}
