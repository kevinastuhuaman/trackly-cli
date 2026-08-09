'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');
const { createServer, installMcpSignalHandlers, startMcpServer } = require('../mcp/server');

const {
  createBackendRelay,
  configureMcpAnalytics,
  isMcpAnalyticsEnabled,
  sanitizeMcpAnalyticsEvent,
  shutdownMcpAnalytics,
} = require('../mcp/analytics');

const ENABLED_ENV = {
  TRACKLY_MCP_ANALYTICS_ENABLED: 'true',
};

test('analytics is default-on with explicit local disable controls', () => {
  assert.equal(isMcpAnalyticsEnabled({}), true);
  assert.equal(isMcpAnalyticsEnabled({ TRACKLY_MCP_ANALYTICS_ENABLED: 'true' }), true);
  assert.equal(isMcpAnalyticsEnabled(ENABLED_ENV), true);
  assert.equal(isMcpAnalyticsEnabled({
    ...ENABLED_ENV,
    TRACKLY_MCP_ANALYTICS_ENABLED: 'false',
  }), false);
  assert.equal(isMcpAnalyticsEnabled({
    ...ENABLED_ENV,
    TRACKLY_MCP_ANALYTICS_DISABLED: 'true',
  }), false);
});

test('backend relay is anonymous before auth and backend-identified after auth', async () => {
  const previous = {
    apiKey: process.env.TRACKLY_API_KEY,
    baseUrl: process.env.TRACKLY_BASE_URL,
    configDir: process.env.TRACKLY_CONFIG_DIR,
  };
  const requests = [];
  const relay = createBackendRelay({
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/api/jobscout/analytics-preference')) {
        return {
          ok: true,
          async json() { return { shareUsageAnalytics: true }; },
        };
      }
      return { ok: true };
    },
    loadConfig: () => ({}),
    saveConfig() {},
  });

  try {
    delete process.env.TRACKLY_API_KEY;
    process.env.TRACKLY_BASE_URL = 'https://closeai.mba';
    process.env.TRACKLY_CONFIG_DIR = `/tmp/trackly-mcp-analytics-test-${process.pid}`;
    relay.capture({
      event: '$mcp_initialize',
      distinctId: 'mcp-anon-4fbe81a9-6b5b-4b4c-9d6f-2e349529f056',
      properties: { channel: 'mcp' },
    });
    await relay.flush();

    process.env.TRACKLY_API_KEY = 'trk_test_analytics_key';
    relay.capture({
      event: '$mcp_tool_call',
      distinctId: 'mcp-anon-4fbe81a9-6b5b-4b4c-9d6f-2e349529f056',
      properties: { $mcp_tool_name: 'trackly_search_jobs' },
    });
    await relay.flush();

    assert.equal(requests[0].url, 'https://closeai.mba/api/jobscout/mcp-analytics/anonymous');
    assert.equal(requests[0].options.headers.Authorization, undefined);
    assert.equal(requests[1].url, 'https://closeai.mba/api/jobscout/analytics-preference');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer trk_test_analytics_key');
    assert.equal(requests[2].url, 'https://closeai.mba/api/jobscout/mcp-analytics');
    assert.equal(requests[2].options.headers.Authorization, 'Bearer trk_test_analytics_key');
    assert.doesNotMatch(requests[2].options.body, /"distinctId":"42"/);
  } finally {
    if (previous.apiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previous.apiKey;
    if (previous.baseUrl === undefined) delete process.env.TRACKLY_BASE_URL;
    else process.env.TRACKLY_BASE_URL = previous.baseUrl;
    if (previous.configDir === undefined) delete process.env.TRACKLY_CONFIG_DIR;
    else process.env.TRACKLY_CONFIG_DIR = previous.configDir;
  }
});

test('anonymous relay preserves setup failures and missing-capability reports only', async () => {
  const previous = {
    apiKey: process.env.TRACKLY_API_KEY,
    baseUrl: process.env.TRACKLY_BASE_URL,
    configDir: process.env.TRACKLY_CONFIG_DIR,
  };
  const events = [];
  let cancellations = 0;
  const relay = createBackendRelay({
    fetch: async (_url, options) => {
      events.push(JSON.parse(options.body));
      return {
        ok: true,
        body: { async cancel() { cancellations += 1; } },
      };
    },
    loadConfig: () => ({}),
    saveConfig() {},
  });

  try {
    delete process.env.TRACKLY_API_KEY;
    process.env.TRACKLY_BASE_URL = 'https://closeai.mba';
    process.env.TRACKLY_CONFIG_DIR = `/tmp/trackly-mcp-analytics-anonymous-${process.pid}`;
    relay.capture({
      event: '$mcp_missing_capability',
      properties: {
        $mcp_resource_name: 'get_more_tools',
        $mcp_intent: 'Compare two saved jobs side by side.',
      },
    });
    relay.capture({
      event: '$mcp_tool_call',
      properties: { $mcp_tool_name: 'trackly_search_jobs' },
    });
    await relay.flush();

    assert.deepEqual(events.map((event) => event.event), ['$mcp_missing_capability']);
    assert.equal(events[0].properties.$mcp_intent, 'Compare two saved jobs side by side.');
    assert.equal(cancellations, 1);
  } finally {
    if (previous.apiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previous.apiKey;
    if (previous.baseUrl === undefined) delete process.env.TRACKLY_BASE_URL;
    else process.env.TRACKLY_BASE_URL = previous.baseUrl;
    if (previous.configDir === undefined) delete process.env.TRACKLY_CONFIG_DIR;
    else process.env.TRACKLY_CONFIG_DIR = previous.configDir;
  }
});

test('cached opt-out suppresses anonymous lifecycle before authentication', async () => {
  const previous = {
    apiKey: process.env.TRACKLY_API_KEY,
    configDir: process.env.TRACKLY_CONFIG_DIR,
  };
  const requests = [];
  const relay = createBackendRelay({
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true };
    },
    loadConfig: () => ({ mcpAnalyticsOptOut: true }),
    saveConfig() {},
  });

  try {
    delete process.env.TRACKLY_API_KEY;
    process.env.TRACKLY_CONFIG_DIR = `/tmp/trackly-mcp-analytics-cached-opt-out-${process.pid}`;
    relay.capture({ event: '$mcp_initialize', properties: {} });
    await relay.flush();
    assert.deepEqual(requests, []);
  } finally {
    if (previous.apiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previous.apiKey;
    if (previous.configDir === undefined) delete process.env.TRACKLY_CONFIG_DIR;
    else process.env.TRACKLY_CONFIG_DIR = previous.configDir;
  }
});

test('anonymous delivery refreshes an opt-out persisted by another MCP process', async () => {
  const previous = {
    apiKey: process.env.TRACKLY_API_KEY,
    configDir: process.env.TRACKLY_CONFIG_DIR,
  };
  const requests = [];
  let config = {};
  const relay = createBackendRelay({
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true };
    },
    loadConfig: () => ({ ...config }),
    saveConfig() {},
  });

  try {
    delete process.env.TRACKLY_API_KEY;
    process.env.TRACKLY_CONFIG_DIR = `/tmp/trackly-mcp-analytics-cross-process-${process.pid}`;
    config = { mcpAnalyticsOptOut: true };
    relay.capture({ event: '$mcp_initialize', properties: {} });
    await relay.flush();
    assert.deepEqual(requests, []);
  } finally {
    if (previous.apiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previous.apiKey;
    if (previous.configDir === undefined) delete process.env.TRACKLY_CONFIG_DIR;
    else process.env.TRACKLY_CONFIG_DIR = previous.configDir;
  }
});

test('authenticated preference lookup fails closed and caches only the opt-out boolean', async () => {
  const previousApiKey = process.env.TRACKLY_API_KEY;
  const requests = [];
  const savedConfigs = [];
  const relay = createBackendRelay({
    fetch: async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        async json() { return { shareUsageAnalytics: false }; },
      };
    },
    loadConfig: () => ({}),
    saveConfig: (config) => savedConfigs.push(config),
  });

  try {
    process.env.TRACKLY_API_KEY = 'trk_test_opt_out';
    relay.capture({
      event: '$mcp_tool_call',
      properties: { $mcp_tool_name: 'trackly_search_jobs' },
    });
    await relay.flush();

    assert.deepEqual(requests, ['https://closeai.mba/api/jobscout/analytics-preference']);
    assert.deepEqual(savedConfigs, [{ mcpAnalyticsOptOut: true }]);
    assert.doesNotMatch(JSON.stringify(savedConfigs), /userId|distinctId|trk_test_opt_out/);
  } finally {
    if (previousApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previousApiKey;
  }
});

test('authenticated preference singleflight is isolated by credential identity', async () => {
  const previousApiKey = process.env.TRACKLY_API_KEY;
  const requests = [];
  const savedConfigs = [];
  let releaseFirstPreference;
  const firstPreference = new Promise((resolve) => { releaseFirstPreference = resolve; });
  const relay = createBackendRelay({
    fetch: async (url, options) => {
      const authorization = options.headers.Authorization;
      requests.push({ path: String(url), authorization });
      if (authorization === 'Bearer trk_account_a') {
        await firstPreference;
        return { ok: true, async json() { return { shareUsageAnalytics: true }; } };
      }
      return { ok: true, async json() { return { shareUsageAnalytics: false }; } };
    },
    loadConfig: () => ({}),
    saveConfig: (config) => savedConfigs.push(config),
  });

  try {
    process.env.TRACKLY_API_KEY = 'trk_account_a';
    relay.capture({ event: '$mcp_tool_call', properties: { $mcp_tool_name: 'trackly_search_jobs' } });
    process.env.TRACKLY_API_KEY = 'trk_account_b';
    relay.capture({ event: '$mcp_tool_call', properties: { $mcp_tool_name: 'trackly_search_jobs' } });
    releaseFirstPreference();
    await relay.flush();

    assert.deepEqual(requests.map(({ authorization }) => authorization).sort(), [
      'Bearer trk_account_a',
      'Bearer trk_account_b',
    ]);
    assert.equal(requests.some(({ path }) => path.endsWith('/mcp-analytics')), false);
    assert.deepEqual(savedConfigs, [{ mcpAnalyticsOptOut: true }]);
  } finally {
    if (previousApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previousApiKey;
  }
});

test('unchanged opt-out does not rewrite config on every event', async () => {
  const previousApiKey = process.env.TRACKLY_API_KEY;
  let config = {};
  const savedConfigs = [];
  const relay = createBackendRelay({
    fetch: async () => ({
      ok: true,
      async json() { return { shareUsageAnalytics: false }; },
    }),
    loadConfig: () => ({ ...config }),
    saveConfig: (next) => {
      config = { ...next };
      savedConfigs.push(next);
    },
  });

  try {
    process.env.TRACKLY_API_KEY = 'trk_stable_opt_out';
    relay.capture({ event: '$mcp_tool_call', properties: { $mcp_tool_name: 'trackly_search_jobs' } });
    await relay.flush();
    relay.capture({ event: '$mcp_tool_call', properties: { $mcp_tool_name: 'trackly_search_jobs' } });
    await relay.flush();
    assert.deepEqual(savedConfigs, [{ mcpAnalyticsOptOut: true }]);
  } finally {
    if (previousApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previousApiKey;
  }
});

test('authenticated deliveries recheck preference so opt-in resumes without restart', async () => {
  const previousApiKey = process.env.TRACKLY_API_KEY;
  const requests = [];
  let config = {};
  let preferenceReads = 0;
  const relay = createBackendRelay({
    fetch: async (url) => {
      const path = String(url);
      requests.push(path);
      if (path.endsWith('/api/jobscout/analytics-preference')) {
        preferenceReads += 1;
        return {
          ok: true,
          async json() { return { shareUsageAnalytics: preferenceReads > 1 }; },
        };
      }
      return { ok: true };
    },
    loadConfig: () => ({ ...config }),
    saveConfig: (next) => { config = { ...next }; },
  });

  try {
    process.env.TRACKLY_API_KEY = 'trk_test_preference_refresh';
    relay.capture({
      event: '$mcp_tool_call',
      properties: { $mcp_tool_name: 'trackly_search_jobs' },
    });
    await relay.flush();
    assert.deepEqual(config, { mcpAnalyticsOptOut: true });

    relay.capture({
      event: '$mcp_tool_call',
      properties: { $mcp_tool_name: 'trackly_search_jobs' },
    });
    await relay.flush();

    assert.deepEqual(requests, [
      'https://closeai.mba/api/jobscout/analytics-preference',
      'https://closeai.mba/api/jobscout/analytics-preference',
      'https://closeai.mba/api/jobscout/mcp-analytics',
    ]);
    assert.deepEqual(config, {});
  } finally {
    if (previousApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previousApiKey;
  }
});

test('failed preference lookups cancel unread response bodies', async () => {
  const previousApiKey = process.env.TRACKLY_API_KEY;
  let cancellations = 0;
  const relay = createBackendRelay({
    fetch: async () => ({
      ok: false,
      body: { async cancel() { cancellations += 1; } },
    }),
    loadConfig: () => ({}),
    saveConfig() {},
  });

  try {
    process.env.TRACKLY_API_KEY = 'trk_test_failed_preference_body';
    relay.capture({
      event: '$mcp_tool_call',
      properties: { $mcp_tool_name: 'trackly_search_jobs' },
    });
    await relay.flush();
    assert.equal(cancellations, 1);
  } finally {
    if (previousApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = previousApiKey;
  }
});

test('disabled analytics never loads the SDK or mutates the server', () => {
  let loads = 0;
  const server = {};
  const result = configureMcpAnalytics(server, {
    env: { TRACKLY_MCP_ANALYTICS_DISABLED: 'true' },
    loadSdk: () => {
      loads += 1;
      throw new Error('must not load');
    },
  });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(loads, 0);
});

test('Trackly server configures analytics only after every source tool is registered', () => {
  let configuredServer;
  let sourceToolCount;
  const server = createServer({
    configureAnalytics(candidate) {
      configuredServer = candidate;
      sourceToolCount = Object.keys(candidate._registeredTools).length;
    },
  });

  assert.equal(configuredServer, server);
  assert.equal(sourceToolCount, 48);
});

test('all existing Trackly tools keep context optional when analytics is enabled', async (t) => {
  const posthog = { capture() {}, async _shutdown() {} };
  const server = createServer({
    analytics: {
      env: ENABLED_ENV,
      loadSdk: () => require('@posthog/mcp'),
      createRelay: () => posthog,
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'trackly-schema-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await shutdownMcpAnalytics(server);
  });

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 49);
  for (const tool of listed.tools) {
    assert.ok(tool.inputSchema.properties.context, `${tool.name} has optional context`);
    assert.ok(!tool.inputSchema.required?.includes('context'), `${tool.name} does not require context`);
  }
});

test('rich public-search telemetry preserves useful content and removes forbidden fields', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$mcp_tool_call',
    distinct_id: '42',
    properties: {
      $mcp_tool_name: 'trackly_search_jobs',
      $mcp_intent: 'Find product jobs at fintech companies in San Francisco.',
      $mcp_parameters: {
        request: {
          params: {
            arguments: {
              keywords: 'fintech product manager',
              locationFilter: 'us',
              apiKey: 'trk_secret_key',
              profileAnswers: { fullName: 'Private Person' },
            },
          },
        },
      },
      $mcp_response: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            jobs: [{ id: 123, title: 'Product Manager', company: 'Acme' }],
            resumeText: 'private resume body',
            candidateResumeText: 'private alternate resume body',
            workAuthorizationAnswerText: 'private work authorization answer',
            applicationNotesInternal: 'private application note',
          }),
        }],
      },
    },
  });

  assert.equal(result.properties.$mcp_intent, 'job_discovery');
  assert.deepEqual(
    result.properties.$mcp_parameters.request.params.arguments.keywords,
    { length: 'fintech product manager'.length },
  );
  assert.equal(result.properties.$mcp_parameters.request.params.arguments.apiKey, '[redacted]');
  assert.equal(result.properties.$mcp_parameters.request.params.arguments.profileAnswers, '[redacted]');
  assert.doesNotMatch(JSON.stringify(result), /Find product jobs|fintech product manager/);

  const response = JSON.parse(result.properties.$mcp_response.content[0].text);
  assert.equal(response.jobs[0].title, 'Product Manager');
  assert.equal(response.resumeText, '[redacted]');
  assert.equal(response.candidateResumeText, '[redacted]');
  assert.equal(response.workAuthorizationAnswerText, '[redacted]');
  assert.equal(response.applicationNotesInternal, '[redacted]');
});

test('private profile and Apply tools never send arguments, responses, or intent', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$mcp_tool_call',
    distinct_id: '42',
    properties: {
      $mcp_tool_name: 'trackly_update_application_profile',
      $mcp_intent: 'Save the candidate work authorization and application answers.',
      $mcp_parameters: {
        request: {
          params: {
            arguments: {
              expectedRevision: 7,
              profileAnswers: {
                workAuthorization: 'private answer',
                demographic: 'private answer',
              },
            },
          },
        },
      },
      $mcp_response: {
        content: [{ type: 'text', text: '{"success":true,"profileAnswers":{"name":"private"}}' }],
      },
      $mcp_duration_ms: 18,
      $mcp_is_error: false,
    },
  });

  assert.equal(result.properties.$mcp_parameters, undefined);
  assert.equal(result.properties.$mcp_response, undefined);
  assert.equal(result.properties.$mcp_intent, undefined);
  assert.equal(result.properties.$mcp_duration_ms, 18);
  assert.equal(result.properties.$mcp_is_error, false);
});

test('rich payloads fail closed when a tool name is missing', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$mcp_tool_call',
    properties: {
      $mcp_parameters: { request: { params: { arguments: { keywords: 'private' } } } },
      $mcp_response: { content: [{ type: 'text', text: '{"jobs":[]}' }] },
      $mcp_intent: 'Find roles for this person.',
    },
  });

  assert.equal(result.properties.$mcp_parameters, undefined);
  assert.equal(result.properties.$mcp_response, undefined);
  assert.equal(result.properties.$mcp_intent, undefined);
});

test('missing-capability intent uses the SDK resource-name shape', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$mcp_missing_capability',
    properties: {
      $mcp_resource_name: 'get_more_tools',
      $mcp_intent: 'Compare two saved jobs side by side.',
    },
  });

  assert.equal(result.properties.$mcp_intent, 'compare_options');
});

test('client identity is removed because authenticated identity is backend-owned', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$identify',
    distinct_id: '42',
    properties: {
      email: 'must-not-be-an-event-property@example.com',
      $set: {
        email: 'verified@example.com',
        name: 'Verified Person',
        provider: 'google',
        analytics_opt_out: false,
        resumeText: 'must not survive',
      },
    },
  });

  assert.equal(result.properties.email, undefined);
  assert.equal(result.properties.$set, undefined);
});

test('error telemetry removes secrets, user paths, and sensitive payload values', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$exception',
    distinct_id: '42',
    properties: {
      $mcp_tool_name: 'trackly_search_jobs',
      $exception_list: [{
        type: 'Error',
        value: 'Request failed with token trk_super_secret at /Users/private-user/.trackly/config.json',
        stacktrace: {
          frames: [{
            filename: '/home/private-linux/Code/trackly-cli/mcp/server.js',
            function: 'wrapTool',
            vars: { authorization: 'Bearer private', applicationNotes: 'do not capture' },
          }],
        },
      }],
    },
  });

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /trk_super_secret/);
  assert.doesNotMatch(serialized, /private-user/);
  assert.doesNotMatch(serialized, /private-linux/);
  assert.doesNotMatch(serialized, /do not capture/);
  assert.doesNotMatch(serialized, /\[redacted\]|<local-path>/);
  assert.match(serialized, /wrapTool/);
  assert.deepEqual(result.properties.$exception_list, [{
    type: 'Error',
    category: 'unknown',
    stacktrace: { frames: [{ function_name: 'wrapTool' }] },
  }]);
});

test('exception fallback classification uses the original error message', () => {
  const result = sanitizeMcpAnalyticsEvent({
    event: '$exception',
    properties: {
      $mcp_tool_name: 'trackly_search_jobs',
      $mcp_error_message: 'Upstream returned 429 Too Many Requests',
      $exception_list: [{ type: 'Error', stacktrace: { frames: [] } }],
    },
  });

  assert.equal(result.properties.$mcp_error_message, 'rate_limit');
  assert.equal(result.properties.$exception_list[0].category, 'rate_limit');
});

test('string redaction removes configured and arbitrary working-directory prefixes', () => {
  const previousConfigDir = process.env.TRACKLY_CONFIG_DIR;
  process.env.TRACKLY_CONFIG_DIR = '/srv/trackly-private';
  try {
    const result = sanitizeMcpAnalyticsEvent({
      event: '$mcp_tool_call',
      properties: {
        $mcp_tool_name: 'trackly_search_jobs',
        $mcp_response: {
          configured: '/srv/trackly-private/config.json failed',
          working: `${process.cwd()}/mcp/server.js failed`,
        },
      },
    });
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /srv\/trackly-private/);
    assert.doesNotMatch(
      serialized,
      new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.match(serialized, /<local-path>/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.TRACKLY_CONFIG_DIR;
    else process.env.TRACKLY_CONFIG_DIR = previousConfigDir;
  }
});

test('enabled instrumentation advertises optional context and strips it before handlers', async (t) => {
  const captures = [];
  const posthog = {
    capture(event) { captures.push(event); },
    async _shutdown() {},
  };
  const server = new McpServer({ name: 'analytics-test', version: '1.0.0' });
  let handlerArgs;
  server.tool(
    'trackly_search_jobs',
    'Search jobs',
    { keywords: z.string() },
    async (args) => {
      handlerArgs = args;
      return { content: [{ type: 'text', text: '{"jobs":[]}' }] };
    },
  );

  const configured = configureMcpAnalytics(server, {
    env: ENABLED_ENV,
    loadSdk: () => require('@posthog/mcp'),
    createRelay: () => posthog,
  });
  assert.equal(configured.enabled, true);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'analytics-test-client', version: '2.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await shutdownMcpAnalytics(server);
  });

  const listed = await client.listTools();
  const searchTool = listed.tools.find((tool) => tool.name === 'trackly_search_jobs');
  assert.ok(searchTool);
  assert.ok(searchTool.inputSchema.properties.context);
  assert.ok(!searchTool.inputSchema.required.includes('context'));
  const missingCapabilityTool = listed.tools.find((tool) => tool.name === 'get_more_tools');
  assert.ok(missingCapabilityTool);
  assert.ok(!missingCapabilityTool.inputSchema.required?.includes('context'));
  await assert.doesNotReject(client.callTool({
    name: 'get_more_tools',
    arguments: {},
  }));

  await assert.doesNotReject(client.callTool({
    name: 'trackly_search_jobs',
    arguments: { keywords: 'fintech' },
  }));
  assert.deepEqual(handlerArgs, { keywords: 'fintech' });

  await assert.doesNotReject(client.callTool({
    name: 'trackly_search_jobs',
    arguments: { keywords: 'fintech', context: '' },
  }));
  assert.deepEqual(handlerArgs, { keywords: 'fintech' });

  await client.callTool({
    name: 'trackly_search_jobs',
    arguments: {
      keywords: 'fintech',
      context: 'Find fintech product roles for the current job-search session.',
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(handlerArgs, { keywords: 'fintech' });
  const toolCall = captures.find((capture) => (
    capture.event === '$mcp_tool_call'
      && capture.properties.$mcp_intent === 'job_discovery'
  ));
  assert.ok(toolCall);
  assert.equal(toolCall.properties.$mcp_intent, 'job_discovery');
  assert.doesNotMatch(JSON.stringify(toolCall), /current job-search session|"fintech"/);
  assert.equal(toolCall.properties.$mcp_parameters.request.params.arguments.context, undefined);
  assert.equal(toolCall.properties.channel, 'mcp');
  assert.equal(toolCall.properties.contract_version, 3);
  assert.equal(toolCall.properties.app_version, require('../package.json').version);
  assert.match(toolCall.distinctId, /^mcp-anon-[0-9a-f-]{36}$/);

  const identify = captures.find((capture) => capture.event === '$identify');
  assert.ok(identify);
  assert.equal(identify.properties.channel, 'mcp');
  assert.equal(identify.properties.contract_version, 3);
});

test('instrumentation failure and shutdown failure are fail-open', async () => {
  const server = { _registeredTools: {} };
  const warnings = [];
  const configured = configureMcpAnalytics(server, {
    env: ENABLED_ENV,
    createRelay: () => ({ _shutdown() { throw new Error('shutdown failed'); } }),
    loadSdk: () => ({ instrument() { throw new Error('instrument failed'); } }),
    onWarning: (warning) => warnings.push(warning),
  });

  assert.equal(configured.enabled, false);
  assert.equal(configured.reason, 'instrumentation_failed');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tools will continue/);
  await assert.doesNotReject(shutdownMcpAnalytics(server));
});

test('concurrent shutdown calls share the in-flight analytics flush', async () => {
  const server = { _registeredTools: {} };
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const relay = { _shutdown: test.mock.fn(async () => pending) };
  const configured = configureMcpAnalytics(server, {
    env: ENABLED_ENV,
    createRelay: () => relay,
    loadSdk: () => ({ instrument() { return {}; } }),
  });
  assert.equal(configured.enabled, true);

  let firstSettled = false;
  let secondSettled = false;
  const first = shutdownMcpAnalytics(server).then(() => { firstSettled = true; });
  const second = shutdownMcpAnalytics(server).then(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(relay._shutdown.mock.callCount(), 1);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);

  finish();
  await Promise.all([first, second]);
  assert.equal(firstSettled, true);
  assert.equal(secondSettled, true);
});

test('SDK private-tool registry drift disables analytics visibly without breaking tools', () => {
  let instrumentCalls = 0;
  const warnings = [];
  const configured = configureMcpAnalytics({}, {
    env: ENABLED_ENV,
    createRelay: () => ({ capture() {}, async _shutdown() {} }),
    loadSdk: () => ({
      instrument() {
        instrumentCalls += 1;
        return {};
      },
    }),
    onWarning: (warning) => warnings.push(warning),
  });

  assert.equal(configured.enabled, false);
  assert.equal(configured.reason, 'instrumentation_failed');
  assert.equal(instrumentCalls, 0);
  assert.deepEqual(warnings, [
    'Usage analytics are unavailable; MCP tools will continue without telemetry.',
  ]);
});

test('a malformed cyclic analytics event is dropped instead of escaping beforeSend', () => {
  let beforeSend;
  const server = { _registeredTools: {} };
  const configured = configureMcpAnalytics(server, {
    env: ENABLED_ENV,
    createRelay: () => ({ capture() {}, async _shutdown() {} }),
    loadSdk: () => ({
      instrument(_server, _relay, options) {
        beforeSend = options.beforeSend;
        return {};
      },
    }),
  });
  assert.equal(configured.enabled, true);

  const event = { event: '$exception', properties: {} };
  event.properties.cycle = event;
  assert.doesNotThrow(() => beforeSend(event));
  assert.equal(beforeSend(event), null);
});

test('capture failures never fail an MCP tool call', async (t) => {
  const server = new McpServer({ name: 'analytics-failure-test', version: '1.0.0' });
  server.tool(
    'trackly_search_jobs',
    'Search jobs',
    { keywords: z.string() },
    async () => ({ content: [{ type: 'text', text: '{"jobs":[]}' }] }),
  );

  const configured = configureMcpAnalytics(server, {
    env: ENABLED_ENV,
    loadSdk: () => require('@posthog/mcp'),
    createRelay: () => ({
      capture() { throw new Error('capture failed'); },
      async _shutdown() {},
    }),
  });
  assert.equal(configured.enabled, true);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'analytics-failure-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await shutdownMcpAnalytics(server);
  });

  await assert.doesNotReject(client.callTool({
    name: 'trackly_search_jobs',
    arguments: { keywords: 'fintech', context: 'Find fintech jobs.' },
  }));
});

test('transport close starts bounded analytics shutdown', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let shutdownCalls = 0;
  const server = await startMcpServer({
    transport: serverTransport,
    configureAnalytics() {},
    async shutdownAnalytics() { shutdownCalls += 1; },
  });
  const client = new Client({ name: 'shutdown-test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  await client.close();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shutdownCalls, 1);
  await server.close().catch(() => {});
});

test('transport connection failure uses the injected analytics shutdown hook', async () => {
  const failure = new Error('transport failed');
  const shutdownAnalytics = test.mock.fn(async () => {});
  const transport = {
    async start() { throw failure; },
    async send() {},
    async close() {},
  };

  await assert.rejects(startMcpServer({
    transport,
    configureAnalytics() {},
    shutdownAnalytics,
  }), failure);
  assert.equal(shutdownAnalytics.mock.callCount(), 1);
});

test('SIGTERM flushes analytics before exiting the MCP process', async () => {
  const signalTarget = new EventEmitter();
  let finishShutdown;
  const shutdownFinished = new Promise((resolve) => { finishShutdown = resolve; });
  const exits = [];
  const shutdownAnalytics = test.mock.fn(async () => shutdownFinished);
  const cleanup = installMcpSignalHandlers({}, {
    signalTarget,
    shutdownAnalytics,
    exit: (code) => exits.push(code),
  });

  signalTarget.emit('SIGTERM');
  signalTarget.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownAnalytics.mock.callCount(), 1);
  assert.deepEqual(exits, []);

  finishShutdown();
  await shutdownFinished;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [143]);
  cleanup();
});
