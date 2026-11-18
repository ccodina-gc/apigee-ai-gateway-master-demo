#!/usr/bin/env python3
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Generates the Apigee proxy bundles of the AI Gateway demo (apigee/proxies/*).

Shared building blocks (logging, finalize JS, error handling, Model Armor, semantic
cache, token limits, circuit breaker) are defined once here so every proxy stays
consistent. Tokens like __PROJECT_ID__ are replaced at deploy time (scripts/lib.sh).

Usage: python3 apigee/generate_proxies.py
"""
import os
import shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
PROXIES = os.path.join(ROOT, "proxies")
COMMON_JS = os.path.join(ROOT, "common", "jsc")

LICENSE = """<!--
 Copyright 2026 Google LLC
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->
"""

LLM_URL = "https://__LLM_HOST__/v1/projects/__PROJECT_ID__/locations/__LLM_LOCATION__/endpoints/openapi"
# Fallback provider: Claude (Anthropic) on Vertex AI Model Garden, Messages API via :rawPredict.
# aigw-circuit.js translates the OpenAI-style request and normalizes the answer back.
FALLBACK_URL = ("https://__FALLBACK_HOST__/v1/projects/__PROJECT_ID__/locations/__FALLBACK_LOCATION__"
                "/publishers/anthropic/models/__MODEL_FALLBACK__:rawPredict")
MA_TEMPLATE = "projects/__PROJECT_ID__/locations/__MODEL_ARMOR_LOCATION__/templates/__MODEL_ARMOR_TEMPLATE__"
PROMPT_SRC = "{jsonPath('$.messages[-1].content',request.content,true)}"
FAILOVER_COND = "(response.status.code = 429) or (response.status.code GreaterThanOrEquals 500)"
MCP_HANDSHAKE = ('(parsepayload.PP-ParseMcp.json-rpc.request.method != "initialize") and '
                 '(parsepayload.PP-ParseMcp.json-rpc.request.method != "ping") and '
                 'NOT (parsepayload.PP-ParseMcp.json-rpc.request.method =| "notifications/")')
MCP_PARSE_FAILED = '(fault.name = "InvalidJson") or (parsepayload.PP-ParseMcp.failed = true)'
GOOGLE_AUTH = """    <Authentication>
      <GoogleAccessToken>
        <Scopes>
          <Scope>https://www.googleapis.com/auth/cloud-platform</Scope>
        </Scopes>
      </GoogleAccessToken>
    </Authentication>
"""


def xml(body):
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + LICENSE + body.strip() + "\n"


def steps(*items):
    """items: name or (name, condition)."""
    out = []
    for it in items:
        if isinstance(it, tuple):
            name, cond = it
            out.append(f"        <Step>\n          <Name>{name}</Name>\n          <Condition>{cond}</Condition>\n        </Step>")
        else:
            out.append(f"        <Step>\n          <Name>{it}</Name>\n        </Step>")
    return "\n".join(out)


def flow_block(tag, req=(), res=(), name=None, extra=""):
    attr = f' name="{name}"' if name is not None else ""
    r1 = f"\n      <Request>\n{steps(*req)}\n      </Request>" if req else "\n      <Request/>"
    r2 = f"\n      <Response>\n{steps(*res)}\n      </Response>" if res else "\n      <Response/>"
    return f"    <{tag}{attr}>{extra}{r1}{r2}\n    </{tag}>"


# --------------------------------------------------------------------------------------
# Common policies
# --------------------------------------------------------------------------------------
def p_verify_api_key():
    return xml("""
<VerifyAPIKey continueOnError="false" enabled="true" name="VA-VerifyAPIKey">
  <DisplayName>VA-VerifyAPIKey</DisplayName>
  <APIKey ref="request.header.x-apikey"/>
</VerifyAPIKey>""")


def p_js(name, resource, props=None, time_limit=500, coe=True):
    props = props or {}
    p = "".join(f'\n    <Property name="{k}">{v}</Property>' for k, v in props.items())
    props_xml = f"\n  <Properties>{p}\n  </Properties>" if props else "\n  <Properties/>"
    return xml(f"""
<Javascript continueOnError="{'true' if coe else 'false'}" enabled="true" timeLimit="{time_limit}" name="{name}">
  <DisplayName>{name}</DisplayName>{props_xml}
  <ResourceURL>jsc://{resource}</ResourceURL>
</Javascript>""")


def p_message_logging(capability):
    # Label values are static strings (MessageLogging does not resolve templates there);
    # __PROXY_NAME__ is replaced by write_proxy().
    return xml(f"""
<MessageLogging continueOnError="true" enabled="true" name="ML-Log">
  <DisplayName>ML-Log</DisplayName>
  <CloudLogging>
    <LogName>projects/{{organization.name}}/logs/__LOG_NAME__</LogName>
    <!-- Compact JSON entry built by JS-Finalize (aigw-finalize.js): only non-empty fields. -->
    <Message contentType="application/json">{{aigw.log_json}}</Message>
    <Labels>
      <Label>
        <Key>proxy</Key>
        <Value>__PROXY_NAME__</Value>
      </Label>
      <Label>
        <Key>capability</Key>
        <Value>{capability}</Value>
      </Label>
    </Labels>
  </CloudLogging>
</MessageLogging>""")


def p_clean_request():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-CleanRequest">
  <DisplayName>AM-CleanRequest</DisplayName>
  <Remove>
    <Headers>
      <Header name="x-apikey"/>
      <Header name="x-aigw-simulate-failure"/>
      <Header name="x-aigw-routing"/>
      <Header name="Accept-Encoding"/>
    </Headers>
  </Remove>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <AssignTo createNew="false" transport="http" type="request"/>
</AssignMessage>""")


def p_error(name, status, reason, payload):
    return xml(f"""
<AssignMessage continueOnError="false" enabled="true" name="{name}">
  <DisplayName>{name}</DisplayName>
  <Set>
    <Payload contentType="application/json">{payload}</Payload>
    <StatusCode>{status}</StatusCode>
    <ReasonPhrase>{reason}</ReasonPhrase>
  </Set>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")


def p_err_unauthorized():
    return p_error("AM-Err-Unauthorized", 401, "Unauthorized",
                   '{"error":{"type":"unauthorized","code":"{fault.name}","message":"API key ausente o inválida. '
                   'Enviala en el header x-apikey.","status":401,"proxy":"{apiproxy.name}","requestId":"{messageid}"}}')


def p_err_forbidden():
    return p_error("AM-Err-Forbidden", 403, "Forbidden",
                   '{"error":{"type":"unauthorized","code":"{fault.name}","message":"La API key es válida pero su API '
                   'Product no incluye este recurso.","status":403,"proxy":"{apiproxy.name}","requestId":"{messageid}"}}')


def p_err_prompt_limit():
    return p_error("AM-Err-PromptTokenLimit", 429, "Too Many Requests",
                   '{"error":{"type":"prompt_token_limit","code":"PROMPT_TOKEN_LIMIT_EXCEEDED","message":"El prompt '
                   'supera el límite de tokens por minuto de la app (PromptTokenLimit). Apigee lo bloqueó antes de '
                   'llegar al LLM.","status":429,"proxy":"{apiproxy.name}","requestId":"{messageid}","details":'
                   '{"promptTokens":{ratelimit.PTL-PromptRate.userPromptTokenCount:0},"limit":1500,"rate":"1500 tokens/min por app"}}}')


def p_err_token_quota():
    return p_error("AM-Err-TokenQuota", 429, "Too Many Requests",
                   '{"error":{"type":"llm_token_quota","code":"LLM_TOKEN_QUOTA_EXCEEDED","message":"Cuota de tokens '
                   'agotada (LLMTokenQuota). Se reinicia automáticamente al terminar el intervalo.","status":429,'
                   '"proxy":"{apiproxy.name}","requestId":"{messageid}","details":{"plan":"{aigw.plan}",'
                   '"used":{ratelimit.LTQ-Enforce.used.count:0},"allowed":{ratelimit.LTQ-Enforce.allowed.count:0},'
                   '"resetAt":{ratelimit.LTQ-Enforce.expiry.time:0}}}}')


def p_mcp_errors():
    rid = "{parsepayload.PP-ParseMcp.json-rpc.request.id:null}"
    tool = "{parsepayload.PP-ParseMcp.json-rpc.request.params.name}"
    return {
        "AM-Err-McpUnauthorized": p_error(
            "AM-Err-McpUnauthorized", 401, "Unauthorized",
            '{"jsonrpc":"2.0","id":' + rid + ',"error":{"code":-32001,"message":"No autorizado: API key ausente o '
            'inválida (header x-apikey).","data":{"type":"unauthorized","code":"{fault.name}","proxy":"{apiproxy.name}",'
            '"requestId":"{messageid}"}}}'),
        "AM-Err-McpForbidden": p_error(
            "AM-Err-McpForbidden", 403, "Forbidden",
            '{"jsonrpc":"2.0","id":' + rid + ',"error":{"code":-32003,"message":"Herramienta no autorizada: '
            + tool + ' no está incluida en el API Product de esta app.","data":{"type":"mcp_tool_not_allowed",'
            '"tool":"' + tool + '","operation":"{parsepayload.PP-ParseMcp.operation}","proxy":"{apiproxy.name}",'
            '"requestId":"{messageid}"}}}'),
        "AM-Err-McpQuota": p_error(
            "AM-Err-McpQuota", 429, "Too Many Requests",
            '{"jsonrpc":"2.0","id":' + rid + ',"error":{"code":-32029,"message":"Cuota agotada para la herramienta '
            + tool + ' (definida en el API Product).","data":{"type":"mcp_tool_quota","tool":"' + tool + '",'
            '"used":{ratelimit.Q-McpToolQuota.used.count:0},"allowed":{ratelimit.Q-McpToolQuota.allowed.count:0},'
            '"resetAt":{ratelimit.Q-McpToolQuota.expiry.time:0},"proxy":"{apiproxy.name}","requestId":"{messageid}"}}}'),
        "AM-Err-McpParse": p_error(
            "AM-Err-McpParse", 400, "Bad Request",
            '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Request JSON-RPC inválido: el body debe ser '
            'un objeto JSON-RPC 2.0 (jsonrpc, id, method, params).","data":{"type":"parse_error",'
            '"proxy":"{apiproxy.name}","requestId":"{messageid}"}}}'),
    }


def p_method_not_allowed():
    return xml("""
<RaiseFault continueOnError="false" enabled="true" name="RF-MethodNotAllowed">
  <DisplayName>RF-MethodNotAllowed</DisplayName>
  <FaultResponse>
    <Set>
      <Headers>
        <Header name="Allow">POST</Header>
      </Headers>
      <StatusCode>405</StatusCode>
      <ReasonPhrase>Method Not Allowed</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")


def p_parse_mcp():
    return xml("""
<ParsePayload continueOnError="false" enabled="true" name="PP-ParseMcp">
  <DisplayName>PP-ParseMcp</DisplayName>
  <Source>request</Source>
  <PayloadType>JSON-RPC-2.0</PayloadType>
  <Protocol>MCP</Protocol>
</ParsePayload>""")


def p_mcp_quota():
    return xml("""
<Quota continueOnError="false" enabled="true" name="Q-McpToolQuota">
  <DisplayName>Q-McpToolQuota</DisplayName>
  <UseQuotaConfigInAPIProduct stepName="VA-VerifyAPIKey">
    <DefaultConfig>
      <Allow>120</Allow>
      <Interval>1</Interval>
      <TimeUnit>minute</TimeUnit>
    </DefaultConfig>
  </UseQuotaConfigInAPIProduct>
  <Distributed>true</Distributed>
  <Synchronous>true</Synchronous>
</Quota>""")


def p_sup():
    return xml(f"""
<SanitizeUserPrompt continueOnError="true" enabled="true" name="SUP-Prompt">
  <DisplayName>SUP-Prompt</DisplayName>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <ModelArmor>
    <TemplateName>{MA_TEMPLATE}</TemplateName>
  </ModelArmor>
  <UserPromptSource>{PROMPT_SRC}</UserPromptSource>
</SanitizeUserPrompt>""")


def p_smr():
    return xml(f"""
<SanitizeModelResponse continueOnError="true" enabled="true" name="SMR-Response">
  <DisplayName>SMR-Response</DisplayName>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <ModelArmor>
    <TemplateName>{MA_TEMPLATE}</TemplateName>
  </ModelArmor>
  <UserPromptSource>{PROMPT_SRC}</UserPromptSource>
  <LLMResponseSource>{{jsonPath('$.choices[0].message.content',response.content,true)}}</LLMResponseSource>
</SanitizeModelResponse>""")


def p_armor_block(name, stage, code):
    return xml(f"""
<RaiseFault continueOnError="false" enabled="true" name="{name}">
  <DisplayName>{name}</DisplayName>
  <FaultResponse>
    <Set>
      <Payload contentType="application/json">{{"error":{{"type":"model_armor_block","code":"{code}","message":"{{escapeJSON(aigw.armor.message)}}","status":400,"proxy":"{{apiproxy.name}}","requestId":"{{messageid}}","details":{{"stage":"{stage}","filters":{{aigw.armor.filters_json}},"labels":{{aigw.armor.labels_json}},"findings":{{aigw.armor.findings_json}},"template":"{MA_TEMPLATE}"}}}}}}</Payload>
      <StatusCode>400</StatusCode>
      <ReasonPhrase>Bad Request</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")


def p_armor_unavailable():
    return xml("""
<RaiseFault continueOnError="false" enabled="true" name="RF-ArmorUnavailable">
  <DisplayName>RF-ArmorUnavailable</DisplayName>
  <FaultResponse>
    <Set>
      <Payload contentType="application/json">{"error":{"type":"upstream_error","code":"MODEL_ARMOR_UNAVAILABLE","message":"No se pudo inspeccionar el prompt con Model Armor; la solicitud se rechaza por seguridad (fail-closed).","status":503,"proxy":"{apiproxy.name}","requestId":"{messageid}"}}</Payload>
      <StatusCode>503</StatusCode>
      <ReasonPhrase>Service Unavailable</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")


def p_scl():
    return xml(f"""
<SemanticCacheLookup continueOnError="true" enabled="true" name="SCL-Lookup">
  <DisplayName>SCL-Lookup</DisplayName>
  <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
  <UserPromptSource>{PROMPT_SRC}</UserPromptSource>
  <Embeddings>
    <VertexAI>
      <URL>https://__REGION__-aiplatform.googleapis.com/v1/projects/__PROJECT_ID__/locations/__REGION__/publishers/google/models/__EMBEDDINGS_MODEL__:predict</URL>
    </VertexAI>
  </Embeddings>
  <SimilaritySearch>
    <VertexAI>
      <URL>https://__VS_PUBLIC_DOMAIN__/v1/projects/__PROJECT_NUMBER__/locations/__REGION__/indexEndpoints/__VS_INDEX_ENDPOINT_ID__:findNeighbors</URL>
      <DeployedIndexID>__VS_DEPLOYED_INDEX_ID__</DeployedIndexID>
      <Threshold>__SEMANTIC_CACHE_THRESHOLD__</Threshold>
      <DistanceMeasureType>DOT_PRODUCT_DISTANCE</DistanceMeasureType>
    </VertexAI>
  </SimilaritySearch>
</SemanticCacheLookup>""")


def p_scp():
    return xml("""
<SemanticCachePopulate continueOnError="true" enabled="true" name="SCP-Populate">
  <DisplayName>SCP-Populate</DisplayName>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <SimilaritySearch>
    <VertexAI>
      <URL>https://__REGION__-aiplatform.googleapis.com/v1/projects/__PROJECT_NUMBER__/locations/__REGION__/indexes/__VS_INDEX_ID__:upsertDatapoints</URL>
    </VertexAI>
  </SimilaritySearch>
  <TTLInSeconds>__SEMANTIC_CACHE_TTL_SEC__</TTLInSeconds>
</SemanticCachePopulate>""")


def p_ptl():
    return xml(f"""
<PromptTokenLimit continueOnError="false" enabled="true" name="PTL-PromptRate">
  <DisplayName>PTL-PromptRate</DisplayName>
  <Properties/>
  <UserPromptSource>{PROMPT_SRC}</UserPromptSource>
  <Identifier ref="verifyapikey.VA-VerifyAPIKey.client_id"/>
  <Rate>1500pm</Rate>
  <UseEffectiveCount>true</UseEffectiveCount>
  <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
</PromptTokenLimit>""")


def p_ltq(name, mode, product_based, shared, model_src, usage_src=None):
    if product_based:
        allow = ('<Allow count="1000" countRef="verifyapikey.VA-VerifyAPIKey.apiproduct.developer.llmQuota.limit"/>\n'
                 '  <Interval ref="verifyapikey.VA-VerifyAPIKey.apiproduct.developer.llmQuota.interval">2</Interval>\n'
                 '  <TimeUnit ref="verifyapikey.VA-VerifyAPIKey.apiproduct.developer.llmQuota.timeunit">minute</TimeUnit>')
    else:
        allow = '<Allow count="30000"/>\n  <Interval>5</Interval>\n  <TimeUnit>minute</TimeUnit>'
    mode_xml = "<CountOnly>true</CountOnly>" if mode == "count" else "<EnforceOnly>true</EnforceOnly>"
    usage = f"\n  <LLMTokenUsageSource>{usage_src}</LLMTokenUsageSource>" if usage_src else ""
    return xml(f"""
<LLMTokenQuota continueOnError="false" enabled="true" name="{name}" type="calendar">
  <DisplayName>{name}</DisplayName>
  {allow}
  <Identifier ref="verifyapikey.VA-VerifyAPIKey.client_id"/>
  <Distributed>true</Distributed>
  <Synchronous>true</Synchronous>
  <StartTime>2026-01-01 00:00:00</StartTime>{usage}
  <LLMModelSource>{model_src}</LLMModelSource>
  {mode_xml}
  <SharedName>{shared}</SharedName>
</LLMTokenQuota>""")


def p_cb_quota(name, mode, shared):
    mode_xml = "<CountOnly>true</CountOnly>" if mode == "count" else "<EnforceOnly>true</EnforceOnly>"
    coe = "true" if mode == "enforce" else "false"
    return xml(f"""
<Quota continueOnError="{coe}" enabled="true" name="{name}" type="rollingwindow">
  <DisplayName>{name}</DisplayName>
  <Allow count="1000"/>
  <Interval>1</Interval>
  <TimeUnit>minute</TimeUnit>
  <Distributed>true</Distributed>
  <Synchronous>true</Synchronous>
  {mode_xml}
  <SharedName>{shared}</SharedName>
</Quota>""")


def p_init(provider=None):
    extra = ""
    if provider:
        extra = f"""
  <AssignVariable>
    <Name>aigw.provider</Name>
    <Value>{provider}</Value>
  </AssignVariable>"""
    return xml(f"""
<AssignMessage continueOnError="false" enabled="true" name="AM-Init">
  <DisplayName>AM-Init</DisplayName>
  <AssignVariable>
    <Name>aigw.simulate</Name>
    <Ref>request.header.x-aigw-simulate-failure</Ref>
  </AssignVariable>{extra}
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")


def p_mark_primary():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-MarkPrimary">
  <DisplayName>AM-MarkPrimary</DisplayName>
  <AssignVariable>
    <Name>aigw.backend</Name>
    <Value>primary</Value>
  </AssignVariable>
  <AssignVariable>
    <Name>aigw.backend_region</Name>
    <Value>__LLM_LOCATION__</Value>
  </AssignVariable>
  <AssignVariable>
    <Name>aigw.backend_model</Name>
    <Template>{jsonPath('$.model',request.content,true)}</Template>
  </AssignVariable>
  <AssignVariable>
    <Name>aigw.failover</Name>
    <Value>false</Value>
  </AssignVariable>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")


def p_simulate_failure():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-SimulateFailure">
  <DisplayName>AM-SimulateFailure</DisplayName>
  <!-- Demo only: point the primary target to the mock provider that answers HTTP 429. -->
  <AssignVariable>
    <Name>target.copy.pathsuffix</Name>
    <Value>false</Value>
  </AssignVariable>
  <AssignVariable>
    <Name>target.url</Name>
    <Value>https://__APIGEE_HOST__/v1/aigw/mock-llm/429</Value>
  </AssignVariable>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")


def p_prep_secondary():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-PrepSecondary">
  <DisplayName>AM-PrepSecondary</DisplayName>
  <AssignTo createNew="true" transport="http" type="request">secondaryRequest</AssignTo>
  <Set>
    <Headers>
      <Header name="Content-Type">application/json</Header>
    </Headers>
    <Payload contentType="application/json">{aigw.fallback_body}</Payload>
    <Verb>POST</Verb>
  </Set>
  <IgnoreUnresolvedVariables>false</IgnoreUnresolvedVariables>
</AssignMessage>""")


def p_sc_secondary():
    return xml(f"""
<ServiceCallout continueOnError="false" enabled="true" name="SC-Secondary">
  <DisplayName>SC-Secondary</DisplayName>
  <Request clearPayload="false" variable="secondaryRequest">
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  </Request>
  <Response>secondaryResponse</Response>
  <HTTPTargetConnection>
{GOOGLE_AUTH}    <Properties>
      <Property name="success.codes">1xx,2xx,3xx,4xx,5xx</Property>
      <Property name="io.timeout.millis">60000</Property>
    </Properties>
    <URL>{FALLBACK_URL}</URL>
  </HTTPTargetConnection>
</ServiceCallout>""")


def p_use_secondary():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-UseSecondary">
  <DisplayName>AM-UseSecondary</DisplayName>
  <Remove>
    <Headers>
      <Header name="Retry-After"/>
    </Headers>
  </Remove>
  <Set>
    <Payload contentType="application/json">{secondaryResponse.content}</Payload>
    <StatusCode>{secondaryResponse.status.code}</StatusCode>
    <ReasonPhrase>OK</ReasonPhrase>
  </Set>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")


def p_set_plan():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-SetPlan">
  <DisplayName>AM-SetPlan</DisplayName>
  <AssignVariable>
    <Name>aigw.plan</Name>
    <Ref>apiproduct.name</Ref>
  </AssignVariable>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")


def p_no_pathsuffix():
    return xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-NoPathSuffix">
  <DisplayName>AM-NoPathSuffix</DisplayName>
  <AssignVariable>
    <Name>target.copy.pathsuffix</Name>
    <Value>false</Value>
  </AssignVariable>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>""")


# --------------------------------------------------------------------------------------
# Endpoint builders
# --------------------------------------------------------------------------------------
def default_fault_rule(kind="llm"):
    if kind == "mcp":
        items = [("AM-Err-McpParse", MCP_PARSE_FAILED),
                 ("AM-Err-McpForbidden", 'fault.name = "InvalidApiKeyForGivenResource"'),
                 ("AM-Err-McpUnauthorized", '(verifyapikey.VA-VerifyAPIKey.failed = true) and (fault.name != "InvalidApiKeyForGivenResource")'),
                 "JS-Finalize"]
    elif kind == "none":
        items = ["JS-Finalize"]
    else:
        items = [("AM-Err-Forbidden", 'fault.name = "InvalidApiKeyForGivenResource"'),
                 ("AM-Err-Unauthorized", '(verifyapikey.VA-VerifyAPIKey.failed = true) and (fault.name != "InvalidApiKeyForGivenResource")'),
                 "JS-Finalize"]
    return ("  <DefaultFaultRule name=\"default-fault\">\n" + steps(*items).replace("        ", "    ")
            + "\n    <AlwaysEnforce>true</AlwaysEnforce>\n  </DefaultFaultRule>")


def fault_rules(rules):
    if not rules:
        return "  <FaultRules/>"
    out = ["  <FaultRules>"]
    for name, step, cond in rules:
        out.append(f"    <FaultRule name=\"{name}\">\n      <Step>\n        <Name>{step}</Name>\n      </Step>\n"
                   f"      <Condition>{cond}</Condition>\n    </FaultRule>")
    out.append("  </FaultRules>")
    return "\n".join(out)


TOKEN_FAULTS = [("prompt-token-limit", "AM-Err-PromptTokenLimit", 'fault.name = "PromptTokenLimitViolation"'),
                ("llm-token-quota", "AM-Err-TokenQuota", 'fault.name = "LLMTokenQuotaViolation"')]


def proxy_endpoint(description, base_path, pre_req, pre_res=(), post_res=("JS-Finalize",), flows="  <Flows/>",
                   routes=None, faults=None, fault_kind="llm"):
    routes = routes or [("llm", "llm", None)]
    route_xml = []
    for name, target, cond in routes:
        t = f"\n    <TargetEndpoint>{target}</TargetEndpoint>" if target else ""
        c = f"\n    <Condition>{cond}</Condition>" if cond else ""
        route_xml.append(f"  <RouteRule name=\"{name}\">{t}{c}\n  </RouteRule>")
    return xml(f"""
<ProxyEndpoint name="default">
  <Description>{description}</Description>
{fault_rules(faults)}
{default_fault_rule(fault_kind)}
{flow_block("PreFlow", pre_req, pre_res, name="PreFlow")}
{flows}
{flow_block("PostFlow", (), post_res, name="PostFlow")}
  <PostClientFlow>
    <Response>
{steps("ML-Log")}
    </Response>
  </PostClientFlow>
  <HTTPProxyConnection>
    <BasePath>{base_path}</BasePath>
  </HTTPProxyConnection>
{chr(10).join(route_xml)}
</ProxyEndpoint>""").replace("    <PreFlow", "  <PreFlow").replace("    </PreFlow>", "  </PreFlow>") \
        .replace("    <PostFlow", "  <PostFlow").replace("    </PostFlow>", "  </PostFlow>")


def target_endpoint(name, url, pre_req=(), pre_res=(), auth=True, props=None, event_flow=None, description="",
                    fault_rules_xml=""):
    props = props or {}
    props.setdefault("io.timeout.millis", "120000")
    p = "\n".join(f'      <Property name="{k}">{v}</Property>' for k, v in props.items())
    ev = ""
    if event_flow:
        ev = (f"\n  <EventFlow name=\"EventFlow\" content-type=\"text/event-stream\">\n    <Response>\n"
              f"{steps(*event_flow).replace('        ', '      ')}\n    </Response>\n  </EventFlow>")
    faults = f"\n{fault_rules_xml}" if fault_rules_xml else ""
    body = f"""
<TargetEndpoint name="{name}">
  <Description>{description}</Description>{faults}
{flow_block("PreFlow", pre_req, pre_res, name="PreFlow").replace("    <PreFlow", "  <PreFlow").replace("    </PreFlow>", "  </PreFlow>")}
  <PostFlow name="PostFlow">
    <Request/>
    <Response/>
  </PostFlow>{ev}
  <HTTPTargetConnection>
{GOOGLE_AUTH if auth else ""}    <Properties>
{p}
    </Properties>
    <URL>{url}</URL>
  </HTTPTargetConnection>
</TargetEndpoint>"""
    return xml(body)


# --------------------------------------------------------------------------------------
# Writer
# --------------------------------------------------------------------------------------
def write_proxy(name, display, description, endpoints, targets, policies, js=(), extra_resources=None):
    base = os.path.join(PROXIES, name, "apiproxy")
    for sub in ("proxies", "targets", "policies"):
        d = os.path.join(base, sub)
        if os.path.isdir(d):
            shutil.rmtree(d)
        os.makedirs(d, exist_ok=True)
    jsc = os.path.join(base, "resources", "jsc")
    if os.path.isdir(jsc):
        shutil.rmtree(jsc)
    os.makedirs(jsc, exist_ok=True)
    with open(os.path.join(base, f"{name}.xml"), "w", encoding="utf-8") as f:
        f.write(xml(f"""
<APIProxy name="{name}">
  <DisplayName>{display}</DisplayName>
  <Description>{description}</Description>
</APIProxy>"""))
    for ep_name, content in endpoints.items():
        with open(os.path.join(base, "proxies", f"{ep_name}.xml"), "w", encoding="utf-8") as f:
            f.write(content)
    for t_name, content in targets.items():
        with open(os.path.join(base, "targets", f"{t_name}.xml"), "w", encoding="utf-8") as f:
            f.write(content)
    for p_name, content in policies.items():
        with open(os.path.join(base, "policies", f"{p_name}.xml"), "w", encoding="utf-8") as f:
            f.write(content.replace("__PROXY_NAME__", name))
    for j in js:
        shutil.copy(os.path.join(COMMON_JS, j), os.path.join(jsc, j))
    print(f"  {name}: {len(policies)} policies, {len(targets)} targets")


def common(capability, read_response=True, stream_header=False, kind="llm"):
    props = {"capability": capability}
    if not read_response:
        props["readResponse"] = "false"
    if stream_header:
        props["streamHeader"] = "true"
    pol = {"JS-Finalize": p_js("JS-Finalize", "aigw-finalize.js", props), "ML-Log": p_message_logging(capability)}
    if kind == "llm":
        pol.update({"VA-VerifyAPIKey": p_verify_api_key(), "AM-Err-Unauthorized": p_err_unauthorized(),
                    "AM-Err-Forbidden": p_err_forbidden(), "AM-CleanRequest": p_clean_request()})
    elif kind == "mcp":
        pol.update({"VA-VerifyAPIKey": p_verify_api_key(), "PP-ParseMcp": p_parse_mcp(),
                    "Q-McpToolQuota": p_mcp_quota(), "RF-MethodNotAllowed": p_method_not_allowed(),
                    "AM-CleanRequest": p_clean_request()})
        pol.update(p_mcp_errors())
    return pol


def armor_policies():
    return {"SUP-Prompt": p_sup(), "SMR-Response": p_smr(),
            "JS-ArmorPrompt": p_js("JS-ArmorPrompt", "aigw-armor.js", {"stage": "prompt"}),
            "JS-ArmorResponse": p_js("JS-ArmorResponse", "aigw-armor.js", {"stage": "response"}),
            "RF-ArmorPromptBlocked": p_armor_block("RF-ArmorPromptBlocked", "prompt", "PROMPT_BLOCKED"),
            "RF-ArmorResponseBlocked": p_armor_block("RF-ArmorResponseBlocked", "response", "RESPONSE_BLOCKED"),
            "RF-ArmorUnavailable": p_armor_unavailable()}


def circuit_policies(shared):
    return {"Q-CB-Check": p_cb_quota("Q-CB-Check", "enforce", shared),
            "Q-CB-Count": p_cb_quota("Q-CB-Count", "count", shared),
            "JS-CircuitState": p_js("JS-CircuitState", "aigw-circuit.js", {"mode": "state", "threshold": "2"}),
            "JS-CircuitPrepare": p_js("JS-CircuitPrepare", "aigw-circuit.js", {"mode": "prepare"}, coe=False),
            "JS-CircuitComplete": p_js("JS-CircuitComplete", "aigw-circuit.js", {"mode": "complete", "threshold": "2"}),
            "JS-CircuitRouteSecondary": p_js("JS-CircuitRouteSecondary", "aigw-circuit.js", {"mode": "route-secondary"}, coe=False),
            "JS-NormalizeSecondary": p_js("JS-NormalizeSecondary", "aigw-circuit.js", {"mode": "normalize"}),
            "AM-MarkPrimary": p_mark_primary(), "AM-SimulateFailure": p_simulate_failure(),
            "AM-PrepSecondary": p_prep_secondary(), "SC-Secondary": p_sc_secondary(),
            "AM-UseSecondary": p_use_secondary()}


FAILOVER_STEPS = (("JS-CircuitPrepare", FAILOVER_COND),
                  ("Q-CB-Count", 'aigw.failover_needed = "true"'),
                  ("AM-PrepSecondary", 'aigw.failover_needed = "true"'),
                  ("SC-Secondary", 'aigw.failover_needed = "true"'),
                  ("AM-UseSecondary", 'aigw.failover_needed = "true"'),
                  ("JS-NormalizeSecondary", 'aigw.failover_needed = "true"'),
                  ("JS-CircuitComplete", 'aigw.failover_needed = "true"'))
ALL_CODES = {"success.codes": "1xx,2xx,3xx,4xx,5xx"}


# --------------------------------------------------------------------------------------
# Proxies
# --------------------------------------------------------------------------------------
def gen_mock_llm():
    pol = common("mock-llm", kind="none")
    pol["RF-Simulated429"] = xml("""
<RaiseFault continueOnError="false" enabled="true" name="RF-Simulated429">
  <DisplayName>RF-Simulated429</DisplayName>
  <FaultResponse>
    <Set>
      <Headers>
        <Header name="Retry-After">30</Header>
      </Headers>
      <Payload contentType="application/json">{"error":{"code":429,"message":"Resource exhausted (simulated by the Apigee AI Gateway demo). Please try again later.","status":"RESOURCE_EXHAUSTED"}}</Payload>
      <StatusCode>429</StatusCode>
      <ReasonPhrase>Too Many Requests</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")
    pol["RF-Simulated503"] = xml("""
<RaiseFault continueOnError="false" enabled="true" name="RF-Simulated503">
  <DisplayName>RF-Simulated503</DisplayName>
  <FaultResponse>
    <Set>
      <Payload contentType="application/json">{"error":{"code":503,"message":"The service is currently unavailable (simulated by the Apigee AI Gateway demo).","status":"UNAVAILABLE"}}</Payload>
      <StatusCode>503</StatusCode>
      <ReasonPhrase>Service Unavailable</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")
    ep = proxy_endpoint("Simulated LLM provider outage (HTTP 429/503) used by the failover demos.",
                        "/v1/aigw/mock-llm",
                        pre_req=(("RF-Simulated503", 'proxy.pathsuffix =| "/503"'), "RF-Simulated429"),
                        routes=[("noroute", None, None)], fault_kind="none")
    write_proxy("aigw-mock-llm", "AI Gateway - Mock LLM (outage simulator)",
                "Returns Vertex AI style 429/503 errors to demonstrate failover and circuit breaking.",
                {"default": ep}, {}, pol, js=("aigw-finalize.js",))


def gen_retail_api():
    pol = common("retail-api", read_response=False, kind="none")
    pol["JS-RetailApi"] = p_js("JS-RetailApi", "retail-api.js", time_limit=500, coe=False)
    ep = proxy_endpoint("Cymbal Retail mock REST API (backend of the MCP Discovery Proxy).", "/v1/aigw/retail",
                        pre_req=(), pre_res=("JS-RetailApi",), routes=[("noroute", None, None)], fault_kind="none")
    base = os.path.join(PROXIES, "aigw-retail-api", "apiproxy", "resources", "jsc")
    keep = os.path.join(base, "retail-api.js")
    content = open(keep, encoding="utf-8").read()
    write_proxy("aigw-retail-api", "AI Gateway - Cymbal Retail API (mock)",
                "Mock catalog/stores/orders API exposed as MCP tools by aigw-mcp-retail.",
                {"default": ep}, {}, pol, js=("aigw-finalize.js",))
    with open(keep, "w", encoding="utf-8") as f:
        f.write(content)


def gen_semantic_cache():
    pol = common("semantic-cache")
    pol.update({"SCL-Lookup": p_scl(), "SCP-Populate": p_scp()})
    ep = proxy_endpoint("Semantic caching for LLM prompts (Vertex AI embeddings + Vector Search).",
                        "/v1/aigw/semantic-cache", pre_req=("VA-VerifyAPIKey", "SCL-Lookup"))
    tg = target_endpoint("llm", LLM_URL, pre_req=("AM-CleanRequest",),
                         pre_res=(("SCP-Populate", "response.status.code = 200"),),
                         description="Gemini on Vertex AI (OpenAI-compatible endpoint)")
    write_proxy("aigw-semantic-cache", "AI Gateway - Semantic Caching",
                "SemanticCacheLookup / SemanticCachePopulate in front of Gemini (OpenAI-compatible API).",
                {"default": ep}, {"llm": tg}, pol, js=("aigw-finalize.js",))


def gen_model_armor():
    pol = common("model-armor")
    pol.update(armor_policies())
    ep = proxy_endpoint(
        "Model Armor: sanitizes user prompts and model responses.", "/v1/aigw/model-armor",
        pre_req=("VA-VerifyAPIKey", "SUP-Prompt", "JS-ArmorPrompt",
                 ("RF-ArmorPromptBlocked", 'aigw.armor.prompt = "blocked"'),
                 ("RF-ArmorUnavailable", 'aigw.armor.prompt = "error"')),
        pre_res=(("SMR-Response", "response.status.code = 200"),
                 ("JS-ArmorResponse", "response.status.code = 200"),
                 ("RF-ArmorResponseBlocked", 'aigw.armor.response = "blocked"')))
    tg = target_endpoint("llm", LLM_URL, pre_req=("AM-CleanRequest",), description="Gemini on Vertex AI")
    write_proxy("aigw-model-armor", "AI Gateway - Model Armor",
                "SanitizeUserPrompt / SanitizeModelResponse with a Model Armor template.",
                {"default": ep}, {"llm": tg}, pol, js=("aigw-finalize.js", "aigw-armor.js"))


def gen_token_limits():
    pol = common("token-limits")
    model_src = "{jsonPath('$.model',request.content,true)}"
    pol.update({
        "AM-SetPlan": p_set_plan(), "PTL-PromptRate": p_ptl(),
        "LTQ-Enforce": p_ltq("LTQ-Enforce", "enforce", True, "aigw-token-limits", model_src),
        "LTQ-Count": p_ltq("LTQ-Count", "count", True, "aigw-token-limits", model_src,
                           "{jsonPath('$.usage.total_tokens',response.content,true)}"),
        "AM-Err-PromptTokenLimit": p_err_prompt_limit(), "AM-Err-TokenQuota": p_err_token_quota()})
    ep = proxy_endpoint("PromptTokenLimit (token spike arrest) + LLMTokenQuota driven by AI Products.",
                        "/v1/aigw/token-limits",
                        pre_req=("VA-VerifyAPIKey", "AM-SetPlan", "PTL-PromptRate", "LTQ-Enforce"),
                        faults=TOKEN_FAULTS)
    tg = target_endpoint("llm", LLM_URL, pre_req=("AM-CleanRequest",),
                         pre_res=(("LTQ-Count", "response.status.code = 200"),), description="Gemini on Vertex AI")
    write_proxy("aigw-token-limits", "AI Gateway - Token Limits",
                "PromptTokenLimit + LLMTokenQuota (Bronze / Gold AI Products).",
                {"default": ep}, {"llm": tg}, pol, js=("aigw-finalize.js",))


def gen_circuit_breaker():
    pol = common("circuit-breaker")
    pol.update(circuit_policies("aigw-cb-failures"))
    pol["AM-Init"] = p_init("Google Gemini")
    ep = proxy_endpoint(
        "Circuit breaking: failover from Gemini (global) to Claude Sonnet 5.5 (Anthropic, Vertex AI Model Garden).",
        "/v1/aigw/circuit-breaker",
        pre_req=("VA-VerifyAPIKey", "AM-Init", "Q-CB-Check", "JS-CircuitState"),
        routes=[("secondary", "secondary", 'aigw.circuit = "OPEN"'), ("primary", "primary", None)])
    primary = target_endpoint("primary", LLM_URL,
                              pre_req=("AM-MarkPrimary", ("AM-SimulateFailure", 'aigw.simulate = "primary"'),
                                       "AM-CleanRequest"),
                              pre_res=FAILOVER_STEPS, props=dict(ALL_CODES),
                              description="Primary: Gemini on Vertex AI (global)")
    secondary = target_endpoint("secondary", FALLBACK_URL,
                                pre_req=("JS-CircuitRouteSecondary", "AM-CleanRequest"),
                                pre_res=("JS-NormalizeSecondary",), props=dict(ALL_CODES),
                                description="Secondary: Claude Sonnet 5.5 (Anthropic) on Vertex AI Model Garden via :rawPredict")
    write_proxy("aigw-circuit-breaker", "AI Gateway - Circuit Breaking",
                "Primary/secondary LLM targets with automatic failover and a quota-based circuit breaker.",
                {"default": ep}, {"primary": primary, "secondary": secondary}, pol,
                js=("aigw-finalize.js", "aigw-circuit.js"))


def gen_llm_routing():
    pol = common("llm-routing")
    pol.pop("AM-CleanRequest", None)
    pol.update({
        "EV-ExtractFields": xml("""
<ExtractVariables continueOnError="true" enabled="true" name="EV-ExtractFields">
  <DisplayName>EV-ExtractFields</DisplayName>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <Header name="x-llm-provider">
    <Pattern ignoreCase="true">{rawProvider}</Pattern>
  </Header>
  <Header name="llm-provider">
    <Pattern ignoreCase="true">{altProvider}</Pattern>
  </Header>
  <Header name="x-logpayload">
    <Pattern ignoreCase="true">{logPayload}</Pattern>
  </Header>
  <JSONPayload>
    <Variable name="requestedModel">
      <JSONPath>$.model</JSONPath>
    </Variable>
  </JSONPayload>
  <Source clearPayload="false">request</Source>
</ExtractVariables>"""),
        "JS-ValidateProvider": p_js("JS-ValidateProvider", "aigw-provider-routing.js", {"mode": "validate"}, coe=False),
        "RF-InvalidProvider": xml("""
<RaiseFault continueOnError="false" enabled="true" name="RF-InvalidProvider">
  <DisplayName>RF-InvalidProvider</DisplayName>
  <FaultResponse>
    <Set>
      <Payload contentType="application/json">{"error":{"type":"invalid_llm_provider","code":"{aigw.provider_error_code}","message":"{aigw.provider_error_msg}","status":400,"proxy":"{apiproxy.name}","requestId":"{messageid}"}}</Payload>
      <StatusCode>400</StatusCode>
      <ReasonPhrase>Bad Request</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>"""),
        "KVM-GetModelProviderConfig": xml("""
<KeyValueMapOperations continueOnError="false" enabled="true" name="KVM-GetModelProviderConfig">
  <DisplayName>KVM-GetModelProviderConfig</DisplayName>
  <ExpiryTimeInSecs>300</ExpiryTimeInSecs>
  <MapName>__ROUTING_KVM_NAME__</MapName>
  <Get assignTo="targetUrlTemplate">
    <Key>
      <Parameter ref="modelProvider"/>
      <Parameter>targetUrl</Parameter>
    </Key>
  </Get>
  <Get assignTo="providerDefaultModel">
    <Key>
      <Parameter ref="modelProvider"/>
      <Parameter>defaultModel</Parameter>
    </Key>
  </Get>
  <Scope>environment</Scope>
</KeyValueMapOperations>"""),
        "AM-SetTarget": xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-SetTarget">
  <DisplayName>AM-SetTarget</DisplayName>
  <Remove>
    <Headers>
      <Header name="x-apikey"/>
      <Header name="x-llm-provider"/>
      <Header name="llm-provider"/>
      <Header name="x-logpayload"/>
      <Header name="Accept-Encoding"/>
    </Headers>
  </Remove>
  <AssignVariable>
    <Name>target.copy.pathsuffix</Name>
    <Value>false</Value>
  </AssignVariable>
  <AssignVariable>
    <Name>target.url</Name>
    <Template ref="targetUrlTemplate"/>
  </AssignVariable>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</AssignMessage>"""),
        "JS-PrepareGoogle": p_js("JS-PrepareGoogle", "aigw-provider-routing.js", {"mode": "google"}, coe=False),
        "JS-PrepareAnthropic": p_js("JS-PrepareAnthropic", "aigw-provider-routing.js", {"mode": "anthropic_req"}, coe=False),
        "JS-NormalizeAnthropic": p_js("JS-NormalizeAnthropic", "aigw-provider-routing.js", {"mode": "anthropic_res"}, coe=False),
    })
    ep = proxy_endpoint(
        "LLM routing by header (x-llm-provider: google | anthropic) across Gemini 3.5 Flash and Claude Sonnet 5.5 (Model Garden).",
        "/v1/aigw/routing",
        pre_req=("VA-VerifyAPIKey", ("EV-ExtractFields", "request.content != null"),
                 "JS-ValidateProvider", ("RF-InvalidProvider", 'aigw.invalid_provider = "true"'),
                 "KVM-GetModelProviderConfig"),
        routes=[("google", "google", 'modelProvider = "google"'),
                ("anthropic", "anthropic", 'modelProvider = "anthropic"')])
    google_tg = target_endpoint(
        "google", "https://notused.googleapis.com",
        pre_req=("JS-PrepareGoogle", "AM-SetTarget"),
        description="Google Vertex AI: gemini-3.5-flash (target.url dynamically set from KVM)")
    anthropic_tg = target_endpoint(
        "anthropic", "https://notused.googleapis.com",
        pre_req=("JS-PrepareAnthropic", "AM-SetTarget"),
        pre_res=("JS-NormalizeAnthropic",),
        props=dict(ALL_CODES),
        description="Vertex AI Model Garden: claude-sonnet-5-5 via :rawPredict (target.url dynamically set from KVM)")
    write_proxy("aigw-llm-routing", "AI Gateway - LLM Routing",
                "Header-based routing (x-llm-provider) via KVM across Gemini 3.5 Flash (Vertex AI) and Claude Sonnet 5.5 (Model Garden).",
                {"default": ep}, {"google": google_tg, "anthropic": anthropic_tg}, pol,
                js=("aigw-finalize.js", "aigw-provider-routing.js"))


def gen_sse_bigquery():
    pol = common("sse-bigquery", read_response=False, stream_header=True, kind="mcp")
    pol.update({"AM-Err-Unauthorized": p_err_unauthorized(), "AM-Err-Forbidden": p_err_forbidden(),
                "AM-NoPathSuffix": p_no_pathsuffix(),
                "JS-SseEvent": p_js("JS-SseEvent", "aigw-sse.js", time_limit=200),
                "RF-NotFound": xml("""
<RaiseFault continueOnError="false" enabled="true" name="RF-NotFound">
  <DisplayName>RF-NotFound</DisplayName>
  <FaultResponse>
    <Set>
      <Payload contentType="application/json">{"error":{"type":"not_found","message":"Usa /mcp/bigquery (MCP) o /chat/completions (streaming).","status":404}}</Payload>
      <StatusCode>404</StatusCode>
      <ReasonPhrase>Not Found</ReasonPhrase>
    </Set>
  </FaultResponse>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
</RaiseFault>""")})
    mcp_path = 'proxy.pathsuffix MatchesPath "/mcp/bigquery"'
    chat_path = 'proxy.pathsuffix MatchesPath "/chat/completions"'
    flows = f"""  <Flows>
    <Flow name="mcp-bigquery">
      <Description>Remote BigQuery MCP server (Streamable HTTP)</Description>
      <Request>
{steps("PP-ParseMcp", ("VA-VerifyAPIKey", MCP_HANDSHAKE), ("Q-McpToolQuota", "verifyapikey.VA-VerifyAPIKey.client_id != null"))}
      </Request>
      <Response/>
      <Condition>{mcp_path}</Condition>
    </Flow>
    <Flow name="chat-stream">
      <Description>Gemini streaming (Server-Sent Events)</Description>
      <Request>
{steps("VA-VerifyAPIKey")}
      </Request>
      <Response/>
      <Condition>{chat_path}</Condition>
    </Flow>
    <Flow name="not-found">
      <Request>
{steps("RF-NotFound")}
      </Request>
      <Response/>
    </Flow>
  </Flows>"""
    # Errors: JSON-RPC for the MCP path, OpenAI style for the chat path.
    dfr_items = [("AM-Err-McpParse", f'({MCP_PARSE_FAILED}) and ({mcp_path})'),
                 ("AM-Err-McpForbidden", f'(fault.name = "InvalidApiKeyForGivenResource") and ({mcp_path})'),
                 ("AM-Err-McpUnauthorized", f'(verifyapikey.VA-VerifyAPIKey.failed = true) and (fault.name != "InvalidApiKeyForGivenResource") and ({mcp_path})'),
                 ("AM-Err-Unauthorized", f'(verifyapikey.VA-VerifyAPIKey.failed = true) and ({chat_path})'),
                 "JS-Finalize"]
    ep = proxy_endpoint("SSE streaming + remote BigQuery MCP server through Apigee.", "/v1/aigw/sse",
                        pre_req=(("RF-MethodNotAllowed", 'request.verb != "POST"'),), flows=flows,
                        routes=[("bigquery", "bigquery", mcp_path), ("llm", "llm-stream", None)],
                        faults=[("tool-quota", "AM-Err-McpQuota", 'fault.name = "QuotaViolation"')])
    ep = ep.replace(default_fault_rule("llm"),
                    "  <DefaultFaultRule name=\"default-fault\">\n" + steps(*dfr_items).replace("        ", "    ")
                    + "\n    <AlwaysEnforce>true</AlwaysEnforce>\n  </DefaultFaultRule>")
    bq = target_endpoint("bigquery", "https://bigquery.googleapis.com/mcp",
                         pre_req=("AM-NoPathSuffix", "AM-CleanRequest"),
                         props={"success.codes": "1xx,2xx,3xx,4xx", "io.timeout.millis": "60000"},
                         event_flow=("JS-SseEvent",), description="BigQuery remote MCP server")
    bq = bq.replace("https://www.googleapis.com/auth/cloud-platform</Scope>",
                    "https://www.googleapis.com/auth/bigquery</Scope>\n          "
                    "<Scope>https://www.googleapis.com/auth/cloud-platform</Scope>")
    llm = target_endpoint("llm-stream", LLM_URL, pre_req=("AM-CleanRequest",), event_flow=("JS-SseEvent",),
                          description="Gemini streaming (text/event-stream)")
    write_proxy("aigw-sse-mcp-bigquery", "AI Gateway - SSE + BigQuery MCP",
                "Proxies the remote BigQuery MCP server (per-tool access via API Products) and Gemini SSE streaming.",
                {"default": ep}, {"bigquery": bq, "llm-stream": llm}, pol, js=("aigw-finalize.js", "aigw-sse.js"))


MCP_UNREACHABLE = '(fault.name = "NoResolvedHost") or (fault.name = "ConnectionRefused")'


def gen_mcp_retail():
    pol = common("mcp-discovery", read_response=False, kind="mcp")
    # Fallback while the managed MCP server (ORG.mcp.apigee.internal) is not reachable yet.
    pol["JS-McpFallback"] = p_js("JS-McpFallback", "aigw-mcp-fallback.js", time_limit=10000, coe=True)
    pol["AM-McpFallbackResponse"] = xml("""
<AssignMessage continueOnError="false" enabled="true" name="AM-McpFallbackResponse">
  <DisplayName>AM-McpFallbackResponse</DisplayName>
  <Remove>
    <Headers>
      <Header name="Retry-After"/>
    </Headers>
  </Remove>
  <Set>
    <Headers>
      <Header name="Content-Type">application/json</Header>
    </Headers>
    <Payload contentType="application/json">{aigw.mcp_fb.body}</Payload>
    <StatusCode>{aigw.mcp_fb.status:503}</StatusCode>
    <ReasonPhrase>{aigw.mcp_fb.reason:Service Unavailable}</ReasonPhrase>
  </Set>
  <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  <AssignTo createNew="false" transport="http" type="response"/>
</AssignMessage>""")
    ep = proxy_endpoint(
        "MCP Discovery Proxy: Apigee exposes the Cymbal Retail API operations as MCP tools.", "/mcp",
        pre_req=(("RF-MethodNotAllowed", 'request.verb != "POST"'), "PP-ParseMcp",
                 ("VA-VerifyAPIKey", MCP_HANDSHAKE),
                 ("Q-McpToolQuota", "verifyapikey.VA-VerifyAPIKey.client_id != null"), "AM-CleanRequest"),
        routes=[("default", "default", None)],
        faults=[("tool-quota", "AM-Err-McpQuota", 'fault.name = "QuotaViolation"')], fault_kind="mcp")
    tg_faults = ("  <FaultRules>\n    <FaultRule name=\"managed-mcp-unavailable\">\n"
                 "      <Step>\n        <Name>JS-McpFallback</Name>\n      </Step>\n"
                 "      <Step>\n        <Name>AM-McpFallbackResponse</Name>\n      </Step>\n"
                 f"      <Condition>{MCP_UNREACHABLE}</Condition>\n    </FaultRule>\n  </FaultRules>")
    tg = target_endpoint("default", "https://__PROJECT_ID__.mcp.apigee.internal/mcp", auth=False,
                         description="Apigee managed MCP server (tools generated from the OpenAPI spec)",
                         fault_rules_xml=tg_faults)
    write_proxy("aigw-mcp-retail", "AI Gateway - MCP Discovery Proxy (Cymbal Retail)",
                "MCP Discovery Proxy generated from resources/oas/retail-openapi.yaml.",
                {"default": ep}, {"default": tg}, pol, js=("aigw-finalize.js", "aigw-mcp-fallback.js"))


def gen_gateway():
    pol = common("gateway")
    pol.update(armor_policies())
    pol.update(circuit_policies("aigw-gw-failures"))
    pol.update({
        "AM-Init": p_init(), "PTL-PromptRate": p_ptl(),
        "LTQ-Enforce": p_ltq("LTQ-Enforce", "enforce", False, "aigw-gateway", "aigw-gateway"),
        "LTQ-Count": p_ltq("LTQ-Count", "count", False, "aigw-gateway", "aigw-gateway",
                           "{jsonPath('$.usage.total_tokens',response.content,true)}"),
        "AM-Err-PromptTokenLimit": p_err_prompt_limit(), "AM-Err-TokenQuota": p_err_token_quota(),
        "SCL-Lookup": p_scl(), "SCP-Populate": p_scp(),
        "JS-Router": p_js("JS-Router", "aigw-router.js", coe=False)})
    not_hit = 'SemanticCacheLookup.SCL-Lookup.cache_hit != "true"'
    # Simulated outages bypass the cache: the demo must reach the backends, and answers produced
    # by the fallback during a simulation are not stored.
    no_sim = 'aigw.simulate != "primary"'
    ep = proxy_endpoint(
        "AI Gateway: security, token governance, semantic cache, routing, resilience and observability.",
        "/v1/aigw/gateway",
        pre_req=("VA-VerifyAPIKey", "AM-Init", "PTL-PromptRate", "LTQ-Enforce",
                 "SUP-Prompt", "JS-ArmorPrompt",
                 ("RF-ArmorPromptBlocked", 'aigw.armor.prompt = "blocked"'),
                 ("RF-ArmorUnavailable", 'aigw.armor.prompt = "error"'),
                 ("SCL-Lookup", no_sim), ("JS-Router", not_hit), ("Q-CB-Check", not_hit), ("JS-CircuitState", not_hit)),
        routes=[("secondary", "secondary", 'aigw.circuit = "OPEN"'), ("primary", "primary", None)],
        faults=TOKEN_FAULTS)
    response_policies = (("SMR-Response", "response.status.code = 200"),
                         ("JS-ArmorResponse", "response.status.code = 200"),
                         ("RF-ArmorResponseBlocked", 'aigw.armor.response = "blocked"'),
                         ("SCP-Populate", f"(response.status.code = 200) and ({no_sim})"),
                         ("LTQ-Count", "response.status.code = 200"))
    primary = target_endpoint("primary", LLM_URL,
                              pre_req=("AM-MarkPrimary", ("AM-SimulateFailure", 'aigw.simulate = "primary"'),
                                       "AM-CleanRequest"),
                              pre_res=FAILOVER_STEPS + response_policies, props=dict(ALL_CODES),
                              description="Primary: routed Gemini model on Vertex AI (global)")
    secondary = target_endpoint("secondary", FALLBACK_URL,
                                pre_req=("JS-CircuitRouteSecondary", "AM-CleanRequest"),
                                pre_res=("JS-NormalizeSecondary",) + response_policies, props=dict(ALL_CODES),
                                description="Secondary: Claude Sonnet 5.5 (Anthropic) on Vertex AI Model Garden via :rawPredict")
    write_proxy("aigw-gateway", "AI Gateway - All capabilities",
                "PromptTokenLimit, LLMTokenQuota, Model Armor, semantic cache, LLM routing, failover/circuit breaking and logging.",
                {"default": ep}, {"primary": primary, "secondary": secondary}, pol,
                js=("aigw-finalize.js", "aigw-armor.js", "aigw-router.js", "aigw-circuit.js"))


if __name__ == "__main__":
    print("Generating proxies into", PROXIES)
    gen_mock_llm()
    gen_retail_api()
    gen_semantic_cache()
    gen_model_armor()
    gen_token_limits()
    gen_circuit_breaker()
    gen_llm_routing()
    gen_sse_bigquery()
    gen_mcp_retail()
    gen_gateway()
    print("done")
