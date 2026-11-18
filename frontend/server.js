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

// AI Gateway demo portal: serves the static UI, relays "try it" calls to the
// Apigee proxies (injecting the API key server-side) and reads Cloud Logging.

import crypto from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { GoogleAuth } from 'google-auth-library';

/* ----------------------------- Configuration ----------------------------- */

const env = process.env;
const PORT = Number(env.PORT) || 8080;
const APIGEE_HOST = (env.APIGEE_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const CONFIG = {
  apigeeHost: APIGEE_HOST,
  apigeeEnv: env.APIGEE_ENV || 'eval',
  projectId: env.PROJECT_ID || '',
  region: env.REGION || 'us-east1',
  defaultModel: env.DEFAULT_MODEL || 'google/gemini-3.5-flash-lite',
  logName: env.LOG_NAME || 'aigw-demo',
};
const API_KEYS = { demo: env.DEMO_API_KEY || '', gold: env.GOLD_API_KEY || '' };
const KEY_REFS = ['demo', 'gold', 'none'];
const PASSCODE = env.PORTAL_PASSCODE || '';
const INTERNAL_RELAY_TOKEN = env.INTERNAL_RELAY_TOKEN || '';
const LOGS_RELAY_URL = (env.LOGS_RELAY_URL || '').trim().replace(/\/+$/, '');
const LOGS_RELAY_TOKEN = env.LOGS_RELAY_TOKEN || '';

const UPSTREAM_TIMEOUT_MS = 120_000;
const LOGGING_TIMEOUT_MS = 15_000;
const LOGGING_URL = 'https://logging.googleapis.com/v2/entries:list';
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Never forwarded in either direction (hop-by-hop or recomputed by the runtime).
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'trailers', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding', 'host', 'expect',
];
const BLOCKED_REQUEST_HEADERS = new Set([...HOP_BY_HOP, 'x-apikey', 'cookie', 'origin', 'referer']);
const BLOCKED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP, 'set-cookie', 'alt-svc', 'strict-transport-security']);

const UPSTREAM_ORIGIN = parseOrigin(APIGEE_HOST);
const LOGS_RELAY_ORIGIN = LOGS_RELAY_URL ? parseOrigin(LOGS_RELAY_URL.replace(/^https?:\/\//, '')) : null;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] });

/* --------------------------------- App ----------------------------------- */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.use(relayOnlyGuard);
app.use(basicAuth);
app.use(securityHeaders);
app.use('/api', express.json({ limit: '2mb' }));

app.get('/api/config', getConfig);
app.post('/api/invoke', invoke);
app.get('/api/logs', logsByRequestId);
app.get('/api/logs/recent', recentLogs);
app.use('/api', (_req, res) => sendError(res, 404, 'NOT_FOUND', 'Endpoint inexistente.'));

app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
app.use(errorHandler);

/* ------------------------------ Middleware ------------------------------- */

/**
 * When INTERNAL_RELAY_TOKEN is set on the Argolis Cloud Run service, disables public UI/invoke
 * access and restricts the instance to serving /api/logs* for the internal corp.google.com portal.
 */
function relayOnlyGuard(req, res, next) {
  if (!INTERNAL_RELAY_TOKEN) return next();
  const token = String(req.headers['x-aigw-relay-token'] || '');
  const isLogsRoute = req.method === 'GET' && (req.path === '/api/logs' || req.path === '/api/logs/recent');
  if (isLogsRoute && token && safeEqual(token, INTERNAL_RELAY_TOKEN)) return next();
  return res.status(403).type('text').send('Acceso público deshabilitado: utiliza el portal interno (*.corp.google.com).');
}

/** Optional Basic Auth: any user name, password = PORTAL_PASSCODE. */
function basicAuth(req, res, next) {
  if (!PASSCODE) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme && scheme.toLowerCase() === 'basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const password = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    if (safeEqual(password, PASSCODE)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="AI Gateway Demo", charset="UTF-8"');
  return res.status(401).type('text').send('Acceso restringido: ingresa el passcode del portal.');
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

function errorHandler(err, _req, res, _next) {
  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error(err);
  const message = err.type === 'entity.parse.failed'
    ? 'El body de la solicitud no es JSON válido.'
    : err.expose ? err.message : 'Error interno del portal.';
  sendError(res, status, 'PORTAL_ERROR', message);
}

/* ------------------------------- Handlers -------------------------------- */

function getConfig(_req, res) {
  res.set('Cache-Control', 'no-store').json({
    ...CONFIG,
    keys: { demo: Boolean(API_KEYS.demo), gold: Boolean(API_KEYS.gold) },
  });
}

/** POST /api/invoke → streams the Apigee response (status, headers, body) back to the browser. */
async function invoke(req, res) {
  const { method = 'POST', path: target, headers = {}, body, key = 'demo' } = req.body || {};
  if (!UPSTREAM_ORIGIN) {
    return sendError(res, 500, 'NO_APIGEE_HOST', 'APIGEE_HOST no está configurado en el portal.');
  }
  const url = resolveUpstream(target);
  if (!url) return sendError(res, 400, 'INVALID_PATH', 'Ruta no permitida: solo /v1/aigw/* o /mcp.');
  const verb = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(verb)) return sendError(res, 400, 'INVALID_METHOD', `Método no permitido: ${verb}.`);
  if (!KEY_REFS.includes(key)) return sendError(res, 400, 'INVALID_KEY_REF', 'key debe ser demo, gold o none.');
  const apiKey = key === 'none' ? '' : API_KEYS[key];
  if (key !== 'none' && !apiKey) {
    return sendError(res, 400, 'KEY_NOT_CONFIGURED',
      `La key "${key}" no está configurada en el portal (${key.toUpperCase()}_API_KEY).`);
  }

  let outHeaders;
  try {
    outHeaders = buildUpstreamHeaders(headers, apiKey, body);
  } catch (err) {
    return sendError(res, 400, 'INVALID_HEADERS', `Header inválido: ${err.message}`);
  }
  const payload = body == null || verb === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), UPSTREAM_TIMEOUT_MS);
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new Error('client_closed'));
  });

  const started = Date.now();
  let upstream;
  try {
    upstream = await fetch(url, { method: verb, headers: outHeaders, body: payload, signal: controller.signal, redirect: 'manual' });
  } catch (err) {
    clearTimeout(timer);
    logInvoke(verb, url, key, 502, started);
    if (res.destroyed) return undefined;
    const timedOut = controller.signal.reason?.message === 'timeout';
    return sendError(res, 502, 'UPSTREAM_UNREACHABLE', timedOut
      ? `Apigee no respondió en ${UPSTREAM_TIMEOUT_MS / 1000} s.`
      : `No se pudo conectar con Apigee: ${describeError(err)}`);
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, name) => {
    if (BLOCKED_RESPONSE_HEADERS.has(name)) return;
    try { res.setHeader(name, relayHeaderValue(value)); } catch { /* skip invalid header */ }
  });
  res.setHeader('x-demo-upstream-url', url.toString());
  res.setHeader('x-accel-buffering', 'no');
  if (!upstream.headers.has('cache-control')) res.setHeader('cache-control', 'no-store');
  res.flushHeaders();

  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
    }
  } catch {
    // Client disconnected, timeout or upstream reset mid-stream: just close.
  } finally {
    clearTimeout(timer);
    res.end();
    logInvoke(verb, url, key, upstream.status, started);
  }
  return undefined;
}

/** GET /api/logs?requestId=... → entries whose jsonPayload.requestId matches. */
async function logsByRequestId(req, res) {
  const requestId = String(req.query.requestId || '');
  if (!/^[\w.:-]{1,200}$/.test(requestId)) return sendError(res, 400, 'INVALID_REQUEST_ID', 'requestId inválido.');
  if (LOGS_RELAY_ORIGIN) return relayLogs(res, `/api/logs?requestId=${encodeURIComponent(requestId)}`);
  return respondWithEntries(res, `jsonPayload.requestId="${requestId}"`, 5, 6);
}

/** GET /api/logs/recent?proxy=aigw-... → latest 10 entries of that proxy. */
async function recentLogs(req, res) {
  const proxy = String(req.query.proxy || '');
  if (!/^[\w.-]{1,100}$/.test(proxy)) return sendError(res, 400, 'INVALID_PROXY', 'proxy inválido.');
  if (LOGS_RELAY_ORIGIN) return relayLogs(res, `/api/logs/recent?proxy=${encodeURIComponent(proxy)}`);
  return respondWithEntries(res, `jsonPayload.proxy="${proxy}"`, 10, 24);
}

async function relayLogs(res, targetPath) {
  try {
    const url = new URL(targetPath, LOGS_RELAY_ORIGIN);
    const headers = { accept: 'application/json' };
    if (LOGS_RELAY_TOKEN) headers['x-aigw-relay-token'] = LOGS_RELAY_TOKEN;
    const upstream = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(LOGGING_TIMEOUT_MS),
      redirect: 'manual',
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      return sendError(res, 502, `LOGGING_RELAY_${upstream.status}`, `Logs relay (${upstream.status}): ${text.slice(0, 200)}`);
    }
    return res.status(200).set('Cache-Control', 'no-store').type('application/json').send(text);
  } catch (err) {
    return sendError(res, 502, 'LOGGING_RELAY_ERROR', `Logs relay: ${describeError(err)}`);
  }
}

/* ------------------------------- Helpers --------------------------------- */

function parseOrigin(host) {
  if (!host) return null;
  try {
    return new URL(`https://${host}`);
  } catch {
    console.error(`APIGEE_HOST inválido: ${host}`);
    return null;
  }
}

/** Builds the upstream URL; only /v1/aigw/* and /mcp on APIGEE_HOST are allowed. */
function resolveUpstream(target) {
  if (typeof target !== 'string' || target.length > 2048) return null;
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  if (/[\\\s]|%2e|%2f|%5c/i.test(target)) return null;
  const pathname = target.split(/[?#]/)[0];
  if (pathname.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  let url;
  try {
    url = new URL(target, UPSTREAM_ORIGIN);
  } catch {
    return null;
  }
  if (url.host !== UPSTREAM_ORIGIN.host) return null;
  url.hash = '';
  return url.pathname === '/mcp' || url.pathname.startsWith('/v1/aigw/') ? url : null;
}

function buildUpstreamHeaders(input, apiKey, body) {
  const out = new Headers();
  if (input && typeof input === 'object') {
    for (const [name, value] of Object.entries(input)) {
      if (value == null || BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      out.set(name, String(value)); // throws on invalid names/values
    }
  }
  if (body != null && !out.has('content-type')) out.set('content-type', 'application/json');
  if (apiKey) out.set('x-apikey', apiKey);
  return out;
}

/**
 * fetch() exposes header bytes as latin1 chars, while Node writes header strings as UTF-8,
 * so non-ASCII values (e.g. Spanish text in x-aigw-route-reason) would be double-encoded.
 * Valid UTF-8 values are relayed percent-encoded (ASCII); the UI decodes them.
 */
function relayHeaderValue(value) {
  if (!/[^\t\x20-\x7e]/.test(value)) return value;
  const utf8 = Buffer.from(value, 'latin1').toString('utf8');
  return utf8.includes('\uFFFD') ? value : encodeURIComponent(utf8);
}

async function respondWithEntries(res, clause, pageSize, hours) {
  try {
    const projectId = await resolveProjectId();
    if (!projectId) return sendError(res, 500, 'NO_PROJECT_ID', 'PROJECT_ID no está configurado en el portal.');
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const logName = `projects/${projectId}/logs/${encodeURIComponent(CONFIG.logName)}`;
    const filter = `logName="${logName}" AND ${clause} AND timestamp>="${since}"`;
    const client = await auth.getClient();
    const { data } = await client.request({
      url: LOGGING_URL,
      method: 'POST',
      timeout: LOGGING_TIMEOUT_MS,
      data: { resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp desc', pageSize },
    });
    const entries = (data.entries || []).map((e) => ({
      timestamp: e.timestamp,
      severity: e.severity || 'DEFAULT',
      jsonPayload: e.jsonPayload,
      textPayload: e.textPayload,
      insertId: e.insertId,
    }));
    return res.set('Cache-Control', 'no-store').json({ entries });
  } catch (err) {
    const status = err.response?.status;
    const message = err.response?.data?.error?.message || err.message || String(err);
    return sendError(res, 502, status ? `LOGGING_${status}` : 'LOGGING_ERROR', `Cloud Logging: ${message}`);
  }
}

let projectIdPromise;
/** PROJECT_ID env var, or the project of the runtime credentials as a fallback. */
function resolveProjectId() {
  if (CONFIG.projectId) return Promise.resolve(CONFIG.projectId);
  projectIdPromise ??= auth.getProjectId()
    .then((id) => (CONFIG.projectId = id || ''))
    .catch(() => {
      projectIdPromise = undefined;
      return '';
    });
  return projectIdPromise;
}

/** Portal-generated errors use the AI Gateway error shape so the UI renders them the same way. */
function sendError(res, status, code, message) {
  if (res.headersSent) return res.end();
  return res.status(status).set('Cache-Control', 'no-store').json({
    error: { type: 'portal_error', code, message, status },
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function describeError(err) {
  const cause = err?.cause;
  return [err?.message, cause?.code || cause?.message].filter(Boolean).join(' · ') || String(err);
}

function logInvoke(method, url, key, status, started) {
  console.log(JSON.stringify({
    severity: status >= 500 ? 'WARNING' : 'INFO',
    message: `invoke ${method} ${url.pathname} → ${status}`,
    path: url.pathname, key, status, latencyMs: Date.now() - started,
  }));
}

/* -------------------------------- Startup -------------------------------- */

if (!CONFIG.projectId) resolveProjectId();

const server = app.listen(PORT, () => {
  console.log(`AI Gateway demo portal escuchando en :${PORT} → https://${APIGEE_HOST || '(APIGEE_HOST sin configurar)'}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
