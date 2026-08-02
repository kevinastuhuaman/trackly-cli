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
const agent = read('lib/agent.js');

const executionTools = [
  'trackly_start_apply_execution',
  'trackly_get_active_apply_execution',
  'trackly_get_apply_execution',
  'trackly_advance_apply_execution',
  'trackly_record_apply_execution_dispositions',
  'trackly_stop_apply_execution',
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
  assert.equal(contract.contractVersion, '3.5.0');
  for (const name of executionTools) {
    assert.ok(contract.tools[name], `${name} missing from contract fixture`);
    assert.match(tools, new RegExp(`['"]${name}['"]`));
  }
  assert.match(tools, /\/api\/jobscout\/apply\/executions/);
  assert.match(tools, /\/advance/);
  assert.match(tools, /\/dispositions/);
  assert.match(tools, /\/stop/);
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
    }), /Invalid literal value|Invalid input/i, source);
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

test('skill 4.3 recovers executions before legacy batches and distinguishes complete from inspect requests', () => {
  assert.match(agent, /const SKILL_VERSION = '4\.3\.0'/);
  assert.match(agent, /const MIN_APPLY_PROTOCOL_VERSION = '3\.4\.0'/);
  assert.match(skill, /Skill 4\.3\.0 requires protocol 3\.4\.0 or newer/);
  assert.match(skill, /trackly_get_active_apply_execution[\s\S]*before[\s\S]*trackly_get_active_apply_batch/i);
  assert.match(skill, /complete_next_n_accessible/);
  assert.match(skill, /durablyReviewReady/);
  assert.match(skill, /explicit[^\n]*inspect[^\n]*fixed[^\n]*batch/i);
  assert.match(orchestration, /original recent-first[^\n]*snapshot/i);
  assert.match(orchestration, /immutable child batch/i);
  assert.match(orchestration, /newly saved jobs[^\n]*next execution/i);
  assert.match(orchestration, /never reconstruct[^\n]*progress/i);
  assert.match(orchestration, /start response's authoritative `progress` and `nextAction`/i);
  assert.match(skill, /Immediately consume the start response's authoritative `progress` and `nextAction`/i);
  assert.match(skill, /advance_apply_execution` with the actual current `browserSurface`/i);
  assert.match(orchestration, /current authoritative progress and the current execution revision/i);
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
  assert.match(integrity, /preserve[\s\S]*?byte-for-byte/i);
  assert.match(lifecycle, /context\s+loss[\s\S]*?preserve every unknown non-empty value/i);
  assert.match(`${integrity}\n${lifecycle}`, /never send[\s\S]*?form values[\s\S]*?Trackly/i);
});

test('probe-only cleanup is consented, no-draft, and separate from submission proof', () => {
  assert.match(lifecycle, /probe_only_no_draft/);
  assert.match(lifecycle, /never|submitted_only|submitted_and_probe_blockers/);
  assert.match(lifecycle, /No private data was entered/i);
  assert.match(lifecycle, /No form control was changed/i);
  assert.match(lifecycle, /No\s+employer draft exists/i);
  assert.match(lifecycle, /tab closure never becomes submission evidence/i);
  assert.match(handoff, /submitted[\s\S]*applied_confirmed[\s\S]*clos/i);
});
