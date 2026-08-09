'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { z } = require('zod');
const { createServer, startMcpServer } = require('../mcp/server');

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
      return { ok: true };
    },
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
    assert.equal(requests[1].url, 'https://closeai.mba/api/jobscout/mcp-analytics');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer trk_test_analytics_key');
    assert.doesNotMatch(requests[1].options.body, /"distinctId":"42"/);
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
  const sourceTools = listed.tools.filter((tool) => tool.name !== 'get_more_tools');
  assert.equal(sourceTools.length, 48);
  for (const tool of sourceTools) {
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

  assert.equal(result.properties.$mcp_intent, 'Find product jobs at fintech companies in San Francisco.');
  assert.equal(
    result.properties.$mcp_parameters.request.params.arguments.keywords,
    'fintech product manager',
  );
  assert.equal(result.properties.$mcp_parameters.request.params.arguments.apiKey, '[redacted]');
  assert.equal(result.properties.$mcp_parameters.request.params.arguments.profileAnswers, '[redacted]');

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

  assert.equal(result.properties.$mcp_intent, 'Compare two saved jobs side by side.');
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
  assert.match(serialized, /\[redacted\]/);
  assert.match(serialized, /<local-path>/);
  assert.match(serialized, /wrapTool/);
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
  assert.ok(listed.tools.some((tool) => tool.name === 'get_more_tools'));

  await assert.doesNotReject(client.callTool({
    name: 'trackly_search_jobs',
    arguments: { keywords: 'fintech' },
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
      && capture.properties.$mcp_intent === 'Find fintech product roles for the current job-search session.'
  ));
  assert.ok(toolCall);
  assert.equal(toolCall.properties.$mcp_intent, 'Find fintech product roles for the current job-search session.');
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
  const server = {};
  const configured = configureMcpAnalytics(server, {
    env: ENABLED_ENV,
    createRelay: () => ({ _shutdown() { throw new Error('shutdown failed'); } }),
    loadSdk: () => ({ instrument() { throw new Error('instrument failed'); } }),
  });

  assert.equal(configured.enabled, false);
  assert.equal(configured.reason, 'instrumentation_failed');
  await assert.doesNotReject(shutdownMcpAnalytics(server));
});

test('a malformed cyclic analytics event is dropped instead of escaping beforeSend', () => {
  let beforeSend;
  const server = {};
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
