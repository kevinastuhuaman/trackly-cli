'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { z } = require('zod');
const { version: PACKAGE_VERSION } = require('../package.json');
const {
  ensureSecureUrl,
  getRequestHeaders,
  hasAuth,
  loadConfig,
  normalizeEndpoint,
  saveConfig,
} = require('../lib/client');

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const RELAY_TIMEOUT_MS = 2_000;
const AUTHENTICATED_RELAY_PATH = '/api/jobscout/mcp-analytics';
const ANONYMOUS_RELAY_PATH = '/api/jobscout/mcp-analytics/anonymous';
const ANALYTICS_PREFERENCE_PATH = '/api/jobscout/analytics-preference';
const ANALYTICS_OPT_OUT_CONFIG_KEY = 'mcpAnalyticsOptOut';
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
  let sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\btrk_[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bph[a-z]_[A-Za-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\/Users\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '<local-path>')
    .replace(/\/home\/[^/\s"'`]+(?:\/[^\s"'`]*)?/g, '<local-path>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`]*)?/g, '<local-path>');
  const localPrefixes = new Set([
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.TRACKLY_CONFIG_DIR,
    process.cwd(),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 1));
  for (const prefix of localPrefixes) {
    sanitized = sanitized.split(prefix).join('<local-path>');
  }
  return sanitized;
}

function contentLength(value) {
  return { length: Math.min(String(value).length, 100_000) };
}

function classifyIntent(toolName, value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (/\b(?:compare|versus|difference|choose|decision)\b/.test(text)) return 'compare_options';
  if (/\b(?:debug|error|failed|failure|broken|troubleshoot)\b/.test(text)) return 'troubleshoot';
  if (/\b(?:apply|application|submit)\b/.test(text)) return 'application_workflow';
  if (/\b(?:explain|why|details?|describe)\b/.test(text)) return 'inspect_details';
  if (/\b(?:recommend|best|rank|prioritize)\b/.test(text)) return 'decision_support';
  const defaults = {
    trackly_search_jobs: 'job_discovery',
    trackly_get_job: 'inspect_job',
    trackly_search_companies: 'company_discovery',
    trackly_list_companies: 'browse_companies',
    trackly_ask: 'natural_language_job_search',
    get_more_tools: 'missing_capability',
  };
  return defaults[toolName] || 'other';
}

function classifyError(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (/\b(?:401|unauthenticated|authentication|invalid token|expired token)\b/.test(text)) {
    return 'authentication';
  }
  if (/\b(?:403|forbidden|permission|not authorized)\b/.test(text)) return 'authorization';
  if (/\b(?:429|rate limit|too many requests)\b/.test(text)) return 'rate_limit';
  if (/\b(?:timeout|timed out|deadline|abort)\b/.test(text)) return 'timeout';
  if (/\b(?:404|not found|missing)\b/.test(text)) return 'not_found';
  if (/\b(?:400|invalid|validation|schema|bad request)\b/.test(text)) return 'validation';
  if (/\b(?:409|conflict|stale)\b/.test(text)) return 'conflict';
  if (/\b(?:fetch|network|socket|connection|dns|econn)\b/.test(text)) return 'network';
  if (/\b(?:500|502|503|504|internal|upstream|unavailable)\b/.test(text)) return 'server';
  return 'unknown';
}

function safeFrameName(value, maxLength = 120) {
  if (typeof value !== 'string' || value === '<local-path>') return undefined;
  const basename = value.replace(/\\/g, '/').split('/').pop() || '';
  const withoutExtension = basename.replace(/\.(?:c?js|mjs|ts|tsx)$/i, '');
  return /^[A-Za-z0-9_.$@<>+-]+$/.test(withoutExtension)
    ? withoutExtension.slice(0, maxLength)
    : undefined;
}

function safeFrameNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 10_000_000
    ? number
    : undefined;
}

function projectExceptionList(value, errorValue) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((candidate) => {
    const exception = candidate && typeof candidate === 'object' ? candidate : {};
    const stacktrace = exception.stacktrace && typeof exception.stacktrace === 'object'
      ? exception.stacktrace
      : {};
    const frames = Array.isArray(stacktrace.frames) ? stacktrace.frames : [];
    const projectedFrames = frames.slice(0, 50).map((candidateFrame) => {
      const frame = candidateFrame && typeof candidateFrame === 'object' ? candidateFrame : {};
      const projected = {};
      const moduleName = safeFrameName(
        frame.module_name ?? frame.module ?? frame.filename ?? frame.abs_path,
      );
      const functionName = safeFrameName(
        frame.function_name ?? frame.function ?? frame.functionName,
      );
      const lineNumber = safeFrameNumber(
        frame.line_number ?? frame.lineno ?? frame.lineNumber,
      );
      const columnNumber = safeFrameNumber(
        frame.column_number ?? frame.colno ?? frame.columnNumber,
      );
      if (moduleName) projected.module_name = moduleName;
      if (functionName) projected.function_name = functionName;
      if (lineNumber !== undefined) projected.line_number = lineNumber;
      if (columnNumber !== undefined) projected.column_number = columnNumber;
      return projected;
    }).filter((frame) => Object.keys(frame).length > 0);
    return {
      type: safeFrameName(exception.type, 80) || 'Error',
      category: classifyError(exception.value ?? errorValue),
      stacktrace: { frames: projectedFrames },
    };
  });
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
  const candidates = [
    redacted.request?.params?.arguments,
    redacted.params?.arguments,
    redacted.arguments,
  ];
  for (const args of candidates) {
    if (!args || typeof args !== 'object') continue;
    delete args.context;
    for (const key of ['keywords', 'query']) {
      if (typeof args[key] === 'string') args[key] = contentLength(args[key]);
    }
  }
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
      properties.$mcp_intent = classifyIntent(toolName, properties.$mcp_intent);
    }
    if (properties.$mcp_intent_source !== 'context_parameter'
        && properties.$mcp_intent_source !== 'inferred') {
      delete properties.$mcp_intent_source;
    }
  }

  if (typeof properties.$mcp_error_message === 'string') {
    properties.$mcp_error_message = classifyError(properties.$mcp_error_message);
  }
  if (properties.$exception_list !== undefined) {
    properties.$exception_list = projectExceptionList(
      properties.$exception_list,
      properties.$mcp_error_message,
    );
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
  if (!tools || typeof tools !== 'object') {
    throw new Error('unsupported_mcp_sdk_tool_registry');
  }

  for (const tool of Object.values(tools)) {
    const shape = tool?.inputSchema?.shape;
    if (!shape || typeof shape !== 'object' || Object.hasOwn(shape, 'context')) continue;

    const originalHandler = tool.handler;
    tool.update({
      paramsSchema: {
        ...shape,
        context: z.string().max(1_000).optional().describe(CONTEXT_DESCRIPTION),
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
  const loadConfigImpl = options.loadConfig || loadConfig;
  const saveConfigImpl = options.saveConfig || saveConfig;
  const pending = new Set();
  let cachedOptOut = readCachedAnalyticsOptOut();
  let preferenceLookup = null;

  function readCachedAnalyticsOptOut() {
    try {
      return loadConfigImpl()[ANALYTICS_OPT_OUT_CONFIG_KEY] === true;
    } catch {
      return true;
    }
  }

  function persistCachedAnalyticsOptOut(optedOut) {
    cachedOptOut = optedOut;
    try {
      const config = loadConfigImpl();
      if (optedOut && config[ANALYTICS_OPT_OUT_CONFIG_KEY] === true) return;
      if (optedOut) config[ANALYTICS_OPT_OUT_CONFIG_KEY] = true;
      else if (Object.hasOwn(config, ANALYTICS_OPT_OUT_CONFIG_KEY)) {
        delete config[ANALYTICS_OPT_OUT_CONFIG_KEY];
      } else {
        return;
      }
      saveConfigImpl(config);
    } catch {
      // The in-memory privacy gate remains authoritative for this process.
    }
  }

  function authenticatedRequestContext() {
    const headers = getRequestHeaders(false, MCP_ANALYTICS_USER_AGENT);
    const authorization = headers.Authorization;
    if (typeof authorization !== 'string' || authorization.length === 0) return null;
    return {
      headers,
      key: createHash('sha256').update(authorization).digest('hex'),
    };
  }

  function isCurrentAuthenticatedContext(expectedKey) {
    try {
      return authenticatedRequestContext()?.key === expectedKey;
    } catch {
      return false;
    }
  }

  async function resolveAuthenticatedPreference(authContext) {
    if (preferenceLookup?.key === authContext.key) return preferenceLookup.promise;

    const lookup = { key: authContext.key, promise: null };
    lookup.promise = (async () => {
      const url = normalizeEndpoint(ANALYTICS_PREFERENCE_PATH);
      ensureSecureUrl(url, 'MCP analytics preference');
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: authContext.headers,
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      if (!response?.ok || typeof response.json !== 'function') {
        if (response?.body && typeof response.body.cancel === 'function') {
          await response.body.cancel().catch(() => {});
        }
        throw new Error('analytics_preference_unavailable');
      }
      const preference = await response.json();
      if (!preference || typeof preference.shareUsageAnalytics !== 'boolean') {
        throw new Error('analytics_preference_invalid');
      }
      if (!isCurrentAuthenticatedContext(authContext.key)) return false;
      persistCachedAnalyticsOptOut(!preference.shareUsageAnalytics);
      return preference.shareUsageAnalytics;
    })().catch(() => false).finally(() => {
      if (preferenceLookup === lookup) preferenceLookup = null;
    });
    preferenceLookup = lookup;
    return lookup.promise;
  }

  function capture(event) {
    try {
      if (!event || typeof event !== 'object' || event.event === '$identify') return;
      const authenticated = hasAuth();
      const authContext = authenticated ? authenticatedRequestContext() : null;
      if (authenticated && !authContext) return;
      if (!authenticated && !ANONYMOUS_RELAY_EVENTS.has(event.event)) return;
      if (!authenticated && cachedOptOut) return;

      const endpoint = authenticated ? AUTHENTICATED_RELAY_PATH : ANONYMOUS_RELAY_PATH;
      const delivery = (async () => {
        if (authContext && !(await resolveAuthenticatedPreference(authContext))) return;
        if (authContext && !isCurrentAuthenticatedContext(authContext.key)) return;
        const url = normalizeEndpoint(endpoint);
        ensureSecureUrl(url, 'MCP analytics');
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: authContext?.headers
            || getRequestHeaders(true, MCP_ANALYTICS_USER_AGENT),
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
    try {
      const warn = options.onWarning
        || ((message) => process.stderr.write(`[trackly-mcp] ${message}\n`));
      warn('Usage analytics are unavailable; MCP tools will continue without telemetry.');
    } catch {
      // Warning delivery is analytics-only and must also fail open.
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
