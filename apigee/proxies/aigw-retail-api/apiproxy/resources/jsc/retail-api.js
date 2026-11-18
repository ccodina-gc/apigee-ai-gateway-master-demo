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
 * retail-api.js - mock "Cymbal Retail" REST API (catalog, stores, orders).
 * It is the backend of the MCP Discovery Proxy: Apigee turns each OpenAPI operation
 * of this API into an MCP tool (searchProducts, getProduct, listStores,
 * getOrderStatus, createOrder, cancelOrder).
 */
var PRODUCTS = [
  { sku: 'TV-55-QLED', name: 'Smart TV QLED 55" 4K', category: 'tv', price: 899, keywords: 'televisor tv tele smart qled 4k', stock: { 'STR-01': 12, 'STR-02': 4, 'STR-03': 0, 'STR-05': 7 } },
  { sku: 'TV-65-OLED', name: 'Smart TV OLED 65" 4K', category: 'tv', price: 1899, keywords: 'televisor tv tele smart oled 4k', stock: { 'STR-01': 3, 'STR-04': 2, 'STR-06': 5 } },
  { sku: 'TV-43-LED', name: 'Smart TV LED 43" Full HD', category: 'tv', price: 349, keywords: 'televisor tv tele smart led', stock: { 'STR-01': 20, 'STR-02': 15, 'STR-03': 9, 'STR-06': 11 } },
  { sku: 'CEL-PRO-256', name: 'Smartphone Pro 256 GB', category: 'celulares', price: 1099, keywords: 'celular telefono smartphone movil', stock: { 'STR-01': 8, 'STR-02': 6, 'STR-05': 4 } },
  { sku: 'CEL-LITE-128', name: 'Smartphone Lite 128 GB', category: 'celulares', price: 399, keywords: 'celular telefono smartphone movil', stock: { 'STR-01': 25, 'STR-03': 14, 'STR-04': 10, 'STR-06': 9 } },
  { sku: 'NB-14-I7', name: 'Notebook 14" Core i7 16 GB', category: 'notebooks', price: 1299, keywords: 'notebook laptop computadora portatil', stock: { 'STR-01': 5, 'STR-02': 2 } },
  { sku: 'NB-15-R5', name: 'Notebook 15" Ryzen 5 8 GB', category: 'notebooks', price: 749, keywords: 'notebook laptop computadora portatil', stock: { 'STR-03': 6, 'STR-04': 4, 'STR-05': 3 } },
  { sku: 'HEL-NF-400', name: 'Heladera No Frost 400 L', category: 'electrodomesticos', price: 1199, keywords: 'heladera refrigerador nevera frio', stock: { 'STR-01': 4, 'STR-03': 2, 'STR-06': 3 } },
  { sku: 'LAV-8KG', name: 'Lavarropas inverter 8 kg', category: 'electrodomesticos', price: 629, keywords: 'lavarropas lavadora ropa', stock: { 'STR-02': 6, 'STR-04': 5 } },
  { sku: 'AUD-SB-300', name: 'Barra de sonido 300 W', category: 'audio', price: 279, keywords: 'barra sonido parlante audio', stock: { 'STR-01': 10, 'STR-05': 6 } },
  { sku: 'AUD-BT-ANC', name: 'Auriculares Bluetooth con cancelacion de ruido', category: 'audio', price: 199, keywords: 'auriculares audifonos bluetooth', stock: { 'STR-01': 30, 'STR-02': 18, 'STR-06': 12 } }
];
var STORES = [
  { storeId: 'STR-01', name: 'Cymbal Centro', city: 'Buenos Aires', address: 'Av. Corrientes 1234', hours: '09:00-21:00' },
  { storeId: 'STR-02', name: 'Cymbal Palermo', city: 'Buenos Aires', address: 'Av. Santa Fe 3200', hours: '10:00-22:00' },
  { storeId: 'STR-03', name: 'Cymbal Cordoba', city: 'Cordoba', address: 'Av. Colon 550', hours: '09:00-20:00' },
  { storeId: 'STR-04', name: 'Cymbal Rosario', city: 'Rosario', address: 'Bv. Orono 900', hours: '09:00-20:00' },
  { storeId: 'STR-05', name: 'Cymbal Providencia', city: 'Santiago', address: 'Av. Providencia 1500', hours: '10:00-21:00' },
  { storeId: 'STR-06', name: 'Cymbal Miraflores', city: 'Lima', address: 'Av. Larco 700', hours: '10:00-22:00' }
];
var ORDERS = {
  'ORD-1001': { orderId: 'ORD-1001', status: 'En camino', items: [{ sku: 'TV-55-QLED', quantity: 1 }], storeId: 'STR-01', total: 899, currency: 'USD', estimatedDelivery: '2026-11-18', carrier: 'Cymbal Express' },
  'ORD-1002': { orderId: 'ORD-1002', status: 'Entregada', items: [{ sku: 'AUD-BT-ANC', quantity: 2 }], storeId: 'STR-02', total: 398, currency: 'USD', deliveredAt: '2026-11-10' },
  'ORD-1003': { orderId: 'ORD-1003', status: 'Preparando', items: [{ sku: 'NB-14-I7', quantity: 1 }], storeId: 'STR-01', total: 1299, currency: 'USD', estimatedDelivery: '2026-11-21' }
};

function v(name) {
  var x = context.getVariable(name);
  return (x === null || x === undefined) ? '' : String(x);
}
function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u00e1\u00e0\u00e4]/g, 'a').replace(/[\u00e9\u00e8\u00eb]/g, 'e')
    .replace(/[\u00ed\u00ec\u00ef]/g, 'i').replace(/[\u00f3\u00f2\u00f6]/g, 'o')
    .replace(/[\u00fa\u00f9\u00fc]/g, 'u').replace(/\u00f1/g, 'n').trim();
}
function stockTotal(p) {
  var t = 0;
  for (var k in p.stock) { if (p.stock.hasOwnProperty(k)) { t += p.stock[k]; } }
  return t;
}
function summary(p) {
  return { sku: p.sku, name: p.name, category: p.category, price: p.price, currency: 'USD', stockTotal: stockTotal(p) };
}
function send(status, body) {
  context.setVariable('response.status.code', String(status));
  context.setVariable('response.header.Content-Type', 'application/json');
  context.setVariable('response.content', JSON.stringify(body));
}
function findProduct(sku) {
  for (var i = 0; i < PRODUCTS.length; i++) { if (norm(PRODUCTS[i].sku) === norm(sku)) { return PRODUCTS[i]; } }
  return null;
}

var verb = v('request.verb');
var path = v('proxy.pathsuffix').replace(/\/+$/, '');
var m;

if (verb === 'GET' && path === '/products') {
  var q = norm(v('request.queryparam.q'));
  var cat = norm(v('request.queryparam.category'));
  var max = parseFloat(v('request.queryparam.maxPrice'));
  var items = [];
  for (var i = 0; i < PRODUCTS.length; i++) {
    var p = PRODUCTS[i];
    var text = norm(p.name + ' ' + p.keywords + ' ' + p.category);
    if (q && text.indexOf(q) < 0) { continue; }
    if (cat && norm(p.category) !== cat) { continue; }
    if (!isNaN(max) && p.price > max) { continue; }
    items.push(summary(p));
  }
  send(200, { count: items.length, items: items });
} else if (verb === 'GET' && (m = path.match(/^\/products\/([^\/]+)$/))) {
  var prod = findProduct(decodeURIComponent(m[1]));
  if (!prod) {
    send(404, { error: 'Producto no encontrado', sku: m[1] });
  } else {
    var byStore = [];
    for (var s in prod.stock) { if (prod.stock.hasOwnProperty(s)) { byStore.push({ storeId: s, units: prod.stock[s] }); } }
    var d = summary(prod);
    d.stockByStore = byStore;
    send(200, d);
  }
} else if (verb === 'GET' && path === '/stores') {
  var city = norm(v('request.queryparam.city'));
  var stores = [];
  for (var j = 0; j < STORES.length; j++) {
    if (!city || norm(STORES[j].city).indexOf(city) >= 0) { stores.push(STORES[j]); }
  }
  send(200, { count: stores.length, items: stores });
} else if (verb === 'GET' && (m = path.match(/^\/orders\/([^\/]+)$/))) {
  var order = ORDERS[decodeURIComponent(m[1]).toUpperCase()];
  if (order) { send(200, order); } else { send(404, { error: 'Orden no encontrada', orderId: m[1] }); }
} else if (verb === 'POST' && path === '/orders') {
  var b;
  try { b = JSON.parse(v('request.content') || '{}'); } catch (e) { b = {}; }
  var po = findProduct(b.sku);
  var qty = parseInt(b.quantity || '1', 10);
  if (!po) {
    send(400, { error: 'SKU invalido', sku: b.sku || null });
  } else if (!b.storeId || po.stock[b.storeId] === undefined || po.stock[b.storeId] < qty) {
    send(409, { error: 'Sin stock suficiente en la tienda', sku: po.sku, storeId: b.storeId || null });
  } else {
    var id = 'ORD-' + (2000 + Math.floor(Math.random() * 8000));
    send(201, { orderId: id, status: 'Confirmada', items: [{ sku: po.sku, quantity: qty }], storeId: b.storeId, total: po.price * qty, currency: 'USD', estimatedDelivery: '2026-11-20' });
  }
} else if (verb === 'POST' && (m = path.match(/^\/orders\/([^\/]+)\/cancel$/))) {
  send(200, { orderId: decodeURIComponent(m[1]).toUpperCase(), status: 'Cancelada', refund: 'En proceso' });
} else {
  send(404, { error: 'Recurso no encontrado', path: path, verb: verb });
}
