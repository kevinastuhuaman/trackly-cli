'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const client = require('../lib/client');
const { withEnv, createTempConfigDir } = require('./helpers');

test('content-disposition filenames prefer RFC 5987 Unicode without lossy rewriting', () => {
  assert.equal(
    client.contentDispositionFileName(
      "attachment; filename=resume.pdf; filename*=UTF-8''Candidate%20R%C3%A9sum%C3%A9%20%282026%29.pdf",
    ),
    'Candidate Résumé (2026).pdf',
  );
  assert.equal(
    client.contentDispositionFileName('attachment; filename="Resume - Candidate.pdf"'),
    'Resume - Candidate.pdf',
  );
  assert.equal(
    client.contentDispositionFileName("attachment; filename*=UTF-8'en'Candidate.pdf"),
    'Candidate.pdf',
  );
  assert.equal(
    client.contentDispositionFileName('attachment; filename=" Resume - Candidate.pdf "'),
    ' Resume - Candidate.pdf ',
  );
  assert.equal(client.contentDispositionFileName('inline'), null);
});

test('API keys take precedence over stored OAuth tokens', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
    TRACKLY_HTTP_TIMEOUT_MS: undefined,
  }, async () => {
    client.saveConfig({
      apiKey: 'trk_local_key',
      token: 'jwt_token',
    });

    assert.equal(client.getAuthMethod(), 'apiKey');
    assert.equal(client.getRequestHeaders().Authorization, 'Bearer trk_local_key');
  });
});

test('apiRequest rejects insecure non-localhost credential transport', async () => {
  await withEnv({
    TRACKLY_API_KEY: 'trk_live_key',
    TRACKLY_BASE_URL: 'http://example.com',
  }, async () => {
    await assert.rejects(
      client.apiRequest('GET', '/api/jobscout/jobs'),
      /Refusing to send credentials over insecure connection/
    );
  });
});

test('Trackly access errors share actionable CLI and MCP rollout guidance', () => {
  const error = client.createTracklyAccessError(
    { code: 'INVITATION_REQUIRED', error: 'backend wording' },
    403,
  );

  assert.equal(error.code, 'INVITATION_REQUIRED');
  assert.equal(error.status, 403);
  assert.match(error.message, /limited rollout/i);
  assert.match(error.message, /private invite/i);
  assert.match(error.message, /https:\/\/usetrackly\.app\/early-access/);
  assert.equal(client.createTracklyAccessError({ code: 'UNRELATED' }, 403), null);

  const unavailable = client.createTracklyAccessError({ code: 'ACCESS_CHECK_UNAVAILABLE' }, 503);
  assert.equal(unavailable.retryable, true);
  assert.match(unavailable.message, /try again/i);
  assert.doesNotMatch(unavailable.message, /private invite/i);

  const pending = client.createTracklyAccessError({ code: 'ALREADY_REQUESTED' }, 409);
  assert.equal(pending.retryable, false);
  assert.match(pending.message, /already pending/i);
  assert.doesNotMatch(pending.message, /request access at/i);
});

test('apiRequest normalizes a structured invitation denial', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'INVITATION_REQUIRED', error: 'backend wording' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    await assert.rejects(
      client.apiRequest('GET', '/api/jobscout/me', undefined, true),
      (error) => error.code === 'INVITATION_REQUIRED'
        && error.status === 403
        && /private invite/i.test(error.message),
    );
  });
});

// ─── refreshAccessToken behavior (PR #20) ─────────────────────────────────────
// Covers the three branches: 4xx from /api/auth/refresh clears the config, a
// 2xx-with-no-token response also clears (CodeRabbit/Cursor/Copilot caught this
// silently left a dead token on disk), and a network error preserves the token
// so transient connectivity blips don't log the user out.

function setupRefreshTestHarness(t, handler) {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ configDir, port: server.address().port });
    });
  });
}

test('apiRequest permits only a bounded Idempotency-Key additional header', async (t) => {
  let receivedKey = null;
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    receivedKey = req.headers['idempotency-key'];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_idempotency_test',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
  }, async () => {
    await client.apiRequest(
      'POST',
      '/api/jobscout/apply/batches',
      { limit: 5 },
      false,
      false,
      'trackly-test/1.0.0',
      { 'Idempotency-Key': 'batch-test-key-0001' },
    );
    assert.equal(receivedKey, 'batch-test-key-0001');

    await assert.rejects(
      client.apiRequest(
        'POST',
        '/api/jobscout/apply/batches',
        { limit: 5 },
        false,
        false,
        'trackly-test/1.0.0',
        { Authorization: 'forbidden' },
      ),
      /Only a valid Idempotency-Key/,
    );
  });
});

test('apiRequest preserves Idempotency-Key across OAuth refresh retry', async (t) => {
  const mutationRequests = [];
  let refreshCount = 0;
  const idempotencyKey = 'batch-oauth-retry-key-0001';
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/refresh') {
      refreshCount++;
      res.end(JSON.stringify({
        success: true,
        token: 'jwt_new',
        refreshToken: 'rt_new',
      }));
      return;
    }
    if (req.url === '/api/jobscout/apply/batches' && req.method === 'POST') {
      mutationRequests.push({
        authorization: req.headers.authorization,
        idempotencyKey: req.headers['idempotency-key'],
      });
      if (mutationRequests.length === 1) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Expired access token' }));
        return;
      }
      res.end(JSON.stringify({ success: true, batch: { id: 44 } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({ token: 'jwt_old', refreshToken: 'rt_old' });

    const result = await client.apiRequest(
      'POST',
      '/api/jobscout/apply/batches',
      { limit: 5 },
      false,
      false,
      'trackly-test/1.0.0',
      { 'Idempotency-Key': idempotencyKey },
    );

    assert.equal(result.batch.id, 44);
    assert.equal(refreshCount, 1, 'the 401 should trigger exactly one OAuth refresh');
    assert.deepEqual(mutationRequests, [
      {
        authorization: 'Bearer jwt_old',
        idempotencyKey,
      },
      {
        authorization: 'Bearer jwt_new',
        idempotencyKey,
      },
    ]);
  });
});

test('apiRequest aborts oversized response body (PR v0.2.4)', async (t) => {
  // The 10 MB body cap prevents a malicious TRACKLY_BASE_URL from OOM'ing the long-lived
  // MCP process via unbounded streaming. We simulate by returning chunks that exceed the
  // cap; the client must reject with a specific error and NOT crash.
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Send a single 11 MB chunk. Node's body-buffer grows past MAX_BODY_BYTES (10 MB)
    // on the first chunk event and the client calls req.destroy.
    const chunk = Buffer.alloc(11 * 1024 * 1024, '{');
    res.write(chunk);
    res.end('}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '5000',
  }, async () => {
    await assert.rejects(
      client.apiRequest('GET', '/oversized'),
      /Trackly response body exceeded/,
      'oversized body must reject with a specific, identifiable error (not swallow into OOM)'
    );
  });
});

test('apiRequest rejection: HTTP statusCode wins over body `status` key (Cursor Bugbot #5)', async (t) => {
  // Regression: apiRequest used to reject with `{ status: res.statusCode, ...json }` — spread
  // came AFTER, so a backend body like `{"status":"error"}` would clobber the numeric HTTP
  // status with a string. Downstream code checking `typeof e.status === 'number'` then
  // skipped the 400/401/403 token-clear branch, and dead refresh tokens stayed on disk.
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'error', error: 'invalid_grant', message: 'token dead' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    let caught;
    try {
      await client.apiRequest('POST', '/api/auth/refresh', { refreshToken: 'rt' }, true);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'apiRequest must reject on 401');
    assert.equal(typeof caught.status, 'number', 'status must stay numeric even when body has status:string');
    assert.equal(caught.status, 401, 'HTTP statusCode must win over body.status');
    assert.equal(caught.error, 'invalid_grant', 'body fields still accessible');
  });
});

test('refreshAccessToken clears tokens on 401 even when body has status:string (Bugbot #5 integration)', async (t) => {
  // End-to-end guard for the spread-order bug: the full refresh path must clear tokens on
  // 401 even when the backend returns `{"status":"error"}` in the body. Before the spread
  // fix, this test would have failed because typeof e.status === 'number' was false.
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'error', error: 'invalid_grant' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({ token: 'jwt', refreshToken: 'rt_dead', baseUrl: 'https://k.com' });
    const out = await client.refreshAccessToken();
    assert.equal(out, null);
    assert.equal(client.getRefreshToken(), null, 'tokens must clear even when body.status overrides');
    assert.equal(client.loadConfig().baseUrl, 'https://k.com');
    assert.equal(
      client.loadConfig().mcpAnalyticsOptOut,
      true,
      'an invalid final OAuth session must fail closed for anonymous analytics',
    );
  });
});

test('refreshAccessToken clears tokens on 401 but preserves baseUrl', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    // Seed a non-default baseUrl on disk so we can assert it survives the refresh failure.
    // The env-var baseUrl (set above for the fake server) overrides getBaseUrl(), but
    // loadConfig().baseUrl reads the raw file — which is what Bugbot flagged as getting
    // wiped by the old clearConfig() call.
    client.saveConfig({
      token: 'jwt',
      refreshToken: 'rt_dead',
      baseUrl: 'https://custom.usetrackly.app',
    });
    assert.equal(client.getRefreshToken(), 'rt_dead');

    const out = await client.refreshAccessToken();
    assert.equal(out, null, 'refresh should return null on 401');
    assert.equal(client.getRefreshToken(), null, 'dead refresh token must be cleared from disk');
    assert.equal(client.getToken(), null, 'access token must be cleared alongside');
    assert.equal(
      client.loadConfig().baseUrl,
      'https://custom.usetrackly.app',
      'user-configured baseUrl must survive a token refresh failure (Cursor Bugbot PR #20)'
    );
  });
});

test('refresh invalidation removes OAuth and fails analytics closed without recursive auth', async (t) => {
  const requests = [];
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/jobscout/analytics-preference') {
      res.statusCode = 200;
      res.end(JSON.stringify({ shareUsageAnalytics: true }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'invalid_grant' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({
      token: 'jwt_expired',
      refreshToken: 'rt_invalid',
      baseUrl: 'https://custom.usetrackly.app',
      mcpAnalyticsOptOut: true,
    });

    assert.equal(await client.refreshAccessToken(), null);
    assert.deepEqual(requests, ['/api/auth/refresh']);
    assert.deepEqual(client.loadConfig(), {
      baseUrl: 'https://custom.usetrackly.app',
      mcpAnalyticsOptOut: true,
    });
  });
});

test('refreshAccessToken clears tokens on 2xx-with-no-token but preserves baseUrl + apiKey', async (t) => {
  // Regression: original code had a comment promising "fall through to clearConfig()" but
  // the only clearConfig() lived in the catch block, so a 200 { success: false } response
  // silently left the dead refresh token on disk and every subsequent 401 re-triggered the
  // same doomed refresh. Caught by Copilot + Cursor Bugbot + CodeRabbit on PR #20.
  // Post-fix Bugbot catch: clearConfig() wiped the whole file including baseUrl/apiKey —
  // now using clearOAuthTokens() for a surgical delete.
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, code: 'invalid_grant' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({
      token: 'jwt',
      refreshToken: 'rt_dead_but_2xx',
      baseUrl: 'https://staging.usetrackly.app',
      apiKey: 'trk_preserved_key',
    });

    const out = await client.refreshAccessToken();
    assert.equal(out, null, 'refresh should return null when body has no token');
    assert.equal(client.getRefreshToken(), null, 'dead refresh token must be cleared');
    assert.equal(client.getToken(), null);
    const onDisk = client.loadConfig();
    assert.equal(onDisk.baseUrl, 'https://staging.usetrackly.app', 'baseUrl must survive');
    assert.equal(onDisk.apiKey, 'trk_preserved_key', 'apiKey must survive a token expiry');
  });
});

test('clearOAuthTokens removes file when no non-auth keys remain', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    // OAuth-only config — no baseUrl/apiKey/etc. After clearing tokens, nothing is left
    // worth persisting, so the file should be unlinked (keeps behavior backward-compatible
    // with the old clearConfig() full-delete for this common "logout" case).
    client.saveConfig({ token: 'jwt', refreshToken: 'rt' });
    client.clearOAuthTokens();
    const configFile = client.getConfigPaths().file;
    assert.equal(fs.existsSync(configFile), false, 'empty post-clear config should be unlinked');
  });
});

test('logout clearing preserves only the anonymous analytics opt-out', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({
      token: 'jwt',
      refreshToken: 'rt',
      apiKey: 'trk_secret',
      baseUrl: 'https://custom.usetrackly.app',
      mcpAnalyticsOptOut: true,
    });

    client.clearConfig();

    assert.deepEqual(client.loadConfig(), { mcpAnalyticsOptOut: true });
    assert.equal(client.getToken(), null);
    assert.equal(client.getRefreshToken(), null);
    assert.equal(client.getApiKey(), null);
  });
});

test('credential removal still unlinks the old credential file when opt-out preservation cannot write', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({ token: 'jwt', refreshToken: 'rt', mcpAnalyticsOptOut: true });
    const configFile = client.getConfigPaths().file;
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (String(file).includes('.tmp.')) throw new Error('disk full');
      return originalWriteFileSync(file, ...args);
    };
    try {
      await assert.doesNotReject(client.removeCredentials({
        scope: 'all',
        request: async () => ({ shareUsageAnalytics: false }),
        timeoutMs: 20,
      }));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(fs.existsSync(configFile), false, 'credential-bearing file must be removed');
  });
});

test('final credential removal times out, aborts preference sync, and ignores late completion', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({ token: 'jwt', refreshToken: 'rt' });
    let requestSignal;
    let finishRequest;
    const request = (...args) => {
      requestSignal = args[7].signal;
      return new Promise((resolve) => { finishRequest = resolve; });
    };

    const startedAt = Date.now();
    await client.removeCredentials({ scope: 'all', request, timeoutMs: 20 });
    assert.ok(Date.now() - startedAt < 500, 'logout must not wait for a hung preference request');
    assert.equal(requestSignal.aborted, true, 'timeout must abort the underlying request');
    assert.deepEqual(client.loadConfig(), { mcpAnalyticsOptOut: true });

    finishRequest({ shareUsageAnalytics: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      client.loadConfig(),
      { mcpAnalyticsOptOut: true },
      'late success must not rewrite post-logout config',
    );
  });
});

test('failed final-credential sync keeps anonymous analytics off until authenticated opt-in sync', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({ apiKey: 'trk_last_credential' });
    await client.removeCredentials({
      scope: 'apiKey',
      request: async () => { throw new Error('offline'); },
      timeoutMs: 20,
    });
    assert.deepEqual(client.loadConfig(), { mcpAnalyticsOptOut: true });

    await client.synchronizeAnalyticsPreferenceBeforeLogout(
      async () => ({ shareUsageAnalytics: true }),
      { timeoutMs: 20 },
    );
    assert.deepEqual(
      client.loadConfig(),
      { mcpAnalyticsOptOut: true },
      'unauthenticated sync must not re-enable capture',
    );

    client.saveConfig({ ...client.loadConfig(), token: 'jwt_authenticated' });
    await client.synchronizeAnalyticsPreferenceBeforeLogout(
      async () => ({ shareUsageAnalytics: true }),
      { timeoutMs: 20 },
    );
    assert.deepEqual(client.loadConfig(), { token: 'jwt_authenticated' });
  });
});

test('known-invalid OAuth cleanup fails closed without recursively requesting preference', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({ token: 'dead_jwt', refreshToken: 'dead_rt' });
    let requestCalls = 0;

    await client.removeCredentials({
      scope: 'oauth',
      preferenceUnavailable: true,
      request: async () => {
        requestCalls += 1;
        throw new Error('must not request with known-invalid credentials');
      },
    });

    assert.equal(requestCalls, 0);
    assert.deepEqual(client.loadConfig(), { mcpAnalyticsOptOut: true });
  });
});

test('logout sync preserves the authoritative analytics opt-out before credentials clear', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({ token: 'jwt', refreshToken: 'rt' });
    const request = async () => ({ success: true, shareUsageAnalytics: false });

    await client.synchronizeAnalyticsPreferenceBeforeLogout(request);
    client.clearConfig();

    assert.deepEqual(client.loadConfig(), { mcpAnalyticsOptOut: true });
  });
});

test('logout sync fails closed when the authoritative preference is unavailable', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    client.saveConfig({ token: 'jwt', refreshToken: 'rt' });

    await client.synchronizeAnalyticsPreferenceBeforeLogout(async () => {
      throw new Error('network unavailable');
    });
    client.clearConfig();

    assert.deepEqual(client.loadConfig(), { mcpAnalyticsOptOut: true });
  });
});

test('logout sync never blocks malformed or unreadable config cleanup', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'config.json');
    for (const raw of ['{invalid', 'null']) {
      fs.writeFileSync(configFile, raw);
      await assert.doesNotReject(client.synchronizeAnalyticsPreferenceBeforeLogout);
      assert.doesNotThrow(() => client.clearConfig());
      assert.equal(fs.existsSync(configFile), false);
    }
  });
});

test('logout clearing removes malformed or non-object config', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  await withEnv({ TRACKLY_CONFIG_DIR: configDir }, async () => {
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'config.json');
    for (const raw of ['{invalid', 'null']) {
      fs.writeFileSync(configFile, raw);
      assert.doesNotThrow(() => client.clearConfig());
      assert.equal(fs.existsSync(configFile), false);
    }
  });
});

test('refreshAccessToken preserves config on network error (transient)', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  // Point at a closed port so connect() fails synchronously with ECONNREFUSED.
  // No t.after() server.close — we never actually listen.
  const deadPort = await (async () => {
    const probe = http.createServer(() => {});
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  })();

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${deadPort}`,
    TRACKLY_HTTP_TIMEOUT_MS: '500',
  }, async () => {
    client.saveConfig({ token: 'jwt_keep', refreshToken: 'rt_keep' });

    const out = await client.refreshAccessToken();
    assert.equal(out, null, 'refresh should return null on network error');
    assert.equal(
      client.getRefreshToken(),
      'rt_keep',
      'transient network error must NOT clear the refresh token (ECONNREFUSED, DNS, etc.)'
    );
    assert.equal(client.getToken(), 'jwt_keep', 'access token must also stay on disk');
  });
});

test('refreshAccessToken updates config on successful token issuance', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, token: 'jwt_new', refreshToken: 'rt_new' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({ token: 'jwt_old', refreshToken: 'rt_old' });

    const out = await client.refreshAccessToken();
    assert.equal(out, 'jwt_new');
    assert.equal(client.getToken(), 'jwt_new');
    assert.equal(client.getRefreshToken(), 'rt_new', 'rotated refresh token must be persisted');
  });
});

test('apiRequest times out stalled requests', async (t) => {
  const configDir = createTempConfigDir();
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));

  const server = http.createServer(() => {
    // Intentionally never respond so the client timeout fires.
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const port = server.address().port;

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '50',
  }, async () => {
    await assert.rejects(
      client.apiRequest('GET', '/slow'),
      /Trackly request timed out after 50ms/
    );
  });
});

// ─── single-flight refresh (PR 0.4.0) ────────────────────────────────────────
// Concurrent 401s in the long-lived MCP server must coalesce into ONE backend
// refresh. Without the single-flight latch, two parallel POSTs race; the backend
// rotates the refresh token, so the second uses a stale token, 4xx, clearOAuthTokens,
// and the user is silently logged out mid-session.
test('refreshAccessToken single-flights concurrent calls into one backend POST', async (t) => {
  let refreshCount = 0;
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    if (req.url === '/api/auth/refresh') {
      refreshCount++;
      // Delay so both Promise.all callers enter refreshAccessToken before the
      // first _doRefresh resolves — the latch must hand the second the same promise.
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, token: 'jwt_new', refreshToken: 'rt_new' }));
      }, 50);
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '2000',
  }, async () => {
    client.saveConfig({ token: 'jwt_old', refreshToken: 'rt_old' });
    const [a, b] = await Promise.all([client.refreshAccessToken(), client.refreshAccessToken()]);
    assert.equal(a, 'jwt_new');
    assert.equal(b, 'jwt_new', 'both concurrent callers get the same rotated token');
    assert.equal(refreshCount, 1, 'concurrent refreshes must coalesce into ONE backend POST');
  });
});

test('apiRequest rejects 3xx redirects with a clear message', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 302;
    res.setHeader('Location', '/somewhere-else');
    res.end();
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    // apiRequest rejects with a plain object (same shape as the >=400 path), so
    // inspect fields directly rather than assert.rejects(RegExp), which only
    // matches Error instances.
    let caught;
    try {
      await client.apiRequest('GET', '/api/jobscout/jobs');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'must reject on a 3xx redirect');
    assert.equal(caught.status, 302, 'status preserved');
    assert.match(caught.message, /Unexpected redirect \(HTTP 302\)/);
  });
});

test('apiRequest accepts planned_maintenance only as a compatibility alias', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '900');
    res.end(JSON.stringify({
      success: false,
      code: 'planned_maintenance',
      error: 'Trackly is upgrading',
      message: 'We will be back shortly.',
      estimatedReturn: 'Sunday 4:00 AM PT',
      retryAfterSeconds: 900,
    }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    let caught;
    try {
      await client.apiRequest('GET', '/api/jobscout/jobs');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'must reject on planned maintenance');
    assert.equal(caught.status, 503);
    assert.equal(caught.code, 'maintenance_mode');
    assert.equal(caught.sourceCode, 'planned_maintenance');
    assert.equal(caught.maintenance.title, 'Trackly is upgrading');
    assert.equal(caught.maintenance.message, 'We will be back shortly.');
    assert.equal(caught.maintenance.estimatedReturnPt, 'Sunday 4:00 AM PT');
    assert.equal(caught.maintenance.retryAfterSeconds, 900);
    assert.equal(caught.error, caught.message);
    assert.match(caught.message, /Trackly is upgrading/);
    assert.match(caught.message, /We will be back shortly\./);
    assert.match(caught.message, /Sunday 4:00 AM PT/);
    assert.match(caught.message, /Retry in about 15 minutes/);
  });
});

test('apiRequest parses HTTP-date Retry-After on planned maintenance', async (t) => {
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-06-21T10:00:00Z');
  t.after(() => { Date.now = originalNow; });

  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', 'Sun, 21 Jun 2026 10:15:00 GMT');
    res.end(JSON.stringify({
      code: 'planned_maintenance',
      message: 'We will be back shortly.',
    }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    let caught;
    try {
      await client.apiRequest('GET', '/api/jobscout/jobs');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'must reject on planned maintenance');
    assert.equal(caught.maintenance.retryAfterSeconds, 900);
    assert.match(caught.message, /Retry in about 15 minutes\./);
  });
});

test('apiRequest hides the planned maintenance sentinel code from user-facing title', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'planned_maintenance',
      message: 'We will be back shortly.',
    }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    let caught;
    try {
      await client.apiRequest('GET', '/api/jobscout/jobs');
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'must reject on planned maintenance');
    assert.equal(caught.maintenance.title, 'Trackly is upgrading');
    assert.match(caught.message, /Trackly is upgrading/);
    assert.match(caught.message, /We will be back shortly\./);
    assert.doesNotMatch(caught.message, /planned_maintenance/);
  });
});

test('apiRequest handles null JSON 503 bodies without crashing', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end('null');
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    let caught;
    try {
      await client.apiRequest('GET', '/api/jobscout/jobs');
    } catch (e) {
      caught = e;
    }
    assert.deepEqual(caught, { status: 503 });
  });
});

test('apiRequest propagates planned maintenance from token refresh without clearing credentials', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    if (req.url === '/api/auth/refresh') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Retry-After', '900');
      res.end(JSON.stringify({
        code: 'planned_maintenance',
        error: 'Trackly is upgrading',
        message: 'We will be back shortly.',
      }));
      return;
    }

    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Expired token' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({ token: 'jwt_expired', refreshToken: 'rt_keep' });

    let caught;
    try {
      await client.apiRequest('GET', '/api/jobscout/jobs');
    } catch (e) {
      caught = e;
    }

    assert.equal(caught?.code, 'maintenance_mode');
    assert.equal(caught?.sourceCode, 'planned_maintenance');
    assert.match(caught.message, /We will be back shortly\./);
    assert.equal(client.getToken(), 'jwt_expired');
    assert.equal(client.getRefreshToken(), 'rt_keep');
  });
});

test('apiRequest preserves the exact canonical backend maintenance body and headers', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '600');
    res.setHeader('X-Trackly-Maintenance', 'maintenance_mode');
    res.setHeader('X-Request-Id', 'req-rest-503');
    res.end(JSON.stringify({
      success: false,
      status: 'maintenance',
      error: 'Trackly is temporarily unavailable',
      message: 'A production migration is in progress.',
      code: 'maintenance_mode',
      estimatedReturn: '2026-07-14T09:30:00-07:00',
      retryAfterSeconds: 600,
      retry_after_seconds: 600,
    }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    const caught = await client.apiRequest('GET', '/api/jobscout/jobs').catch((error) => error);
    assert.equal(caught.status, 503);
    assert.equal(caught.httpStatus, 503);
    assert.equal(caught.serviceStatus, 'maintenance');
    assert.equal(caught.code, 'maintenance_mode');
    assert.equal(caught.sourceCode, 'maintenance_mode');
    assert.equal(caught.estimatedReturn, '2026-07-14T09:30:00-07:00');
    assert.equal(caught.retryAfterSeconds, 600);
    assert.equal(caught.requestId, 'req-rest-503');
    assert.equal(caught.retryable, false);
    assert.match(caught.message, /Expected back around/);
    assert.match(caught.message, /Retry in about 10 minutes/);
    assert.match(caught.guidance, /resume the existing agent_browser run/);
    assert.match(caught.guidance, /Never create a duplicate run or click Submit/);
  });
});

test('shared normalizer preserves hosted MCP JSON-RPC -32002 maintenance context', () => {
  const hostedResponse = {
    jsonrpc: '2.0',
    id: 'rpc-7',
    error: {
      code: -32002,
      message: 'Please wait for the migration to finish.',
      data: {
        code: 'maintenance_mode',
        status: 'maintenance',
        title: 'Trackly is upgrading',
        message: 'Please wait for the migration to finish.',
        retryAfterSeconds: 420,
        retry_after_seconds: 420,
        estimatedReturn: '2026-07-14T09:45:00-07:00',
        requestId: 'req-rpc-32002',
      },
    },
  };
  assert.equal(hostedResponse.error.code, -32002);
  const normalized = client.createMaintenanceError(hostedResponse, { status: 503 });

  assert.ok(normalized);
  assert.equal(normalized.status, 503);
  assert.equal(normalized.serviceStatus, 'maintenance');
  assert.equal(normalized.code, 'maintenance_mode');
  assert.equal(normalized.retryAfterSeconds, 420);
  assert.equal(normalized.estimatedReturn, '2026-07-14T09:45:00-07:00');
  assert.equal(normalized.requestId, 'req-rpc-32002');
  assert.match(normalized.message, /Please wait for the migration to finish/);
});

test('shared normalizer preserves a legacy code nested in the maintenance envelope', () => {
  const normalized = client.createMaintenanceError({
    maintenance: {
      code: 'planned_maintenance',
      status: 'maintenance',
      message: 'A legacy maintenance envelope is active.',
    },
  }, { status: 503 });

  assert.ok(normalized);
  assert.equal(normalized.code, 'maintenance_mode');
  assert.equal(normalized.sourceCode, 'planned_maintenance');
});

test('downloadFile surfaces canonical maintenance instead of a generic file error', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', '300');
    res.setHeader('X-Request-Id', 'req-download');
    res.end(JSON.stringify({
      status: 'maintenance',
      code: 'maintenance_mode',
      message: 'Resume storage is paused.',
      estimatedReturn: '9:50 AM PT',
    }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    const caught = await client.downloadFile('/api/jobscout/application-profile/default-resume').catch((error) => error);
    assert.equal(caught.code, 'maintenance_mode');
    assert.equal(caught.status, 503);
    assert.equal(caught.requestId, 'req-download');
    assert.equal(caught.retryAfterSeconds, 300);
    assert.equal(caught.estimatedReturn, '9:50 AM PT');
    assert.match(caught.message, /Resume storage is paused/);
  });
});

test('downloadFile preserves a structured controlled-access denial', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code: 'INVITATION_REDEEMED', error: 'backend wording' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    const caught = await client.downloadFile('/api/jobscout/application-profile/default-resume').catch((error) => error);
    assert.equal(caught.code, 'INVITATION_REDEEMED');
    assert.equal(caught.status, 403);
    assert.equal(caught.retryable, false);
    assert.match(caught.message, /private invite/i);
  });
});

test('downloadFile propagates maintenance during token refresh and preserves OAuth', async (t) => {
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/refresh') {
      res.statusCode = 503;
      res.end(JSON.stringify({
        status: 'maintenance',
        code: 'maintenance_mode',
        message: 'Authentication is paused for migration.',
        retryAfterSeconds: 180,
      }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'Expired token' }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    client.saveConfig({ token: 'jwt_keep', refreshToken: 'rt_keep' });
    const caught = await client.downloadFile('/api/jobscout/application-profile/default-resume').catch((error) => error);
    assert.equal(caught.code, 'maintenance_mode');
    assert.equal(client.getToken(), 'jwt_keep');
    assert.equal(client.getRefreshToken(), 'rt_keep');
  });
});

test('downloadFile returns exact resume proof headers and PDF metadata', async (t) => {
  const pdf = Buffer.from('%PDF-1.7\ntrackly-resume-proof\n%%EOF\n');
  const sha256 = 'a'.repeat(64);
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    assert.equal(req.url, '/api/jobscout/application-profile/default-resume');
    assert.equal(req.method, 'GET');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf; charset=binary');
    res.setHeader('Content-Disposition', 'attachment; filename="Resume - Candidate.pdf"');
    res.setHeader('X-Trackly-File-Sha256', sha256);
    res.setHeader('X-Trackly-Apply-Run-Id', '166');
    res.setHeader('X-Trackly-Resume-Id', '70');
    res.end(pdf);
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_download_proof_test',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    const downloaded = await client.downloadFile(
      '/api/jobscout/application-profile/default-resume',
      'trackly-test/1.0.0',
    );

    assert.deepEqual(downloaded.buffer, pdf);
    assert.equal(downloaded.contentType, 'application/pdf');
    assert.equal(downloaded.fileName, 'Resume - Candidate.pdf');
    assert.equal(downloaded.sha256, sha256);
    assert.equal(downloaded.applyRunId, '166');
    assert.equal(downloaded.resumeId, '70');
  });
});

test('a request succeeds after maintenance clears without an internal retry loop', async (t) => {
  let requestCount = 0;
  const { configDir, port } = await setupRefreshTestHarness(t, (req, res) => {
    requestCount++;
    res.setHeader('Content-Type', 'application/json');
    if (requestCount === 1) {
      res.statusCode = 503;
      res.end(JSON.stringify({ code: 'maintenance_mode', retryAfterSeconds: 60 }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ jobs: [{ id: 7 }] }));
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: 'trk_k',
    TRACKLY_BASE_URL: `http://127.0.0.1:${port}`,
    TRACKLY_HTTP_TIMEOUT_MS: '1000',
  }, async () => {
    const first = await client.apiRequest('GET', '/api/jobscout/jobs').catch((error) => error);
    assert.equal(first.code, 'maintenance_mode');
    assert.equal(requestCount, 1, 'the client must not blindly retry maintenance');

    const recovered = await client.apiRequest('GET', '/api/jobscout/jobs');
    assert.equal(recovered.jobs[0].id, 7);
    assert.equal(requestCount, 2, 'recovery is an explicit later request, not a loop');
  });
});

test('loadConfig surfaces an unreadable config (EACCES) as a clear TracklyConfigError', async (t) => {
  const configDir = createTempConfigDir();
  const file = path.join(configDir, 'config.json');
  t.after(() => {
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  await withEnv({
    TRACKLY_CONFIG_DIR: configDir,
    TRACKLY_API_KEY: undefined,
    TRACKLY_BASE_URL: undefined,
  }, async () => {
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    fs.chmodSync(file, 0o000);
    // chmod 000 doesn't block root; detect that and assert accordingly so the
    // test is robust whether or not it runs privileged (CI runs unprivileged).
    let readable = true;
    try { fs.readFileSync(file, 'utf8'); } catch (_) { readable = false; }
    if (readable) {
      assert.deepEqual(client.loadConfig(), {}, 'privileged reader: still parses');
    } else {
      assert.throws(() => client.loadConfig(), /not readable|permissions/);
    }
  });
});
