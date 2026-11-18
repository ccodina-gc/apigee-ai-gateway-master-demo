# Apigee AI Gateway · Demo para clientes

Portal que explica y deja **probar en vivo** las capacidades de
AI Gateway de Apigee X. Cada capacidad es un API proxy independiente, y uno más las suma todas.

Cada escenario es un botón: el portal muestra la respuesta, los headers del gateway, el request, el cURL equivalente y el **log de Apigee en Cloud Logging**.

> [!NOTE]
> Es un demo, no una arquitectura de producción: las API keys viven en el portal (nunca llegan al navegador)
> y las cuotas son chicas a propósito para poder mostrar los límites en vivo.

![Inicio del portal](docs/img/home.png)

| AI Gateway completo (failover) | Model Armor |
|---|---|
| ![Gateway](docs/img/gateway.png) | ![Model Armor](docs/img/model-armor.png) |
| **MCP Discovery Proxy** | **Circuit Breaking** |
| ![MCP](docs/img/mcp.png) | ![Circuit breaker](docs/img/circuit-breaker.png) |

## Arquitectura

```mermaid
flowchart LR
  U["Presentador"] --> P["Portal de demo - Cloud Run"]
  P -- "x-apikey (server-side)" --> A["Apigee X - env eval"]
  P -- "lee logs" --> L["Cloud Logging - log aigw-demo"]
  A --> G["Gemini 3.5 Flash-Lite / 3.8 Flash / 4 Argon - Vertex AI global"]
  A --> O["Claude Sonnet 5.5 - Model Garden global (rawPredict)"]
  A --> MA["Model Armor - us-east1"]
  A --> VS["Embeddings + Vector Search - us-east1"]
  A --> BQ["BigQuery MCP remoto"]
  A --> MCP["MCP Discovery - mcp.apigee.internal"]
  MCP --> R["Cymbal Retail API mock"]
  A -- "MessageLogging" --> L
```

## Capacidades

| Capacidad | Proxy · base path | Políticas clave | Escenarios del portal |
|---|---|---|---|
| Semantic Caching | `aigw-semantic-cache` · `/v1/aigw/semantic-cache` | SemanticCacheLookup / SemanticCachePopulate (embeddings + Vector Search) | Primera pregunta (MISS) · misma intención con otras palabras (HIT) · pregunta distinta (MISS) |
| Model Armor | `aigw-model-armor` · `/v1/aigw/model-armor` | SanitizeUserPrompt / SanitizeModelResponse | Prompt legítimo · jailbreak · PII · URL maliciosa · contenido peligroso · acoso |
| LLM Token Limit + Prompt Token Limit | `aigw-token-limits` · `/v1/aigw/token-limits` | PromptTokenLimit · LLMTokenQuota con AI Products Bronze / Gold | Prompt normal · prompt gigante (429) · agotar cuota Bronze (429) · plan Gold |
| MCP Discovery Proxy | `aigw-mcp-retail` · `/mcp` | MCP Discovery (OpenAPI → tools) · ParsePayload · VerifyAPIKey · Quota por tool | tools/list · searchProducts · getOrderStatus · cancelOrder (403) · createOrder ×4 (429) · sin key (401) |
| SSE + MCP externo (BigQuery) | `aigw-sse-mcp-bigquery` · `/v1/aigw/sse` | ParsePayload · allowlist de tools por API Product · EventFlow (SSE) | tools/list · execute_sql_readonly · get_table_info · execute_sql (403) · streaming de Gemini |
| LLM Circuit Breaking | `aigw-circuit-breaker` · `/v1/aigw/circuit-breaker` | 2 targets · failover en el response flow · Quota como contador de fallas | Tráfico normal · 429 simulado → failover · abrir el circuito · ver estado |
| LLM Routing | `aigw-llm-routing` · `/v1/aigw/routing` | `EV-ExtractFields` (`x-llm-provider`) · `KVM-GetModelProviderConfig` · 2 `TargetEndpoint`s (`google` / `anthropic`) | `x-llm-provider: google` (`gemini-3.5-flash`) · `x-llm-provider: anthropic` (`claude-sonnet-5-5` en Model Garden) · comparar ambos · proveedor inválido (400) |
| AI Gateway completo | `aigw-gateway` · `/v1/aigw/gateway` | Todo lo anterior en un único endpoint | Request completo · pregunta similar (HIT) · injection · prompt complejo · failover · prompt gigante |

Proxies de soporte: `aigw-mock-llm` (simula un 429/503 del proveedor) y `aigw-retail-api`
(API REST mock de Cymbal Retail que el MCP Discovery Proxy expone como tools).

Todos los proxies:

- Exponen una API **compatible con OpenAI** (`/chat/completions`) o **MCP** (JSON-RPC 2.0).
- Responden errores en JSON y en español, con headers `x-aigw-*` (caché, tokens, modelo, failover, etc.).
- Escriben un log por request con **MessageLogging** en el log `aigw-demo` de Cloud Logging
  (también en los errores, desde el PostClientFlow).

## Requisitos

- Una org de **Apigee X** con un environment y un environment group con hostname y TLS válidos.
- **API hub** provisionado y con el proyecto de runtime asociado (lo necesita el MCP Discovery Proxy).
- `gcloud`, `curl`, `jq`, `zip` y `python3` (alcanza con el bash 3.2 de macOS).
- Permisos de owner o equivalentes en el proyecto: Apigee, IAM, Vertex AI, Model Armor, Cloud Run y Cloud Build.

## Despliegue

1. Autenticarse:

   ```bash
   gcloud auth login
   gcloud auth application-default login
   gcloud config set project macro-project-512518
   ```

2. Revisar [`env.sh`](env.sh): proyecto, environment de Apigee, hostname, regiones y modelos.

3. Desplegar todo:

   ```bash
   source ./env.sh
   ./deploy-all.sh
   ```

`deploy-all.sh` ejecuta, en orden:

| Paso | Script | Qué hace |
|---|---|---|
| 1 | [`scripts/01-prereqs.sh`](scripts/01-prereqs.sh) | APIs, cuentas de servicio y roles IAM, template de Model Armor |
| 2 | [`scripts/02-vector-search.sh`](scripts/02-vector-search.sh) | Índice, endpoint y deploy de Vector Search para el semantic cache (el deploy tarda ~20–40 min) |
| 3 | [`scripts/03-apigee.sh`](scripts/03-apigee.sh) | Genera y despliega los 10 proxies, crea los API Products, el developer y 2 apps; guarda las keys en `.build/credentials.env` |
| 4 | [`scripts/04-portal.sh`](scripts/04-portal.sh) | Despliega el portal en Cloud Run (con `--source`, sin Docker local) |

Cuentas de servicio que crea el paso 1:

| Cuenta | Roles | Uso |
|---|---|---|
| `aigw-proxy-sa` | aiplatform.user, modelarmor.user/viewer, logging.logWriter, bigquery.jobUser/dataViewer, mcp.toolUser | Identidad de los proxies para Vertex AI, Model Armor, BigQuery MCP y Cloud Logging |
| `aigw-mcp-sa` | apigee.admin | Solo para desplegar el MCP Discovery Proxy, como pide el quickstart de MCP |
| `aigw-portal-sa` | logging.viewer | Identidad del portal en Cloud Run (pestaña *Log de Apigee*) |
| `aigw-build-sa` | run.builder | Build del portal con `gcloud run deploy --source` |

Los pasos son idempotentes. Atajos útiles:

```bash
./scripts/03-apigee.sh aigw-gateway      # redesplegar un solo proxy
./scripts/03-apigee.sh --products        # solo API Products, developer y apps
./scripts/04-portal.sh                   # redesplegar el portal
```

Los bundles se generan con [`apigee/generate_proxies.py`](apigee/generate_proxies.py) a partir de los
JavaScript compartidos de [`apigee/common/jsc`](apigee/common/jsc). Conviene editar el generador y no los
XML de `apigee/proxies/`, porque se sobrescriben en cada deploy.

### Acceso al portal

El portal queda en una URL pública de Cloud Run protegida con Basic Auth: cualquier usuario más el passcode.
Se usa `--no-invoker-iam-check` porque la política de la organización (Domain Restricted Sharing) no permite
dar acceso a `allUsers`. El passcode se genera la primera vez y queda en `.build/portal-passcode.txt`.
Para elegir uno propio, o quitarlo con `off`, se define `PORTAL_PASSCODE` en [`env.sh`](env.sh) y se vuelve
a ejecutar el paso 4.

> [!CAUTION]
> Sin passcode, cualquiera que tenga la URL puede consumir tokens de los modelos con las API keys del portal.

## Guion sugerido (10 minutos)

1. **Inicio**: el flujo App → Apigee → modelos y el mapa de capacidades.
2. **Model Armor**: prompt legítimo (pasa) y jailbreak (400 con el filtro que lo detectó). Abrir la pestaña *Log de Apigee*.
3. **Semantic Caching**: primera pregunta (MISS, ~2 s) y la misma intención con otras palabras (HIT, sin tokens, con la similitud).
4. **Token Limits**: prompt gigante (429 de PromptTokenLimit), agotar la cuota Bronze (429 de LLMTokenQuota) y el mismo prompt con la key Gold.
5. **LLM Routing**: el mismo prompt con `x-llm-provider: google` (Gemini 3.5 Flash) y `x-llm-provider: anthropic` (Claude Sonnet 5.5 en Model Garden); un proveedor no soportado → 400.
6. **Circuit Breaking**: simular el 429 del primario y ver que responde Claude Sonnet 5.5 (otro proveedor) sin cambios en la app; luego abrir el circuito.
7. **MCP Discovery**: `tools/list` muestra solo las tools del API Product; `cancelOrder` → 403; `createOrder` ×4 → 429.
8. **SSE + BigQuery**: consulta en vivo al MCP de BigQuery, `execute_sql` bloqueada y streaming de Gemini.
9. **AI Gateway completo**: los mismos controles juntos en un único endpoint.

## Observabilidad

Cada request genera un JSON compacto con `requestId`, `proxy`, `capability`, `status`, `outcome`,
`latencyMs`, `model`, `cache`, `similarity`, tokens, cuota, veredictos de Model Armor, backend,
failover, circuito y tool MCP. Para verlo en Logs Explorer:

```text
logName="projects/macro-project-512518/logs/aigw-demo"
jsonPayload.proxy="aigw-gateway"
```

## Costos

> [!WARNING]
> El índice desplegado de Vector Search (e2-standard-2) cobra por hora aunque no se use
> (del orden de USD 70+/mes). El resto se cobra por uso.

Para pausar o reanudar el semantic cache (lo demás sigue funcionando):

```bash
./scripts/semantic-cache-index.sh status
./scripts/semantic-cache-index.sh pause
./scripts/semantic-cache-index.sh resume   # vuelve a tardar ~20-40 min
```

Borra solo los recursos `aigw-*` de este demo: el portal, las apps, el developer, los productos, los proxies,
Vector Search, el template de Model Armor y las cuentas de servicio. No toca otros proxies de la org.

## Notas técnicas

- **Modelos**: Gemini 3.5 Flash-Lite (`MODEL_LITE`), 3.8 Flash (`MODEL_FLASH`) y 4 Argon (`MODEL_PRO`) por el endpoint
  compatible con OpenAI de Vertex AI en `global` (exige el prefijo `google/`). Como fallback del circuit breaker y del
  gateway se usa `claude-sonnet-5-5` (Anthropic, Model Garden) por `:rawPredict` en `global`: Apigee traduce el request
  OpenAI a la Messages API de Anthropic y normaliza la respuesta, así la app no cambia. El routing por header usa
  `google/gemini-3.5-flash` y `claude-sonnet-5-5` (KVM `aigw-llm-routing-config`).
  Gemini 3.8 Flash no acepta `reasoning_effort: minimal` (se usa `low`), los endpoints regionales de Claude no tienen
  cuota en este proyecto (429) y Gemini 2.5 no estaba disponible en este proyecto.
- **Semantic cache**: `text-multilingual-embedding-002` (768 dimensiones) y Vector Search con `DOT_PRODUCT`.
  El umbral 0.92 se calibró con preguntas en español: las paráfrasis dan 0.89–0.97 y las preguntas distintas 0.58–0.75.
  Las entradas viven 15 minutos (`SEMANTIC_CACHE_TTL_SEC`), así cada demo nueva arranca con un MISS.
- **MCP Discovery Proxy**: `aigw-mcp-retail` apunta al servidor MCP gestionado de Apigee
  (`ORG.mcp.apigee.internal`), que genera las tools desde [`retail-openapi.yaml`](apigee/proxies/aigw-mcp-retail/apiproxy/resources/oas/retail-openapi.yaml).
  Apigee lo aprovisiona en forma asíncrona después del deploy: mientras tanto el deployment figura como
  `PROGRESSING` y el host interno no resuelve. Para que la demo funcione igual, una FaultRule del target
  responde con [`aigw-mcp-fallback.js`](apigee/common/jsc/aigw-mcp-fallback.js): mismas tools que el OAS y `tools/list`
  filtrado con `apiproduct.operation.payload.tools`. El header `x-aigw-mcp-server` (`managed` o `fallback`)
  y el portal muestran cuál respondió. VerifyAPIKey, el filtro por API Product y las cuotas por tool se
  aplican en los dos casos.
- **MCP de BigQuery**: el servidor remoto responde `application/json` aunque el cliente acepte
  `text/event-stream`, así que el SSE se demuestra con el streaming de Gemini en el mismo proxy (EventFlow).
  Apigee filtra automáticamente `tools/list`: `execute_sql` y `cancel_job` no aparecen porque no están en el API Product.
- **API Products MCP**: en este runtime cada `operationConfig` de `payloadOperationGroup` admite una sola operación,
  así que hay una entrada por tool (con su cuota).
- **Circuit breaker**: el target primario acepta cualquier código HTTP (`success.codes`), así el failover ocurre en
  el response flow y Model Armor, la caché y el conteo de tokens también se aplican a la respuesta del fallback.
  El header `x-aigw-simulate-failure: primary` apunta el primario a `aigw-mock-llm`, que devuelve un 429.
  Dos failovers en un minuto abren el circuito (Quota `EnforceOnly` + `CountOnly` con el mismo `SharedName`).
- **JavaScript en Apigee**: las `properties` de las políticas llegan como `java.lang.String`; se convierten con
  `String()` antes de compararlas con `===`.
- **Headers HTTP**: los valores van solo en ASCII; los cuerpos JSON van en UTF-8.

## Estructura

```text
ai-gateway-master/
├── env.sh                 # configuración del entorno
├── deploy-all.sh          # pasos 1 a 4
├── cleanup.sh             # borra todo lo creado
├── scripts/               # pasos de despliegue y utilidades (lib.sh)
├── apigee/
│   ├── generate_proxies.py
│   ├── common/jsc/        # JavaScript compartido (logging, armor, router, circuito, SSE, fallback MCP)
│   ├── proxies/           # bundles generados (10 proxies)
│   └── products/          # API Products (REST, AI Products y MCP)
├── docs/img/              # capturas del portal
└── frontend/              # portal (Express + HTML/CSS/JS sin build)
```
