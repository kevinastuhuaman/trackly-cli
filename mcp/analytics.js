'use strict';

const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { version: PACKAGE_VERSION } = require('../package.json');
const {
  ensureSecureUrl,
  getRequestHeaders,
  hasAuth,
  normalizeEndpoint,
} = require('../lib/client');

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const RELAY_TIMEOUT_MS = 2_000;
const AUTHENTICATED_RELAY_PATH = '/api/jobscout/mcp-analytics';
const ANONYMOUS_RELAY_PATH = '/api/jobscout/mcp-analytics/anonymous';
const MCP_ANALYTICS_USER_AGENT = `trackly-mcp-analytics/${PACKAGE_VERSION}`;
const REDACTED = '[redacted]';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const CONTEXT_DESCRIPTION =
  'Briefly explain why this tool helps the current job-search goal. Never include resume text, profile answers, demographic or work-authorization answers, application notes, credentials, or secrets.';
const ANONYMOUS_RELAY_EVENTS = new Set([
  '$exception',
  '$mcp_initialize',
  '$mcp_missing_capability',
  '$mcp_tools_list',
]);

// Rich payload capture is deliberately allowlisted. Every other Trackly tool
// remains observable by name, duration, outcome, client, and session without
// duplicating profile, Apply, contact, or account payloads into PostHog.
const RICH_PAYLOAD_TOOLS = new Set([
  'trackly_search_jobs',
  'trackly_get_job',
  'trackly_search_companies',
  'trackly_list_companies',
  'trackly_ask',
  'get_more_tools',
]);

const FORBIDDEN_KEYS = new Set([
  // Credentials and authentication material.
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'apitoken',
  'accesstoken',
  'refreshtoken',
  'token',
  'password',
  'secret',
  'clientsecret',
  'privatekey',
  // User-defined sensitive analytics boundary.
  'resume',
  'resumetext',
  'resumecontent',
  'resumebytes',
  'resumefile',
  'defaultresume',
  'profile',
  'profileanswer',
  'profileanswers',
  'demographic',
  'demographics',
  'workauthorization',
  'workauthorizationanswer',
  'authorizedtowork',
  'applicationnote',
  'applicationnotes',
  'applicationtext',
  'coverletter',
]);

const analyticsState = new WeakMap();

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isForbiddenKey(key) {
  const normalized = normalizedKey(key);
  if (FORBIDDEN_KEYS.has(normalized)) return true;
  return normalized.includes('resumetext')
    || normalized.includes('resumecontent')
    || normalized.includes('resumebytes')
    || normalized.includes('resumefile')
    || normalized.includes('profileanswer')
    || normalized.includes('demographic')
    || normalized.includes('workauthorization')
    || normalized.startsWith('authorizedtowork')
    || normalized.includes('applicationnote')
    || normalized.includes('coverletter')
    || normalized.endsWith('token')
    || normalized.endsWith('password')
    || normalized.endsWith('secret');
}

function truthy(value) {
  return TRUE_VALUES.has(String(value || '').trim().toLowerCase());
}

function isMcpAnalyticsEnabled(env = process.env) {
  if (truthy(env.TRACKLY_MCP_ANALYTICS_DISABLED)) return false;
  if (env.TRACKLY_MCP_ANALYTICS_ENABLED !== undefined
      && !truthy(env.TRACKLY_MCP_ANALYTICS_ENABLED)) {
    return false;
  }
  return true;
}

function scrubString(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\btrk_[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bph[a-z]_[A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '<local-path>')
    .replace(/\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '<local-path>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`]*)?/g, '<local-path>');
}

function redactValue(value) {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isForbiddenKey(key) ? REDACTED : redactValue(nested);
  }
  return result;
}

function redactJsonText(value) {
  if (typeof value !== 'string') return redactValue(value);
  try {
    return JSON.stringify(redactValue(JSON.parse(value)));
  } catch {
    return scrubString(value);
  }
}

function redactMcpResponse(response) {
  const redacted = redactValue(response);
  if (!redacted || typeof redacted !== 'object' || !Array.isArray(redacted.content)) {
    return redacted;
  }

  return {
    ...redacted,
    content: redacted.content.map((block) => {
      if (!block || typeof block !== 'object' || block.type !== 'text') return block;
      return { ...block, text: redactJsonText(block.text) };
    }),
  };
}

function removeContextParameter(parameters) {
  if (!parameters || typeof parameters !== 'object') return parameters;
  const redacted = redactValue(parameters);
  const args = redacted.request?.params?.arguments;
  if (args && typeof args === 'object') delete args.context;
  return redacted;
}

function sanitizeMcpAnalyticsEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const sanitized = redactValue(event);
  const properties = sanitized.properties;
  if (!properties || typeof properties !== 'object') return sanitized;

  // Identity is backend-owned. The CLI may carry only its ephemeral anonymous
  // session identifier; verified user/person properties never cross this relay.
  delete properties.$set;
  delete properties.$set_once;
  delete properties.$unset;
  delete properties.email;
  delete properties.name;

  // The stdio server must not fingerprint a user's machine or forward a local
  // path even if a future SDK begins attaching either automatically.
  delete properties.$ip;
  delete properties.ip;
  delete properties.hostname;
  delete properties.username;
  delete properties.$mcp_conversation_id;

  const toolName = properties.$mcp_tool_name ?? properties.$mcp_resource_name;
  if (typeof toolName !== 'string' || !RICH_PAYLOAD_TOOLS.has(toolName)) {
    delete properties.$mcp_parameters;
    delete properties.$mcp_response;
    delete properties.$mcp_intent;
    delete properties.$mcp_intent_source;
  } else {
    if (properties.$mcp_parameters !== undefined) {
      properties.$mcp_parameters = removeContextParameter(properties.$mcp_parameters);
    }
    if (properties.$mcp_response !== undefined) {
      properties.$mcp_response = redactMcpResponse(properties.$mcp_response);
    }
    if (typeof properties.$mcp_intent === 'string') {
      properties.$mcp_intent = scrubString(properties.$mcp_intent);
    }
  }

  if (typeof properties.$mcp_error_message === 'string') {
    properties.$mcp_error_message = scrubString(properties.$mcp_error_message);
  }
  if (properties.$exception_list !== undefined) {
    properties.$exception_list = redactValue(properties.$exception_list);
  }
  return sanitized;
}

function safelySanitizeMcpAnalyticsEvent(event) {
  try {
    return sanitizeMcpAnalyticsEvent(event);
  } catch {
    return null;
  }
}

function addOptionalContextToTools(server) {
  const tools = server?._registeredTools;
  if (!tools || typeof tools !== 'object') return;

  for (const tool of Object.values(tools)) {
    const shape = tool?.inputSchema?.shape;
    if (!shape || typeof shape !== 'object' || Object.hasOwn(shape, 'context')) continue;

    const originalHandler = tool.handler;
    tool.update({
      paramsSchema: {
        ...shape,
        context: z.string().min(1).max(1_000).optional().describe(CONTEXT_DESCRIPTION),
      },
      callback: (args, extra) => {
        if (!args || typeof args !== 'object' || !Object.hasOwn(args, 'context')) {
          return originalHandler(args, extra);
        }
        const { context: _context, ...handlerArgs } = args;
        return originalHandler(handlerArgs, extra);
      },
    });
  }
}

function runtimeEventProperties(env = process.env) {
  return {
    channel: 'mcp',
    contract_version: 3,
    environment: env.TRACKLY_MCP_ANALYTICS_ENVIRONMENT || 'production',
    app_version: PACKAGE_VERSION,
    build: env.TRACKLY_MCP_BUILD || PACKAGE_VERSION,
    trackly_package_version: PACKAGE_VERSION,
    trackly_mcp_analytics_contract: 'production-v1',
    node_version: process.versions.node,
    operating_system: process.platform,
    cpu_architecture: process.arch,
  };
}

function createBackendRelay(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const pending = new Set();

  function capture(event) {
    try {
      if (!event || typeof event !== 'object' || event.event === '$identify') return;
      const authenticated = hasAuth();
      if (!authenticated && !ANONYMOUS_RELAY_EVENTS.has(event.event)) return;

      const endpoint = authenticated ? AUTHENTICATED_RELAY_PATH : ANONYMOUS_RELAY_PATH;
      const delivery = (async () => {
        const url = normalizeEndpoint(endpoint);
        ensureSecureUrl(url, 'MCP analytics');
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: getRequestHeaders(!authenticated, MCP_ANALYTICS_USER_AGENT),
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
        });
        // A capture response is analytics-only. Cancel the unread body so
        // keep-alive connections are not retained until garbage collection.
        if (response?.body && typeof response.body.cancel === 'function') {
          await response.body.cancel().catch(() => {});
        }
      })().catch(() => {}).finally(() => pending.delete(delivery));
      pending.add(delivery);
    } catch {
      // Config reads, URL parsing, serialization, and fetch setup all fail open.
    }
  }

  async function flush() {
    await Promise.allSettled([...pending]);
  }

  return {
    capture,
    flush,
    _shutdown: flush,
  };
}

function configureMcpAnalytics(server, options = {}) {
  const env = options.env || process.env;
  if (!isMcpAnalyticsEnabled(env)) {
    return { enabled: false, reason: 'disabled' };
  }

  let relay;
  try {
    const sdk = (options.loadSdk || (() => require('@posthog/mcp')))();
    const anonymousDistinctId = `mcp-anon-${randomUUID()}`;
    relay = (options.createRelay || createBackendRelay)({ fetch: options.fetch });
    const eventProperties = runtimeEventProperties(env);
    addOptionalContextToTools(server);
    const analytics = sdk.instrument(server, relay, {
      reportMissing: true,
      enableConversationId: false,
      enableExceptionAutocapture: true,
      context: false,
      intentFallback: (request) => {
        const context = request?.params?.arguments?.context;
        return typeof context === 'string' && context.trim() ? context : null;
      },
      identify: { distinctId: anonymousDistinctId },
      beforeSend: (event) => safelySanitizeMcpAnalyticsEvent({
        ...event,
        properties: {
          ...event?.properties,
          ...eventProperties,
        },
      }),
      eventProperties: () => eventProperties,
      logger: () => {},
    });

    analyticsState.set(server, { analytics, relay });
    return { enabled: true, analytics };
  } catch {
    if (relay && typeof relay._shutdown === 'function') {
      try {
        Promise.resolve(relay._shutdown()).catch(() => {});
      } catch {
        // A synchronous SDK shutdown failure is still an analytics-only failure.
      }
    }
    return { enabled: false, reason: 'instrumentation_failed' };
  }
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdownMcpAnalytics(server, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
  const state = analyticsState.get(server);
  analyticsState.delete(server);
  if (!state?.relay) return;

  try {
    if (typeof state.relay._shutdown === 'function') {
      await withTimeout(Promise.resolve(state.relay._shutdown()), timeoutMs);
      return;
    }
    if (typeof state.relay.flush === 'function') {
      await withTimeout(Promise.resolve(state.relay.flush()), timeoutMs);
    }
  } catch {
    // Fail open on shutdown too; stdio clients must not hang on telemetry.
  }
}

module.exports = {
  RICH_PAYLOAD_TOOLS,
  createBackendRelay,
  configureMcpAnalytics,
  isMcpAnalyticsEnabled,
  runtimeEventProperties,
  sanitizeMcpAnalyticsEvent,
  shutdownMcpAnalytics,
};
