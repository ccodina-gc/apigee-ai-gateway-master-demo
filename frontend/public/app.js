/**
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

// AI Gateway demo portal: vanilla single-page app (ES module, no build step).

import { CAPABILITIES, chat } from './scenarios.js';

/* ════════════════════════════════ Constants ════════════════════════════════ */

const TABS = [
  { id: 'response', label: 'Respuesta', icon: 'forum' },
  { id: 'json', label: 'JSON', icon: 'data_object' },
  { id: 'request', label: 'Request', icon: 'upload' },
  { id: 'curl', label: 'cURL', icon: 'terminal' },
  { id: 'log', label: 'Log de Apigee', icon: 'receipt_long' },
];

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved', 302: 'Found',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  408: 'Timeout', 413: 'Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
  500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable', 504: 'Gateway Timeout',
};

const ERROR_INFO = {
  model_armor_block: { icon: 'shield', tone: 'red', title: 'Bloqueado por Model Armor', short: 'Model Armor' },
  prompt_token_limit: { icon: 'straighten', tone: 'yellow', title: 'Prompt demasiado grande', short: 'Prompt grande' },
  llm_token_quota: { icon: 'hourglass_bottom', tone: 'yellow', title: 'Cuota de tokens agotada', short: 'Cuota agotada' },
  invalid_llm_provider: { icon: 'alt_route', tone: 'yellow', title: 'Header x-llm-provider inválido o ausente', short: 'Header inválido' },
  model_garden_access: { icon: 'lock_open', tone: 'yellow', title: 'Habilitación pendiente en Model Garden', short: 'Model Garden' },
  unauthorized: { icon: 'key_off', tone: 'red', title: 'API key inválida o ausente', short: 'Sin acceso' },
  upstream_error: { icon: 'cloud_off', tone: 'red', title: 'Error del modelo o backend', short: 'Backend' },
  mcp_tool_not_allowed: { icon: 'block', tone: 'red', title: 'Herramienta no autorizada', short: 'Tool bloqueada' },
  mcp_tool_quota: { icon: 'speed', tone: 'yellow', title: 'Cuota de la herramienta agotada', short: 'Cuota tool' },
  tool_error: { icon: 'build', tone: 'red', title: 'La herramienta devolvió un error', short: 'Error tool' },
  portal_error: { icon: 'error', tone: 'red', title: 'Error del portal', short: 'Portal' },
};
const DEFAULT_ERROR = { icon: 'error', title: 'Error del backend', tone: 'red', short: 'Error' };

// Apigee default fault codes (when the proxy does not return the AI Gateway error format).
const FAULTS = [
  [/ApplicationNotFound/i, { icon: 'cloud_off', tone: 'yellow', title: 'Proxy no desplegado', short: 'Sin proxy' }],
  [/ApiKey|InvalidClientId/i, ERROR_INFO.unauthorized],
  [/QuotaViolation/i, { icon: 'speed', tone: 'yellow', title: 'Cuota excedida', short: 'Cuota' }],
  [/SpikeArrest/i, { icon: 'speed', tone: 'yellow', title: 'Spike Arrest', short: 'Spike Arrest' }],
];

const ARMOR_FILTERS = [
  { id: 'pi_and_jailbreak', label: 'Jailbreak', icon: 'gpp_maybe' },
  { id: 'sdp', label: 'Datos sensibles', icon: 'credit_card' },
  { id: 'malicious_uris', label: 'URLs maliciosas', icon: 'link_off' },
  { id: 'rai', label: 'IA responsable', icon: 'diversity_3' },
  { id: 'csam', label: 'CSAM', icon: 'child_care' },
];
const FILTER_PATTERNS = [
  ['pi_and_jailbreak', /jailbreak|injection|^pi_/i],
  ['csam', /csam|child|infantil/i],
  ['malicious_uris', /uri|url|malicious|malicios/i],
  ['sdp', /sdp|sensitive|sensib|dlp|pii|tarjeta/i],
  ['rai', /rai|danger|peligros|harass|acoso|hate|odio|sexual/i],
];

const ROUTING_TARGETS = [
  { id: 'google', label: 'google · gemini-3.5-flash', icon: 'flash_on' },
  { id: 'anthropic', label: 'anthropic · claude-sonnet-5-5', icon: 'deployed_code' },
];

const PIPELINE = [
  { id: 'key', label: 'API Key', icon: 'key' },
  { id: 'ptl', label: 'Token limit', icon: 'straighten' },
  { id: 'quota', label: 'Cuota', icon: 'data_usage' },
  { id: 'armorIn', label: 'Armor prompt', icon: 'shield' },
  { id: 'cache', label: 'Caché', icon: 'bolt' },
  { id: 'route', label: 'Routing', icon: 'alt_route' },
  { id: 'backend', label: 'Backend', icon: 'dns' },
  { id: 'armorOut', label: 'Armor resp.', icon: 'verified_user' },
  { id: 'log', label: 'Log', icon: 'receipt_long' },
];
const PIPE_MARKS = { ok: 'check', hit: 'bolt', fail: 'close', warn: 'swap_horiz', skip: 'remove' };

const KEY_LABELS = { demo: 'Key demo · Bronze', gold: 'Key gold · Gold', none: 'Sin API key' };
const SECRET_KEY_RE = /api[-_]?key|apikey|client[-_]?secret|authorization|password|passcode/i;
const BACKEND_CHIP_RE = /^(gemini|vertex|retail api|bigquery|model garden|flash|backend)/i;
const LOG_POLL_TRIES = 12;
const LOG_POLL_MS = 2000;

/* ═════════════════════════════════ State ═══════════════════════════════════ */

const state = {
  config: {
    apigeeHost: '',
    apigeeEnv: 'eval',
    projectId: '',
    region: 'us-east1',
    defaultModel: 'google/gemini-3.5-flash-lite',
    logName: 'aigw-demo',
    keys: { demo: false, gold: false },
  },
  route: 'home',
  tab: 'response',
  showHeaders: false,
  sessions: Object.fromEntries(CAPABILITIES.map((cap) => [cap.id, newSession()])),
};
let runCounter = 0;

function newSession() {
  return { run: null, topic: 0, last: null, lastByScenario: {}, cacheCalls: [], quota: {}, circuit: null, regions: {} };
}

const capById = (id) => CAPABILITIES.find((cap) => cap.id === id);
const resolve = (value, ctx) => (typeof value === 'function' ? value(ctx) : value);
const makeCtx = (cap) => ({ topic: cap.topics?.[state.sessions[cap.id].topic], config: state.config });
const selectedIndex = (run) => run.selected ?? run.steps.length - 1;
const selectedResult = (session) => (session.run ? session.run.steps[selectedIndex(session.run)] || null : null);

/* ══════════════════════════════ DOM helpers ════════════════════════════════ */

const $ = (selector, root = document) => root.querySelector(selector);

/** Tiny hyperscript: h('div', {class, onclick, ...attrs}, ...children). Text is never parsed as HTML. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const icon = (name, cls = '') => h('span', { class: cls ? `ms ${cls}` : 'ms', 'aria-hidden': 'true' }, name);
const logo = (cls = '') => h('span', { class: `logo ${cls}`.trim(), 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
const chip = (ic, label, tone = 'gray') => h('span', { class: `chip t-${tone}` }, ic ? icon(ic) : null, label);
const note = (ic, text, ...extra) => h('div', { class: 'note' }, icon(ic), h('span', null, text), ...extra);

/* ═════════════════════════════ Text & format ═══════════════════════════════ */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
const escapeText = (s) => String(s).replace(/[&<>]/g, (c) => ESCAPES[c]);
const truncate = (s, max) => {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max)}…` : str;
};
const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const trimZero = (s) => s.replace(/\.0$/, '');
const shortModel = (m) => (m ? String(m).split('/').pop() : '');
const shortId = (id) => (id.length > 16 ? `${id.slice(0, 7)}…${id.slice(-6)}` : id);
const sseCountLabel = (n) => `${n} ${n === 1 ? 'evento' : 'eventos'} SSE`;

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Integer with "." as thousands separator (3.012). */
function fmtNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n ?? '—');
  const abs = String(Math.abs(Math.round(x))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return x < 0 ? `-${abs}` : abs;
}

/** Compact number (1.2k, 15k, 1.5M). */
function fmtCompact(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a < 1000) return String(Math.round(x));
  if (a < 1e6) return `${trimZero((x / 1e3).toFixed(a < 1e4 ? 1 : 0))}k`;
  return `${trimZero((x / 1e6).toFixed(1))}M`;
}

const fmtMs = (ms) => `${fmtNum(ms)} ms`;
const fmtShortMs = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${trimZero((ms / 1000).toFixed(1))}s`);

function fmtClock(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value ?? '') : d.toLocaleTimeString('es-AR', { hour12: false });
}

function fmtTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  return `${d.toLocaleDateString('es-AR')} ${d.toLocaleTimeString('es-AR', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Epoch ms from epoch seconds/ms or an ISO date. */
function toEpoch(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function countdownText(epoch) {
  const s = Math.ceil((epoch - Date.now()) / 1000);
  if (s <= 0) return 'cuota renovada';
  return s > 90 ? `renueva en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min` : `renueva en ${s} s`;
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Decodes header values relayed percent-encoded and repairs UTF-8 read as latin1 (max 2 levels). */
function fixHeader(value) {
  let v = String(value);
  if (/%[0-9a-f]{2}/i.test(v)) {
    try { v = decodeURIComponent(v); } catch { /* keep as is */ }
  }
  for (let i = 0; i < 2 && /[\u00c2-\u00f4][\u0080-\u00bf]/.test(v) && [...v].every((c) => c.charCodeAt(0) < 256); i += 1) {
    try {
      v = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(v, (c) => c.charCodeAt(0)));
    } catch {
      break;
    }
  }
  return v;
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    out[key] = key.startsWith('x-') ? fixHeader(value) : value;
  });
  return out;
}

/** Deep copy with secret-looking fields masked. */
function maskDeep(value, depth = 0) {
  if (depth > 25) return value;
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k,
      SECRET_KEY_RE.test(k) && v != null && typeof v !== 'object' ? '••••' : maskDeep(v, depth + 1),
    ]));
  }
  return value;
}

function shortenStrings(value, max) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}… [+${fmtNum(value.length - max)} caracteres]` : value;
  if (Array.isArray(value)) return value.map((v) => shortenStrings(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenStrings(v, max)]));
  return value;
}

function sleep(ms, signal) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
  });
}

/* ════════════════════════ Markdown & highlighting ══════════════════════════ */

/** Basic markdown: paragraphs, headings, lists, **bold**, *italic*, `code` and fenced code. */
function renderMarkdown(src) {
  const out = [];
  let para = [];
  let list = null;
  let code = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join('<br>'))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (tag, start = 1) => {
    if (list !== tag) {
      closeList();
      // Numbered items separated by blank lines open a new <ol>: keep their numbering.
      out.push(tag === 'ol' && start > 1 ? `<ol start="${start}">` : `<${tag}>`);
      list = tag;
    }
  };
  for (const line of escapeHtml(src || '').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      if (code) {
        out.push(`<pre><code>${code.join('\n')}</code></pre>`);
        code = null;
      } else {
        flushPara();
        closeList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    let m = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (m) {
      flushPara();
      closeList();
      out.push(`<h4>${inlineMd(m[1])}</h4>`);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = ul ? null : line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      openList(ol ? 'ol' : 'ul', ol ? Number(ol[1]) : 1);
      out.push(`<li>${inlineMd(ul ? ul[1] : ol[2])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushPara();
  closeList();
  return out.join('');
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>');
}

/** Puts the typing caret at the end of the last text block. */
function appendCaret(el) {
  let target = el.lastElementChild || el;
  while (/^(UL|OL|LI)$/.test(target.tagName) && target.lastElementChild) target = target.lastElementChild;
  if (target.tagName === 'PRE') target = el;
  target.append(h('span', { class: 'caret', 'aria-hidden': 'true' }));
}

function highlightJson(text) {
  const token = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  return escapeText(text).replace(token, (m) => {
    let cls = 'j-num';
    if (m.startsWith('"')) cls = /:\s*$/.test(m) ? 'j-key' : 'j-str';
    else if (m === 'true' || m === 'false') cls = 'j-bool';
    else if (m === 'null') cls = 'j-null';
    return `<span class="${cls}">${m}</span>`;
  });
}

function highlightSSE(raw) {
  const text = raw.length > 300000 ? `${raw.slice(0, 300000)}\n…` : raw;
  return text.split('\n').map((line) => {
    const m = line.match(/^(data|event|id|retry):\s?(.*)$/);
    if (!m) return escapeText(line);
    const value = m[2].trim();
    const body = /^[[{]/.test(value) ? highlightJson(m[2]) : escapeText(m[2]);
    return `<span class="j-sse">${m[1]}:</span> ${body}`;
  }).join('\n');
}

function highlightCurl(cmd) {
  return escapeText(cmd)
    .replace(/^curl\b/, '<span class="j-key">curl</span>')
    .replace(/^(\s+)(-[A-Za-z])\b/gm, '$1<span class="j-num">$2</span>')
    .replace(/\$APIKEY/g, '<span class="j-bool">$APIKEY</span>');
}

/* ═══════════════════════════ Clipboard & toast ═════════════════════════════ */

let toastTimer = 0;
function toast(message, tone = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${tone}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' }, text);
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copiado al portapapeles');
}

/* ═══════════════════════════════ App shell ═════════════════════════════════ */

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    Object.assign(state.config, await res.json());
  } catch (err) {
    console.warn('No se pudo leer /api/config', err);
    toast('No se pudo leer la configuración del portal', 'warn');
  }
}

function renderTopbar() {
  const c = state.config;
  $('#env-text').textContent = [c.apigeeEnv, c.region].filter(Boolean).join(' · ');
  $('#host-text').textContent = c.apigeeHost || 'APIGEE_HOST sin configurar';
  $('#key-warn').hidden = Boolean(c.keys?.demo);
}

function currentRoute() {
  const id = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split(/[/?]/)[0];
  return capById(id) ? id : 'home';
}

function onRoute() {
  state.route = currentRoute();
  renderRail();
  renderMain();
  $('#main').scrollTop = 0;
}

function renderRail() {
  const home = { id: 'home', name: 'Inicio', shortName: 'Inicio', icon: 'home', color: 'blue' };
  $('#rail').replaceChildren(
    railItem(home),
    h('span', { class: 'rail-sep', 'aria-hidden': 'true' }),
    ...CAPABILITIES.map(railItem),
  );
}

function railItem(item) {
  const active = state.route === item.id;
  return h('a', {
    class: `rail-item a-${item.color}${active ? ' active' : ''}`,
    href: item.id === 'home' ? '#/' : `#/${item.id}`,
    title: item.name,
    'aria-current': active ? 'page' : null,
  },
  h('span', { class: 'rail-pill' }, icon(item.icon, active ? 'fill' : '')),
  h('span', { class: 'rail-label' }, item.shortName));
}

function renderMain() {
  const cap = capById(state.route);
  $('#main').replaceChildren(cap ? renderCapability(cap) : renderHome());
  document.title = cap ? `${cap.name} · AI Gateway` : 'AI Gateway · Apigee';
}

/** Re-renders parts of the current capability view. */
function refresh(cap, ...parts) {
  if (state.route !== cap.id) return;
  for (const part of parts) {
    if (part === 'panel') renderPanel(cap);
    else if (part === 'scenarios') $('#scenarios')?.replaceChildren(...renderScenarioCards(cap));
    else if (part === 'viz') $('#viz')?.replaceChildren(...[renderViz(cap)].filter(Boolean));
    else if (part === 'endpoint') $('#endpoint')?.replaceWith(renderEndpoint(cap));
  }
}

/* ════════════════════════════════ Home view ════════════════════════════════ */

function renderHome() {
  return h('div', { class: 'view home' },
    h('section', { class: 'hero' },
      h('span', { class: 'eyebrow' }, logo('sm'), 'Apigee AI Gateway'),
      h('h1', null, 'Gobierna, protege y optimiza ', h('span', { class: 'grad-text' }, 'el tráfico de IA')),
      h('p', { class: 'lead' }, 'Ocho capacidades listas para probar en vivo.')),
    renderArch(),
    h('div', { class: 'section-head' }, h('span', { class: 'section-label' }, 'Capacidades')),
    h('div', { class: 'cap-grid' }, CAPABILITIES.map(capCard)));
}

function renderArch() {
  const node = (icons, title) => h('div', { class: 'arch-node' },
    h('div', { class: 'arch-icons' }, icons.map((name) => icon(name))),
    h('div', { class: 'arch-title' }, title));
  const link = () => h('div', { class: 'arch-link', 'aria-hidden': 'true' }, h('span', { class: 'arch-line' }), icon('chevron_right'));
  return h('section', { class: 'arch', 'aria-label': 'Arquitectura' },
    node(['devices', 'smart_toy'], 'Apps y agentes'),
    link(),
    h('div', { class: 'arch-node gw' },
      h('div', { class: 'gw-title' }, logo(), 'Apigee AI Gateway'),
      h('div', { class: 'gw-caps' }, CAPABILITIES.map((cap) => h('a', {
        class: `gw-cap a-${cap.color}`, href: `#/${cap.id}`, title: cap.name, 'aria-label': cap.name,
      }, icon(cap.icon))))),
    link(),
    node(['auto_awesome', 'deployed_code', 'hub'], 'Gemini · Model Garden · MCP'));
}

function capCard(cap) {
  return h('a', { class: `cap-card a-${cap.color}`, href: `#/${cap.id}` },
    h('span', { class: 'cap-card-icon' }, icon(cap.icon)),
    h('span', { class: 'cap-card-name' }, cap.name),
    h('span', { class: 'cap-card-tag' }, cap.tagline),
    h('span', { class: 'cap-card-cta' }, 'Probar', icon('arrow_forward')));
}

/* ═════════════════════════════ Capability view ═════════════════════════════ */

function renderCapability(cap) {
  return h('div', { class: `view cap a-${cap.color}` },
    h('header', { class: 'cap-head' },
      h('span', { class: 'cap-icon' }, icon(cap.icon)),
      h('div', { class: 'cap-titles' }, h('h1', null, cap.name), h('p', { class: 'tagline' }, cap.tagline)),
      renderEndpoint(cap)),
    renderFlow(cap),
    h('div', { class: 'cap-body' },
      h('div', { class: 'col-left' },
        renderScenarioHead(cap),
        h('div', { class: 'scenarios', id: 'scenarios' }, renderScenarioCards(cap)),
        cap.custom ? renderCustom(cap) : null),
      h('div', { class: 'col-right' },
        cap.viz ? h('div', { class: 'viz', id: 'viz' }, renderViz(cap)) : null,
        h('section', { class: 'panel', id: 'panel', 'aria-label': 'Respuesta del gateway' }, renderPanelContent(cap)))));
}

const upstreamUrl = (path) => `https://${state.config.apigeeHost || '<APIGEE_HOST>'}${path}`;

function renderEndpoint(cap) {
  const req = state.sessions[cap.id].run?.steps[0]?.req;
  const method = req?.method || cap.endpoint.method;
  const url = upstreamUrl(req?.path || cap.endpoint.path);
  return h('div', { class: 'endpoint', id: 'endpoint' },
    h('span', { class: 'method' }, method),
    h('code', { class: 'url mono', title: url }, url),
    h('button', { class: 'icon-btn', type: 'button', title: 'Copiar URL', 'aria-label': 'Copiar URL', onclick: () => copyText(url) }, icon('content_copy')));
}

function renderFlow(cap) {
  const last = cap.flow.length - 1;
  const chips = cap.flow.flatMap((label, i) => {
    let kind = 'policy';
    if (i === 0) kind = 'client';
    else if (i === last) kind = 'log';
    else if (BACKEND_CHIP_RE.test(label)) kind = 'backend';
    const ic = { client: /agente/i.test(label) ? 'smart_toy' : 'devices', log: 'receipt_long', backend: 'cloud' }[kind];
    return [
      i ? h('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, icon('arrow_forward')) : null,
      h('span', { class: `flow-chip ${kind}` }, ic ? icon(ic) : null, label),
    ];
  });
  return h('section', { class: 'flow', 'aria-label': 'Cómo funciona' },
    h('span', { class: 'section-label' }, 'Cómo funciona'),
    h('div', { class: 'flow-chips' }, chips));
}

function renderScenarioHead(cap) {
  const topic = cap.topics?.[state.sessions[cap.id].topic];
  return h('div', { class: 'section-head', id: 'scn-head' },
    h('span', { class: 'section-label' }, 'Escenarios'),
    topic ? h('button', {
      class: 'btn ghost sm topic-btn', type: 'button', title: 'Rota los textos para volver a ver un MISS', onclick: () => rotateTopic(cap),
    }, icon('shuffle'), 'Cambiar tema', h('span', { class: 'topic-chip' }, topic.name)) : null);
}

function rotateTopic(cap) {
  const session = state.sessions[cap.id];
  session.topic = (session.topic + 1) % cap.topics.length;
  $('#scn-head')?.replaceWith(renderScenarioHead(cap));
  refresh(cap, 'scenarios');
  toast(`Tema: ${cap.topics[session.topic].name}`);
}

function renderScenarioCards(cap) {
  const session = state.sessions[cap.id];
  const ctx = makeCtx(cap);
  return cap.scenarios.map((scn) => {
    const current = session.run?.scenarioId === scn.id;
    const running = current && session.run.running;
    const last = session.lastByScenario[scn.id];
    const subtitle = resolve(scn.subtitle, ctx);
    let side = null;
    if (running && session.run.isSequence) side = h('span', { class: 'scn-last t-blue' }, `${session.run.steps.length}/${session.run.planned}`);
    else if (last) side = h('span', { class: `scn-last ${last.tone}`, title: 'Último resultado' }, last.text);
    return h('button', {
      class: `scn${current ? ' active' : ''}${running ? ' running' : ''}`,
      type: 'button',
      title: subtitle || scn.title,
      'aria-busy': running ? 'true' : null,
      onclick: () => runScenario(cap, scn),
    },
    h('span', { class: 'scn-emoji', 'aria-hidden': 'true' }, running ? h('span', { class: 'spinner' }) : scn.icon || '▶️'),
    h('span', { class: 'scn-text' },
      h('span', { class: 'scn-title' }, scn.title),
      subtitle ? h('span', { class: 'scn-sub' }, subtitle) : null),
    h('span', { class: 'scn-side' },
      scn.expect ? h('span', { class: `badge t-${scn.expect.tone || 'gray'}` }, scn.expect.label) : null,
      side));
  });
}

function renderCustom(cap) {
  const opts = cap.custom;
  const textarea = h('textarea', { rows: '3', placeholder: 'Escribe tu prompt…', 'aria-label': 'Tu prompt', maxlength: '20000' });
  const providerSel = opts.providers
    ? h('select', { 'aria-label': 'Header x-llm-provider' }, opts.providers.map((p) => h('option', { value: p.value }, p.label)))
    : null;
  const modelSel = opts.models ? h('select', { 'aria-label': 'Modelo' }, opts.models.map((m) => h('option', { value: m }, m))) : null;
  const keySel = opts.keys ? h('select', { 'aria-label': 'API key' }, opts.keys.map((k) => h('option', { value: k }, KEY_LABELS[k] || k))) : null;
  const send = () => {
    const text = textarea.value.trim();
    if (!text) {
      textarea.focus();
      return;
    }
    runScenario(cap, customScenario(cap, text, modelSel?.value, keySel?.value, providerSel?.value));
  };
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
  return h('details', { class: 'custom' },
    h('summary', null, icon('edit_note'), h('span', null, 'Probar con tu propio prompt'), icon('expand_more', 'chev')),
    h('div', { class: 'custom-body' },
      textarea,
      h('div', { class: 'custom-actions' },
        providerSel,
        modelSel,
        keySel,
        h('span', { class: 'spacer' }),
        h('span', { class: 'kbd' }, '⌘/Ctrl + Enter'),
        h('button', { class: 'btn primary', type: 'button', onclick: send }, icon('send'), 'Enviar'))));
}

function customScenario(cap, text, model, key, provider) {
  const opts = cap.custom;
  const provInfo = provider && opts.providers?.find((p) => p.value === provider);
  const headers = {
    ...(opts.stream ? { Accept: 'text/event-stream' } : {}),
    ...(provider ? { 'x-llm-provider': provider } : {}),
  };
  return {
    id: 'custom',
    icon: '✍️',
    title: provider ? `Tu prompt · x-llm-provider: ${provider}` : 'Tu prompt',
    subtitle: text,
    request: {
      path: opts.path,
      key,
      headers: Object.keys(headers).length ? headers : undefined,
      body: chat(text, { model: model || provInfo?.model, ...(opts.stream ? { stream: true } : {}) }),
    },
  };
}

/* ════════════════════════════ Execution engine ═════════════════════════════ */

async function runScenario(cap, scn) {
  const session = state.sessions[cap.id];
  if (session.run?.running) session.run.controller.abort();
  const ctx = makeCtx(cap);
  const mode = Array.isArray(scn.steps) ? 'steps' : scn.repeat ? 'repeat' : 'single';
  const run = {
    id: ++runCounter,
    scenarioId: scn.id,
    icon: scn.icon || '▶️',
    title: scn.title,
    subtitle: resolve(scn.subtitle, ctx) || '',
    mode,
    isSequence: mode !== 'single',
    planned: mode === 'steps' ? scn.steps.length : mode === 'repeat' ? scn.repeat.times : 1,
    plannedLabels: mode === 'steps' ? scn.steps.map((st, i) => st.label || `Paso ${i + 1}`) : [],
    stopOnStatus: scn.repeat?.stopOnStatus,
    stoppedAt: null,
    steps: [],
    selected: null,
    running: true,
    aborted: false,
    controller: new AbortController(),
    startedAt: new Date(),
  };
  session.run = run;
  state.tab = 'response';
  refresh(cap, 'panel', 'scenarios', 'viz');

  const { signal } = run.controller;
  const delay = scn.delayMs ?? scn.repeat?.delayMs ?? 0;
  try {
    if (mode === 'single') {
      await runStep(cap, run, buildRequest(cap, scn, null, ctx), scn.title);
    } else if (mode === 'steps') {
      for (const [i, step] of scn.steps.entries()) {
        if (i && delay) await sleep(delay, signal);
        if (signal.aborted) break;
        await runStep(cap, run, buildRequest(cap, scn, step, ctx), run.plannedLabels[i]);
      }
    } else {
      for (let i = 0; i < scn.repeat.times; i += 1) {
        if (i && delay) await sleep(delay, signal);
        if (signal.aborted) break;
        const result = await runStep(cap, run, buildRequest(cap, scn, null, ctx), `Intento ${i + 1}`);
        if (result.status === run.stopOnStatus) {
          run.stoppedAt = i;
          break;
        }
      }
    }
  } catch (err) {
    console.error('Error ejecutando el escenario', err);
  }
  run.running = false;
  run.aborted = signal.aborted;
  session.lastByScenario[scn.id] = runOutcome(run);
  refresh(cap, 'panel', 'scenarios', 'viz');
}

async function runStep(cap, run, req, label) {
  const result = newResult(run.steps.length, label, req);
  run.steps.push(result);
  if (run.steps.length === 1) refresh(cap, 'endpoint');
  refresh(cap, 'scenarios');
  await execute(cap, run, result);
  recordResult(cap, run, result);
  refresh(cap, 'panel', 'viz', 'scenarios');
  return result;
}

function stopRun(cap) {
  const run = state.sessions[cap.id].run;
  if (run?.running) run.controller.abort();
}

function runOutcome(run) {
  const last = run.steps[run.steps.length - 1];
  if (!last) return null;
  if (last.phase === 'aborted') return { tone: 't-gray', text: 'cancelado' };
  const code = last.error ? 'ERR' : String(last.status);
  return { tone: last.error ? 't-red' : statusTone(last.status), text: run.isSequence ? `${code} · ${run.steps.length}×` : code };
}

/** Merges capability defaults, scenario request and (optional) step overrides. */
function buildRequest(cap, scn, step, ctx) {
  const base = resolve(scn.request, ctx) || {};
  const over = (step && resolve(step.request, ctx)) || {};
  let headers = { ...(base.headers || {}), ...(over.headers || {}) };
  let body = over.body !== undefined ? over.body : base.body;
  if (body && typeof body === 'object' && Array.isArray(body.messages)) {
    const { model, ...rest } = body;
    body = { model: model || state.config.defaultModel, ...rest };
  }
  if (body != null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers = { 'Content-Type': 'application/json', ...headers };
  }
  const path = over.path || base.path || cap.endpoint.path;
  const accept = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept')?.[1] || '';
  return {
    method: String(over.method || base.method || cap.endpoint.method || 'POST').toUpperCase(),
    path,
    url: upstreamUrl(path),
    key: over.key || base.key || cap.defaultKey || 'demo',
    headers,
    body,
    stream: body?.stream === true || /event-stream/.test(accept),
    render: scn.render || 'auto',
  };
}

function newResult(index, label, req) {
  return {
    index, label, req,
    phase: 'pending', status: 0, headers: {}, contentType: '',
    t0: performance.now(), latency: 0,
    raw: '', json: undefined, sse: null, error: null, cancelled: false,
    logs: null, recent: null,
  };
}

/** Calls /api/invoke and reads the relayed response (SSE incrementally). */
async function execute(cap, run, r) {
  const { signal } = run.controller;
  const { method, path, headers, body, key } = r.req;
  r.phase = 'waiting';
  r.t0 = performance.now();
  refresh(cap, 'panel');
  let res;
  try {
    res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, path, headers, body, key }),
      signal,
    });
  } catch (err) {
    r.latency = performance.now() - r.t0;
    if (signal.aborted) r.phase = 'aborted';
    else {
      r.phase = 'done';
      r.error = { message: err.message || String(err) };
    }
    return;
  }
  r.status = res.status;
  r.headers = headersToObject(res.headers);
  r.contentType = r.headers['content-type'] || '';
  if (/text\/event-stream/i.test(r.contentType) && res.body) {
    r.sse = { events: [], count: 0, text: '', buffer: '', done: false, rpc: null, firstAt: 0, usage: null, model: '', finish: '', error: null };
    r.phase = 'streaming';
    refresh(cap, 'panel');
    await readStream(cap, r, res, signal);
    r.json = r.sse.rpc || undefined;
  } else {
    r.phase = 'reading';
    try {
      r.raw = await res.text();
    } catch (err) {
      if (!signal.aborted) r.readError = err.message;
    }
    r.json = parseJson(r.raw);
  }
  r.latency = performance.now() - r.t0;
  r.cancelled = signal.aborted;
  r.phase = 'done';
}

async function readStream(cap, r, res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      r.raw += text;
      feedSSE(r, text);
      scheduleLive(cap);
    }
    const tail = decoder.decode();
    if (tail) {
      r.raw += tail;
      feedSSE(r, tail);
    }
    if (r.sse.buffer.trim()) handleSSEBlock(r, r.sse.buffer);
    r.sse.buffer = '';
  } catch (err) {
    if (!signal.aborted) r.readError = err.message;
  }
}

function feedSSE(r, text) {
  const sse = r.sse;
  sse.buffer += text;
  const blocks = sse.buffer.split(/\r?\n\r?\n/);
  sse.buffer = blocks.pop();
  blocks.forEach((block) => handleSSEBlock(r, block));
}

/** Parses one SSE event block (event:/data: lines). */
function handleSSEBlock(r, block) {
  const sse = r.sse;
  const data = [];
  let event = 'message';
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    const value = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (!data.length) return;
  const payload = data.join('\n');
  sse.count += 1;
  if (!sse.firstAt) sse.firstAt = performance.now() - r.t0;
  sse.events.push({ event, data: payload });
  if (payload.trim() === '[DONE]') {
    sse.done = true;
    return;
  }
  const json = parseJson(payload);
  if (json && typeof json === 'object') applySSEJson(sse, json);
}

function applySSEJson(sse, json) {
  if (json.jsonrpc) {
    if ('result' in json || 'error' in json) sse.rpc = json;
    return;
  }
  if (json.error) {
    sse.error = json.error;
    return;
  }
  const choice = json.choices?.[0];
  const piece = choice?.delta?.content ?? choice?.message?.content ?? choice?.text;
  if (typeof piece === 'string') sse.text += piece;
  else if (Array.isArray(piece)) sse.text += piece.map((p) => p?.text || '').join('');
  if (choice?.finish_reason) sse.finish = choice.finish_reason;
  if (json.usage) sse.usage = json.usage;
  if (json.model) sse.model = json.model;
}

let liveFrame = 0;
const liveCaps = new Set();
/** Throttles streaming UI updates to one per animation frame. */
function scheduleLive(cap) {
  liveCaps.add(cap.id);
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    liveCaps.forEach((id) => updateLive(capById(id)));
    liveCaps.clear();
  });
}

/** Targeted DOM updates while an SSE response streams (counter, text, ticker). */
function updateLive(cap) {
  if (state.route !== cap.id) return;
  const r = selectedResult(state.sessions[cap.id]);
  const panel = $('#panel');
  if (!panel || !r?.sse) return;
  panel.querySelectorAll('[data-live="count"]').forEach((el) => { el.textContent = sseCountLabel(r.sse.count); });
  const first = panel.querySelector('[data-live="first"]');
  if (first && r.sse.firstAt) first.textContent = `1er evento ${fmtMs(r.sse.firstAt)}`;
  const textEl = panel.querySelector('[data-live="text"]');
  if (textEl) {
    const body = textEl.closest('.tab-body');
    const atBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 48 : false;
    textEl.innerHTML = renderMarkdown(r.sse.text);
    appendCaret(textEl);
    if (body && atBottom) body.scrollTop = body.scrollHeight;
  }
  const ticker = panel.querySelector('[data-live="events"]');
  if (ticker) ticker.replaceChildren(...eventTicker(r.sse));
}

/** Updates per-capability session data used by the visualizations. */
function recordResult(cap, run, r) {
  if (r.phase !== 'done' || r.error) return;
  const session = state.sessions[cap.id];
  session.last = r;
  const cache = (r.headers['x-aigw-cache'] || '').toUpperCase();
  if (cap.viz === 'cache' && (cache || (r.status >= 200 && r.status < 300))) {
    session.cacheCalls.push({ latency: r.latency, cache, status: r.status, label: run.title, prompt: lastUserPrompt(r.req.body), at: Date.now() });
    if (session.cacheCalls.length > 40) session.cacheCalls.shift();
  }
  updateQuota(session, r);
  updateCircuit(session, r);
}

function planId(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('gold')) return 'gold';
  if (n.includes('bronze')) return 'bronze';
  return n || 'bronze';
}

function updateQuota(session, r) {
  const hd = r.headers;
  const err = errorOf(r);
  const planName = hd['x-aigw-plan'] || (r.req.key === 'gold' ? 'Gold' : 'Bronze');
  const id = planId(planName);
  const used = toNum(hd['x-aigw-quota-used']);
  const allowed = toNum(hd['x-aigw-quota-allowed']);
  if (used != null && allowed != null) {
    session.quota[id] = {
      plan: planName,
      used,
      allowed,
      available: toNum(hd['x-aigw-quota-available']) ?? Math.max(0, allowed - used),
      reset: toEpoch(hd['x-aigw-quota-reset']),
      exhausted: err?.type === 'llm_token_quota',
    };
  } else if (err?.type === 'llm_token_quota') {
    const d = err.details || {};
    const quotaAllowed = toNum(d.allowed) ?? session.quota[id]?.allowed ?? null;
    session.quota[id] = {
      plan: planName,
      used: toNum(d.used) ?? quotaAllowed,
      allowed: quotaAllowed,
      available: 0,
      reset: toEpoch(d.resetAt),
      exhausted: true,
    };
  }
}

function updateCircuit(session, r) {
  const hd = r.headers;
  if (!hd['x-aigw-circuit'] && !hd['x-aigw-backend']) return;
  const backend = (hd['x-aigw-backend'] || '').toLowerCase();
  if (backend && hd['x-aigw-backend-region']) session.regions[backend] = hd['x-aigw-backend-region'];
  session.circuit = {
    state: (hd['x-aigw-circuit'] || '').toUpperCase(),
    failures: toNum(hd['x-aigw-circuit-failures']),
    backend,
    failover: hd['x-aigw-failover'] === 'true',
  };
}

/* ═════════════════════════════ Response panel ══════════════════════════════ */

function renderPanel(cap) {
  if (state.route !== cap.id) return;
  const panel = $('#panel');
  if (!panel) return;
  const oldBody = panel.querySelector('.tab-body');
  const key = oldBody?.dataset.key;
  const scroll = oldBody?.scrollTop || 0;
  const sideScroll = panel.querySelector('.seq-side')?.scrollTop || 0;
  panel.replaceChildren(...renderPanelContent(cap));
  const newBody = panel.querySelector('.tab-body');
  if (newBody && key && newBody.dataset.key === key) newBody.scrollTop = scroll;
  const side = panel.querySelector('.seq-side');
  const run = state.sessions[cap.id].run;
  if (side) side.scrollTop = run?.running && run.selected == null ? side.scrollHeight : sideScroll;
}

function renderPanelContent(cap) {
  const session = state.sessions[cap.id];
  const run = session.run;
  if (!run) return [renderEmptyPanel(cap)];
  const r = selectedResult(session);
  const head = renderPanelHead(cap, run);
  const detail = r ? renderDetail(cap, run, r) : h('div', { class: 'detail' }, h('div', { class: 'tab-body' }, renderWaiting()));
  if (!run.isSequence) return [head, detail];
  return [head, h('div', { class: 'seq' }, renderTimeline(cap, run), h('div', { class: 'seq-detail' }, detail))];
}

function renderEmptyPanel(cap) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-art' }, h('span', { class: 'empty-ring' }), h('span', { class: 'empty-ring r2' }), icon(cap.icon)),
    h('div', { class: 'empty-title' }, 'Elige un escenario'),
    h('div', { class: 'empty-sub' }, 'La respuesta del gateway aparece aquí.'));
}

function renderPanelHead(cap, run) {
  return h('div', { class: 'panel-head' },
    h('span', { class: 'panel-emoji', 'aria-hidden': 'true' }, run.icon),
    h('div', { class: 'panel-title' },
      h('strong', null, run.title),
      run.subtitle ? h('span', { title: run.subtitle }, run.subtitle) : null),
    run.running
      ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => stopRun(cap) }, icon('stop_circle'), 'Detener')
      : h('span', { class: 'muted sm mono', title: 'Hora de ejecución' }, fmtClock(run.startedAt)));
}

function renderTimeline(cap, run) {
  const selected = selectedIndex(run);
  const summary = seqSummary(run);
  const items = run.steps.map((r, i) => {
    const done = r.phase === 'done';
    let tone = r.phase === 'aborted' ? 't-gray' : 't-blue';
    if (done) tone = r.error ? 't-red' : statusTone(r.status);
    return h('li', { class: `tl-item ${tone}${i === selected ? ' selected' : ''}${run.stoppedAt === i ? ' stop' : ''}` },
      h('button', { class: 'tl-btn', type: 'button', 'aria-current': i === selected ? 'step' : null, onclick: () => selectStep(cap, run, i) },
        h('span', { class: 'tl-node' }, done || r.phase === 'aborted' ? String(i + 1) : h('span', { class: 'spinner sm' })),
        h('span', { class: 'tl-main' },
          h('span', { class: 'tl-label' }, r.label),
          h('span', { class: 'tl-badges' }, keyBadges(r).map((b) => h('span', { class: `mini t-${b.tone}` }, b.label)))),
        h('span', { class: 'tl-meta' },
          done ? h('span', { class: 'status-mini' }, r.error ? 'ERR' : String(r.status)) : null,
          done ? h('span', { class: 'mono muted xs' }, fmtShortMs(r.latency)) : null)));
  });
  if (run.running && run.mode === 'steps') {
    run.plannedLabels.slice(run.steps.length).forEach((label, j) => {
      items.push(h('li', { class: 'tl-item t-gray pending' },
        h('div', { class: 'tl-btn' },
          h('span', { class: 'tl-node' }, String(run.steps.length + j + 1)),
          h('span', { class: 'tl-main' }, h('span', { class: 'tl-label' }, label)))));
    });
  }
  return h('div', { class: 'seq-side' },
    h('div', { class: `seq-summary t-${summary.tone}` }, icon(summary.icon), h('span', null, summary.text)),
    h('ol', { class: 'timeline' }, items));
}

function selectStep(cap, run, index) {
  run.selected = index === run.steps.length - 1 ? null : index;
  refresh(cap, 'panel', 'viz');
}

function seqSummary(run) {
  const n = run.steps.length;
  if (run.running) {
    return run.mode === 'repeat'
      ? { tone: 'blue', icon: 'autorenew', text: `Intento ${n} de ${run.planned} · corta en ${run.stopOnStatus}` }
      : { tone: 'blue', icon: 'autorenew', text: `Paso ${n} de ${run.planned}` };
  }
  if (run.aborted) return { tone: 'gray', icon: 'stop_circle', text: `Detenido · ${n} de ${run.planned}` };
  if (run.mode === 'repeat') {
    return run.stoppedAt != null
      ? { tone: 'yellow', icon: 'flag', text: `${run.stopOnStatus} en el intento ${run.stoppedAt + 1}` }
      : { tone: 'green', icon: 'check_circle', text: `${n} intentos sin ${run.stopOnStatus}` };
  }
  const circuit = (run.steps[n - 1]?.headers['x-aigw-circuit'] || '').toUpperCase();
  if (circuit) {
    return { tone: circuit === 'OPEN' ? 'red' : 'green', icon: 'electrical_services', text: `Circuito ${circuit === 'OPEN' ? 'ABIERTO' : 'CERRADO'}` };
  }
  return { tone: 'green', icon: 'check_circle', text: `${n} pasos completados` };
}

function renderDetail(cap, run, r) {
  const reason = r.headers['x-aigw-route-reason'];
  return h('div', { class: 'detail' },
    renderSummary(r, cap),
    reason ? h('div', { class: 'reason' }, icon('lightbulb'), h('span', null, reason)) : null,
    renderTabs(cap, r),
    renderTabBody(cap, run, r));
}

function renderSummary(r, cap) {
  const live = r.phase === 'pending' || r.phase === 'waiting' || r.phase === 'streaming' || r.phase === 'reading';
  let badges = r.phase === 'pending' || r.phase === 'waiting' ? [] : headerBadges(r);
  if (cap.badges) badges = badges.filter((b) => cap.badges.includes(b.kind) || b.kind === 'sse' || b.kind === 'cancel');
  return h('div', { class: 'summary' },
    statusPill(r),
    h('span', { class: 'metric', title: 'Latencia total medida en el navegador' }, icon('timer'),
      live ? h('span', { 'data-t0': String(r.t0) }, fmtMs(performance.now() - r.t0)) : fmtMs(r.latency)),
    r.sse ? h('span', { class: 'metric muted', 'data-live': 'first' }, r.sse.firstAt ? `1er evento ${fmtMs(r.sse.firstAt)}` : '') : null,
    badges.length ? h('span', { class: 'vsep', 'aria-hidden': 'true' }) : null,
    badges.map(hbadge));
}

function statusTone(status) {
  if (status >= 200 && status < 300) return 't-green';
  if (status >= 300 && status < 400) return 't-blue';
  if (status === 429 || status === 404 || status === 408) return 't-yellow';
  return 't-red';
}

function statusPill(r) {
  if (r.phase === 'pending' || r.phase === 'waiting') {
    return h('span', { class: 'status-pill t-blue' }, h('span', { class: 'spinner sm' }), 'Ejecutando');
  }
  if (r.phase === 'aborted') return h('span', { class: 'status-pill t-gray' }, icon('stop_circle'), 'Cancelado');
  if (r.error) return h('span', { class: 'status-pill t-red' }, icon('wifi_off'), 'Sin conexión');
  return h('span', { class: `status-pill ${statusTone(r.status)}` },
    r.phase === 'streaming' ? h('span', { class: 'live-dot', 'aria-hidden': 'true' }) : null,
    `${r.status} ${STATUS_TEXT[r.status] || ''}`.trim());
}

/** Badges derived from x-aigw-* headers (and usage / SSE). */
function headerBadges(r) {
  const hd = r.headers;
  const out = [];
  const add = (kind, tone, ic, label, title) => out.push({ kind, tone, icon: ic, label, title });

  const cache = (hd['x-aigw-cache'] || '').toUpperCase();
  if (cache === 'BYPASS') {
    add('cache', 'gray', 'bolt', 'Caché omitida', 'x-aigw-cache');
  } else if (cache) {
    const sim = cache === 'HIT' && hd['x-aigw-similarity'] ? ` ${hd['x-aigw-similarity']}` : '';
    add('cache', cache === 'HIT' ? 'green' : 'gray', 'bolt', `Cache ${cache}${sim}`, 'x-aigw-cache');
  }
  const armorIn = (hd['x-aigw-armor-prompt'] || '').toLowerCase();
  if (armorIn) add('armor', armorIn === 'blocked' ? 'red' : 'green', 'shield', armorIn === 'blocked' ? 'Prompt bloqueado' : 'Prompt limpio', 'x-aigw-armor-prompt');
  const armorOut = (hd['x-aigw-armor-response'] || '').toLowerCase();
  if (armorOut) add('armor', armorOut === 'blocked' ? 'red' : 'green', 'verified_user', armorOut === 'blocked' ? 'Respuesta bloqueada' : 'Respuesta limpia', 'x-aigw-armor-response');
  const filters = splitList(hd['x-aigw-armor-filters']);
  if (filters.length) add('filters', 'gray', 'filter_alt', filters.map(filterLabel).join(' · '), 'x-aigw-armor-filters');
  if (hd['x-aigw-plan']) add('plan', 'yellow', 'workspace_premium', `Plan ${capitalize(hd['x-aigw-plan'])}`, 'x-aigw-plan');
  if (hd['x-aigw-prompt-tokens']) add('ptokens', 'gray', 'straighten', `Prompt ${fmtNum(hd['x-aigw-prompt-tokens'])} tok`, 'x-aigw-prompt-tokens');
  const used = toNum(hd['x-aigw-quota-used']);
  const allowed = toNum(hd['x-aigw-quota-allowed']);
  if (used != null && allowed != null) {
    const ratio = allowed ? used / allowed : 1;
    add('quota', ratio >= 1 ? 'red' : ratio >= 0.7 ? 'yellow' : 'green', 'data_usage', `Cuota ${fmtCompact(used)}/${fmtCompact(allowed)}`, 'x-aigw-quota-used / x-aigw-quota-allowed');
  }
  const model = hd['x-aigw-model'] || r.json?.model || r.sse?.model;
  if (model) add('model', 'blue', 'neurology', shortModel(model), hd['x-aigw-model'] ? 'x-aigw-model' : 'model');
  if (hd['x-aigw-provider']) add('provider', 'gray', 'cloud', hd['x-aigw-provider'], 'x-aigw-provider');
  if (hd['x-aigw-llm-provider']) add('llm-provider', 'blue', 'alt_route', `x-llm-provider: ${hd['x-aigw-llm-provider']}`, 'x-aigw-llm-provider');
  else if (hd['x-aigw-routing']) add('routing', 'blue', 'alt_route', `Routing ${hd['x-aigw-routing']}`, 'x-aigw-routing');
  if (hd['x-aigw-target']) add('target', 'green', 'dns', `Target: ${hd['x-aigw-target']}`, 'x-aigw-target');
  const backend = (hd['x-aigw-backend'] || '').toLowerCase();
  if (backend) {
    const name = { primary: 'Primario', secondary: 'Fallback' }[backend] || backend;
    const where = [hd['x-aigw-backend-region'] ? `· ${hd['x-aigw-backend-region']}` : ''].join('');
    add('backend', backend === 'primary' ? 'green' : 'yellow', 'dns', `${name} ${where}`.trim(), 'x-aigw-backend / x-aigw-backend-region');
  }
  if (hd['x-aigw-failover'] === 'true') add('failover', 'yellow', 'swap_horiz', 'Failover', 'x-aigw-failover');
  const circuit = (hd['x-aigw-circuit'] || '').toUpperCase();
  if (circuit) {
    const f = toNum(hd['x-aigw-circuit-failures']);
    const failures = f ? ` · ${f} ${f === 1 ? 'falla' : 'fallas'}` : '';
    add('circuit', circuit === 'OPEN' ? 'red' : 'green', 'electrical_services', `Circuito ${circuit === 'OPEN' ? 'abierto' : 'cerrado'}${failures}`, 'x-aigw-circuit');
  }
  if (hd['x-aigw-mcp-tool']) add('tool', 'green', 'build', hd['x-aigw-mcp-tool'], 'x-aigw-mcp-tool');
  const mcpServer = (hd['x-aigw-mcp-server'] || '').toLowerCase();
  if (mcpServer) {
    add('mcpserver', mcpServer === 'managed' ? 'green' : 'yellow', 'hub',
      mcpServer === 'managed' ? 'Servidor MCP gestionado' : 'Servidor MCP de respaldo', 'x-aigw-mcp-server');
  }
  const usage = r.json?.usage || r.sse?.usage;
  if (usage?.total_tokens != null) add('tokens', 'gray', 'toll', `Tokens ${fmtNum(usage.total_tokens)}`, 'usage.total_tokens');
  if (r.sse) out.push({ kind: 'sse', tone: 'blue', icon: 'stream', label: sseCountLabel(r.sse.count), live: 'count', title: 'Eventos SSE recibidos' });
  else if (hd['x-aigw-stream'] === 'true') add('stream', 'blue', 'stream', 'Streaming', 'x-aigw-stream');
  if (r.cancelled) add('cancel', 'gray', 'stop_circle', 'Cancelado');
  return out;
}

function hbadge(b) {
  return h('span', { class: `hbadge t-${b.tone}`, title: b.title || null },
    b.icon ? icon(b.icon) : null,
    b.live ? h('span', { 'data-live': b.live }, b.label) : b.label);
}

/** One or two key badges for timeline rows. */
function keyBadges(r) {
  if (r.phase !== 'done' || r.error) return [];
  const priority = ['circuit', 'failover', 'backend', 'quota', 'cache', 'tool'];
  const list = headerBadges(r)
    .filter((b) => priority.includes(b.kind))
    .sort((a, b) => priority.indexOf(a.kind) - priority.indexOf(b.kind));
  const err = errorOf(r);
  if (err) {
    const info = errorInfo(err);
    list.unshift({ tone: info.tone, label: info.short });
  }
  return list.slice(0, 2);
}

function renderTabs(cap, r) {
  const reqId = r.headers['x-aigw-request-id'];
  return h('div', { class: 'tabs', role: 'tablist' },
    TABS.map((t) => h('button', {
      class: `tab${state.tab === t.id ? ' active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': state.tab === t.id ? 'true' : 'false',
      onclick: () => {
        state.tab = t.id;
        renderPanel(cap);
      },
    }, icon(t.icon), t.label)),
    reqId ? h('button', {
      class: 'reqid mono', type: 'button', title: `x-aigw-request-id: ${reqId} (clic para copiar)`, onclick: () => copyText(reqId),
    }, icon('fingerprint'), h('span', { class: 'reqid-text' }, shortId(reqId))) : null);
}

function renderTabBody(cap, run, r) {
  const renderers = { response: renderResponseTab, json: renderJsonTab, request: renderRequestTab, curl: renderCurlTab, log: renderLogTab };
  let content;
  try {
    content = (renderers[state.tab] || renderResponseTab)(r, cap);
  } catch (err) {
    console.error('Error de renderizado', err);
    content = h('div', { class: 'stack' },
      callout({ tone: 'yellow', icon: 'warning', title: 'No se pudo mostrar la respuesta', message: err.message }),
      r.raw ? codeBlock(r.raw, false) : null);
  }
  return h('div', { class: 'tab-body', role: 'tabpanel', 'data-key': `${run.id}:${r.index}:${state.tab}` }, content);
}

function renderWaiting(text = 'Esperando respuesta de Apigee…') {
  return h('div', { class: 'waiting' },
    h('div', { class: 'skeleton', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    h('div', { class: 'muted sm' }, text));
}

/* ════════════════════════════ Tab: Respuesta ═══════════════════════════════ */

function renderResponseTab(r) {
  if (r.phase === 'pending' || r.phase === 'waiting') return renderWaiting();
  if (r.phase === 'aborted') return note('stop_circle', 'Solicitud cancelada antes de recibir respuesta.');
  if (r.error) return callout({ tone: 'red', icon: 'wifi_off', title: 'No se pudo contactar al portal', message: r.error.message });
  if (r.sse) return renderStream(r);
  if (r.phase === 'reading') return renderWaiting('Recibiendo respuesta…');
  return renderBody(r);
}

function renderBody(r) {
  const j = r.json;
  if (r.req.render === 'json' && j !== undefined) return codeBlock(JSON.stringify(maskDeep(j), null, 2));
  if (j && typeof j === 'object') {
    if (j.jsonrpc) return renderRpc(j);
    const err = gatewayError(j);
    if (err) return renderGatewayError(err, r);
    if (Array.isArray(j.choices)) return renderChat(r, j);
    return renderData(maskDeep(j));
  }
  if (!r.raw && r.status === 404) {
    return callout({
      tone: 'yellow',
      icon: 'cloud_off',
      title: 'Proxy no encontrado',
      message: 'Apigee respondió 404 sin contenido: el proxy de esta capacidad todavía no está desplegado o la ruta no coincide.',
      meta: [['URL', r.headers['x-demo-upstream-url'] || r.req.url]],
    });
  }
  if (!r.raw) return note('inbox', `Respuesta vacía · HTTP ${r.status}`);
  if (r.status >= 400) {
    return callout({
      tone: statusTone(r.status) === 't-yellow' ? 'yellow' : 'red',
      icon: 'error',
      title: `HTTP ${r.status} ${STATUS_TEXT[r.status] || ''}`.trim(),
      message: truncate(r.raw, 800),
    });
  }
  return codeBlock(truncate(r.raw, 50000), false);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

function lastUserPrompt(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs)) return '';
  return messageText([...msgs].reverse().find((m) => m?.role === 'user')?.content);
}

function userBubble(body) {
  const prompt = lastUserPrompt(body);
  if (!prompt) return null;
  const text = prompt.length > 320 ? `${prompt.slice(0, 320)}… (+${fmtNum(prompt.length - 320)} caracteres)` : prompt;
  return h('div', { class: 'bubble user' }, h('div', { class: 'bubble-body' }, text));
}

function assistantBubble(content, foot = []) {
  const chips = foot.filter(Boolean);
  return h('div', { class: 'bubble assistant' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, icon('auto_awesome', 'fill')),
    h('div', { class: 'bubble-body' }, content, chips.length ? h('div', { class: 'bubble-foot' }, chips) : null));
}

function renderChat(r, j) {
  const choice = j.choices[0] || {};
  const content = messageText(choice.message?.content ?? choice.text);
  const usage = j.usage;
  const model = r.headers['x-aigw-model'] || j.model;
  const body = content
    ? h('div', { class: 'md', html: renderMarkdown(content) })
    : h('div', { class: 'muted' }, choice.finish_reason === 'length'
      ? 'Sin texto: el modelo alcanzó max_tokens antes de responder.'
      : 'La respuesta no incluye texto.');
  return h('div', { class: 'chat' },
    userBubble(r.req.body),
    assistantBubble(body, [
      model ? chip('neurology', shortModel(model), 'blue') : null,
      usage ? chip('token', `${fmtNum(usage.prompt_tokens ?? 0)} entrada · ${fmtNum(usage.completion_tokens ?? 0)} salida · ${fmtNum(usage.total_tokens ?? 0)} total`) : null,
      choice.finish_reason ? chip('flag', choice.finish_reason, choice.finish_reason === 'stop' ? 'gray' : 'yellow') : null,
    ]));
}

const isRpcBody = (body) => Boolean(body && typeof body === 'object' && body.jsonrpc);

function renderStream(r) {
  const sse = r.sse;
  const live = r.phase === 'streaming';
  const head = h('div', { class: 'sse-head' },
    h('span', { class: `live-badge${live ? ' on' : ''}` }, icon('stream'), h('span', { 'data-live': 'count' }, sseCountLabel(sse.count))),
    h('span', { class: 'muted sm' }, live ? 'recibiendo…' : sse.done ? 'stream completo · [DONE]' : 'stream cerrado'));
  if (isRpcBody(r.req.body)) {
    let content = note('inbox', 'El stream terminó sin un resultado JSON-RPC.');
    if (sse.rpc) content = renderRpc(sse.rpc);
    else if (live) content = renderWaiting('Esperando el resultado JSON-RPC…');
    return h('div', { class: 'stack' }, head, content);
  }
  if (sse.error) return h('div', { class: 'stack' }, head, renderGatewayError(sse.error, r));
  const text = h('div', { class: 'md', 'data-live': 'text', html: renderMarkdown(sse.text) });
  if (live) appendCaret(text);
  const usage = sse.usage;
  return h('div', { class: 'stack' },
    head,
    h('div', { class: 'chat' },
      userBubble(r.req.body),
      assistantBubble(text, live ? [] : [
        sse.model ? chip('neurology', shortModel(sse.model), 'blue') : null,
        usage?.total_tokens != null ? chip('token', `${fmtNum(usage.total_tokens)} tokens`) : null,
        sse.finish ? chip('flag', sse.finish) : null,
      ])),
    h('div', { class: 'ticker', 'data-live': 'events', 'aria-hidden': 'true' }, eventTicker(sse)));
}

function eventTicker(sse) {
  return sse.events.slice(-4).map((e) => h('div', { class: 'tick mono' }, h('span', { class: 'tick-k' }, 'data:'), ` ${truncate(e.data, 160)}`));
}

/* Errors */

/** Normalizes AI Gateway errors, Apigee faults and OAuth-style errors (not JSON-RPC). */
function gatewayError(j) {
  let body = j;
  if (Array.isArray(body) && body[0]?.error) [body] = body;
  if (!body || typeof body !== 'object' || body.jsonrpc) return null;
  if (body.error && typeof body.error === 'object') return body.error;
  if (body.fault) return { type: 'apigee_fault', code: body.fault.detail?.errorcode || '', message: body.fault.faultstring || 'Error de Apigee' };
  if (typeof body.error === 'string') return { type: body.error, message: body.error_description || body.message || body.error };
  return null;
}

/** Any error carried by a result (gateway error, JSON-RPC error, tool error, SSE error). */
function errorOf(r) {
  const j = r.json;
  if (j?.jsonrpc) {
    if (j.error) return { type: j.error.data?.type, message: j.error.message, code: j.error.code, details: j.error.data };
    return j.result?.isError ? { type: 'tool_error', message: ERROR_INFO.tool_error.title } : null;
  }
  return gatewayError(j) || r.sse?.error || null;
}

function errorInfo(err) {
  if (ERROR_INFO[err.type]) return ERROR_INFO[err.type];
  if (err.type === 'apigee_fault') return FAULTS.find(([re]) => re.test(err.code || ''))?.[1] || { ...DEFAULT_ERROR, title: 'Error de Apigee' };
  return DEFAULT_ERROR;
}

function renderGatewayError(err, r) {
  const info = errorInfo(err);
  const d = err.details && typeof err.details === 'object' ? err.details : {};
  let title = info.title;
  if (err.type === 'model_armor_block' && d.stage) title += d.stage === 'response' ? ' · en la respuesta' : ' · en el prompt';
  if (info === DEFAULT_ERROR && typeof err.status === 'string') title = `Error · ${err.status}`;
  const known = new Set(['labels', 'filters', 'stage', 'promptTokens', 'limit', 'used', 'allowed', 'resetAt']);
  const extraDetails = Object.entries(d).filter(([k, v]) => !known.has(k) && v != null && typeof v !== 'object');
  return callout({
    tone: info.tone,
    icon: info.icon,
    title,
    message: err.message,
    chips: [
      ...asArray(d.labels).map((l) => ({ label: String(l), tone: info.tone, icon: 'flag' })),
      ...asArray(d.filters).map((f) => ({ label: String(f), tone: 'gray', mono: true })),
    ],
    extra: errorExtra(err, d),
    meta: [
      ['Código', err.code],
      ['HTTP', typeof err.status === 'number' ? err.status : r.status],
      ['Proxy', err.proxy],
      ...extraDetails,
    ],
  });
}

function errorExtra(err, d) {
  if (err.type === 'prompt_token_limit' && toNum(d.promptTokens) != null) {
    return ratioBar(toNum(d.promptTokens), toNum(d.limit),
      `${fmtNum(d.promptTokens)} tokens en el prompt · límite ${d.limit != null ? fmtNum(d.limit) : '—'}`);
  }
  if ((err.type === 'llm_token_quota' || err.type === 'mcp_tool_quota') && (d.used != null || d.allowed != null)) {
    const reset = toEpoch(d.resetAt);
    return h('div', { class: 'stack tight' },
      ratioBar(toNum(d.used) ?? toNum(d.allowed), toNum(d.allowed),
        `${d.used != null ? fmtNum(d.used) : '—'} usados · ${d.allowed != null ? fmtNum(d.allowed) : '—'} permitidos`),
      reset ? h('span', { class: 'muted sm', 'data-countdown': String(reset) }, countdownText(reset)) : null);
  }
  return null;
}

function ratioBar(value, limit, text) {
  if (value == null) return null;
  const max = Math.max(value, limit || 0, 1);
  return h('div', { class: 'ratio' },
    h('div', { class: 'ratio-track' },
      h('span', { class: 'ratio-fill', style: `width:${Math.min(100, (value / max) * 100)}%` }),
      limit ? h('span', { class: 'ratio-limit', style: `left:${Math.min(99.5, (limit / max) * 100)}%`, title: 'Límite' }) : null),
    h('span', { class: 'ratio-text mono' }, text));
}

function callout({ tone = 'red', icon: ic = 'error', title, message, chips = [], extra = null, meta = [] }) {
  const rows = meta.filter((m) => Array.isArray(m) && m[1] != null && m[1] !== '');
  return h('div', { class: `callout t-${tone}` },
    h('span', { class: 'callout-icon' }, icon(ic, 'fill')),
    h('div', { class: 'callout-main' },
      h('div', { class: 'callout-title' }, title),
      message ? h('div', { class: 'callout-msg' }, String(message)) : null,
      chips.length ? h('div', { class: 'chips' }, chips.map((c) => h('span', { class: `chip t-${c.tone || 'gray'}${c.mono ? ' mono' : ''}` }, c.icon ? icon(c.icon) : null, c.label))) : null,
      extra,
      rows.length ? h('dl', { class: 'meta' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono' }, String(v))])) : null));
}

/* MCP (JSON-RPC 2.0) */

function renderRpc(j) {
  if (j.error) {
    const data = j.error.data && typeof j.error.data === 'object' ? j.error.data : null;
    const info = ERROR_INFO[data?.type] || { icon: 'error', tone: 'red', title: `Error JSON-RPC ${j.error.code ?? ''}`.trim() };
    return h('div', { class: 'stack' },
      callout({
        tone: info.tone,
        icon: info.icon,
        title: info.title,
        message: j.error.message,
        chips: asArray(data?.labels).map((l) => ({ label: String(l), tone: info.tone, icon: 'flag' })),
        meta: [['Código JSON-RPC', j.error.code]],
      }),
      data ? codeBlock(JSON.stringify(maskDeep(data), null, 2)) : null);
  }
  const res = j.result ?? {};
  if (Array.isArray(res.tools)) return renderTools(res.tools);
  if (Array.isArray(res.content) || res.structuredContent) return renderToolResult(res);
  return renderData(maskDeep(res));
}

function renderTools(tools) {
  if (!tools.length) return note('construction', 'El servidor MCP no expuso herramientas.');
  return h('div', { class: 'stack' },
    h('div', { class: 'block-head' }, icon('construction'), `${tools.length} ${tools.length === 1 ? 'herramienta disponible' : 'herramientas disponibles'}`),
    h('div', { class: 'tools' }, tools.map((tool, i) => {
      const props = Object.keys(tool.inputSchema?.properties || {});
      const required = new Set(tool.inputSchema?.required || []);
      return h('div', { class: 'tool', style: `--i:${i}` },
        h('div', { class: 'tool-name mono' }, icon('build'), tool.name),
        tool.description ? h('div', { class: 'tool-desc', title: tool.description }, tool.description) : null,
        props.length ? h('div', { class: 'tool-params' }, props.map((p) => h('span', { class: `param${required.has(p) ? ' req' : ''}` }, p))) : null);
    })));
}

function renderToolResult(res) {
  const items = asArray(res.content);
  if (res.isError) {
    const text = items.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
    return callout({ tone: 'red', icon: 'build', title: ERROR_INFO.tool_error.title, message: truncate(text || 'Sin detalle', 900) });
  }
  if (res.structuredContent && typeof res.structuredContent === 'object') return renderData(maskDeep(res.structuredContent));
  const parts = items.map((c) => {
    if (c?.type !== 'text') return codeBlock(JSON.stringify(c, null, 2));
    const data = parseJson(c.text);
    return data && typeof data === 'object'
      ? renderData(maskDeep(data))
      : h('div', { class: 'md', html: renderMarkdown(String(c.text ?? '')) });
  });
  return parts.length ? h('div', { class: 'stack' }, parts) : note('inbox', 'La herramienta no devolvió contenido.');
}

/* Generic data: tables for row arrays, key/value lists for flat objects, JSON otherwise */

const isRowArray = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
const isFlat = (o) => Object.values(o).every((v) => v == null || typeof v !== 'object'
  || (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object')));

function renderData(data) {
  if (Array.isArray(data)) return isRowArray(data) ? dataTable(data) : codeBlock(JSON.stringify(data, null, 2));
  if (data && typeof data === 'object') {
    if (Array.isArray(data.rows)) {
      const rows = normalizeRows(data.rows, data.schema);
      let table = codeBlock(JSON.stringify(data.rows, null, 2));
      if (!rows.length) table = note('table_chart', 'La consulta no devolvió filas.');
      else if (isRowArray(rows)) table = dataTable(rows);
      return h('div', { class: 'stack' }, scalarChips(data, ['rows', 'schema']), table);
    }
    const listKeys = Object.keys(data).filter((k) => isRowArray(data[k]));
    if (listKeys.length === 1) return h('div', { class: 'stack' }, scalarChips(data, listKeys), dataTable(data[listKeys[0]], listKeys[0]));
    if (Object.keys(data).length && isFlat(data)) return kvList(data);
    return codeBlock(JSON.stringify(data, null, 2));
  }
  return h('div', { class: 'md' }, String(data));
}

/** Supports BigQuery REST rows ({f:[{v}]}) and array rows with a schema. */
function normalizeRows(rows, schema) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : Array.isArray(schema) ? schema : null;
  const nameAt = (i) => fields?.[i]?.name ?? `col${i + 1}`;
  return rows.map((row) => {
    if (row && Array.isArray(row.f)) return Object.fromEntries(row.f.map((cell, i) => [nameAt(i), cell?.v ?? null]));
    if (Array.isArray(row)) return Object.fromEntries(row.map((v, i) => [nameAt(i), v]));
    return row;
  });
}

function scalarChips(obj, exclude) {
  const entries = Object.entries(obj).filter(([k, v]) => !exclude.includes(k) && v != null && typeof v !== 'object');
  if (!entries.length) return null;
  return h('div', { class: 'chips' }, entries.map(([k, v]) => h('span', { class: 'chip t-gray' }, h('span', { class: 'muted' }, `${k}:`), ` ${v}`)));
}

function dataTable(rows, title) {
  const cols = [];
  rows.slice(0, 50).forEach((row) => Object.keys(row).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const shown = rows.slice(0, 100);
  return h('div', { class: 'stack tight' },
    h('div', { class: 'block-head' }, icon('table_chart'), `${title ? `${title} · ` : ''}${fmtNum(rows.length)} ${rows.length === 1 ? 'fila' : 'filas'}`),
    h('div', { class: 'table-scroll' },
      h('table', { class: 'table' },
        h('thead', null, h('tr', null, cols.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, shown.map((row) => h('tr', null, cols.map((c) => tableCell(row[c]))))))),
    rows.length > shown.length ? h('div', { class: 'muted sm' }, `… y ${fmtNum(rows.length - shown.length)} filas más`) : null);
}

function tableCell(v) {
  if (v == null) return h('td', { class: 'null' }, '—');
  if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16)) {
    const n = Number(v);
    return h('td', { class: 'num' }, Number.isInteger(n) && Math.abs(n) >= 10000 ? fmtNum(n) : String(v));
  }
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    return h('td', { class: 'mono sm', title: json }, truncate(json, 80));
  }
  const text = String(v);
  return h('td', { title: text.length > 60 ? text : null }, truncate(text, 120));
}

function kvList(obj) {
  return h('dl', { class: 'kv' }, Object.entries(obj).map(([k, v]) => [h('dt', null, k), h('dd', null, kvValue(v))]));
}

function kvValue(v) {
  if (v == null) return h('span', { class: 'muted' }, '—');
  if (typeof v === 'object') return h('pre', { class: 'code sm', html: highlightJson(JSON.stringify(v, null, 2)) });
  if (typeof v === 'boolean') return chip(null, String(v), v ? 'green' : 'gray');
  return String(v);
}

function codeBlock(text, highlight = true, copyValue = text) {
  const str = String(text);
  const shown = str.length > 300000 ? `${str.slice(0, 300000)}\n…` : str;
  return h('div', { class: 'code-wrap' },
    h('button', { class: 'icon-btn copy', type: 'button', title: 'Copiar', 'aria-label': 'Copiar', onclick: () => copyText(String(copyValue)) }, icon('content_copy')),
    highlight ? h('pre', { class: 'code', html: highlightJson(shown) }) : h('pre', { class: 'code' }, shown));
}

/* ═══════════════════════ Tabs: JSON, Request, cURL ═════════════════════════ */

function renderJsonTab(r) {
  if (r.phase === 'pending' || r.phase === 'waiting') return renderWaiting();
  if (r.error) return codeBlock(JSON.stringify({ error: r.error }, null, 2));
  const rows = Object.entries(r.headers).sort(([a], [b]) => Number(b.startsWith('x-aigw-')) - Number(a.startsWith('x-aigw-')) || a.localeCompare(b));
  const headers = rows.length ? h('details', {
    class: 'fold',
    open: state.showHeaders || null,
    ontoggle: (e) => { state.showHeaders = e.currentTarget.open; },
  },
  h('summary', null, icon('list_alt'), `Headers de respuesta (${rows.length})`),
  h('pre', {
    class: 'code hdrs',
    html: rows.map(([k, v]) => `<span class="${k.startsWith('x-aigw-') ? 'j-key' : 'j-dim'}">${escapeText(k)}</span>: ${escapeText(v)}`).join('\n'),
  })) : null;
  let body;
  if (r.sse) body = h('pre', { class: 'code', html: highlightSSE(r.raw) });
  else if (r.json !== undefined) body = codeBlock(JSON.stringify(maskDeep(r.json), null, 2));
  else body = r.raw ? codeBlock(r.raw, false) : note('inbox', 'Body vacío');
  return h('div', { class: 'stack' }, headers, body);
}

function renderRequestTab(r) {
  const q = r.req;
  const url = r.headers['x-demo-upstream-url'] || q.url;
  const headers = Object.entries(q.headers);
  if (q.key !== 'none') headers.push(['x-apikey', '••••']);
  const fullBody = typeof q.body === 'string' ? q.body : JSON.stringify(q.body, null, 2);
  return h('div', { class: 'stack' },
    h('div', { class: 'req-line' },
      h('span', { class: 'method' }, q.method),
      h('code', { class: 'url mono' }, url),
      h('button', { class: 'icon-btn', type: 'button', title: 'Copiar URL', 'aria-label': 'Copiar URL', onclick: () => copyText(url) }, icon('content_copy'))),
    h('div', { class: 'block-head' }, icon('list_alt'), 'Headers'),
    h('pre', { class: 'code hdrs', html: headers.map(([k, v]) => `<span class="j-key">${escapeText(k)}</span>: ${escapeText(v)}`).join('\n') }),
    q.body != null ? [
      h('div', { class: 'block-head' }, icon('data_object'), 'Body'),
      codeBlock(typeof q.body === 'string' ? q.body : JSON.stringify(shortenStrings(q.body, 600), null, 2), true, fullBody),
    ] : null,
    note('lock', `La API key la agrega el servidor del portal (${KEY_LABELS[q.key] || q.key}); nunca llega al navegador.`));
}

function toCurl(q) {
  const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const lines = [`curl ${q.stream ? '-N ' : ''}-sS -X ${q.method} ${quote(q.url)}`];
  Object.entries(q.headers).forEach(([k, v]) => lines.push(`  -H ${quote(`${k}: ${v}`)}`));
  if (q.key !== 'none') lines.push('  -H "x-apikey: $APIKEY"');
  if (q.body != null) lines.push(`  -d ${quote(typeof q.body === 'string' ? q.body : JSON.stringify(q.body, null, 2))}`);
  return lines.join(' \\\n');
}

function renderCurlTab(r) {
  const cmd = toCurl(r.req);
  return h('div', { class: 'stack' },
    note('info', 'Define tu API key antes de ejecutar: ', h('code', { class: 'inline' }, 'export APIKEY=…')),
    h('div', { class: 'code-wrap' },
      h('button', { class: 'btn ghost sm copy-curl', type: 'button', onclick: () => copyText(cmd) }, icon('content_copy'), 'Copiar'),
      h('pre', { class: 'code curl', html: highlightCurl(cmd) })));
}

/* ══════════════════════════ Tab: Log de Apigee ═════════════════════════════ */

function logFilter(clause) {
  const { projectId, logName } = state.config;
  return `logName="projects/${projectId || 'PROJECT_ID'}/logs/${encodeURIComponent(logName || 'aigw-demo')}"\n${clause}`;
}

function consoleLink(filter) {
  const query = encodeURIComponent(filter).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `https://console.cloud.google.com/logs/query;query=${query}?project=${encodeURIComponent(state.config.projectId || '')}`;
}

function renderLogTab(r, cap) {
  if (r.phase !== 'done') {
    return renderWaiting(r.phase === 'aborted' ? 'Solicitud cancelada.' : 'El log estará disponible al terminar la llamada.');
  }
  const reqId = r.headers['x-aigw-request-id'];
  const proxy = r.headers['x-aigw-proxy'] || cap.proxy;
  const filter = logFilter(reqId ? `jsonPayload.requestId="${reqId}"` : `jsonPayload.proxy="${proxy}"`);
  const bar = h('div', { class: 'log-bar' },
    reqId ? h('span', { class: 'chip t-gray mono', title: 'x-aigw-request-id' }, icon('fingerprint'), reqId) : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn ghost sm', type: 'button', onclick: () => loadRecent(cap, r, proxy) }, icon('history'), 'Últimos 10 del proxy'),
    h('a', { class: 'btn ghost sm', href: consoleLink(filter), target: '_blank', rel: 'noopener noreferrer' }, icon('open_in_new'), 'Abrir en Cloud Logging'));
  if (!reqId) {
    return h('div', { class: 'stack' }, bar, note('help', 'La respuesta no incluyó x-aigw-request-id: no se puede buscar el log exacto.'), renderRecent(r));
  }
  if (!r.logs) startLogPolling(cap, r, reqId);
  return h('div', { class: 'stack' }, bar, renderLogState(cap, r, reqId), renderRecent(r));
}

/** Polls /api/logs every 2 s (max 12 tries) until the entry is ingested. */
async function startLogPolling(cap, r, reqId) {
  const logs = { status: 'polling', tries: 0, entries: [], message: '' };
  r.logs = logs;
  for (let i = 1; i <= LOG_POLL_TRIES; i += 1) {
    if (r.logs !== logs) return;
    logs.tries = i;
    if (i > 1) refreshLog(cap, r);
    try {
      const res = await fetch(`/api/logs?requestId=${encodeURIComponent(reqId)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        logs.status = 'error';
        logs.message = data?.error?.message || `HTTP ${res.status}`;
        break;
      }
      if (Array.isArray(data.entries) && data.entries.length) {
        logs.status = 'found';
        logs.entries = data.entries;
        break;
      }
    } catch (err) {
      logs.status = 'error';
      logs.message = err.message;
      break;
    }
    if (i < LOG_POLL_TRIES) await sleep(LOG_POLL_MS);
  }
  if (r.logs !== logs) return;
  if (logs.status === 'polling') logs.status = 'notfound';
  refreshLog(cap, r);
}

function refreshLog(cap, r) {
  if (state.tab === 'log' && selectedResult(state.sessions[cap.id]) === r) renderPanel(cap);
}

function renderLogState(cap, r, reqId) {
  const logs = r.logs;
  const retry = () => {
    r.logs = null;
    renderPanel(cap);
  };
  const retryBtn = () => h('button', { class: 'btn ghost sm', type: 'button', onclick: retry }, icon('refresh'), 'Reintentar');
  if (logs.status === 'polling') {
    return h('div', { class: 'polling' }, h('span', { class: 'spinner' }),
      h('div', null,
        h('div', null, `Buscando el log en Cloud Logging… intento ${logs.tries}/${LOG_POLL_TRIES}`),
        h('div', { class: 'muted sm' }, 'La ingesta puede tardar unos segundos.')));
  }
  if (logs.status === 'error') {
    return callout({ tone: 'yellow', icon: 'cloud_off', title: 'No se pudo consultar Cloud Logging', message: logs.message, extra: h('div', null, retryBtn()) });
  }
  if (logs.status === 'notfound') return note('search_off', `Todavía no aparece el log de ${shortId(reqId)}.`, retryBtn());
  return h('div', { class: 'stack' }, logs.entries.map(logEntry));
}

const severityClass = (sev) => `sev sev-${String(sev || 'default').toLowerCase()}`;

function logEntry(entry) {
  const payload = entry.jsonPayload ? maskDeep(entry.jsonPayload) : null;
  return h('article', { class: 'log-entry' },
    h('div', { class: 'log-head' },
      h('span', { class: severityClass(entry.severity) }, entry.severity || 'DEFAULT'),
      h('span', { class: 'mono sm' }, fmtTimestamp(entry.timestamp)),
      payload?.proxy ? h('span', { class: 'mono sm muted' }, String(payload.proxy)) : null),
    payload ? kvList(payload) : h('pre', { class: 'code' }, entry.textPayload || '(sin payload)'),
    payload ? h('details', { class: 'fold' }, h('summary', null, icon('data_object'), 'JSON'), codeBlock(JSON.stringify(payload, null, 2))) : null);
}

async function loadRecent(cap, r, proxy) {
  r.recent = { status: 'loading', entries: [], message: '', proxy };
  renderPanel(cap);
  try {
    const res = await fetch(`/api/logs/recent?proxy=${encodeURIComponent(proxy)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    r.recent = { status: 'done', entries: data.entries || [], proxy };
  } catch (err) {
    r.recent = { status: 'error', entries: [], message: err.message, proxy };
  }
  refreshLog(cap, r);
}

function renderRecent(r) {
  const rec = r.recent;
  if (!rec) return null;
  const head = h('div', { class: 'block-head' }, icon('history'), `Últimos registros de ${rec.proxy}`);
  if (rec.status === 'loading') return h('div', { class: 'stack' }, head, h('div', { class: 'polling' }, h('span', { class: 'spinner' }), 'Cargando…'));
  if (rec.status === 'error') return h('div', { class: 'stack' }, head, callout({ tone: 'yellow', icon: 'cloud_off', title: 'No se pudo consultar Cloud Logging', message: rec.message }));
  if (!rec.entries.length) return h('div', { class: 'stack' }, head, note('inbox', 'Sin registros recientes.'));
  return h('div', { class: 'stack tight' }, head, rec.entries.map((e) => {
    const p = e.jsonPayload ? maskDeep(e.jsonPayload) : null;
    const summary = p
      ? [p.requestId && shortId(String(p.requestId)), p.status ?? p.statusCode, p.latencyMs != null && `${fmtNum(p.latencyMs)} ms`, p.model && shortModel(p.model)].filter((x) => x != null && x !== false && x !== '').join(' · ')
      : truncate(e.textPayload || '', 80);
    return h('details', { class: 'recent' },
      h('summary', null,
        h('span', { class: severityClass(e.severity) }, e.severity || 'DEFAULT'),
        h('span', { class: 'mono sm' }, fmtTimestamp(e.timestamp)),
        h('span', { class: 'muted sm mono' }, summary)),
      p ? kvList(p) : h('pre', { class: 'code' }, e.textPayload || ''));
  }));
}

/* ═════════════════════════════ Visualizations ══════════════════════════════ */

function renderViz(cap) {
  const session = state.sessions[cap.id];
  const renderers = { cache: cacheViz, armor: armorViz, quota: quotaViz, circuit: circuitViz, routing: routingViz, pipeline: pipelineViz };
  return renderers[cap.viz]?.(session) || null;
}

function vizCard(ic, title, extra, body) {
  return h('div', { class: 'viz-card' },
    h('div', { class: 'viz-head' },
      h('span', { class: 'viz-title' }, icon(ic), title),
      extra ? h('div', { class: 'viz-extra' }, extra) : null),
    body);
}

/* Semantic cache: latency bars (MISS blue, HIT green) */
function cacheViz(session) {
  const calls = session.cacheCalls.slice(-14);
  const offset = session.cacheCalls.length - calls.length;
  const max = Math.max(1, ...calls.map((c) => c.latency));
  const avg = (list) => list.reduce((sum, c) => sum + c.latency, 0) / list.length;
  const hits = session.cacheCalls.filter((c) => c.cache === 'HIT');
  const misses = session.cacheCalls.filter((c) => c.cache === 'MISS');
  const saving = hits.length && misses.length ? Math.round((1 - avg(hits) / avg(misses)) * 100) : null;
  const extra = [
    h('span', { class: 'lg miss' }, 'MISS'),
    h('span', { class: 'lg hit' }, 'HIT'),
    saving != null ? h('span', { class: `chip ${saving > 0 ? 't-green' : 't-gray'}` }, icon('speed'), `${saving > 0 ? '−' : '+'}${Math.abs(saving)}% latencia con caché`) : null,
  ];
  const bar = (cls, pct, val, x, title) => h('div', { class: `bar-col ${cls}`, title },
    h('span', { class: 'bar-val' }, val),
    h('span', { class: 'bar-track' }, h('span', { class: 'bar', style: `height:${pct}%` })),
    h('span', { class: 'bar-x' }, x));
  const body = calls.length
    ? h('div', { class: 'bars' }, calls.map((c, i) => bar(
      `${c.cache === 'HIT' ? 'hit' : c.cache === 'MISS' ? 'miss' : 'other'}${Date.now() - c.at < 700 ? ' fresh' : ''}`,
      Math.max(6, (c.latency / max) * 100),
      fmtShortMs(c.latency),
      String(offset + i + 1),
      `#${offset + i + 1} · ${c.label} · ${c.cache || c.status} · ${fmtMs(c.latency)}\n${c.prompt}`,
    )))
    : h('div', { class: 'bars ghost', 'aria-hidden': 'true' }, [70, 18, 62, 14, 54, 12].map((p) => bar('', p, '\u00a0', '\u00a0', null)));
  return vizCard('bolt', 'Latencia de la sesión', extra,
    h('div', { class: 'cache-viz' }, body, calls.length ? null : h('div', { class: 'viz-overlay' }, 'Ejecuta los escenarios para comparar latencias')));
}

/* Model Armor: stages + filters */
function normalizeFilter(f) {
  const s = String(f);
  return FILTER_PATTERNS.find(([, re]) => re.test(s))?.[0] || s.toLowerCase();
}
const filterLabel = (f) => ARMOR_FILTERS.find((x) => x.id === normalizeFilter(f))?.label || String(f);

function armorState(r) {
  if (!r) return { prompt: '', response: '', filters: [], blocked: false };
  const hd = r.headers;
  const err = errorOf(r);
  const blocked = err?.type === 'model_armor_block' || hd['x-aigw-armor-prompt'] === 'blocked' || hd['x-aigw-armor-response'] === 'blocked';
  const d = err?.details || {};
  const stage = d.stage || (hd['x-aigw-armor-response'] === 'blocked' ? 'response' : 'prompt');
  const ok = r.status >= 200 && r.status < 300;
  const matched = [...asArray(d.filters), ...asArray(d.labels)];
  return {
    prompt: hd['x-aigw-armor-prompt'] || (blocked ? (stage === 'prompt' ? 'blocked' : 'clean') : ok ? 'clean' : ''),
    response: hd['x-aigw-armor-response'] || (blocked ? (stage === 'response' ? 'blocked' : '') : ok ? 'clean' : ''),
    filters: blocked ? (matched.length ? matched : splitList(hd['x-aigw-armor-filters'])) : [],
    blocked,
  };
}

function armorViz(session) {
  const a = armorState(session.last);
  const hits = new Set(a.filters.map(normalizeFilter));
  const stage = (label, value) => {
    const tone = { blocked: 'red', clean: 'green' }[value] || 'gray';
    const ic = { blocked: 'block', clean: 'check' }[value] || 'remove';
    return h('span', { class: `stage t-${tone}` }, icon(ic), label);
  };
  return vizCard('shield', 'Filtros de Model Armor',
    h('div', { class: 'stages' }, stage('Prompt', a.prompt), icon('arrow_forward', 'dim'), stage('Respuesta', a.response)),
    h('div', { class: 'fchips' }, ARMOR_FILTERS.map((f) => {
      const hit = a.blocked && hits.has(f.id);
      const pass = !a.blocked && a.prompt === 'clean';
      return h('span', { class: `fchip${hit ? ' hit' : pass ? ' pass' : ''}` }, icon(hit ? 'block' : pass ? 'check' : f.icon), f.label);
    })));
}

/* Token limits: quota meter per plan */
function quotaViz(session) {
  const ids = ['bronze', 'gold', ...Object.keys(session.quota).filter((k) => k !== 'bronze' && k !== 'gold')];
  return vizCard('data_usage', 'Cuota de tokens por plan', null, h('div', { class: 'meters' }, ids.map((id) => quotaMeter(id, session.quota[id]))));
}

function quotaMeter(id, q) {
  const name = capitalize(q?.plan || id);
  let pct = 0;
  if (q?.allowed) pct = Math.min(100, (q.used / q.allowed) * 100);
  else if (q?.exhausted) pct = 100;
  let tone = 'gray';
  if (q) tone = q.exhausted || pct >= 100 ? 'red' : pct >= 70 ? 'yellow' : 'green';
  let foot = h('span', null, id === 'gold' && !state.config.keys?.gold ? 'GOLD_API_KEY no configurada' : 'Sin datos aún');
  if (q) {
    foot = [
      h('span', null, q.exhausted ? 'Agotada' : `Disponible ${fmtNum(q.available ?? 0)}`),
      q.reset ? h('span', { 'data-countdown': String(q.reset) }, countdownText(q.reset)) : null,
    ];
  }
  return h('div', { class: `meter t-${tone}` },
    h('div', { class: 'meter-top' },
      h('span', { class: 'meter-name' }, icon(id === 'gold' ? 'workspace_premium' : 'military_tech'), name),
      h('span', { class: 'mono sm' }, q && q.allowed != null ? `${fmtNum(q.used)} / ${fmtNum(q.allowed)}` : '—')),
    h('div', { class: 'meter-track' }, h('span', { class: 'meter-fill', style: `width:${pct}%` })),
    h('div', { class: 'meter-foot muted sm' }, foot));
}

/* Circuit breaker: state + which region answered */
function circuitViz(session) {
  const c = session.circuit;
  const known = Boolean(c?.state);
  const open = c?.state === 'OPEN';
  let tone = 'gray';
  if (known) tone = open ? 'red' : 'green';
  const regionOf = (id) => session.regions[id] || 'global';
  const row = (id, label) => {
    const active = c?.backend === id;
    const paused = id === 'primary' && open;
    let rowTone = 'gray';
    if (active) rowTone = id === 'primary' ? 'green' : 'yellow';
    else if (paused) rowTone = 'red';
    let tag = '';
    if (active) tag = c.failover ? 'respondió · failover' : 'respondió';
    else if (paused) tag = 'en pausa';
    return h('div', { class: `backend-row t-${rowTone}${active ? ' active' : ''}${paused ? ' paused' : ''}` },
      h('span', { class: 'dot' }),
      h('strong', null, label),
      h('span', { class: 'mono sm muted' }, regionOf(id)),
      h('span', { class: 'tag' }, tag));
  };
  let failures = 'Estado del circuito';
  if (known) failures = `${c.failures ?? 0} ${c.failures === 1 ? 'falla' : 'fallas'}`;
  return vizCard('electrical_services', 'Circuit breaker', null,
    h('div', { class: 'circuit' },
      h('div', { class: `circuit-state t-${tone}` },
        icon(open ? 'power_off' : 'power', 'fill'),
        h('div', null,
          h('strong', null, !known ? 'Sin datos' : open ? 'ABIERTO' : 'CERRADO'),
          h('span', { class: 'sm' }, failures))),
      h('div', { class: 'circuit-links' }, row('primary', 'Primario · Gemini'), row('secondary', 'Fallback · Claude Sonnet 5.5 (Anthropic)'))));
}

/* LLM routing: x-llm-provider header -> KVM -> TargetEndpoint (google | anthropic) */
function routeTargetOf(r) {
  return (r?.headers['x-aigw-target'] || '').toLowerCase();
}

function routingViz(session) {
  const r = (session.run && selectedResult(session)) || session.last;
  const reqHdrs = r?.req?.headers || {};
  const inboundHdr = reqHdrs['x-llm-provider'] || reqHdrs['llm-provider'] || '';
  const provider = r ? (r.headers['x-aigw-llm-provider'] || inboundHdr) : '';
  const target = routeTargetOf(r);
  const model = target && r ? (r.headers['x-aigw-model'] || r.json?.model || '') : '';
  let extra = null;
  if (target) {
    extra = chip('dns', `TargetEndpoint: ${target} · KVM`, 'green');
  } else if (r && r.status === 400) {
    extra = chip('block', 'Bloqueado en Proxy', 'yellow');
  }
  const hdrName = !reqHdrs['x-llm-provider'] && reqHdrs['llm-provider'] ? 'llm-provider' : 'x-llm-provider';
  const hdrLabel = r ? `${hdrName}: ${provider || '(ausente)'}` : 'x-llm-provider';
  return vizCard('alt_route', 'Routing por header (KVM + RouteRules)', extra,
    h('div', { class: 'routing' },
      h('div', { class: 'tiers' },
        h('span', { class: 'router mono' }, icon('input'), hdrLabel),
        icon('arrow_forward', 'dim'),
        ROUTING_TARGETS.map((t) => h('span', { class: `tier${target === t.id ? ' active' : ''}` }, icon(t.icon), t.label))),
      h('div', { class: 'route-meta' },
        model
          ? [icon('neurology'), h('span', { class: 'mono' }, shortModel(model)),
            r.headers['x-aigw-provider'] ? h('span', null, `· ${r.headers['x-aigw-provider']}`) : null,
            h('span', { class: 'mono' }, `· targets/${target}.xml`)]
          : r?.headers['x-aigw-route-reason']
            ? [icon('info'), h('span', null, r.headers['x-aigw-route-reason'])]
            : h('span', null, 'Ejecuta un escenario para enrutar según x-llm-provider entre Gemini 3.5 Flash y Claude Sonnet 5.5.'))));
}

/* Full gateway: pipeline inferred from headers and error.type / details.stage */
function pipelineSteps(r) {
  const steps = Object.fromEntries(PIPELINE.map((p) => [p.id, { state: 'idle', note: '' }]));
  if (!r || r.phase !== 'done' || r.error) return steps;
  const hd = r.headers;
  const err = errorOf(r);
  const d = err?.details || {};
  const reqId = hd['x-aigw-request-id'];
  const hit = (hd['x-aigw-cache'] || '').toUpperCase() === 'HIT';
  let failAt = null;
  if (r.status === 401 || err?.type === 'unauthorized') failAt = 'key';
  else if (err?.type === 'prompt_token_limit') failAt = 'ptl';
  else if (err?.type === 'llm_token_quota') failAt = 'quota';
  else if (err?.type === 'model_armor_block') failAt = d.stage === 'response' ? 'armorOut' : 'armorIn';
  else if (r.status >= 400) {
    if (!reqId) return steps; // the proxy did not run (e.g. not deployed yet)
    failAt = 'backend';
  }
  const failIdx = failAt ? PIPELINE.findIndex((p) => p.id === failAt) : Infinity;
  PIPELINE.forEach((p, i) => {
    if (p.id === 'log') return;
    if (i > failIdx) steps[p.id] = { state: 'skip', note: 'omitido' };
    else if (i === failIdx) steps[p.id] = { state: 'fail', ...failNote(p.id, d, r) };
    else steps[p.id] = passedStep(p.id, hd, hit);
  });
  steps.log = reqId ? { state: 'ok', note: 'registrado', title: reqId } : { state: 'idle', note: '' };
  return steps;
}

function passedStep(id, hd, hit) {
  const ok = (text, title) => ({ state: 'ok', note: text, title });
  if (id === 'key') return ok('válida');
  if (id === 'ptl') return ok(hd['x-aigw-prompt-tokens'] ? `${fmtNum(hd['x-aigw-prompt-tokens'])} tok` : 'ok');
  if (id === 'quota') {
    const used = toNum(hd['x-aigw-quota-used']);
    const allowed = toNum(hd['x-aigw-quota-allowed']);
    return ok(used != null && allowed != null ? `${fmtCompact(used)}/${fmtCompact(allowed)}` : 'ok');
  }
  if (id === 'armorIn') return ok(hd['x-aigw-armor-prompt'] === 'clean' ? 'limpio' : 'ok');
  if (id === 'cache') {
    if (hit) return { state: 'hit', note: `HIT${hd['x-aigw-similarity'] ? ` ${hd['x-aigw-similarity']}` : ''}` };
    const cacheState = (hd['x-aigw-cache'] || '').toUpperCase();
    if (cacheState === 'BYPASS') return { state: 'skip', note: 'omitida', title: 'Falla simulada: el gateway no usa la caché' };
    return ok(cacheState ? 'MISS' : '—');
  }
  const armorOut = hd['x-aigw-armor-response'];
  if (id === 'armorOut' && armorOut) return ok(armorOut === 'clean' ? 'limpio' : armorOut);
  if (hit) return { state: 'skip', note: 'por caché' };
  if (id === 'route') return ok(shortModel(hd['x-aigw-routed-model'] || hd['x-aigw-model']) || '—', hd['x-aigw-route-reason']);
  if (id === 'backend') {
    const region = hd['x-aigw-backend-region'] || hd['x-aigw-backend'] || '—';
    return hd['x-aigw-failover'] === 'true' ? { state: 'warn', note: region, title: 'Failover al secundario' } : ok(region);
  }
  if (id === 'armorOut') return ok(hd['x-aigw-armor-response'] === 'clean' ? 'limpio' : 'ok');
  return ok('');
}

function failNote(id, d, r) {
  const label = asArray(d.labels)[0];
  if (id === 'key') return { note: 'inválida' };
  if (id === 'ptl') return { note: d.promptTokens != null ? `${fmtNum(d.promptTokens)} tok` : 'excedido', title: d.limit != null ? `Límite ${fmtNum(d.limit)}` : '' };
  if (id === 'quota') return { note: 'agotada' };
  if (id === 'armorIn' || id === 'armorOut') return { note: label ? String(label) : 'bloqueado', title: label ? String(label) : '' };
  return { note: `HTTP ${r.status}` };
}

function pipelineViz(session) {
  const running = Boolean(session.run?.running);
  const r = running ? null : session.last;
  const steps = pipelineSteps(r);
  const failed = PIPELINE.find((p) => steps[p.id].state === 'fail');
  let extra = null;
  if (running) extra = h('span', { class: 'chip t-blue' }, h('span', { class: 'spinner sm' }), 'Procesando');
  else if (failed) extra = chip('block', `Detenido en ${failed.label}`, 'red');
  else if (r && steps.log.state === 'ok') extra = chip('check_circle', 'Pipeline completo', 'green');
  return vizCard('auto_awesome', 'Pipeline del gateway', extra,
    h('ol', { class: `pipeline${running ? ' running' : ''}` }, PIPELINE.map((p, i) => {
      const st = steps[p.id];
      const mark = PIPE_MARKS[st.state];
      return h('li', { class: `pipe-step st-${st.state}`, style: `--i:${i}`, title: st.title || null },
        h('span', { class: 'pipe-node' }, icon(p.icon), mark ? h('span', { class: 'pipe-mark' }, icon(mark)) : null),
        h('span', { class: 'pipe-label' }, p.label),
        h('span', { class: 'pipe-note mono' }, st.note || '\u00a0'));
    })));
}

/* ═══════════════════════════════ Bootstrap ═════════════════════════════════ */

function startTickers() {
  setInterval(() => {
    const now = performance.now();
    document.querySelectorAll('[data-t0]').forEach((el) => { el.textContent = fmtMs(now - Number(el.dataset.t0)); });
  }, 100);
  setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((el) => { el.textContent = countdownText(Number(el.dataset.countdown)); });
  }, 1000);
}

async function init() {
  await loadConfig();
  renderTopbar();
  window.addEventListener('hashchange', onRoute);
  onRoute();
  startTickers();
}

init();
