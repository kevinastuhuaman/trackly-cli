'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const cli = require('../bin/trackly');
const pkg = require('../package.json');

const BIN_PATH = path.join(__dirname, '..', 'bin', 'trackly');

test('parseArgs supports flags before the command', () => {
  const parsed = cli.parseArgs(['--json', 'job', '1234']);

  assert.equal(parsed.command, 'job');
  assert.deepEqual(parsed._, ['1234']);
  assert.equal(parsed.json, true);
});

test('parseArgs keeps command sub-arguments intact', () => {
  const parsed = cli.parseArgs(['companies', 'search', 'fintech', '--limit', '5']);

  assert.equal(parsed.command, 'companies');
  assert.deepEqual(parsed._, ['search', 'fintech']);
  assert.equal(parsed.limit, '5');
});

test('parseArgs marks missing value flags as null', () => {
  const parsed = cli.parseArgs(['config', '--api-key']);

  assert.equal(parsed.command, 'config');
  assert.equal(parsed['api-key'], null);
});

test('documented MCP command installs bounded-shutdown signal handlers', async () => {
  const server = {};
  const cleanup = () => {};
  const starts = [];
  const installs = [];

  const result = await cli.cmdMcp({
    startOptions: { marker: 'start' },
    signalOptions: { marker: 'signals' },
    mcpServer: {
      async startMcpServer(options) {
        starts.push(options);
        return server;
      },
      installMcpSignalHandlers(value, options) {
        installs.push([value, options]);
        return cleanup;
      },
    },
  });

  assert.deepEqual(starts, [{ marker: 'start' }]);
  assert.deepEqual(installs, [[server, { marker: 'signals' }]]);
  assert.equal(result, cleanup);
});

test('parseJobId validates positive integer identifiers', () => {
  assert.equal(cli.parseJobId('123'), 123);
  assert.equal(cli.parseJobId('00123'), 123);
  assert.equal(cli.parseJobId('abc'), null);
  assert.equal(cli.parseJobId('-1'), null);
});

test('normalizeBaseUrlValue trims trailing slashes', () => {
  assert.equal(cli.normalizeBaseUrlValue('https://closeai.mba/'), 'https://closeai.mba');
});

test('limited-rollout OAuth errors explain invitations and the access page', () => {
  const error = cli.loginAccessError('invitation_invalid');

  assert.equal(error.code, 'INVITATION_INVALID');
  assert.match(error.message, /limited rollout/i);
  assert.match(error.message, /private invite/i);
  assert.match(error.message, /https:\/\/usetrackly\.app\/early-access/);
  assert.ok(cli.loginAccessError('invitation_redeemed'));
  assert.ok(cli.loginAccessError('signup_intent_expired'));
  assert.ok(cli.loginAccessError('access_batch_full'));
  assert.equal(cli.loginAccessError('access_check_unavailable').status, 503);
  assert.equal(cli.loginAccessError('access_check_unavailable').retryable, true);
  assert.match(cli.loginAccessError('access_check_unavailable').message, /try again/i);
  assert.equal(cli.loginAccessError('auth_failed'), null);
});

test('login progress keeps JSON stdout clean while remaining visible on stderr', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalTTY = process.stdout.isTTY;
  const stdoutWrites = [];
  const stderrWrites = [];
  console.log = (value) => stdoutWrites.push(value);
  console.error = (value) => stderrWrites.push(value);
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });

  try {
    cli.writeLoginProgress('human progress');
  } finally {
    console.log = originalLog;
    console.error = originalError;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY });
  }

  assert.deepEqual(stdoutWrites, []);
  assert.deepEqual(stderrWrites, ['human progress']);
});

test('non-interactive OAuth login returns structured success and keeps the fallback URL on stderr', async (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-cli-login-test-'));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const originalConfigDir = process.env.TRACKLY_CONFIG_DIR;
  const originalTTY = process.stdout.isTTY;
  const originalLog = console.log;
  const originalError = console.error;
  const stdoutWrites = [];
  const stderrWrites = [];
  process.env.TRACKLY_CONFIG_DIR = configDir;
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  console.log = (value) => stdoutWrites.push(value);
  console.error = (value) => stderrWrites.push(value);
  t.after(() => {
    if (originalConfigDir === undefined) delete process.env.TRACKLY_CONFIG_DIR;
    else process.env.TRACKLY_CONFIG_DIR = originalConfigDir;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY });
    console.log = originalLog;
    console.error = originalError;
  });

  await cli.cmdLogin({
    openUrl(loginUrl) {
      const authorizeUrl = new URL(loginUrl);
      const callbackUrl = new URL('http://127.0.0.1/callback');
      callbackUrl.port = authorizeUrl.searchParams.get('port');
      callbackUrl.searchParams.set('state', authorizeUrl.searchParams.get('state'));
      callbackUrl.searchParams.set('token', 'test-access-token');
      callbackUrl.searchParams.set('refreshToken', 'test-refresh-token');
      setImmediate(() => http.get(callbackUrl, (response) => response.resume()));
      return false;
    },
  });

  assert.equal(stdoutWrites.length, 1);
  assert.deepEqual(JSON.parse(stdoutWrites[0]), { success: true, authMethod: 'oauth' });
  assert.doesNotMatch(stdoutWrites[0], /test-access-token|test-refresh-token/);
  assert.match(stderrWrites.join('\n'), /Open this URL in your browser/);
  assert.match(stderrWrites.join('\n'), /\/auth\/google\/cli\?/);
});

test('nearestFlag suggests the closest valid flag within edit distance 2', () => {
  const allowed = new Set(['region', 'function', 'status', 'limit']);
  assert.equal(cli.nearestFlag('regoin', allowed), 'region');
  assert.equal(cli.nearestFlag('functon', allowed), 'function');
  assert.equal(cli.nearestFlag('zzzzzzzzz', allowed), null, 'no suggestion when nothing is close');
});

test('COMMAND_FLAGS keeps deprecated jobs flags so they reach the migration message', () => {
  assert.ok(cli.COMMAND_FLAGS.jobs.includes('location'));
  assert.ok(cli.COMMAND_FLAGS.jobs.includes('modality'));
  assert.ok(cli.COMMAND_FLAGS.jobs.includes('region'));
  assert.ok(cli.COMMAND_FLAGS.jobs.includes('work-arrangement'));
  assert.deepEqual(cli.COMMAND_FLAGS.job, [], 'job detail accepts no filter flags');
});

test('parseExperienceLimits accepts the canonical role=years contract and clear', () => {
  assert.deepEqual(
    cli.parseExperienceLimits(['product=2', 'strategy=5']),
    { product: 2, strategy: 5 },
  );
  assert.deepEqual(cli.parseExperienceLimits(['clear']), {});
});

test('parseExperienceLimits rejects ambiguous, invalid, and out-of-range values', () => {
  assert.throws(() => cli.parseExperienceLimits([]), /at least one role limit or `clear`/i);
  assert.throws(() => cli.parseExperienceLimits(['clear', 'product=2']), /cannot be combined/i);
  assert.throws(() => cli.parseExperienceLimits(['product']), /role=years/i);
  assert.throws(() => cli.parseExperienceLimits(['unknown=2']), /unknown job function/i);
  assert.throws(() => cli.parseExperienceLimits(['product=2.5']), /integer from 0 to 60/i);
  assert.throws(() => cli.parseExperienceLimits(['product=61']), /integer from 0 to 60/i);
  assert.throws(() => cli.parseExperienceLimits(['product=2', 'product=3']), /duplicate limit/i);
});

test('trackly --version prints the package version', () => {
  const result = spawnSync(process.execPath, [BIN_PATH, '--version'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('agent diagnose-path reports the exact measured path as JSON', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-cli-diagnose-'));
  try {
    const result = spawnSync(process.execPath, [BIN_PATH, 'agent', 'diagnose-path', directory, '--errno', 'ENOSPC', '--json'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.exactPath, path.resolve(directory));
    assert.equal(report.originalErrno, 'ENOSPC');
    assert.equal(report.writableProbe.ok, true);
    assert.ok(report.filesystem.freeBytes >= 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('agent diagnose-path rejects a bare --errno flag', () => {
  const result = spawnSync(process.execPath, [BIN_PATH, 'agent', 'diagnose-path', os.tmpdir(), '--errno', '--json'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing value for --errno/);
});

test('human maintenance output retains code, statuses, request ID, and resume guidance', () => {
  const rendered = cli.formatMaintenanceForHuman({
    message: 'Trackly is migrating. Retry in about 5 minutes.',
    code: 'maintenance_mode',
    status: 503,
    serviceStatus: 'maintenance',
    requestId: 'req-human-cli',
    guidance: 'Wait, refetch state, and resume the existing run without clicking Submit.',
  });

  assert.match(rendered, /Trackly is migrating/);
  assert.match(rendered, /Code: maintenance_mode/);
  assert.match(rendered, /HTTP status: 503/);
  assert.match(rendered, /service status: maintenance/);
  assert.match(rendered, /Request ID: req-human-cli/);
  assert.match(rendered, /resume the existing run without clicking Submit/);

  const source = fs.readFileSync(BIN_PATH, 'utf8');
  assert.match(source, /report\.resume\?\.maintenance/);
  assert.match(source, /formatMaintenanceForHuman\(report\.resume\.maintenance\)/);
  assert.match(source, /formatMaintenanceForHuman\(report\.apiError\)/);
});
