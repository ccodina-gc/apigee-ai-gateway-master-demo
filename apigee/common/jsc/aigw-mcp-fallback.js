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
 * aigw-mcp-fallback.js - built-in MCP server used ONLY while the Apigee managed MCP server
 * (ORG.mcp.apigee.internal) is not reachable, e.g. while the MCP Discovery Proxy is still
 * provisioning. It runs in a target FaultRule of aigw-mcp-retail.
 *
 * Same tool catalog the MCP Discovery Proxy generates from resources/oas/retail-openapi.yaml
 * (tool name = operationId). tools/list is filtered with apiproduct.operation.payload.tools,
 * the tools allowed by the app's API product (the same data the managed server uses).
 * Tool access and per-tool quotas were already enforced by VerifyAPIKey + Quota.
 *
 * Output: aigw.mcp_fb.status / aigw.mcp_fb.reason / aigw.mcp_fb.body (AM-McpFallbackResponse)
 */
var RETAIL_BASE = 'https://__APIGEE_HOST__/v1/aigw/retail';

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}
function str(p) { return { type: 'string', description: p }; }

var TOOLS = [
  {
    name: 'searchProducts',
    description: 'Buscar productos en el catalogo. Busca productos por texto libre, categoria o precio maximo. Devuelve SKU, nombre, precio y stock total.',
    inputSchema: {
      type: 'object',
      properties: {
        q: str('Texto a buscar, por ejemplo "televisor" o "notebook".'),
        category: { type: 'string', description: 'Categoria del producto.', 'enum': ['tv', 'celulares', 'notebooks', 'electrodomesticos', 'audio'] },
        maxPrice: { type: 'number', description: 'Precio maximo en USD.' }
      }
    },
    http: { method: 'GET', path: '/products', query: ['q', 'category', 'maxPrice'] }
  },
  {
    name: 'getProduct',
    description: 'Detalle y stock de un producto. Devuelve el detalle de un producto y su stock en cada tienda.',
    inputSchema: { type: 'object', properties: { sku: str('SKU del producto, por ejemplo TV-55-QLED.') }, required: ['sku'] },
    http: { method: 'GET', path: '/products/{sku}' }
  },
  {
    name: 'listStores',
    description: 'Listar tiendas. Lista las tiendas de Cymbal Retail, opcionalmente filtradas por ciudad.',
    inputSchema: { type: 'object', properties: { city: str('Ciudad, por ejemplo "Buenos Aires" o "Lima".') } },
    http: { method: 'GET', path: '/stores', query: ['city'] }
  },
  {
    name: 'createOrder',
    description: 'Crear una orden de compra. Crea una orden de compra para retirar en una tienda.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: str('SKU del producto.'),
        quantity: { type: 'integer', description: 'Cantidad de unidades.' },
        storeId: str('Tienda de retiro, por ejemplo STR-01.')
      },
      required: ['sku', 'quantity', 'storeId']
    },
    http: { method: 'POST', path: '/orders', body: ['sku', 'quantity', 'storeId'] }
  },
  {
    name: 'getOrderStatus',
    description: 'Estado de una orden. Devuelve el estado y la fecha estimada de entrega de una orden.',
    inputSchema: { type: 'object', properties: { orderId: str('Identificador de la orden, por ejemplo ORD-1001.') }, required: ['orderId'] },
    http: { method: 'GET', path: '/orders/{orderId}' }
  },
  {
    name: 'cancelOrder',
    description: 'Cancelar una orden. Cancela una orden existente e inicia el reembolso. Operacion sensible.',
    inputSchema: { type: 'object', properties: { orderId: str('Identificador de la orden a cancelar.') }, required: ['orderId'] },
    http: { method: 'POST', path: '/orders/{orderId}/cancel' }
  }
];

var req;
try { req = JSON.parse(v('request.content') || '{}'); } catch (e) { req = {}; }
var id = (req.id === undefined) ? null : req.id;
var method = String(req.method || '');
var params = req.params || {};

function reply(status, reason, payload) {
  context.setVariable('aigw.mcp_fb.status', String(status));
  context.setVariable('aigw.mcp_fb.reason', reason);
  context.setVariable('aigw.mcp_fb.body', payload === null ? '' : JSON.stringify(payload));
}
function result(r) { reply(200, 'OK', { jsonrpc: '2.0', id: id, result: r }); }
function rpcError(status, code, message) {
  reply(status, status === 200 ? 'OK' : 'Bad Request', { jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}
function find(name) {
  for (var i = 0; i < TOOLS.length; i++) { if (TOOLS[i].name === name) { return TOOLS[i]; } }
  return null;
}

// Tools allowed by the app's API product (empty = no product filter available).
var allowed = v('apiproduct.operation.payload.tools');
var allowList = allowed ? allowed.split(',') : null;

context.setVariable('aigw.mcp.server', 'fallback');

if (method === 'initialize') {
  result({
    protocolVersion: params.protocolVersion || '2025-11-25',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'cymbal-retail (fallback de Apigee)', version: '1.0.0' }
  });
} else if (method.indexOf('notifications/') === 0) {
  reply(202, 'Accepted', null);
} else if (method === 'ping') {
  result({});
} else if (method === 'tools/list') {
  var tools = [];
  for (var t = 0; t < TOOLS.length; t++) {
    var tool = TOOLS[t];
    if (allowList && allowList.indexOf(tool.name) < 0) { continue; }
    tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
  }
  result({ tools: tools });
} else if (method === 'tools/call') {
  var def = find(String(params.name || ''));
  if (!def) {
    rpcError(200, -32602, 'Herramienta desconocida: ' + params.name);
  } else {
    var args = params.arguments || {};
    if (args.body && typeof args.body === 'object') { args = args.body; }
    var path = def.http.path.replace(/\{(\w+)\}/g, function (m, k) { return encodeURIComponent(String(args[k] || '')); });
    var qs = [];
    var q = def.http.query || [];
    for (var j = 0; j < q.length; j++) {
      if (args[q[j]] !== undefined && args[q[j]] !== null && args[q[j]] !== '') {
        qs.push(q[j] + '=' + encodeURIComponent(String(args[q[j]])));
      }
    }
    var url = RETAIL_BASE + path + (qs.length ? '?' + qs.join('&') : '');
    var body = null;
    if (def.http.body) {
      body = {};
      for (var b = 0; b < def.http.body.length; b++) { body[def.http.body[b]] = args[def.http.body[b]]; }
    }
    var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    var exchange = httpClient.send(new Request(url, def.http.method, headers, body ? JSON.stringify(body) : ''));
    exchange.waitForComplete(8000);
    if (exchange.isSuccess()) {
      var resp = exchange.getResponse();
      var code = parseInt(String(resp.status.code), 10);
      var text = String(resp.content || '');
      var out = { content: [{ type: 'text', text: text }], isError: code >= 400 };
      try { var parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !(parsed instanceof Array)) { out.structuredContent = parsed; } } catch (e3) { /* plain text */ }
      result(out);
    } else {
      result({ content: [{ type: 'text', text: 'No se pudo llamar a la API de Cymbal Retail: ' + String(exchange.getError()) }], isError: true });
    }
  }
} else {
  rpcError(200, -32601, 'Metodo no soportado: ' + method);
}
