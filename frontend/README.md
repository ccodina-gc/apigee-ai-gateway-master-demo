# AI Gateway · Portal de demo

Portal estilo *Dev Portal* para mostrar en vivo las capacidades de **Apigee AI Gateway**
(Semantic Caching, Model Armor, Token Limits, MCP Discovery, SSE + MCP BigQuery,
Circuit Breaking, LLM Routing y el gateway completo). Se despliega en Cloud Run.

- `server.js`: Express. Sirve `public/`, reenvía los "Probar" a Apigee agregando la API key
  del lado del servidor (el navegador nunca la ve) y lee los logs de Cloud Logging.
- `public/`: HTML + CSS + JS vanilla (ES modules, sin build).
  Los escenarios se editan en [`public/scenarios.js`](public/scenarios.js).

## Correr localmente

Requiere Node 22+.

```bash
cd frontend
npm install
APIGEE_HOST=136.82.167.0.nip.io \
PROJECT_ID=macro-project-512518 \
DEMO_API_KEY=<key-bronze> \
GOLD_API_KEY=<key-gold> \
npm start
# → http://localhost:8080
```

Para la pestaña **Log de Apigee** en local hace falta Application Default Credentials
(`gcloud auth application-default login`) con permiso de lectura de logs en el proyecto.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `8080` | Puerto HTTP. |
| `APIGEE_HOST` | — (requerida) | Host de los proxies, p. ej. `136.82.167.0.nip.io` (siempre HTTPS). |
| `APIGEE_ENV` | `eval` | Se muestra en el encabezado. |
| `PROJECT_ID` | proyecto de las credenciales | Proyecto de Cloud Logging y link a la consola. |
| `REGION` | `us-east1` | Se muestra en el encabezado (región primaria). |
| `DEFAULT_MODEL` | `google/gemini-3.5-flash-lite` | Modelo de los escenarios que no usan un modelo virtual. |
| `DEMO_API_KEY` | — | Key `demo` (plan Bronze). |
| `GOLD_API_KEY` | — | Key `gold` (plan Gold). |
| `LOG_NAME` | `aigw-demo` | Log donde los proxies escriben `jsonPayload.requestId`. |
| `PORTAL_PASSCODE` | — | Si se define, Basic Auth: cualquier usuario + este passcode. |

En Cloud Run, la cuenta de servicio necesita `roles/logging.viewer` para la pestaña de logs.

## API del servidor

| Método y ruta | Descripción |
|---|---|
| `GET /api/config` | Configuración pública (nunca expone las keys). |
| `POST /api/invoke` | `{method, path, headers, body, key: "demo"\|"gold"\|"none"}`. Solo `/v1/aigw/*` o `/mcp`. Respuesta en streaming (SSE incluido). |
| `GET /api/logs?requestId=…` | Entradas de Cloud Logging con `jsonPayload.requestId`. |
| `GET /api/logs/recent?proxy=…` | Últimas 10 entradas de un proxy. |
| `GET /healthz` | Health check (sin autenticación). |
