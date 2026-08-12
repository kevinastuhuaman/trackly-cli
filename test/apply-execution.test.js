'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { z } = require('zod');
const { registerApplyTools } = require('../mcp/apply-tools');

const ROOT = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const contract = JSON.parse(read('contracts/trackly-apply-tools.json'));
const tools = read('mcp/apply-tools.js');
const skill = read('skills/trackly-apply/SKILL.md');
const orchestration = read('skills/trackly-apply/references/batch-orchestration.md');
const integrity = read('skills/trackly-apply/references/form-integrity.md');
const lifecycle = read('skills/trackly-apply/references/browser-lifecycle.md');
const handoff = read('skills/trackly-apply/references/review-handoff.md');
const toolDocs = read('docs/trackly-tools.md');
const contributorDocs = read('CLAUDE.md');
const agent = read('lib/agent.js');

const executionTools = [
  'trackly_start_apply_execution',
  'trackly_get_active_apply_execution',
  'trackly_get_apply_execution',
  'trackly_advance_apply_execution',
  'trackly_record_apply_execution_dispositions',
  'trackly_stop_apply_execution',
  'trackly_get_apply_execution_snapshot',
  'trackly_resume_parked_apply_member',
  'trackly_approve_apply_execution_resume',
];

function registerRuntimeTools(apiResponse = { ok: true }) {
  const registrations = new Map();
  const calls = [];
  const server = {
    tool(name, description, schema, handler) {
      registrations.set(name, { description, schema: z.object(schema), handler });
    },
    registerTool(name, definition, handler) {
      registrations.set(name, {
        description: definition.description,
        schema: definition.inputSchema,
        handler,
      });
    },
    registerPrompt() {},
    registerResource() {},
  };
  registerApplyTools(server, {
    wrapTool: (handler) => handler,
    mcpUserAgent: 'trackly-mcp/test',
    throwMcpResourceError: (error) => { throw error; },
    applyApiRequest: async (...args) => {
      calls.push(args);
      return apiResponse;
    },
  });
  return { registrations, calls };
}

test('protocol 3.4 publishes all accessible execution tools', () => {
  assert.equal(contract.contractVersion, '3.6.3');
  for (const name of executionTools) {
    assert.ok(contract.tools[name], `${name} missing from contract fixture`);
    assert.match(tools, new RegExp(`['"]${name}['"]`));
  }
  assert.match(tools, /\/api\/jobscout\/apply\/executions/);
  assert.match(tools, /\/advance/);
  assert.match(tools, /\/dispositions/);
  assert.match(tools, /\/stop/);
});

test('profile jurisdiction tools validate ISO codes and forward the accepted spelling', async () => {
  const { registrations, calls } = registerRuntimeTools();
  const getProfile = registrations.get('trackly_get_application_profile');
  const updateProfile = registrations.get('trackly_update_application_profile');

  const getInput = getProfile.schema.parse({ jurisdiction: 'us' });
  await getProfile.handler(getInput);
  assert.deepEqual(calls.at(-1), [
    'GET',
    '/api/jobscout/application-profile?jurisdiction=us',
    null,
    false,
    false,
    'trackly-mcp/test',
  ]);

  const updateInput = updateProfile.schema.parse({
    expectedRevision: 9,
    changes: [{
      key: 'authorization.legally_authorized_by_country',
      state: 'answered',
      value: true,
      scope: 'jurisdiction',
      scopeValue: 'pe',
    }],
  });
  await updateProfile.handler(updateInput);
  assert.deepEqual(calls.at(-1), [
    'PATCH',
    '/api/jobscout/application-profile',
    updateInput,
    false,
    false,
    'trackly-mcp/test',
  ]);

  assert.throws(
    () => getProfile.schema.parse({ jurisdiction: 'XX' }),
    /ISO 3166-1 alpha-2 country code/i,
  );
  assert.throws(
    () => updateProfile.schema.parse({
      expectedRevision: 9,
      changes: [{
        key: 'authorization.legally_authorized_by_country',
        state: 'answered',
        value: true,
        scope: 'jurisdiction',
        scopeValue: 'ZZ',
      }],
    }),
    /ISO 3166-1 alpha-2 country code/i,
  );
});

test('execution tools validate and send the exact HTTP contract', async () => {
  const { registrations, calls } = registerRuntimeTools();
  const idempotencyKey = 'runtime-contract-key-0001';
  const cases = [
    ['trackly_start_apply_execution',
      { mode: 'complete_next_n_accessible', target: 10, idempotencyKey },
      ['POST', '/api/jobscout/apply/executions', { mode: 'complete_next_n_accessible', target: 10 }, false, false, 'trackly-mcp/test', { 'Idempotency-Key': idempotencyKey }]],
    ['trackly_get_active_apply_execution', {},
      ['GET', '/api/jobscout/apply/executions/active', null, false, false, 'trackly-mcp/test', undefined]],
    ['trackly_get_apply_execution', { executionId: 41 },
      ['GET', '/api/jobscout/apply/executions/41', null, false, false, 'trackly-mcp/test', undefined]],
    ['trackly_get_apply_execution_snapshot', {
      executionId: 41,
      memberIds: [2, 3],
      profileKeys: ['writing.em_dash_policy'],
      browserSurface: 'codex_in_app',
    }, ['POST', '/api/jobscout/apply/executions/41/snapshot', {
      memberIds: [2, 3],
      profileKeys: ['writing.em_dash_policy'],
      browserSurface: 'codex_in_app',
    }, false, false, 'trackly-mcp/test', undefined]],
    ['trackly_resume_parked_apply_member', {
      executionId: 41,
      memberId: 2,
      expectedRevision: 7,
      browserSurface: 'codex_in_app',
      explicitUserResume: true,
      idempotencyKey,
    }, ['POST', '/api/jobscout/apply/executions/41/parked/2/resume', {
      expectedRevision: 7,
      browserSurface: 'codex_in_app',
      explicitUserResume: true,
    }, false, false, 'trackly-mcp/test', { 'Idempotency-Key': idempotencyKey }]],
    ['trackly_approve_apply_execution_resume', {
      executionId: 41,
      expectedRevision: 8,
      originalSnapshotHash: 'a'.repeat(64),
      profileRevision: 12,
      resumeId: 9,
      resumeSha256: 'b'.repeat(64),
      resumeFilename: 'Resume.pdf',
      resumeSizeBytes: 1024,
      expiresAt: '2026-08-02T23:00:00.000Z',
      idempotencyKey,
    }, ['POST', '/api/jobscout/apply/executions/41/resume-approval', {
      expectedRevision: 8,
      originalSnapshotHash: 'a'.repeat(64),
      profileRevision: 12,
      resumeId: 9,
      resumeSha256: 'b'.repeat(64),
      resumeFilename: 'Resume.pdf',
      resumeSizeBytes: 1024,
      expiresAt: '2026-08-02T23:00:00.000Z',
    }, false, false, 'trackly-mcp/test', { 'Idempotency-Key': idempotencyKey }]],
    ['trackly_advance_apply_execution', {
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey,
    },
    ['POST', '/api/jobscout/apply/executions/41/advance', {
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
    }, false, false, 'trackly-mcp/test', { 'Idempotency-Key': idempotencyKey }]],
    ['trackly_record_apply_execution_dispositions', {
      executionId: 41,
      expectedRevision: 4,
      idempotencyKey,
      dispositions: [{
        jobId: 88,
        classification: 'authentication_required',
        source: 'live_probe',
        batchId: 9,
        memberId: 10,
        runId: 11,
        expectedMemberVersion: 3,
        expectedInspectionEpoch: 1,
        probeOnlyNoDraft: true,
        browserSurface: 'codex_in_app',
      }],
    }, [
      'POST',
      '/api/jobscout/apply/executions/41/dispositions',
      {
        expectedRevision: 4,
        dispositions: [{
          jobId: 88,
          classification: 'authentication_required',
          source: 'live_probe',
          batchId: 9,
          memberId: 10,
          runId: 11,
          expectedMemberVersion: 3,
          expectedInspectionEpoch: 1,
          probeOnlyNoDraft: true,
          browserSurface: 'codex_in_app',
        }],
      },
      false,
      false,
      'trackly-mcp/test',
      { 'Idempotency-Key': idempotencyKey },
    ]],
    ['trackly_stop_apply_execution', {
      executionId: 41,
      expectedRevision: 5,
      idempotencyKey,
      reasonCode: 'user_requested',
    }, [
      'POST',
      '/api/jobscout/apply/executions/41/stop',
      { expectedRevision: 5, reasonCode: 'user_requested' },
      false,
      false,
      'trackly-mcp/test',
      { 'Idempotency-Key': idempotencyKey },
    ]],
  ];
  for (const [name, input, expectedCall] of cases) {
    const registration = registrations.get(name);
    assert.ok(registration, `${name} was not registered`);
    const parsed = registration.schema.parse(input);
    await registration.handler(parsed);
    assert.deepEqual(calls.at(-1), expectedCall, name);
  }
  assert.throws(() => registrations.get('trackly_resume_parked_apply_member').schema.parse({
    executionId: 41,
    memberId: 2,
    expectedRevision: 7,
    browserSurface: 'codex_in_app',
    explicitUserResume: false,
    idempotencyKey,
  }));
  assert.throws(() => registrations.get('trackly_approve_apply_execution_resume').schema.parse({
    executionId: 41,
    expectedRevision: 8,
    originalSnapshotHash: 'a'.repeat(64),
    profileRevision: 0,
    resumeId: 9,
    resumeSha256: 'b'.repeat(64),
    resumeFilename: 'Resume.pdf',
    resumeSizeBytes: 1024,
    expiresAt: '2026-08-02T23:00:00.000Z',
    idempotencyKey,
  }));
});

test('explicit start-fresh confirmation cancels a legacy fixed batch without waiting for expiry', async () => {
  const { registrations, calls } = registerRuntimeTools();
  const registration = registrations.get('trackly_cancel_apply_batch');
  assert.ok(registration);
  const idempotencyKey = 'cancel-fixed-batch-key-0001';
  await registration.handler(registration.schema.parse({
    batchId: 19,
    expectedRevision: 6,
    reasonCode: 'user_requested_restart',
    idempotencyKey,
  }));
  assert.deepEqual(calls.at(-1), [
    'POST',
    '/api/jobscout/apply/batches/19/cancel',
    { expectedRevision: 6, reasonCode: 'user_requested_restart' },
    false,
    false,
    'trackly-mcp/test',
    { 'Idempotency-Key': idempotencyKey },
  ]);
  assert.match(skill, /start fresh[\s\S]*trackly_cancel_apply_batch[\s\S]*same turn/i);
  assert.match(skill, /Never wait for expiry/i);
  assert.match(tools, /start fresh[\s\S]*trackly_cancel_apply_batch[\s\S]*Never wait for batch expiry/i);
  assert.match(lifecycle, /Cancelling a legacy fixed batch[\s\S]*does\s+not close browser tabs/i);
});

test('execution contract uses bounded targets, revisions, idempotency, and typed value-free dispositions', () => {
  const fixture = JSON.stringify(contract.tools);
  assert.match(fixture, /complete_next_n_accessible/);
  assert.equal(contract.constants.applyExecutionMaxTarget, 20);
  assert.match(fixture, /max\(APPLY_EXECUTION_MAX_TARGET\)/);
  assert.match(fixture, /expectedRevision/);
  assert.match(fixture, /idempotencyKey/);
  assert.match(contract.tools.trackly_advance_apply_execution, /browserSurface:z\.enum\(APPLY_BROWSER_SURFACES\)/);
  for (const classification of [
    'accessible',
    'authentication_required',
    'account_creation_required',
    'otp_required',
    'captcha_before_form',
    'captcha_at_submit',
    'manual_only',
    'unknown_unobservable',
  ]) assert.ok(
    contract.constants.applyAccessClassifications.includes(classification),
    `${classification} missing from contract classifications`,
  );
  assert.doesNotMatch(fixture, /fieldValue|answerValue|pageText|rawUrl|credentials/i);
  assert.ok(contract.constants.applyCheckpointActionCodes.includes('auth/account_creation'));
  assert.deepEqual(contract.constants.applyExecutionStopReasonCodes, [
    'user_requested',
    'target_changed',
    'session_ended',
    'execution_restarted',
    'operator_stop',
  ]);
  assert.deepEqual(contract.constants.applyExecutionDispositionSources, ['live_probe']);
  assert.match(tools, /source: z\.enum\(APPLY_EXECUTION_DISPOSITION_SOURCES\)/);
  const skill = read('skills/trackly-apply/SKILL.md');
  const orchestration = read('skills/trackly-apply/references/batch-orchestration.md');
  const lifecycle = read('skills/trackly-apply/references/browser-lifecycle.md');
  assert.match(skill, /exact current-wave `jobId`, `batchId`, `memberId`, `runId`/);
  assert.match(skill, /assertion releases scheduling capacity but never authorizes closing the tab/i);
  assert.match(orchestration, /`response\.progress\.nextAction`/);
  assert.match(lifecycle, /assertion is independent of cleanup consent and never authorizes tab\s+closure/i);
});

test('local MCP accepts only fully bound live-probe dispositions', () => {
  const { registrations, calls } = registerRuntimeTools();
  const registration = registrations.get('trackly_record_apply_execution_dispositions');
  const common = {
    executionId: 41,
    expectedRevision: 4,
    idempotencyKey: 'runtime-contract-key-0001',
  };
  const bound = {
    jobId: 88,
    classification: 'authentication_required',
    source: 'live_probe',
    batchId: 9,
    memberId: 10,
    runId: 11,
    expectedMemberVersion: 3,
    expectedInspectionEpoch: 1,
    browserSurface: 'codex_in_app',
  };
  for (const missing of [
    'batchId', 'memberId', 'runId', 'expectedMemberVersion',
    'expectedInspectionEpoch', 'browserSurface',
  ]) {
    const disposition = { ...bound };
    delete disposition[missing];
    assert.throws(() => registration.schema.parse({
      ...common,
      dispositions: [disposition],
    }), /Required|Invalid input/i, missing);
  }
  for (const source of ['cache_hint', 'static_policy']) {
    assert.throws(() => registration.schema.parse({
      ...common,
      dispositions: [{ ...bound, source }],
    }), z.ZodError, source);
  }
  assert.throws(() => registration.schema.parse({
    ...common,
    dispositions: [{ ...bound, cacheHint: true }],
  }), /Unrecognized key|Invalid input/i, 'cacheHint');
  assert.equal(calls.length, 0);
});

test('start execution returns numeric identity plus authoritative progress and nextAction unchanged', async () => {
  const response = {
    success: true,
    replay: false,
    execution: {
      id: 41,
      revision: 1,
      currentWave: null,
    },
    candidateCount: 12,
    progress: {
      target: 10,
      durablyReviewReady: 0,
      submitted: 0,
      reservedReviewSlots: 0,
      currentlyFilling: 0,
      awaitingAnswer: 0,
      authParked: 0,
      excluded: 0,
      conflicted: 0,
      attempted: 0,
      remainingCandidates: 12,
      queueExhausted: false,
      targetReached: false,
      nextAction: 'advance',
    },
  };
  const { registrations } = registerRuntimeTools(response);
  const registration = registrations.get('trackly_start_apply_execution');
  const result = await registration.handler(registration.schema.parse({
    mode: 'complete_next_n_accessible',
    target: 10,
    idempotencyKey: 'runtime-contract-key-0001',
  }));

  assert.equal(typeof result.execution.id, 'number');
  assert.deepEqual(result.progress, response.progress);
  assert.equal(result.progress.nextAction, 'advance');
});

test('advance replay returns the backend current revision and progress unchanged', async () => {
  const response = {
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 7,
    replay: true,
    progress: {
      target: 10,
      durablyReviewReady: 3,
      submitted: 1,
      reservedReviewSlots: 2,
      currentlyFilling: 0,
      awaitingAnswer: 2,
      authParked: 4,
      excluded: 1,
      conflicted: 0,
      attempted: 11,
      remainingCandidates: 8,
      queueExhausted: false,
      targetReached: false,
      nextAction: 'answer_required',
    },
  };
  const { registrations } = registerRuntimeTools(response);
  const registration = registrations.get('trackly_advance_apply_execution');
  const result = await registration.handler(registration.schema.parse({
    executionId: 41,
    expectedRevision: 3,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'runtime-contract-key-0001',
  }));

  assert.equal(typeof result.executionId, 'number');
  assert.equal(result.revision, 7);
  assert.equal(result.progress.nextAction, 'answer_required');
  assert.deepEqual(result, response);
});

test('skill 4.4.2 recovers executions before legacy batches and distinguishes complete from inspect requests', () => {
  assert.match(agent, /const SKILL_VERSION = '4\.4\.2'/);
  assert.match(agent, /const MIN_APPLY_PROTOCOL_VERSION = '3\.5\.0'/);
  assert.match(skill, /Skill 4\.4\.2 requires protocol 3\.5\.0 or newer/);
  assert.match(skill, /trackly_get_active_apply_execution[\s\S]*before[\s\S]*trackly_get_active_apply_batch/i);
  assert.match(skill, /complete_next_n_accessible/);
  assert.match(skill, /durablyReviewReady/);
  assert.match(skill, /explicit[^\n]*inspect[^\n]*fixed[^\n]*batch/i);
  assert.match(skill, /stop it with reason `target_changed`/i);
  assert.match(skill, /target differs[\s\S]*explicit confirmation[\s\S]*reason `target_changed`[\s\S]*exact execution reached `stopped` or `closed`[\s\S]*`active: false`/i);
  assert.match(skill, /absence is not a blocker after the exact execution is terminal/i);
  assert.match(skill, /asks to stop[\s\S]*reason `user_requested`[\s\S]*exact execution reached `stopped` or `closed`[\s\S]*`active: false`/i);
  assert.match(skill, /even when `batchOrchestration\.accessibleExecution\.enabled` is false/i);
  assert.match(skill, /When disabled and an execution is active[\s\S]*read-only[\s\S]*never start, advance, or record dispositions/i);
  assert.match(tools, /Only when the fetched protocol is 3\.4 or newer call trackly_get_active_apply_execution/i);
  assert.match(tools, /For protocol 3\.3, skip the execution endpoint[\s\S]*active immutable fixed batch/i);
  assert.match(tools, /execution\.unresolvedWaves in ascending waveOrder[\s\S]*execution\.currentWave is only the latest scheduling identity/i);
  assert.match(tools, /immutable fixed batch is active[\s\S]*start fresh[\s\S]*trackly_cancel_apply_batch/i);
  assert.match(skill, /asks for `complete_next_n_accessible` while an immutable fixed batch is active[\s\S]*trackly_cancel_apply_batch[\s\S]*same turn/i);
  assert.match(tools, /protocol 3\.2 remains valid only for an already-active explicit legacy single run/i);
  assert.match(tools, /generic queue-first instruction applies only when resuming that already-active legacy 3\.2/i);
  assert.match(orchestration, /original recent-first[^\n]*snapshot/i);
  assert.match(orchestration, /immutable child batch/i);
  assert.match(orchestration, /newly saved jobs[^\n]*next execution/i);
  assert.match(orchestration, /never reconstruct[^\n]*progress/i);
  assert.match(orchestration, /start response's authoritative `progress`\s+and\s+`nextAction`/i);
  assert.match(skill, /Immediately consume the start response's authoritative `progress` and `nextAction`/i);
  assert.match(skill, /advance_apply_execution` with the actual current `browserSurface`/i);
  assert.match(skill, /`expectedMemberVersion`, `expectedInspectionEpoch`/);
  assert.match(orchestration, /current-wave `jobId`,\s*`batchId`, `memberId`, `runId`, `expectedMemberVersion`/i);
  assert.match(orchestration, /current authoritative progress and the current execution revision/i);
  assert.match(orchestration, /response\.execution\.currentWave\.batchId/);
  assert.match(orchestration, /execution\.unresolvedWaves[^\n]*ascending `waveOrder`/i);
  assert.match(orchestration, /currentWave\.batchId[\s\S]*latest scheduling identity[\s\S]*not[\s\S]*complete recovery set/i);
  assert.match(skill, /Recover every entry in `execution\.unresolvedWaves` in ascending `waveOrder`/i);
  assert.match(orchestration, /advance response[\s\S]*response\.batchId/i);
});

test('skill reserves accessible drafts and parks non-counting access walls', () => {
  assert.match(orchestration, /awaiting[\s\S]*?answer[\s\S]*?reserve/i);
  assert.match(orchestration, /authentication[\s\S]*?consume no slots/i);
  assert.match(orchestration, /captcha_at_submit[^\n]*may[^\n]*review/i);
  assert.match(orchestration, /no unclassified `queued` or `inspecting`/i);
  assert.match(handoff, /target[\s\S]*durablyReviewReady[\s\S]*authParked[\s\S]*remainingCandidates/);
});

test('field provenance preserves user and unknown external edits across recovery', () => {
  for (const provenance of [
    'agent_filled',
    'user_edited',
    'parser_filled',
    'employer_default',
    'unknown_external_change',
  ]) {
    assert.match(`${integrity}\n${lifecycle}`, new RegExp(provenance));
  }
  assert.match(integrity, /compare[\s\S]*?last agent-written fingerprint/i);
  assert.match(integrity, /initial field snapshot[\s\S]*?employer_default/i);
  assert.match(integrity, /do not misclassify[\s\S]*?browser autofill[\s\S]*?user edits/i);
  assert.match(integrity, /preserve[\s\S]*?byte-for-byte/i);
  assert.match(lifecycle, /context\s+loss[\s\S]*?preserve every unknown non-empty value/i);
  assert.match(`${integrity}\n${lifecycle}`, /never send[\s\S]*?form values[\s\S]*?Trackly/i);
});

test('probe-only cleanup is consented, no-draft, and separate from submission proof', () => {
  assert.match(`${skill}\n${lifecycle}`, /probeOnlyNoDraft: true/);
  assert.match(lifecycle, /never|submitted_only|submitted_and_probe_blockers/);
  assert.match(lifecycle, /No private data was entered/i);
  assert.match(lifecycle, /No form control was changed/i);
  assert.match(lifecycle, /No\s+employer draft exists/i);
  assert.match(lifecycle, /pre-close[\s\S]*close receipt[\s\S]*post-close absence/i);
  assert.match(lifecycle, /tab closure never becomes submission evidence/i);
  assert.match(handoff, /submitted[\s\S]*applied_confirmed[\s\S]*clos/i);
});

test('redirected access probes report only fresh live evidence and never synthesize cache fields', () => {
  assert.doesNotMatch(tools, /cacheHint=false/);
  assert.match(tools, /report only the fresh live disposition[\s\S]*backend invalidate its own hint/i);
  assert.match(skill, /redirect or contradictory result[\s\S]*current live observation/i);
});

test('execution documentation includes strict disposition inputs and every public endpoint', () => {
  assert.match(toolDocs, /`jobId`[\s\S]*`classification`[\s\S]*`source: 'live_probe'`/);
  for (const suffix of [
    '/apply/executions`',
    '/apply/executions/active`',
    '/apply/executions/:executionId`',
    '/apply/executions/:executionId/advance`',
    '/apply/executions/:executionId/dispositions`',
    '/apply/executions/:executionId/stop`',
  ]) assert.match(contributorDocs, new RegExp(suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
