'use strict';

/**
 * MCP schema regression tests.
 *
 * Codex audit (2026-04-19) found that sort drift between backend handler,
 * MCP Zod schema, and CLI help text was possible because no test asserted
 * the enum values. This suite locks the enum surface so future changes
 * either update the tests deliberately or fail CI.
 *
 * Source-of-truth citations (Codex can verify these against close-ai repo):
 *   - sort:       close-ai/src/routes/jobscout.ts:3053  (newest | match)
 *   - status:     public canonical pipeline states (the retired applying state is excluded)
 *   - function:   close-ai/src/routes/jobscout-filter-utils.ts:17-21  (14 values incl. partnerships)
 *   - modality:   close-ai/src/routes/jobscout.ts:2870-2875  (full_time | internship | all)
 *   - arrangement: close-ai/src/routes/jobscout-filter-utils.ts (remote | hybrid | in_person | unspecified)
 *   - regions:    close-ai/src/services/region-classifier.ts:8  (10 values)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createServer } = require('../mcp/server');

const SERVER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'server.js'),
  'utf8'
);
const APPLY_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'apply-tools.js'),
  'utf8'
);
const AGENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent.js'), 'utf8');

// Tiny extractor: pull the enum values as JSON-ish literals.
// We don't import the file because Zod wants a connected server; we parse the
// source directly. These regressions are *textual* — if the enum string in
// the source changes, the test fails. That's the point.
function extractArrayLiteral(source, varName) {
  const m = source.match(new RegExp(`const\\s+${varName}\\s*=\\s*\\[([^\\]]+)\\]`));
  if (!m) throw new Error(`Could not find const ${varName} = [...] in mcp/server.js`);
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

test('MCP JOB_FUNCTIONS has 14 canonical values including partnerships', () => {
  const fns = extractArrayLiteral(SERVER_SRC, 'JOB_FUNCTIONS');
  assert.equal(fns.length, 14, `expected 14 functions, got ${fns.length}: ${fns.join(', ')}`);
  assert.ok(fns.includes('partnerships'), 'partnerships must be present (was missing before PR #14)');
  for (const v of ['product', 'engineering', 'design', 'data', 'marketing', 'sales', 'partnerships', 'finance', 'strategy', 'operations', 'people', 'legal', 'support', 'other']) {
    assert.ok(fns.includes(v), `missing canonical function value: ${v}`);
  }
});

test('MCP server delegates the focused Apply surface below 1,000 lines', () => {
  assert.ok(SERVER_SRC.split('\n').length < 1000);
  assert.match(SERVER_SRC, /registerApplyTools\(server,/);
  assert.match(APPLY_SRC, /function registerApplyTools\(/);
});

test('local MCP preference tools use the authoritative V2 and revision contracts', () => {
  const getRegion = SERVER_SRC.slice(
    SERVER_SRC.indexOf("'trackly_get_preferences'"),
    SERVER_SRC.indexOf("'trackly_update_experience_limits'"),
  );
  const updateRegion = SERVER_SRC.slice(
    SERVER_SRC.indexOf("'trackly_update_experience_limits'"),
    SERVER_SRC.indexOf("'trackly_update_status'"),
  );

  assert.match(getRegion, /apiRequest\(\s*['"]GET['"]\s*,\s*['"]\/api\/jobscout\/me['"]/);
  assert.match(
    updateRegion,
    /experienceLimitsByJobFunction:\s*z\.record\(z\.enum\(JOB_FUNCTIONS\),\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(60\)\)/,
  );
  assert.match(
    updateRegion,
    /expectedPreferenceRevision:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(Number\.MAX_SAFE_INTEGER\)/,
  );
  assert.match(getRegion, /projectPreferenceResponse/);
  assert.match(updateRegion, /experienceFilterV2Available !== true/);
  assert.match(updateRegion, /apiRequest\(\s*['"]GET['"]\s*,\s*['"]\/api\/jobscout\/me['"]/);
  assert.ok(
    updateRegion.indexOf("apiRequest('GET', '/api/jobscout/me'")
      < updateRegion.indexOf("apiRequest('PUT', '/api/jobscout/preferences'"),
    'MCP update must check capability before PUT',
  );
  assert.match(updateRegion, /apiRequest\(\s*['"]PUT['"]\s*,\s*['"]\/api\/jobscout\/preferences['"]/);
  assert.match(updateRegion, /experienceFilterVersion:\s*2/);
  assert.match(updateRegion, /expectedPreferenceRevision/);
  assert.match(updateRegion, /Jobs with no stated minimum remain visible/i);
  assert.match(updateRegion, /never retry blindly/i);
  assert.match(SERVER_SRC, /error\?\.status === 409 && error\?\.error === ['"]preference_revision_conflict['"]/);
  assert.match(SERVER_SRC, /payload\.preferences = error\.preferences/);
  assert.match(SERVER_SRC, /payload\.discoveryPreferenceRevision = error\.discoveryPreferenceRevision/);
});

test('local MCP projects preference reads and refuses unavailable V2 updates before PUT', async (t) => {
  const requests = [];
  let capabilityAvailable = false;
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'PUT') {
        res.end(JSON.stringify({
          success: true,
          preferences: {
            experienceLimitsByJobFunction: { product: 2 },
            discoveryPreferenceRevision: 4,
          },
          discoveryPreferenceRevision: 4,
        }));
        return;
      }
      res.end(JSON.stringify({
        success: true,
        user: {
          email: 'must-not-leak@example.com',
          experienceFilterV2Available: capabilityAvailable,
          preferences: {
            experienceLimitsByJobFunction: {},
            discoveryPreferenceRevision: 3,
          },
        },
      }));
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());

  const originalApiKey = process.env.TRACKLY_API_KEY;
  const originalBaseUrl = process.env.TRACKLY_BASE_URL;
  process.env.TRACKLY_API_KEY = 'trk_test_preference_capability';
  process.env.TRACKLY_BASE_URL = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.TRACKLY_BASE_URL;
    else process.env.TRACKLY_BASE_URL = originalBaseUrl;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'preference-capability-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  const tools = await client.listTools();
  const updateTool = tools.tools.find((tool) => tool.name === 'trackly_update_experience_limits');
  assert.equal(
    updateTool.inputSchema.properties.expectedPreferenceRevision.maximum,
    Number.MAX_SAFE_INTEGER,
  );

  const readResult = await client.callTool({ name: 'trackly_get_preferences', arguments: {} });
  assert.deepEqual(JSON.parse(readResult.content[0].text), {
    success: true,
    experienceFilterV2Available: false,
    preferences: {
      experienceLimitsByJobFunction: {},
      discoveryPreferenceRevision: 3,
    },
  });

  const updateResult = await client.callTool({
    name: 'trackly_update_experience_limits',
    arguments: {
      experienceLimitsByJobFunction: { product: 2 },
      expectedPreferenceRevision: 3,
    },
  });
  assert.equal(updateResult.isError, true);
  assert.match(updateResult.content[0].text, /not available/i);
  assert.equal(
    JSON.parse(updateResult.content[0].text).code,
    'experience_filter_v2_unavailable',
  );
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: '/api/jobscout/me' },
    { method: 'GET', url: '/api/jobscout/me' },
  ], 'MCP capability denial must not send a PUT');

  capabilityAvailable = true;
  const conflictResult = await client.callTool({
    name: 'trackly_update_experience_limits',
    arguments: {
      experienceLimitsByJobFunction: { product: 2 },
      expectedPreferenceRevision: 2,
    },
  });
  assert.equal(conflictResult.isError, true);
  const conflict = JSON.parse(conflictResult.content[0].text);
  assert.equal(conflict.discoveryPreferenceRevision, 3);
  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET', 'GET']);

  const successResult = await client.callTool({
    name: 'trackly_update_experience_limits',
    arguments: {
      experienceLimitsByJobFunction: { product: 2 },
      expectedPreferenceRevision: 3,
    },
  });
  assert.deepEqual(JSON.parse(successResult.content[0].text), {
    success: true,
    experienceFilterV2Available: true,
    preferences: {
      experienceLimitsByJobFunction: { product: 2 },
      discoveryPreferenceRevision: 4,
    },
  });
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: '/api/jobscout/me' },
    { method: 'GET', url: '/api/jobscout/me' },
    { method: 'GET', url: '/api/jobscout/me' },
    { method: 'GET', url: '/api/jobscout/me' },
    { method: 'PUT', url: '/api/jobscout/preferences' },
  ]);
  assert.deepEqual(JSON.parse(requests[4].body), {
    experienceLimitsByJobFunction: { product: 2 },
    experienceFilterVersion: 2,
    expectedPreferenceRevision: 3,
  });
});

test('truth certification publishes concrete inputs and enforces both resume branches', async (t) => {
  const requests = [];
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: JSON.parse(body),
        idempotencyKey: req.headers['idempotency-key'],
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());

  const originalApiKey = process.env.TRACKLY_API_KEY;
  const originalBaseUrl = process.env.TRACKLY_BASE_URL;
  process.env.TRACKLY_API_KEY = 'trk_test_truth_schema';
  process.env.TRACKLY_BASE_URL = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.TRACKLY_BASE_URL;
    else process.env.TRACKLY_BASE_URL = originalBaseUrl;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'truth-schema-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  const { tools } = await client.listTools();
  const truthTool = tools.find((tool) => tool.name === 'trackly_certify_apply_batch_truth');
  assert.equal(truthTool.inputSchema.type, 'object');
  assert.deepEqual(
    Object.keys(truthTool.inputSchema.properties).sort(),
    [
      'answerSnapshotHash',
      'batchId',
      'expiresAt',
      'idempotencyKey',
      'leaseToken',
      'memberRuns',
      'membershipHash',
      'profileRevision',
      'resumeDependency',
      'resumeId',
      'resumeSha256',
      'wordingFingerprint',
    ],
  );
  assert.deepEqual(truthTool.inputSchema.properties.resumeDependency.enum, [
    'approved',
    'not_applicable',
  ]);

  const common = {
    batchId: 44,
    leaseToken: 'lease-token',
    membershipHash: 'a'.repeat(64),
    profileRevision: 9,
    memberRuns: [{
      memberId: 91,
      runId: 701,
      memberVersion: 2,
      inspectionEpoch: 1,
    }],
    answerSnapshotHash: 'b'.repeat(64),
    wordingFingerprint: 'c'.repeat(64),
    expiresAt: '2026-07-25T20:00:00.000Z',
    idempotencyKey: 'truth-certification-0001',
  };
  const approved = await client.callTool({
    name: 'trackly_certify_apply_batch_truth',
    arguments: {
      ...common,
      resumeDependency: 'approved',
      resumeId: 17,
      resumeSha256: 'd'.repeat(64),
    },
  });
  assert.equal(approved.isError, undefined);

  const notApplicable = await client.callTool({
    name: 'trackly_certify_apply_batch_truth',
    arguments: {
      ...common,
      idempotencyKey: 'truth-certification-0002',
      resumeDependency: 'not_applicable',
    },
  });
  assert.equal(notApplicable.isError, undefined);

  for (const arguments_ of [
    {
      ...common,
      idempotencyKey: 'truth-certification-0003',
      resumeDependency: 'approved',
      resumeId: null,
      resumeSha256: null,
    },
    {
      ...common,
      idempotencyKey: 'truth-certification-0004',
      resumeDependency: 'not_applicable',
      resumeId: 17,
      resumeSha256: 'd'.repeat(64),
    },
  ]) {
    const invalid = await client.callTool({
      name: 'trackly_certify_apply_batch_truth',
      arguments: arguments_,
    });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /resume(Id|Sha256)|invalid/i);
  }

  assert.equal(requests.length, 2, 'invalid mixed resume inputs must not reach the backend');
  assert.deepEqual(requests.map(({ idempotencyKey }) => idempotencyKey), [
    'truth-certification-0001',
    'truth-certification-0002',
  ]);
  assert.deepEqual(requests.map(({ body }) => body.resumeDependency), [
    'approved',
    'not_applicable',
  ]);
});

test('MCP JOB_MODALITIES matches backend is_internship column semantics', () => {
  const mods = extractArrayLiteral(SERVER_SRC, 'JOB_MODALITIES');
  assert.deepEqual(mods, ['full_time', 'internship', 'all']);
  // Guard against resurrection of the old broken values:
  assert.ok(!mods.includes('remote'), 'jobModality must NOT include remote — remote is a work-location filter, not employment type');
  assert.ok(!mods.includes('hybrid'), 'hybrid is not a supported jobModality value');
  assert.ok(!mods.includes('onsite'), 'onsite is not a supported jobModality value');
});

test('MCP WORK_ARRANGEMENTS matches the backend filter contract', () => {
  const arrangements = extractArrayLiteral(SERVER_SRC, 'WORK_ARRANGEMENTS');
  assert.deepEqual(arrangements, ['remote', 'hybrid', 'in_person', 'unspecified']);

  const searchJobsRegion = SERVER_SRC.slice(
    SERVER_SRC.indexOf("'trackly_search_jobs'"),
    SERVER_SRC.indexOf("'trackly_get_job'"),
  );
  assert.match(
    searchJobsRegion,
    /workArrangements:\s*z\.array\(z\.enum\(WORK_ARRANGEMENTS\)\)/,
    'trackly_search_jobs must expose a typed workArrangements array',
  );
  assert.match(
    searchJobsRegion,
    /qs\.set\(['"]workArrangements['"],\s*params\.workArrangements\.join\(['"],['"]\)\)/,
    'trackly_search_jobs must serialize workArrangements for the backend',
  );
});

test('MCP STATUS_VALUES exposes only canonical public pipeline states', () => {
  const statuses = extractArrayLiteral(SERVER_SRC, 'STATUS_VALUES');
  assert.deepEqual(
    statuses,
    ['new', 'applied_confirmed', 'check_later', 'not_interested', 'all']
  );
  // Guard against the pre-PR-14 values that the backend 400s on:
  for (const bad of ['saved', 'applied', 'dismissed']) {
    assert.ok(!statuses.includes(bad), `status must NOT include legacy value: ${bad}`);
  }
});

test('MCP REGION_TAGS has 10 values and REGION_TAGS_ARRAY_SAFE excludes us', () => {
  const tags = extractArrayLiteral(SERVER_SRC, 'REGION_TAGS');
  assert.equal(tags.length, 10);
  for (const v of ['us', 'europe', 'latam', 'middle_east', 'asia', 'africa', 'canada', 'oceania', 'remote', 'unknown']) {
    assert.ok(tags.includes(v), `REGION_TAGS missing ${v}`);
  }
  // REGION_TAGS_ARRAY_SAFE is derived via .filter — verify the derivation exists
  // and the source comment explains why.
  assert.ok(
    SERVER_SRC.includes("REGION_TAGS.filter((t) => t !== 'us')"),
    'REGION_TAGS_ARRAY_SAFE must be REGION_TAGS.filter((t) => t !== "us") to prevent ["us","europe"] silent drop'
  );
});

test('MCP SORT_VALUES is [newest, match] — NOT the deprecated [newest, oldest, company]', () => {
  // SORT_VALUES is a named constant (centralized per CodeRabbit review on PR #17).
  const values = extractArrayLiteral(SERVER_SRC, 'SORT_VALUES');
  assert.deepEqual(values, ['newest', 'match'], `expected [newest, match], got [${values.join(', ')}]`);
  // Guard: the backend REJECTS these values with HTTP 400.
  for (const bad of ['oldest', 'company']) {
    assert.ok(!values.includes(bad), `sort must NOT include ${bad} — backend jobscout.ts:3053 rejects it`);
  }
  // Also verify the schema actually uses the centralized constant, not an inline literal
  // (guards against future "just add one value inline" drift).
  assert.ok(
    SERVER_SRC.includes('z.enum(SORT_VALUES)'),
    'sort param must use z.enum(SORT_VALUES), not an inline array literal',
  );
});

test('CLI --sort help text is [newest, match] in bin/trackly', () => {
  const binSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'trackly'), 'utf8');
  // The help line should NOT mention oldest or company; SHOULD mention newest and match.
  const sortLine = binSrc.split('\n').find((l) => l.includes('--sort '));
  assert.ok(sortLine, '--sort help line not found in bin/trackly');
  assert.ok(sortLine.includes('newest'), `--sort help must mention newest: ${sortLine}`);
  assert.ok(sortLine.includes('match'), `--sort help must mention match: ${sortLine}`);
  assert.ok(!sortLine.match(/\boldest\b/), `--sort help must NOT mention oldest: ${sortLine}`);
  assert.ok(!sortLine.match(/\bcompany\b/), `--sort help must NOT mention company as a sort value: ${sortLine}`);
});

test('CLI help exposes no retired Applying pipeline state', () => {
  const binSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'trackly'), 'utf8');
  assert.doesNotMatch(binSrc, /--status[^\n]*\bapplying\b/i);
  assert.match(binSrc, /--status[^\n]*new, applied_confirmed, check_later, not_interested, all/i);
});

test('local MCP exposes a pre-attach resume integrity verifier', () => {
  const verifyRegion = APPLY_SRC.slice(
    APPLY_SRC.indexOf("'trackly_verify_prepared_resume'"),
    APPLY_SRC.indexOf("server.registerPrompt('trackly-apply'"),
  );
  assert.match(verifyRegion, /runId:\s*z\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(verifyRegion, /confirmationId:\s*z\.string\(\)\.min\(1\)/);
  assert.match(verifyRegion, /exactLocalPath:\s*z\.string\(\)\.min\(1\)/);
  assert.match(verifyRegion, /sha256:\s*z\.string\(\)\.regex/);
  assert.match(verifyRegion, /sizeBytes:\s*z\.number\(\)\.int\(\)\.min\(1\)/);
  assert.match(verifyRegion, /expiresAt:\s*z\.string\(\)\.datetime\(\)/);
  assert.match(verifyRegion, /verifyPreparedResume\(proof\)/);
});

test('local MCP requires committed-state evidence on every apply observation', () => {
  const observationRegion = APPLY_SRC.slice(
    APPLY_SRC.indexOf("'trackly_report_apply_observation'"),
    APPLY_SRC.indexOf("'trackly_record_application_outcome'"),
  );
  assert.match(observationRegion, /committed:\s*z\.boolean\(\)/);
  assert.doesNotMatch(observationRegion, /committed:\s*z\.boolean\(\)\.optional\(\)/);
});

test('local MCP prompt includes the complete run-bound resume proof gate', () => {
  const promptRegion = APPLY_SRC.slice(
    APPLY_SRC.indexOf("server.registerPrompt('trackly-apply'"),
    APPLY_SRC.indexOf("server.registerResource('trackly-apply-protocol'"),
  );
  assert.match(promptRegion, /major\(run\.protocolVersion\) === major\(protocol\.version\)/);
  assert.match(promptRegion, /protocol\.compatibleSkillMajor === 4/);
  assert.match(promptRegion, /semantically identified Resume or CV attachment control/);
  assert.match(promptRegion, /Only when that specific control exists, prepare the run-bound resume locally/);
  assert.match(promptRegion, /cover-letter, portfolio, transcript, and other supporting-document controls separately/);
  assert.match(promptRegion, /never upload a resume to them/);
  assert.match(promptRegion, /exact path, filename, size, SHA-256, run, and expiration/);
  assert.match(promptRegion, /obtain my explicit confirmation/);
  assert.match(promptRegion, /Immediately before attaching the resume, use the local verifier/);
  assert.match(promptRegion, /lock the file read-only/);
  assert.match(promptRegion, /stop on every non-null executionBlocker/);
  assert.match(promptRegion, /every manual_only item/);
  assert.match(promptRegion, /provider, atsCapability, required scenarios, and originPolicy/);
  assert.match(promptRegion, /host === allowedDomain or host\.endsWith/);
  assert.match(promptRegion, /trackly_employer_source_exact_origin/);
  assert.match(promptRegion, /never promote it to a host suffix/);
  assert.match(promptRegion, /When job_identity_match is required/);
  assert.match(promptRegion, /never include the company, role, URL, requisition identifier, page text, or any profile value/);
  assert.match(promptRegion, /after every navigation or redirect and before entering any additional private data/);
  assert.match(promptRegion, /require both originPolicy\.tenantRule and originPolicy\.verifiedAtsTenant to be non-null/);
  assert.match(promptRegion, /backend-owned originPolicy\.tenantRule/);
  assert.match(promptRegion, /originPolicy\.verifiedAtsTenant/);
  assert.match(promptRegion, /never invent or reinterpret a strategy token/);
  assert.match(promptRegion, /same-run passed or corrected scenario_coverage observation/);
  assert.match(promptRegion, /scenario_coverage observation with committed=true/);
  assert.match(promptRegion, /browser_reclaim, which is satisfied only by browser_ready/);
  assert.match(promptRegion, /record blocked rather than review_ready/);
  assert.match(promptRegion, /literal outcome=review_ready/);
  assert.match(promptRegion, /verify every recorded run returns awaiting_manual_submit/);
  assert.match(promptRegion, /literal outcome=submitted/);
});

test('resume preparation requires backend confirmation for the exact active run', () => {
  const prepareRegion = AGENT_SRC.slice(
    AGENT_SRC.indexOf('async function prepareResume'),
    AGENT_SRC.indexOf('async function doctorAgent'),
  );
  assert.match(prepareRegion, /default-resume\?runId=\$\{normalizedRunId\}/);
  assert.match(prepareRegion, /Number\(download\.applyRunId\) !== normalizedRunId/);
  assert.match(prepareRegion, /Number\(download\.resumeId\)/);
  assert.match(prepareRegion, /default resume identity/);
});

test('CLI + MCP use new /jobscout/tracker/jobs/:id/stage endpoint (not removed /jobscout-tracker/status)', () => {
  const binSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'trackly'), 'utf8');
  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf8');

  // Backend removed the old endpoint; using it = 404 silent failure on apply/save/dismiss.
  // Check for actual API calls (apiRequest('POST', ...)) in ANY quoting style — single/double
  // quotes AND template literals (bin/trackly uses backticks for the stage URL). Comments and
  // documentation that mention the removed path for historical context are OK.
  const postCallRegex = /apiRequest\(\s*['"\x60]POST['"\x60]\s*,\s*([`'"])((?:[^\\\x60]|\\.)*?)\1/g;
  function extractPostUrls(source) {
    const urls = [];
    let m;
    while ((m = postCallRegex.exec(source)) !== null) {
      urls.push(m[2]);
    }
    return urls;
  }
  const binUrls = extractPostUrls(binSrc);
  const mcpUrls = extractPostUrls(mcpSrc);
  assert.ok(binUrls.length > 0, 'bin/trackly must contain at least one apiRequest POST call for this test to be meaningful');
  assert.ok(mcpUrls.length > 0, 'mcp/server.js must contain at least one apiRequest POST call');
  for (const url of binUrls) {
    assert.ok(!url.includes('/api/jobscout-tracker/status'), `CLI has a live apiRequest POST to the removed endpoint: ${url}`);
  }
  for (const url of mcpUrls) {
    assert.ok(!url.includes('/api/jobscout-tracker/status'), `MCP has a live apiRequest POST to the removed endpoint: ${url}`);
  }
  // Positive: at least one POST in each source uses the new stage endpoint path.
  const stagePathPattern = /\/api\/jobscout\/tracker\/jobs\/[^/]+\/stage/;
  assert.ok(
    binUrls.some((u) => stagePathPattern.test(u)),
    `CLI must POST to /api/jobscout/tracker/jobs/:id/stage (urls seen: ${binUrls.join(', ')})`,
  );
  assert.ok(
    mcpUrls.some((u) => stagePathPattern.test(u)),
    `MCP must POST to /api/jobscout/tracker/jobs/:id/stage (urls seen: ${mcpUrls.join(', ')})`,
  );

  // Stage mapping — CLI and MCP both need applied→applied, saved→backlog, dismissed→discarded.
  // Use a formatting-tolerant regex (any quote style, any whitespace) so harmless reformats
  // don't break this guard.
  const stageMappingRules = [
    [/\bapplied\s*:\s*['"\x60]applied['"\x60]/, 'applied → applied'],
    [/\bsaved\s*:\s*['"\x60]backlog['"\x60]/, 'saved → backlog'],
    [/\bdismissed\s*:\s*['"\x60]discarded['"\x60]/, 'dismissed → discarded'],
  ];
  for (const [label, src] of [['bin/trackly', binSrc], ['mcp/server.js', mcpSrc]]) {
    for (const [rx, desc] of stageMappingRules) {
      assert.ok(rx.test(src), `${label} missing stage mapping ${desc} (formatting-tolerant regex)`);
    }
  }
});

test('docs/trackly-tools.md sort description matches backend', () => {
  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'trackly-tools.md'), 'utf8');
  // Find the sort line
  const sortLine = docs.split('\n').find((l) => l.includes('`sort`:'));
  assert.ok(sortLine, 'sort line not found in docs/trackly-tools.md');
  assert.ok(sortLine.includes('newest'), `sort docs must mention newest: ${sortLine}`);
  assert.ok(sortLine.includes('match'), `sort docs must mention match: ${sortLine}`);
  // Block the old valid-values pattern: `newest`, `oldest`, `company` (the literal pre-fix format).
  // Mentions in a deprecation sentence are allowed since the project deliberately calls out
  // that the backend rejects those values — the bug was advertising them as valid.
  assert.ok(
    !sortLine.match(/`newest`\s*,\s*`oldest`\s*,\s*`company`/),
    `sort docs must not list the stale valid-values triplet 'newest, oldest, company': ${sortLine}`
  );
});

test('CLI + MCP guard /ask jobsUrl with a path allowlist (PR v0.2.4)', () => {
  // Three invariants, in order of criticality:
  //   1. Both sources DEFINE JOBS_URL_ALLOWLIST with the correct anchors — including the
  //      trailing `(\?|$)` so `/api/v1/jobsFOO` can't pass as `/jobs` + suffix.
  //   2. Both sources CALL JOBS_URL_ALLOWLIST.test(...) against the jobsUrl.
  //   3. The .test() CALL must appear BEFORE the apiRequest fetch in the source file —
  //      otherwise the guard runs after the fetch and doesn't gate anything.
  //
  // The /ask endpoint returns a jobsUrl string that the CLI + MCP then fetch with the
  // user's Authorization header. normalizeEndpoint blocks cross-origin, but a compromised
  // backend could emit a same-origin `/api/admin/...` path. (Originally PR v0.2.4;
  // tightened per CodeRabbit to prevent future weakened regex from passing silently.)
  const binSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'trackly'), 'utf8');
  const mcpSrc = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf8');
  // Full regex literal with boundary anchor: /^\/api\/(v1|jobscout)\/jobs(\?|$)/
  const allowlistDefRegex = /const\s+JOBS_URL_ALLOWLIST\s*=\s*\/\^\\\/api\\\/\(v1\|jobscout\)\\\/jobs\(\\\?\|\$\)\//;

  for (const [label, src] of [['bin/trackly', binSrc], ['mcp/server.js', mcpSrc]]) {
    // (1) Definition includes the boundary anchor so a weakened regex that drops (\?|$)
    //     doesn't pass. Future refactor attempt like `/^\/api\/(v1|jobscout)\/jobs/`
    //     would fail this test.
    assert.ok(
      allowlistDefRegex.test(src),
      `${label} must define JOBS_URL_ALLOWLIST = /^\\/api\\/(v1|jobscout)\\/jobs(\\?|$)/ with the boundary anchor (drops the /jobsX bypass)`
    );
    // (2) The constant must be USED, not just DEFINED.
    const testCallIdx = src.search(/JOBS_URL_ALLOWLIST\.test\(/);
    assert.ok(
      testCallIdx !== -1,
      `${label} must CALL JOBS_URL_ALLOWLIST.test(...) — defining the regex without using it would defeat the guard`
    );
    // (3) apiRequest for the jobsUrl must come AFTER the .test() call in source order.
    //     We look for `apiRequest(...jobsUrl...)` patterns (two forms across the CLI vs MCP).
    const fetchCallIdx = Math.min(
      ...['apiRequest(\'GET\', result.jobsUrl', 'apiRequest(\'GET\', askResult.jobsUrl']
        .map((needle) => src.indexOf(needle))
        .filter((i) => i !== -1)
    );
    if (Number.isFinite(fetchCallIdx)) {
      assert.ok(
        testCallIdx < fetchCallIdx,
        `${label} must call JOBS_URL_ALLOWLIST.test(...) BEFORE apiRequest fetches the jobsUrl`
      );
    }
  }
});

test('trackly_request_company posts to /api/jobscout/companies/request with source="mcp"', () => {
  // Mirrors the close-ai PR #456 hosted MCP. The dual-server rule
  // (~/CLAUDE.md → reference_mcp_dual_server_close_ai_and_trackly_cli.md)
  // requires the npm-published MCP to call the same endpoint with the same
  // payload shape. If the body shape drifts (snake_case → camelCase, missing
  // `source`, wrong source value), backend validation 400s or coerces source
  // to NULL and the request goes unattributed.
  assert.ok(
    SERVER_SRC.includes("'trackly_request_company'"),
    'trackly_request_company tool must be registered in mcp/server.js',
  );
  // Endpoint path matches backend handler at jobscout.ts:9222.
  assert.ok(
    /apiRequest\(\s*['"]POST['"]\s*,\s*['"]\/api\/jobscout\/companies\/request['"]/.test(SERVER_SRC),
    'trackly_request_company must POST to /api/jobscout/companies/request',
  );
  // Source attribution must be the literal string 'mcp' (backend whitelist:
  // {ios, mac, web, cli, mcp}). Unknown values get coerced to NULL by the
  // backend — silent attribution loss.
  const requestRegion = SERVER_SRC.slice(SERVER_SRC.indexOf("'trackly_request_company'"));
  assert.ok(
    /source:\s*['"]mcp['"]/.test(requestRegion),
    'trackly_request_company must tag requests with source: "mcp"',
  );
  // Body uses snake_case keys (company_name, company_url, notes) to match
  // the Express handler's req.body destructure at jobscout.ts:9227.
  assert.ok(
    /company_name:\s*companyName/.test(requestRegion),
    'request body must map companyName → company_name (backend expects snake_case)',
  );
  assert.ok(
    /company_url:\s*companyUrl/.test(requestRegion),
    'request body must map companyUrl → company_url',
  );
});

test('CLI request-company command exists and tags source="cli"', () => {
  const binSrc = fs.readFileSync(path.join(__dirname, '..', 'bin', 'trackly'), 'utf8');
  // Dispatch case + handler function both present.
  assert.ok(
    /case 'request-company':/.test(binSrc),
    "switch must include case 'request-company' (CLI dispatch)",
  );
  assert.ok(
    /async function cmdRequestCompany\(/.test(binSrc),
    'cmdRequestCompany handler must be defined',
  );
  // POST to the same backend endpoint as the MCP tool.
  assert.ok(
    /apiRequest\(\s*['"]POST['"]\s*,\s*['"]\/api\/jobscout\/companies\/request['"]/.test(binSrc),
    'CLI must POST to /api/jobscout/companies/request',
  );
  // CLI tags source as 'cli' (NOT 'mcp' — the CLI shares lib/client.js with
  // the MCP, so a copy-paste regression that flipped this would unattribute
  // CLI requests entirely).
  const cmdRegion = binSrc.slice(binSrc.indexOf('async function cmdRequestCompany'));
  const cmdEndIdx = cmdRegion.indexOf('async function ', 1);
  const cmdBody = cmdEndIdx === -1 ? cmdRegion : cmdRegion.slice(0, cmdEndIdx);
  assert.ok(
    /source:\s*['"]cli['"]/.test(cmdBody),
    'cmdRequestCompany must tag requests with source: "cli"',
  );
  assert.ok(
    !/source:\s*['"]mcp['"]/.test(cmdBody),
    'CLI command must NOT use source="mcp" (that\'s for the MCP tool)',
  );
});

test('trackly_search_jobs defaults jobFunction to ALL functions when caller omits `function`', () => {
  // Regression guard for the 2026-05-20 Cahoot/Iterative Health bug:
  // When the MCP caller doesn't specify `function`, the backend's legacy
  // fallback (granola-followup-app src/routes/jobscout.ts:3478) defaults to
  // `is_pm_role = TRUE` and returns 0 for companies with no PM roles. The
  // fix sends the full JOB_FUNCTIONS list so the backend takes the
  // all-roles short-circuit at isAllJobFunctionsSelection.
  //
  // We assert TEXTUALLY because the tool handler is wrapped via
  // server.tool(...) and not directly exported. If someone reverts the
  // defaulting (e.g. back to `if (params.function !== undefined) ...`),
  // this test fails with a clear message pointing at the regression class.

  // 1. The defaulting expression must use JOB_FUNCTIONS.join(',') as the fallback.
  assert.ok(
    /qs\.set\(['"]jobFunction['"],\s*params\.function\s*!==\s*undefined\s*\?\s*params\.function\s*:\s*JOB_FUNCTIONS\.join\(['"],['"]\)\)/.test(SERVER_SRC),
    'trackly_search_jobs URL builder must default `jobFunction` to JOB_FUNCTIONS.join(",") ' +
    'when params.function is undefined. Without this, backend defaults to PM-only filter ' +
    'and returns 0 for companies with no PM roles (Cahoot, Iterative Health). ' +
    'See mcp/server.js around line 131 + comment block.',
  );

  // 2. The defaulting MUST NOT be gated by an undefined check that drops the param.
  //    Specifically, the old buggy pattern `if (params.function !== undefined) qs.set(...)`
  //    must not exist anywhere in the trackly_search_jobs handler region.
  const searchJobsRegion = SERVER_SRC.slice(
    SERVER_SRC.indexOf("'trackly_search_jobs'"),
    SERVER_SRC.indexOf("'trackly_get_job'"),
  );
  assert.ok(
    searchJobsRegion.length > 0,
    'Could not locate trackly_search_jobs handler region in mcp/server.js',
  );
  // The negative-regex must catch the buggy pattern in BOTH the no-braces and
  // braced/multi-line forms (Copilot PR #27 R0). The `\{?` + `\s*` allows for
  // optional brace + arbitrary whitespace/newlines between the `)` and `qs.set`.
  assert.ok(
    !/if\s*\(\s*params\.function\s*!==\s*undefined\s*\)\s*\{?\s*qs\.set\(['"]jobFunction['"]/.test(searchJobsRegion),
    'Buggy pattern detected: the old `if (params.function !== undefined) qs.set("jobFunction", ...)` ' +
    '(or the braced/multi-line equivalent) was reintroduced. This drops the param entirely when no ' +
    'function is specified, causing the backend PM-only fallback. Use the ternary that sends ' +
    'JOB_FUNCTIONS.join(",") on the else branch.',
  );
});

test('sensitive consent revocation fails closed on malformed profile or schema responses', async (t) => {
  const goodFields = { 'eeo.gender': { state: 'answered' } };
  const goodSchema = [{ key: 'eeo.gender', storage: 'answer', sensitivity: 'restricted' }];
  let mode = 'missing-revision';
  const requests = [];
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/jobscout/application-profile') {
        if (mode === 'missing-revision') {
          res.end(JSON.stringify({ success: true, profile: { sensitiveStorage: { consented: true }, fields: goodFields } }));
        } else if (mode === 'missing-fields') {
          res.end(JSON.stringify({ success: true, profile: { revision: 7, sensitiveStorage: { consented: true } } }));
        } else if (mode === 'array-fields') {
          res.end(JSON.stringify({ success: true, profile: { revision: 7, sensitiveStorage: { consented: true }, fields: ['eeo.gender'] } }));
        } else if (mode === 'null-field-entry') {
          res.end(JSON.stringify({ success: true, profile: { revision: 7, sensitiveStorage: { consented: true }, fields: { 'eeo.gender': null } } }));
        } else if (mode === 'stateless-field-entry') {
          res.end(JSON.stringify({ success: true, profile: { revision: 7, sensitiveStorage: { consented: true }, fields: { 'eeo.gender': {} } } }));
        } else {
          res.end(JSON.stringify({ success: true, profile: { revision: 7, sensitiveStorage: { consented: true }, fields: goodFields } }));
        }
        return;
      }
      if (req.method === 'GET' && req.url === '/api/jobscout/application-profile/schema') {
        if (mode === 'empty-schema') {
          res.end(JSON.stringify({ success: true, fields: [] }));
        } else if (mode === 'null-schema-entry') {
          res.end(JSON.stringify({ success: true, fields: [null] }));
        } else if (mode === 'partial-schema-entry') {
          res.end(JSON.stringify({ success: true, fields: [{ key: 'eeo.gender', storage: 'answer' }] }));
        } else {
          res.end(JSON.stringify({ success: true, fields: goodSchema }));
        }
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'unexpected request' }));
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());

  const originalApiKey = process.env.TRACKLY_API_KEY;
  const originalBaseUrl = process.env.TRACKLY_BASE_URL;
  process.env.TRACKLY_API_KEY = 'trk_test_failclosed_revocation';
  process.env.TRACKLY_BASE_URL = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.TRACKLY_BASE_URL;
    else process.env.TRACKLY_BASE_URL = originalBaseUrl;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'fail-closed-revocation-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  const cases = [
    { mode: 'missing-revision', code: 'invalid_profile_revision' },
    { mode: 'missing-fields', code: 'invalid_profile_response' },
    { mode: 'array-fields', code: 'invalid_profile_response' },
    { mode: 'null-field-entry', code: 'invalid_profile_response' },
    { mode: 'stateless-field-entry', code: 'invalid_profile_response' },
    { mode: 'empty-schema', code: 'invalid_profile_response' },
    { mode: 'null-schema-entry', code: 'invalid_profile_response' },
    { mode: 'partial-schema-entry', code: 'invalid_profile_response' },
  ];
  for (const testCase of cases) {
    mode = testCase.mode;
    const result = await client.callTool({
      name: 'trackly_update_application_profile',
      arguments: { expectedRevision: 7, sensitiveStorageConsent: false },
    });
    assert.equal(result.isError, true, `${testCase.mode} must be an error`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.code, testCase.code, `${testCase.mode} code`);
    assert.equal(payload.status, 502, `${testCase.mode} status`);
    assert.match(payload.error, /No changes were saved\./);
  }
  assert.equal(requests.filter(({ method }) => method === 'PATCH').length, 0, 'fail-closed paths must never PATCH');
});

test('sensitive consent revocation requires an echoed confirmation token before any PATCH', async (t) => {
  const { createHash } = require('node:crypto');
  const profileFields = {
    'eeo.gender': { state: 'answered' },
    'identity.age_18_or_older': { state: 'declined' },
    'location.residential_city': { state: 'answered' },
    'authorization.visa_type': { state: 'unknown' },
    'identity.email': { state: 'answered' },
    'identity.first_name': { state: 'answered' },
  };
  const schemaFields = [
    { key: 'eeo.gender', storage: 'answer', sensitivity: 'restricted' },
    { key: 'identity.age_18_or_older', storage: 'answer', sensitivity: 'sensitive' },
    { key: 'location.residential_city', storage: 'answer', sensitivity: 'restricted' },
    { key: 'authorization.visa_type', storage: 'answer', sensitivity: 'restricted' },
    { key: 'identity.email', storage: 'profile', sensitivity: 'sensitive' },
    { key: 'identity.first_name', storage: 'answer', sensitivity: 'standard' },
  ];
  const expectedAffectedKeys = ['eeo.gender', 'identity.age_18_or_older', 'location.residential_city'];
  const tokenFor = (revision, keys) => createHash('sha256')
    .update(`trackly:sensitive-revocation:v1:${revision}:${keys.join(',')}`, 'utf8')
    .digest('hex');

  let profileRevision = 7;
  const requests = [];
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/jobscout/application-profile') {
        res.end(JSON.stringify({
          success: true,
          profile: { revision: profileRevision, sensitiveStorage: { consented: true }, fields: profileFields },
        }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/jobscout/application-profile/schema') {
        res.end(JSON.stringify({ success: true, fields: schemaFields }));
        return;
      }
      if (req.method === 'PATCH' && req.url === '/api/jobscout/application-profile') {
        res.end(JSON.stringify({
          success: true,
          revision: profileRevision + 1,
          changedKeys: [...expectedAffectedKeys, 'profile.sensitive_storage_consent'],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unexpected request' }));
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => httpServer.close());

  const originalApiKey = process.env.TRACKLY_API_KEY;
  const originalBaseUrl = process.env.TRACKLY_BASE_URL;
  process.env.TRACKLY_API_KEY = 'trk_test_sensitive_revocation';
  process.env.TRACKLY_BASE_URL = `http://127.0.0.1:${httpServer.address().port}`;
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.TRACKLY_API_KEY;
    else process.env.TRACKLY_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.TRACKLY_BASE_URL;
    else process.env.TRACKLY_BASE_URL = originalBaseUrl;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'sensitive-revocation-test', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  const tools = await client.listTools();
  const updateTool = tools.tools.find((tool) => tool.name === 'trackly_update_application_profile');
  assert.ok(updateTool.inputSchema.properties.sensitiveRevocationConfirmToken, 'token field must be published');
  assert.equal(
    updateTool.inputSchema.properties.sensitiveRevocationConfirmToken.pattern,
    '^[a-f0-9]{64}$',
  );
  assert.match(updateTool.description, /two-step action/);

  const challengeResult = await client.callTool({
    name: 'trackly_update_application_profile',
    arguments: { expectedRevision: 7, sensitiveStorageConsent: false },
  });
  assert.equal(challengeResult.isError, true);
  const challenge = JSON.parse(challengeResult.content[0].text);
  assert.equal(challenge.code, 'sensitive_revocation_confirmation_required');
  assert.equal(challenge.status, 409);
  assert.match(challenge.error, /No changes were saved\./);
  assert.equal(challenge.confirmation.currentRevision, 7);
  assert.deepEqual(challenge.confirmation.affectedKeys, expectedAffectedKeys);
  assert.equal(challenge.confirmation.confirmationToken, tokenFor(7, expectedAffectedKeys));
  assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: '/api/jobscout/application-profile' },
    { method: 'GET', url: '/api/jobscout/application-profile/schema' },
  ], 'MCP revocation challenge must not send a PATCH');

  const confirmedResult = await client.callTool({
    name: 'trackly_update_application_profile',
    arguments: {
      expectedRevision: 7,
      sensitiveStorageConsent: false,
      sensitiveRevocationConfirmToken: challenge.confirmation.confirmationToken,
    },
  });
  assert.ok(!confirmedResult.isError, 'confirmed revocation must pass through');
  const confirmed = JSON.parse(confirmedResult.content[0].text);
  assert.deepEqual(confirmed.changedKeys, [...expectedAffectedKeys, 'profile.sensitive_storage_consent']);
  const patchRequests = requests.filter(({ method }) => method === 'PATCH');
  assert.equal(patchRequests.length, 1, 'exactly one PATCH after confirmation');
  assert.deepEqual(JSON.parse(patchRequests[0].body), {
    expectedRevision: 7,
    sensitiveStorageConsent: false,
  }, 'confirmation token must be stripped from the PATCH body');

  profileRevision = 9;
  const staleResult = await client.callTool({
    name: 'trackly_update_application_profile',
    arguments: {
      expectedRevision: 7,
      sensitiveStorageConsent: false,
      sensitiveRevocationConfirmToken: challenge.confirmation.confirmationToken,
    },
  });
  assert.equal(staleResult.isError, true);
  const stale = JSON.parse(staleResult.content[0].text);
  assert.equal(stale.confirmation.currentRevision, 9);
  assert.equal(stale.confirmation.confirmationToken, tokenFor(9, expectedAffectedKeys));
  assert.equal(requests.filter(({ method }) => method === 'PATCH').length, 1, 'stale token must not PATCH');

  const staleRevisionResult = await client.callTool({
    name: 'trackly_update_application_profile',
    arguments: {
      expectedRevision: 7,
      sensitiveStorageConsent: false,
      sensitiveRevocationConfirmToken: tokenFor(9, expectedAffectedKeys),
    },
  });
  assert.equal(staleRevisionResult.isError, true);
  const staleRevision = JSON.parse(staleRevisionResult.content[0].text);
  assert.equal(staleRevision.code, 'sensitive_revocation_confirmation_required');
  assert.match(staleRevision.confirmation.instructions, /reconcile them against the current revision/);
  assert.equal(requests.filter(({ method }) => method === 'PATCH').length, 1, 'current token with stale expectedRevision must not PATCH');

  const optInResult = await client.callTool({
    name: 'trackly_update_application_profile',
    arguments: { expectedRevision: 10, sensitiveStorageConsent: true },
  });
  assert.ok(!optInResult.isError);
  const finalPatches = requests.filter(({ method }) => method === 'PATCH');
  assert.equal(finalPatches.length, 2, 'opt-in stays single-call');
  assert.deepEqual(JSON.parse(finalPatches[1].body), {
    expectedRevision: 10,
    sensitiveStorageConsent: true,
  });
});
