# AI Gateway · Portal de demo

- `server.js`: Express. Sirve `public/`, reenvía los "Probar" a Apigee agregando la API key
  del lado del servidor (el navegador nunca la ve) y lee los logs de Cloud Logging.
- `public/`: HTML + CSS + JS vanilla (ES modules, sin build).
  Los escenarios se editan en [`public/scenarios.js`](public/scenarios.js).

## Correr localmente

Requiere Node 22+.

```bash
cd frontend
npm install
APIGEE_HOST=<your-apigee-hostname> \
PROJECT_ID=<your-project-id> \
DEMO_API_KEY=<key-bronze> \
GOLD_API_KEY=<key-gold> \
npm start
# → http://localhost:8080
```

Para la pestaña **Log de Apigee** en local hace falta Application Default Credentials
(`gcloud auth application-default login`) con permiso de lectura de logs en el proyecto.

## Variables de entorno

En Cloud Run, la cuenta de servicio necesita `roles/logging.viewer` para la pestaña de logs.

## API del servidor

| Método y ruta | Descripción |
|---|---|
| `GET /api/config` | Configuración pública (nunca expone las keys). |
| `POST /api/invoke` | `{method, path, headers, body, key: "demo"\|"gold"\|"none"}`. Solo `/v1/aigw/*` o `/mcp`. Respuesta en streaming (SSE incluido). |
| `GET /api/logs?requestId=…` | Entradas de Cloud Logging con `jsonPayload.requestId`. |
| `GET /api/logs/recent?proxy=…` | Últimas 10 entradas de un proxy. |
| `GET /healthz` | Health check (sin autenticación). |
