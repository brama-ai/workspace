// @ts-check
/* global process, fetch, setInterval, clearInterval, setTimeout, Date, JSON, Math, console */
"use strict";

/**
 * OpenClaw plugin: Platform Tools Bridge
 *
 * Fetches the tool catalog from Core's /api/v1/a2a/discovery endpoint
 * and registers each tool so the LLM can invoke platform agents via A2A.
 *
 * Writes structured logs to OpenSearch so every request/response is visible
 * in the admin log viewer alongside PHP/Python application logs.
 */

const PLATFORM_CORE_URL = /** @type {string} */ (process.env.PLATFORM_CORE_URL) || "http://core";
const PLATFORM_TOKEN = /** @type {string} */ (process.env.OPENCLAW_GATEWAY_TOKEN) || "";
const OPENSEARCH_URL = /** @type {string} */ (process.env.OPENSEARCH_URL) || "";

const DISCOVERY_URL = /** @type {string} */ (process.env.PLATFORM_DISCOVERY_URL)
  || `${PLATFORM_CORE_URL}/api/v1/a2a/discovery`;
const INVOKE_URL = /** @type {string} */ (process.env.PLATFORM_INVOKE_URL)
  || `${PLATFORM_CORE_URL}/api/v1/a2a/send-message`;

const APP_NAME = "openclaw";
const INDEX_PREFIX = "platform_logs";

/** @typedef {{ info?: Function, warn?: Function, error?: Function, debug?: Function }} PluginLogger */

// ---------------------------------------------------------------------------
// OpenSearch direct logger
// ---------------------------------------------------------------------------

/** @type {Array<object>} */
let logBuffer = [];
const FLUSH_SIZE = 20;
const FLUSH_INTERVAL_MS = 5000;

/** @type {ReturnType<typeof setInterval> | null} */
let flushTimer = null;

/**
 * @param {'DEBUG'|'INFO'|'WARNING'|'ERROR'} levelName
 * @param {string} message
 * @param {object} [context]
 * @param {string} [traceId]
 * @param {string} [requestId]
 */
function osLog(levelName, message, context, traceId, requestId) {
  /** @type {Record<string, number>} */
  const levelValues = { DEBUG: 100, INFO: 200, WARNING: 300, ERROR: 400 };
  /** @type {string[]} */
  const promotedKeys = [
    "event_name",
    "step",
    "source_app",
    "target_app",
    "tool",
    "intent",
    "status",
    "duration_ms",
    "error_code",
    "agent_run_id",
    "sequence_order",
    "session_key",
    "sender",
    "recipient",
    "channel",
  ];

  /** @type {Record<string, unknown>} */
  const doc = {
    "@timestamp": new Date().toISOString(),
    level: levelValues[levelName] || 200,
    level_name: levelName,
    message,
    channel: "openclaw",
    app_name: APP_NAME,
  };

  if (traceId) doc.trace_id = traceId;
  if (requestId) doc.request_id = requestId;
  if (context && Object.keys(context).length > 0) {
    const remaining = { ...context };
    for (const key of promotedKeys) {
      if (Object.prototype.hasOwnProperty.call(remaining, key)) {
        doc[key] = remaining[key];
        delete remaining[key];
      }
    }
    if (Object.keys(remaining).length > 0) {
      doc.context = remaining;
    }
  }

  logBuffer.push(doc);

  if (logBuffer.length >= FLUSH_SIZE) {
    flushLogs();
  }
}

function flushLogs() {
  if (logBuffer.length === 0 || !OPENSEARCH_URL) return;

  const indexName = `${INDEX_PREFIX}_${formatDate(new Date())}`;
  let body = "";

  for (const doc of logBuffer) {
    body += JSON.stringify({ index: { _index: indexName } }) + "\n";
    body += JSON.stringify(doc) + "\n";
  }

  logBuffer = [];

  const url = `${OPENSEARCH_URL.replace(/\/+$/, "")}/_bulk`;

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-ndjson" },
    body,
  }).catch(() => {
    // silent fail — same pattern as PHP OpenSearchHandler
  });
}

/** @param {Date} d */
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}_${m}_${day}`;
}

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flushLogs, FLUSH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function eventCtx(payload) {
  return {
    source_app: APP_NAME,
    sequence_order: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    ...payload,
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeValue(v);
    }
    return out;
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  return value;
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isSensitiveKey(key) {
  const normalized = key.toLowerCase();
  return [
    "token",
    "authorization",
    "api_key",
    "apikey",
    "secret",
    "password",
    "cookie",
  ].some((needle) => normalized.includes(needle));
}

/**
 * @param {unknown} value
 * @param {{redacted: number, truncated: number}} counters
 * @returns {unknown}
 */
function sanitizeValue(value, counters) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, counters));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        counters.redacted += 1;
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeValue(v, counters);
      }
    }
    return out;
  }

  if (typeof value === "string" && value.length > 1024) {
    counters.truncated += 1;
    return `${value.slice(0, 1024)}...[truncated]`;
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {number} [maxLen]
 * @returns {{data: unknown, capture_meta: Record<string, unknown>}}
 */
function sanitizeForLog(value, maxLen = 16384) {
  const normalized = normalizeValue(value);
  const counters = { redacted: 0, truncated: 0 };
  let data = sanitizeValue(normalized, counters);

  const originalJson = JSON.stringify(normalized) || "";
  let capturedJson = JSON.stringify(data) || "";
  let isTruncated = false;

  if (capturedJson.length > maxLen) {
    isTruncated = true;
    data = { _truncated: true, _preview: capturedJson.slice(0, maxLen) };
    capturedJson = JSON.stringify(data) || "";
  }

  return {
    data,
    capture_meta: {
      is_truncated: isTruncated,
      original_size_bytes: originalJson.length,
      captured_size_bytes: capturedJson.length,
      redacted_fields_count: counters.redacted,
      truncated_values_count: counters.truncated,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function schemaFingerprint(value) {
  const str = JSON.stringify(normalizeValue(value)) || "";
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return `djb2_${(hash >>> 0).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Core API calls
// ---------------------------------------------------------------------------

/**
 * Fetch the tool catalog from Core.
 * @param {PluginLogger} log
 * @returns {Promise<Array<{name: string, agent: string, description: string, input_schema: object}>>}
 */
async function fetchDiscovery(log) {
  const requestId = generateId("req");

  osLog("INFO", "Discovery request started", eventCtx({
    event_name: "openclaw.discovery.fetch.started",
    step: "discovery_fetch",
    target_app: "core",
    status: "started",
    url: DISCOVERY_URL,
  }), undefined, requestId);
  log.debug?.(`[platform-tools] Fetching discovery from ${DISCOVERY_URL}`);

  const start = Date.now();

  const res = await fetch(DISCOVERY_URL, {
    headers: { Authorization: `Bearer ${PLATFORM_TOKEN}` },
  });

  const durationMs = Date.now() - start;

  if (!res.ok) {
    osLog("ERROR", `Discovery request failed: ${res.status} ${res.statusText}`, eventCtx({
      event_name: "openclaw.discovery.fetch.failed",
      step: "discovery_fetch",
      target_app: "core",
      status: "failed",
      error_code: "discovery_http_error",
      url: DISCOVERY_URL,
      http_status: res.status,
      duration_ms: durationMs,
    }), undefined, requestId);

    throw new Error(
      `Discovery request failed: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();
  const tools = data.tools || [];
  const snapshot = tools.map((/** @type {{name: string, agent: string, description: string, input_schema?: object}} */ t) => ({
    name: t.name,
    agent: t.agent,
    description: t.description,
    input_schema_fingerprint: schemaFingerprint(t.input_schema || {}),
  }));
  const sanitizedSnapshot = sanitizeForLog({
    generated_at: data.generated_at || null,
    tool_count: tools.length,
    tools: snapshot,
  });

  osLog("INFO", `Discovery completed: ${tools.length} tool(s) found`, eventCtx({
    event_name: "openclaw.discovery.fetch.completed",
    step: "discovery_fetch",
    target_app: "core",
    status: "completed",
    url: DISCOVERY_URL,
    http_status: res.status,
    duration_ms: durationMs,
    tool_count: tools.length,
    tool_names: tools.map((/** @type {{name: string}} */ t) => t.name),
  }), undefined, requestId);
  osLog("INFO", "Discovery snapshot captured", eventCtx({
    event_name: "openclaw.discovery.snapshot",
    step: "discovery_response",
    target_app: "core",
    status: "completed",
    step_output: sanitizedSnapshot.data,
    capture_meta: sanitizedSnapshot.capture_meta,
  }), undefined, requestId);

  log.debug?.(
    `[platform-tools] Discovery response parsed: ${tools.length} tool(s)`
  );
  return tools;
}

/**
 * Invoke a platform tool via Core's A2A bridge.
 * @param {string} tool
 * @param {object} input
 * @param {PluginLogger} log
 * @returns {Promise<object>}
 */
async function invokeTool(tool, input, log) {
  const traceId = generateId("trace");
  const requestId = generateId("req");
  const sanitizedInput = sanitizeForLog(input);

  osLog("INFO", `Invoke request: tool=${tool}`, eventCtx({
    event_name: "openclaw.invoke.request.started",
    step: "invoke_request",
    target_app: "core",
    status: "started",
    tool,
    intent: tool,
    url: INVOKE_URL,
    step_input: sanitizedInput.data,
    capture_meta: sanitizedInput.capture_meta,
  }), traceId, requestId);

  log.debug?.(
    `[platform-tools] Sending invoke request: tool=${tool}, trace_id=${traceId}`
  );

  const start = Date.now();
  const res = await fetch(INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PLATFORM_TOKEN}`,
    },
    body: JSON.stringify({
      tool,
      input,
      trace_id: traceId,
      request_id: requestId,
    }),
  });

  const durationMs = Date.now() - start;

  if (!res.ok) {
    let responseBody = "";
    try {
      responseBody = await res.text();
    } catch (_e) {
      // ignore
    }

    const sanitizedOutput = sanitizeForLog({ response_body: responseBody });
    osLog("ERROR", `Invoke failed: tool=${tool}, status=${res.status}`, eventCtx({
      event_name: "openclaw.invoke.request.failed",
      step: "invoke_request",
      target_app: "core",
      status: "failed",
      error_code: "invoke_http_error",
      tool,
      intent: tool,
      url: INVOKE_URL,
      http_status: res.status,
      http_status_text: res.statusText,
      duration_ms: durationMs,
      step_output: sanitizedOutput.data,
      capture_meta: sanitizedOutput.capture_meta,
    }), traceId, requestId);

    log.warn?.(
      `[platform-tools] Invoke failed: tool=${tool}, status=${res.status}, duration=${durationMs}ms`
    );
    throw new Error(`Invoke request failed: ${res.status} ${res.statusText}`);
  }

  const result = await res.json();
  const status = result.status || "unknown";
  const sanitizedOutput = sanitizeForLog(result);

  osLog("INFO", `Invoke completed: tool=${tool}, status=${status}`, eventCtx({
    event_name: "openclaw.invoke.request.completed",
    step: "invoke_request",
    target_app: "core",
    status,
    error_code: status === "failed" ? "invoke_failed" : undefined,
    tool,
    intent: tool,
    url: INVOKE_URL,
    http_status: res.status,
    duration_ms: durationMs,
    result_status: status,
    step_output: sanitizedOutput.data,
    capture_meta: sanitizedOutput.capture_meta,
  }), traceId, requestId);

  log.info?.(
    `[platform-tools] Invoke completed: tool=${tool}, status=${status}, duration=${durationMs}ms`
  );
  return result;
}

/**
 * Convert a JSON Schema object to TypeBox-compatible parameter definition.
 * OpenClaw's registerTool expects a TypeBox schema, but we can pass
 * a raw JSON Schema object since TypeBox schemas are just plain objects.
 * @param {object} schema
 * @returns {object}
 */
function toToolParameters(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return schema;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/** @param {import('./types').PluginAPI} api */
module.exports = function platformTools(api) {
  const log = api.log || console;

  startFlushTimer();

  osLog("INFO", "OpenClaw platform-tools plugin initializing", {
    core_url: PLATFORM_CORE_URL,
    opensearch_configured: !!OPENSEARCH_URL,
  });

  log.info?.("[platform-tools] Plugin initializing");

  // ---------------------------------------------------------------------------
  // Lifecycle hooks — log every message in/out so the admin panel shows full
  // conversation flow, including cases where no agent tool was called.
  // ---------------------------------------------------------------------------

  // Incoming user message
  api.registerHook("message:preprocessed", (/** @type {any} */ event) => {
    const text = event?.text || event?.message?.text || "";
    const channel = event?.channelId || event?.channel || "unknown";
    const sender = event?.sender || event?.from || event?.userId || "unknown";
    const isGroup = !!event?.isGroup;
    const groupId = event?.groupId || undefined;
    const sessionKey = event?.sessionKey || undefined;
    const traceId = generateId("trace");

    const sanitized = sanitizeForLog({ text });

    osLog("INFO", `Message received: channel=${channel}, sender=${sender}`, eventCtx({
      event_name: "openclaw.message.received",
      step: "message_inbound",
      status: "completed",
      channel,
      sender,
      is_group: isGroup,
      group_id: groupId,
      session_key: sessionKey,
      step_input: sanitized.data,
      capture_meta: sanitized.capture_meta,
    }), traceId);

    log.debug?.(`[platform-tools] Message received from ${sender} on ${channel}`);
  }, { name: "platform-tools.message-received", description: "Log inbound messages to OpenSearch" });

  // Outgoing bot response
  api.registerHook("message:sent", (/** @type {any} */ event) => {
    const text = event?.text || event?.message?.text || "";
    const channel = event?.channelId || event?.channel || "unknown";
    const recipient = event?.recipient || event?.to || event?.userId || "unknown";
    const isGroup = !!event?.isGroup;
    const groupId = event?.groupId || undefined;
    const sessionKey = event?.sessionKey || undefined;
    const traceId = generateId("trace");

    const sanitized = sanitizeForLog({ text });

    osLog("INFO", `Message sent: channel=${channel}, recipient=${recipient}`, eventCtx({
      event_name: "openclaw.message.sent",
      step: "message_outbound",
      status: "completed",
      channel,
      recipient,
      is_group: isGroup,
      group_id: groupId,
      session_key: sessionKey,
      step_output: sanitized.data,
      capture_meta: sanitized.capture_meta,
    }), traceId);

    log.debug?.(`[platform-tools] Message sent to ${recipient} on ${channel}`);
  }, { name: "platform-tools.message-sent", description: "Log outbound messages to OpenSearch" });

  // Session lifecycle
  api.registerHook("session_start", (/** @type {any} */ event) => {
    const sessionKey = event?.sessionKey || "unknown";
    const channel = event?.channelId || event?.channel || "unknown";
    const userId = event?.userId || event?.sender || "unknown";

    osLog("INFO", `Session started: session=${sessionKey}, channel=${channel}`, eventCtx({
      event_name: "openclaw.session.started",
      step: "session_lifecycle",
      status: "started",
      channel,
      session_key: sessionKey,
      user_id: userId,
    }));

    log.debug?.(`[platform-tools] Session started: ${sessionKey}`);
  }, { name: "platform-tools.session-started", description: "Log session start to OpenSearch" });

  // ---------------------------------------------------------------------------

  fetchDiscovery(log)
    .then((tools) => {
      if (!tools.length) {
        osLog("WARNING", "No tools discovered from Core");
        log.info?.("[platform-tools] No tools discovered from Core");
        return;
      }

      log.info?.(
        `[platform-tools] Discovered ${tools.length} tool(s) from Core`
      );

      for (const tool of tools) {
        const toolName = tool.name.replace(/\./g, "_");

        api.registerTool({
          name: toolName,
          description: `[${tool.agent}] ${tool.description}`,
          parameters: toToolParameters(tool.input_schema),

          async execute(_id, params) {
            const traceId = generateId("trace");
            const requestId = generateId("req");
            const sanitizedInput = sanitizeForLog(params);
            osLog("INFO", `Tool execute: ${tool.name} on agent ${tool.agent}`, eventCtx({
              event_name: "openclaw.tool.execute.started",
              step: "tool_execute",
              target_app: tool.agent,
              status: "started",
              tool: tool.name,
              intent: tool.name,
              step_input: sanitizedInput.data,
              capture_meta: sanitizedInput.capture_meta,
            }), traceId, requestId);

            log.info?.(
              `[platform-tools] Invoking ${tool.name} on ${tool.agent}`
            );
            try {
              const result = await invokeTool(tool.name, params, log);
              const sanitizedOutput = sanitizeForLog(result);

              osLog("INFO", `Tool execute success: ${tool.name}`, eventCtx({
                event_name: "openclaw.tool.execute.completed",
                step: "tool_execute",
                target_app: tool.agent,
                status: "completed",
                tool: tool.name,
                intent: tool.name,
                step_output: sanitizedOutput.data,
                capture_meta: sanitizedOutput.capture_meta,
              }), traceId, requestId);

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                  },
                ],
              };
            } catch (/** @type {any} */ err) {
              const errMsg = err instanceof Error ? err.message : String(err);

              osLog("ERROR", `Tool execute error: ${tool.name}: ${errMsg}`, eventCtx({
                event_name: "openclaw.tool.execute.failed",
                step: "tool_execute",
                target_app: tool.agent,
                status: "failed",
                error_code: "tool_execute_error",
                tool: tool.name,
                intent: tool.name,
                error: errMsg,
                stack: err instanceof Error ? err.stack : undefined,
              }), traceId, requestId);

              log.error?.(
                `[platform-tools] Invocation error: tool=${tool.name}, agent=${tool.agent}, error=${errMsg}`
              );
              return {
                content: [
                  {
                    type: "text",
                    text: `Error invoking ${tool.name}: ${errMsg}`,
                  },
                ],
                isError: true,
              };
            }
          },
        });

        log.info?.(
          `[platform-tools] Registered tool: ${toolName} (${tool.agent})`
        );
      }

      osLog("INFO", `Plugin ready: ${tools.length} tool(s) registered`, {
        tool_count: tools.length,
        tool_names: tools.map((/** @type {{name: string}} */ t) => t.name),
      });

      log.info?.(
        `[platform-tools] Plugin ready: ${tools.length} tool(s) registered`
      );

      // Flush immediately so init logs are visible right away
      flushLogs();
    })
    .catch((/** @type {any} */ err) => {
      const errMsg = err instanceof Error ? err.message : String(err);

      osLog("ERROR", `Failed to fetch discovery: ${errMsg}`, eventCtx({
        event_name: "openclaw.discovery.fetch.failed",
        step: "discovery_fetch",
        target_app: "core",
        status: "failed",
        error_code: "discovery_exception",
        error: errMsg,
        stack: err instanceof Error ? err.stack : undefined,
      }));

      log.error?.(
        `[platform-tools] Failed to fetch discovery: ${errMsg}`
      );

      flushLogs();
    });
};
