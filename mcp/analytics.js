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
const DEFAULT_MAX_PENDING_DELIVERIES = 32;
const MAX_CAPTURED_ITEMS = 50;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_SANITIZE_DEPTH = 8;
const MAX_SANITIZE_ITEMS = 500;
const MAX_SANITIZE_STRING_LENGTH = 4_096;
const AUTHENTICATED_RELAY_PATH = '/api/jobscout/mcp-analytics';
const ANONYMOUS_RELAY_PATH = '/api/jobscout/mcp-analytics/anonymous';
const ANALYTICS_PREFERENCE_PATH = '/api/jobscout/analytics-preference';
const ANALYTICS_OPT_OUT_CONFIG_KEY = 'mcpAnalyticsOptOut';
const MCP_ANALYTICS_USER_AGENT = `trackly-mcp-analytics/${PACKAGE_VERSION}`;
const REDACTED = '[redacted]';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const CONTEXT_DESCRIPTION =
  'Briefly explain why this tool helps the current job-search goal. Never include resume text, profile answers, demographic or work-authorization answers, application notes, credentials, or secrets.';
const CONTEXT_INTENT_MARKER = 'trackly_context_parameter:';
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

const MISSING_CAPABILITY_VALUES = {
  requestedCapability: [
    'search', 'inspect', 'compare', 'rank', 'recommend', 'track', 'update', 'apply',
    'submit', 'export', 'notify', 'schedule', 'integrate', 'authenticate', 'debug', 'other',
  ],
  requestedAction: [
    'find', 'read', 'compare', 'rank', 'create', 'update', 'delete', 'submit',
    'export', 'notify', 'schedule', 'connect', 'debug', 'other',
  ],
  requestedResource: [
    'job', 'company', 'application', 'contact', 'profile', 'resume', 'preference',
    'analytics', 'account', 'tool', 'other',
  ],
  requestedDestination: [
    'trackly', 'external_site', 'file', 'email', 'calendar', 'crm', 'browser', 'other',
  ],
};

const SAFE_RESPONSE_SHAPES = {
  trackly_search_jobs: {
    containers: ['jobs', 'data', 'results', 'pagination', 'meta'],
    textLengths: ['title', 'company', 'companyName', 'location', 'description'],
  },
  trackly_get_job: {
    containers: ['job', 'data', 'result', 'company'],
    textLengths: ['title', 'company', 'companyName', 'location', 'description'],
  },
  trackly_search_companies: {
    containers: ['companies', 'data', 'results', 'pagination', 'meta'],
    textLengths: ['name', 'companyName', 'domain', 'description'],
  },
  trackly_list_companies: {
    containers: ['companies', 'data', 'results', 'pagination', 'meta'],
    textLengths: ['name', 'companyName', 'domain', 'description'],
  },
  trackly_ask: {
    containers: ['jobs', 'data', 'results', 'filters', 'parsedFilters', 'pagination', 'meta'],
    textLengths: ['title', 'company', 'companyName', 'location', 'description', 'query'],
  },
  get_more_tools: {
    containers: [],
    textLengths: [],
  },
};

const SAFE_ID_KEYS = new Set([
  'id', 'jobid', 'postingid', 'companyid', 'trackerid', 'requestid',
]);
const SAFE_COUNT_KEYS = new Set([
  'total', 'count', 'limit', 'offset', 'page', 'pages', 'pagesize', 'remaining',
  'activejobcount', 'jobcount', 'resultcount', 'returnedcount',
]);
const SAFE_BOOLEAN_KEYS = new Set([
  'success', 'iserror', 'hasmore', 'remote', 'active', 'tracked', 'applied', 'saved',
  'dismissed', 'jobsurlrefused', 'reported',
]);
const SAFE_ENUM_VALUES = new Set([
  'new', 'applied', 'applied_confirmed', 'check_later', 'not_interested', 'all',
  'backlog', 'discarded', 'full_time', 'internship', 'remote', 'hybrid', 'in_person',
  'unspecified', 'us', 'non_us', 'europe', 'latam', 'middle_east', 'asia', 'africa',
  'canada', 'oceania', 'unknown', 'product', 'engineering', 'design', 'data',
  'marketing', 'sales', 'partnerships', 'finance', 'strategy', 'operations', 'people',
  'legal', 'support', 'other', 'newest', 'match',
]);
const SAFE_ENUM_KEYS = new Set([
  'status', 'stage', 'function', 'jobfunction', 'jobmodality', 'workarrangement',
  'region', 'regiontag', 'locationfilter', 'sort',
]);
const SDK_FAILURE_WARNING = /Warning: (?:Failed to instrument server|Failed to setup tool call instrumentation|No PostHog client passed)/i;

const ALLOWED_EVENT_PROPERTY_KEYS = new Set([
  '$exception_list', '$lib', '$lib_version', '$mcp_client_name',
  '$mcp_client_user_agent', '$mcp_client_version', '$mcp_duration_ms',
  '$mcp_error_message', '$mcp_error_type', '$mcp_intent', '$mcp_intent_source',
  '$mcp_is_error', '$mcp_listed_tool_names', '$mcp_parameters',
  '$mcp_protocol_version', '$mcp_resource_name', '$mcp_response',
  '$mcp_server_name', '$mcp_server_version', '$mcp_source', '$mcp_tool_category',
  '$mcp_tool_description', '$mcp_tool_name', '$mcp_vendor_client',
  '$process_person_profile', '$session_id', 'app_version', 'build', 'channel',
  'contract_version', 'cpu_architecture', 'environment', 'node_version',
  'operating_system', 'trackly_mcp_analytics_contract', 'trackly_package_version',
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
  return { length: Math.min(String(value).length, MAX_CONTENT_LENGTH) };
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

function redactValue(
  value,
  depth = 0,
  budget = { remaining: MAX_SANITIZE_ITEMS },
  seen = new WeakSet(),
) {
  if (typeof value === 'string') {
    return scrubString(value.slice(0, MAX_SANITIZE_STRING_LENGTH));
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_SANITIZE_DEPTH || budget.remaining <= 0 || seen.has(value)) {
    return undefined;
  }

  seen.add(value);
  budget.remaining -= 1;
  if (Array.isArray(value)) {
    const projected = [];
    for (const nested of value.slice(0, MAX_CAPTURED_ITEMS)) {
      if (budget.remaining <= 0) break;
      const redacted = redactValue(nested, depth + 1, budget, seen);
      if (redacted !== undefined) projected.push(redacted);
    }
    return projected;
  }

  const result = {};
  let capturedItems = 0;
  for (const key in value) {
    capturedItems += 1;
    if (capturedItems > MAX_CAPTURED_ITEMS) break;
    if (!Object.hasOwn(value, key)) continue;
    if (budget.remaining <= 0) break;
    const nested = value[key];
    const redacted = isForbiddenKey(key)
      ? REDACTED
      : redactValue(nested, depth + 1, budget, seen);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

function safeId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  return undefined;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CONTENT_LENGTH
    ? value
    : undefined;
}

function projectRichObject(toolName, value, depth = 0, budget = { remaining: 200 }) {
  if (!value || typeof value !== 'object' || depth > 5 || budget.remaining <= 0) return {};
  budget.remaining -= 1;
  const shape = SAFE_RESPONSE_SHAPES[toolName];
  if (!shape) return {};
  const containers = new Set(shape.containers.map(normalizedKey));
  const textLengths = new Set(shape.textLengths.map(normalizedKey));
  const result = {};
  for (const [key, nested] of Object.entries(value).slice(0, MAX_CAPTURED_ITEMS)) {
    const normalized = normalizedKey(key);
    if (SAFE_ID_KEYS.has(normalized)) {
      const projected = safeId(nested);
      if (projected !== undefined) result[key] = projected;
      continue;
    }
    if (SAFE_COUNT_KEYS.has(normalized)) {
      const projected = safeCount(nested);
      if (projected !== undefined) result[key] = projected;
      continue;
    }
    if (SAFE_BOOLEAN_KEYS.has(normalized) && typeof nested === 'boolean') {
      result[key] = nested;
      continue;
    }
    if (SAFE_ENUM_KEYS.has(normalized) && typeof nested === 'string'
        && SAFE_ENUM_VALUES.has(nested)) {
      result[key] = nested;
      continue;
    }
    if (normalized === 'workarrangements' && Array.isArray(nested)) {
      result[key] = nested.slice(0, 4).filter((candidate) => SAFE_ENUM_VALUES.has(candidate));
      continue;
    }
    if (textLengths.has(normalized) && typeof nested === 'string') {
      result[`${key}_length`] = contentLength(nested).length;
      continue;
    }
    if (!containers.has(normalized)) continue;
    if (Array.isArray(nested)) {
      result[key] = nested.slice(0, MAX_CAPTURED_ITEMS)
        .map((candidate) => projectRichObject(toolName, candidate, depth + 1, budget));
    } else if (nested && typeof nested === 'object') {
      result[key] = projectRichObject(toolName, nested, depth + 1, budget);
    }
  }
  return result;
}

function projectRichJsonText(toolName, value) {
  if (typeof value !== 'string') return projectRichObject(toolName, value);
  try {
    return JSON.stringify(projectRichObject(toolName, JSON.parse(value)));
  } catch {
    return JSON.stringify({
      unparsed: true,
      ...contentLength(value),
      truncated: value.length > MAX_CONTENT_LENGTH,
    });
  }
}

function redactMcpResponse(toolName, response) {
  if (!response || typeof response !== 'object') return {};
  const projected = {};
  if (typeof response.isError === 'boolean') projected.isError = response.isError;
  if (!Array.isArray(response.content)) {
    return { ...projected, ...projectRichObject(toolName, response) };
  }

  return {
    ...projected,
    content: response.content.slice(0, 10).map((block) => {
      if (!block || typeof block !== 'object') return { type: 'unknown' };
      if (block.type === 'text') {
        return { type: 'text', text: projectRichJsonText(toolName, block.text) };
      }
      const type = ['image', 'audio', 'resource', 'resource_link'].includes(block.type)
        ? block.type
        : 'unknown';
      const encoded = block.data ?? block.blob ?? block.resource?.blob;
      return {
        type,
        ...(typeof encoded === 'string' ? { length: contentLength(encoded).length } : {}),
      };
    }),
  };
}

function findArguments(parameters) {
  if (!parameters || typeof parameters !== 'object') return null;
  return parameters.request?.params?.arguments
    ?? parameters.params?.arguments
    ?? parameters.arguments
    ?? null;
}

function projectMcpParameters(toolName, parameters) {
  const args = findArguments(parameters);
  if (!args || typeof args !== 'object') return {};
  const projected = {};
  const allowed = {
    trackly_search_jobs: new Set([
      'function', 'companyId', 'locationFilter', 'jobModality', 'workArrangements',
      'remote', 'status', 'sort', 'limit', 'offset', 'keywords',
    ]),
    trackly_get_job: new Set(['id']),
    trackly_search_companies: new Set(['query', 'limit']),
    trackly_list_companies: new Set(['limit', 'offset']),
    trackly_ask: new Set(['query']),
    get_more_tools: new Set(Object.keys(MISSING_CAPABILITY_VALUES)),
  }[toolName] || new Set();

  for (const [key, value] of Object.entries(args).slice(0, MAX_CAPTURED_ITEMS)) {
    if (!allowed.has(key)) continue;
    if ((key === 'keywords' || key === 'query') && typeof value === 'string') {
      projected[key] = contentLength(value);
    } else if (key === 'companyId' || key === 'id') {
      const id = safeId(value);
      if (id !== undefined) projected[key] = id;
    } else if (key === 'limit' || key === 'offset') {
      const count = safeCount(value);
      if (count !== undefined) projected[key] = count;
    } else if (key === 'remote' && typeof value === 'boolean') {
      projected[key] = value;
    } else if (key === 'workArrangements' && Array.isArray(value)) {
      projected[key] = value.slice(0, 4).filter((candidate) => SAFE_ENUM_VALUES.has(candidate));
    } else if (Object.hasOwn(MISSING_CAPABILITY_VALUES, key)) {
      if (MISSING_CAPABILITY_VALUES[key].includes(value)) projected[key] = value;
    } else if (typeof value === 'string' && SAFE_ENUM_VALUES.has(value)) {
      projected[key] = value;
    } else if (key === 'locationFilter' && Array.isArray(value)) {
      projected[key] = value.slice(0, 10).filter((candidate) => SAFE_ENUM_VALUES.has(candidate));
    }
  }
  return { request: { params: { arguments: projected } } };
}

function sanitizeMcpAnalyticsEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const sanitized = redactValue(event);
  if (!sanitized || typeof sanitized !== 'object') return null;
  const sourceProperties = sanitized.properties;
  if (sourceProperties && typeof sourceProperties === 'object') {
    sanitized.properties = Object.fromEntries(
      Object.entries(sourceProperties)
        .filter(([key]) => ALLOWED_EVENT_PROPERTY_KEYS.has(key)),
    );
  }
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

  if (typeof properties.$session_id === 'string') {
    const sdkSession = /^ses_([0-9a-f-]{36})$/i.exec(properties.$session_id);
    if (sdkSession) properties.$session_id = sdkSession[1];
  }

  const toolName = properties.$mcp_tool_name ?? properties.$mcp_resource_name;
  const sourceArguments = findArguments(properties.$mcp_parameters);
  const sourceIntent = properties.$mcp_intent;
  const markedContextIntent = typeof sourceIntent === 'string'
    && sourceIntent.startsWith(CONTEXT_INTENT_MARKER);
  const hasContext = markedContextIntent || (typeof sourceArguments?.context === 'string'
    && sourceArguments.context.trim().length > 0);
  if (markedContextIntent) {
    properties.$mcp_intent = sourceIntent.slice(CONTEXT_INTENT_MARKER.length);
  }
  if (typeof toolName !== 'string' || !RICH_PAYLOAD_TOOLS.has(toolName)) {
    delete properties.$mcp_parameters;
    delete properties.$mcp_response;
  } else {
    if (properties.$mcp_parameters !== undefined) {
      properties.$mcp_parameters = projectMcpParameters(toolName, properties.$mcp_parameters);
    }
    if (properties.$mcp_response !== undefined) {
      properties.$mcp_response = redactMcpResponse(toolName, properties.$mcp_response);
    }
  }
  if (typeof toolName === 'string' && toolName.length > 0) {
    if (toolName === 'get_more_tools') {
      properties.$mcp_resource_name = toolName;
      delete properties.$mcp_tool_name;
    } else {
      properties.$mcp_tool_name = toolName;
      delete properties.$mcp_resource_name;
    }
    properties.$mcp_intent = classifyIntent(toolName, properties.$mcp_intent);
    properties.$mcp_intent_source = hasContext ? 'context_parameter' : 'inferred';
    if (toolName === 'get_more_tools' && event.event === '$mcp_tool_call') {
      sanitized.event = '$mcp_missing_capability';
    }
  } else {
    delete properties.$mcp_intent;
    delete properties.$mcp_intent_source;
  }

  const sourceErrorMessage = properties.$mcp_error_message;
  if (typeof sourceErrorMessage === 'string') {
    properties.$mcp_error_message = classifyError(sourceErrorMessage);
  }
  if (properties.$exception_list !== undefined) {
    properties.$exception_list = projectExceptionList(
      properties.$exception_list,
      sourceErrorMessage,
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

  for (const [toolName, tool] of Object.entries(tools)) {
    const shape = tool?.inputSchema?.shape;
    if (!shape || typeof shape !== 'object') continue;
    if (Object.hasOwn(shape, 'context')) continue;

    const originalHandler = tool.handler;
    tool.update({
      paramsSchema: {
        ...shape,
        context: z.string().optional().describe(CONTEXT_DESCRIPTION),
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
    $mcp_source: 'local',
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
  const maxPendingDeliveries = Number.isSafeInteger(options.maxPendingDeliveries)
    && options.maxPendingDeliveries > 0
    ? options.maxPendingDeliveries
    : DEFAULT_MAX_PENDING_DELIVERIES;
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
      // Another MCP process can persist an opt-out before this process loses
      // authentication. Refresh the anonymous gate from disk before every
      // unauthenticated delivery, while preserving a known in-memory opt-out
      // if its earlier persistence attempt failed.
      if (!authenticated) cachedOptOut ||= readCachedAnalyticsOptOut();
      if (!authenticated && cachedOptOut) return;
      if (pending.size >= maxPendingDeliveries) return;

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
  let diagnostic = 'instrumentation_exception';
  try {
    const sdk = (options.loadSdk || (() => require('@posthog/mcp')))();
    const anonymousDistinctId = `mcp-anon-${randomUUID()}`;
    relay = (options.createRelay || createBackendRelay)({ fetch: options.fetch });
    const eventProperties = runtimeEventProperties(env);
    const { $mcp_source: _mcpSource, ...sdkEventProperties } = eventProperties;
    addOptionalContextToTools(server);
    const sdkFailureWarnings = [];
    const analytics = sdk.instrument(server, relay, {
      reportMissing: false,
      enableConversationId: false,
      enableExceptionAutocapture: true,
      context: false,
      intentFallback: (request) => {
        const context = request?.params?.arguments?.context;
        return typeof context === 'string' && context.trim()
          ? `${CONTEXT_INTENT_MARKER}${context}`
          : null;
      },
      identify: { distinctId: anonymousDistinctId },
      beforeSend: (event) => safelySanitizeMcpAnalyticsEvent({
        ...event,
        properties: {
          ...event?.properties,
          ...eventProperties,
        },
      }),
      eventProperties: () => sdkEventProperties,
      logger: (message) => {
        if (SDK_FAILURE_WARNING.test(String(message))) {
          sdkFailureWarnings.push('sdk_setup_warning');
        }
      },
    });
    if (sdkFailureWarnings.length > 0) {
      diagnostic = sdkFailureWarnings[0];
      throw new Error('posthog_mcp_instrumentation_warning');
    }
    if (!analytics || typeof analytics.capture !== 'function') {
      diagnostic = 'sdk_noop_handle';
      throw new Error('posthog_mcp_noop_handle');
    }

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
      warn(`Usage analytics are unavailable (${diagnostic}); MCP tools will continue without telemetry.`);
    } catch {
      // Warning delivery is analytics-only and must also fail open.
    }
    return { enabled: false, reason: 'instrumentation_failed', diagnostic };
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
  if (!state?.relay) return;
  if (state.shutdownPromise) return state.shutdownPromise;

  state.shutdownPromise = (async () => {
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
  })();
  await state.shutdownPromise;
  if (analyticsState.get(server) === state) analyticsState.delete(server);
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
