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
  'trackly_list_recoverable_apply_executions',
  'trackly_recover_exact_apply_members',
  'trackly_list_apply_review_handoffs',
  'trackly_claim_apply_review_handoff',
  'trackly_list_apply_access_deferments',
  'trackly_defer_apply_access',
  'trackly_clear_apply_access_deferment',
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
      return typeof apiResponse === 'function' ? apiResponse(...args) : apiResponse;
    },
  });
  return { registrations, calls };
}

test('protocol 3.7 publishes all accessible execution, recovery, and access-knowledge tools', () => {
  assert.equal(contract.contractVersion, '3.8.1');
  for (const name of executionTools) {
    assert.ok(contract.tools[name], `${name} missing from contract fixture`);
    assert.match(tools, new RegExp(`['"]${name}['"]`));
  }
  assert.match(tools, /\/api\/jobscout\/apply\/executions/);
  assert.match(tools, /\/advance/);
  assert.match(tools, /\/dispositions/);
  assert.match(tools, /\/stop/);
});

test('local upload proof validates ordered value-free stages without a Trackly API call', async () => {
  const { registrations, calls } = registerRuntimeTools();
  const tool = registrations.get('trackly_validate_apply_resume_upload');
  assert.ok(tool);
  const result = await tool.handler(tool.schema.parse({
    capabilities: {
      semanticControlDiscovery: true,
      chooserArming: true,
      fileAttachment: true,
      committedFilenameInspection: true,
      parserFieldRecheck: true,
    },
    events: contract.constants.applyUploadStages.map((stage) => ({ stage, outcome: 'passed' })),
  }));
  assert.equal(result.safeToClaimAttachment, true);
  assert.deepEqual(calls, []);
});

test('durable recovery tools use exact bounded HTTP contracts and validate results', async () => {
  const sourceSnapshotHash = 'a'.repeat(64);
  const orderedMemberSetHash = 'b'.repeat(64);
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (route.endsWith('/recoverable')) return {
      success: true,
      sources: [{
        sourceExecutionId: 11,
        sourceSnapshotHash,
        recoverableUntil: '2026-09-01T12:00:00.000Z',
        candidates: [{ candidateId: 21, jobId: 31, queuePosition: 0, eligibilityCode: 'recoverable' }],
      }],
    };
    if (route.endsWith('/recover')) return {
      success: true,
      replay: false,
      execution: { id: 12, mode: 'recover_exact_members' },
      assertedCandidateIds: [21],
      eligibleCandidateIds: [21],
      eligibility: [{ candidateId: 21, jobId: 31, queuePosition: 0, eligibilityCode: 'recoverable' }],
    };
    if (route.endsWith('/review-handoffs')) return {
      success: true,
      executionId: 12,
      handoffs: [{
        id: 41,
        executionId: 12,
        orderedMemberSetHash,
        generation: 1,
        status: 'active',
        claimedAt: null,
        expiresAt: '2026-09-01T12:00:00.000Z',
        members: [{
          handoffId: 41,
          ordinal: 0,
          batchId: 61,
          memberId: 51,
          runId: 71,
          memberVersion: 1,
          inspectionEpoch: 0,
          reconciliationClassification: null,
          reconciliationResultStatus: null,
        }],
      }],
    };
    return {
      success: true,
      handoffId: 41,
      executionId: 12,
      orderedMemberSetHash,
      members: [{ memberId: 51, classification: 'detected' }],
      transition: 'claimed',
    };
  });
  const idempotencyKey = 'durable-recovery-key-0001';
  await registrations.get('trackly_list_recoverable_apply_executions').handler({});
  await registrations.get('trackly_recover_exact_apply_members').handler({
    sourceExecutionId: 11, sourceSnapshotHash, candidateIds: [21],
    explicitExactSetConfirmation: true, idempotencyKey,
  });
  await registrations.get('trackly_list_apply_review_handoffs').handler({ executionId: 12 });
  await registrations.get('trackly_claim_apply_review_handoff').handler({
    handoffId: 41,
    idempotencyKey,
    members: [{ memberId: 51, classification: 'detected' }],
  });
  assert.deepEqual(calls[0], [
    'GET', '/api/jobscout/apply/executions/recoverable', null, false, false,
    'trackly-mcp/test', undefined,
  ]);
  assert.deepEqual(calls[1].slice(0, 3), ['POST', '/api/jobscout/apply/executions/recover', {
    mode: 'recover_exact_members', sourceExecutionId: 11, sourceSnapshotHash, candidateIds: [21],
    explicitExactSetConfirmation: true,
  }]);
  assert.deepEqual(calls[1].at(-1), { 'Idempotency-Key': idempotencyKey });
  assert.deepEqual(calls[2].slice(0, 2), ['GET', '/api/jobscout/apply/executions/12/review-handoffs']);
  assert.deepEqual(calls[3].slice(0, 3), ['POST', '/api/jobscout/apply/review-handoffs/41/claim', {
    members: [{ memberId: 51, classification: 'detected' }],
  }]);
  assert.deepEqual(calls[3].at(-1), { 'Idempotency-Key': idempotencyKey });
});

test('exact recovery rejects a backend response for a different or duplicate candidate set', async () => {
  const sourceSnapshotHash = 'a'.repeat(64);
  const recover = async (response) => {
    const { registrations } = registerRuntimeTools((method, route) => {
      if (method === 'GET' && route.endsWith('/recoverable')) return {
        success: true,
        sources: [{
          sourceExecutionId: 11,
          sourceSnapshotHash,
          recoverableUntil: '2026-09-01T12:00:00.000Z',
          candidates: [21, 22].map((candidateId, queuePosition) => ({
            candidateId,
            jobId: candidateId + 10,
            queuePosition,
            eligibilityCode: 'recoverable',
          })),
        }],
      };
      return response;
    });
    await registrations.get('trackly_list_recoverable_apply_executions').handler({});
    return registrations.get('trackly_recover_exact_apply_members').handler({
      sourceExecutionId: 11,
      sourceSnapshotHash,
      candidateIds: [21, 22],
      explicitExactSetConfirmation: true,
      idempotencyKey: 'durable-recovery-key-0002',
    });
  };
  const base = {
    success: true,
    replay: false,
    execution: { id: 12, mode: 'recover_exact_members' },
    assertedCandidateIds: [21, 22],
    eligibleCandidateIds: [21, 22],
    eligibility: [
      { candidateId: 21, jobId: 31, queuePosition: 0, eligibilityCode: 'recoverable' },
      { candidateId: 22, jobId: 32, queuePosition: 1, eligibilityCode: 'recoverable' },
    ],
  };
  await assert.rejects(recover({ ...base, assertedCandidateIds: [21, 23] }), /does not match/);
  await assert.rejects(recover({ ...base, assertedCandidateIds: [21, 21] }), /does not match/);
  await assert.rejects(recover({ ...base, eligibleCandidateIds: [21, 21] }), /does not match/);
  await assert.rejects(recover({
    ...base,
    eligibility: [base.eligibility[0], { ...base.eligibility[1], eligibilityCode: 'revoked' }],
  }), /does not match/);
  await assert.rejects(recover({
    ...base,
    eligibility: [base.eligibility[0], { ...base.eligibility[0] }],
  }), /does not match/);
});

test('exact recovery rejects undiscovered or substituted candidates before the write', async () => {
  const sourceSnapshotHash = 'a'.repeat(64);
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (method === 'GET' && route.endsWith('/recoverable')) return {
      success: true,
      sources: [{
        sourceExecutionId: 11,
        sourceSnapshotHash,
        recoverableUntil: '2026-09-01T12:00:00.000Z',
        candidates: [21, 22].map((candidateId, queuePosition) => ({
          candidateId,
          jobId: candidateId + 10,
          queuePosition,
          eligibilityCode: 'recoverable',
        })),
      }],
    };
    throw new Error(`unexpected write ${method} ${route}`);
  });
  const recover = (overrides = {}) => registrations.get('trackly_recover_exact_apply_members').handler({
    sourceExecutionId: 11,
    sourceSnapshotHash,
    candidateIds: [21],
    explicitExactSetConfirmation: true,
    idempotencyKey: 'durable-recovery-key-0003',
    ...overrides,
  });

  await assert.rejects(recover(), /latest discovery response/i);
  await registrations.get('trackly_list_recoverable_apply_executions').handler({});
  await assert.rejects(recover({ sourceExecutionId: 12 }), /latest discovery response/i);
  await assert.rejects(recover({ sourceSnapshotHash: 'b'.repeat(64) }), /latest discovery response/i);
  await assert.rejects(recover({ candidateIds: [23] }), /latest discovery response/i);
  assert.equal(calls.length, 1);
});

test('recovery and handoff discovery reject ambiguous or cross-boundary identities', async () => {
  const source = {
    sourceExecutionId: 11,
    sourceSnapshotHash: 'a'.repeat(64),
    recoverableUntil: '2026-09-01T12:00:00.000Z',
    candidates: [{ candidateId: 21, jobId: 31, queuePosition: 0, eligibilityCode: 'recoverable' }],
  };
  const parseRecoverable = async (response) => {
    const { registrations } = registerRuntimeTools(response);
    return registrations.get('trackly_list_recoverable_apply_executions').handler({});
  };
  await assert.rejects(parseRecoverable({
    success: true,
    sources: [{ ...source, candidates: [source.candidates[0], { ...source.candidates[0], jobId: 32 }] }],
  }), /unique/i);
  await assert.rejects(parseRecoverable({ success: true, sources: [source, source] }), /unique/i);

  const member = {
    handoffId: 41,
    ordinal: 0,
    batchId: 61,
    memberId: 51,
    runId: 71,
    memberVersion: 1,
    inspectionEpoch: 0,
    reconciliationClassification: null,
    reconciliationResultStatus: null,
  };
  const handoff = {
    id: 41,
    executionId: 12,
    orderedMemberSetHash: 'b'.repeat(64),
    generation: 1,
    status: 'active',
    claimedAt: null,
    expiresAt: '2026-09-01T12:00:00.000Z',
    members: [member],
  };
  const listHandoffs = async (response) => {
    const { registrations } = registerRuntimeTools(response);
    return registrations.get('trackly_list_apply_review_handoffs').handler({ executionId: 12 });
  };
  await assert.rejects(listHandoffs({ success: true, executionId: 13, handoffs: [] }), /does not match/i);
  await assert.rejects(listHandoffs({
    success: true, executionId: 12, handoffs: [{ ...handoff, executionId: 13 }],
  }), /does not match/i);
  await assert.rejects(listHandoffs({
    success: true, executionId: 12, handoffs: [{ ...handoff, members: [{ ...member, handoffId: 42 }] }],
  }), /does not match/i);
  await assert.rejects(listHandoffs({
    success: true, executionId: 12, handoffs: [handoff, handoff],
  }), /does not match/i);
  await assert.rejects(listHandoffs({
    success: true,
    executionId: 12,
    handoffs: [{ ...handoff, members: [member, { ...member, ordinal: 1, runId: 72 }] }],
  }), /does not match/i);
});

test('handoff claim rejects a backend response for a different handoff or member set', async () => {
  const claim = async (response) => {
    const { registrations } = registerRuntimeTools((method, route) => {
      if (method === 'GET' && route.endsWith('/review-handoffs')) return {
        success: true,
        executionId: 12,
        handoffs: [{
          id: 41,
          executionId: 12,
          orderedMemberSetHash: 'b'.repeat(64),
          generation: 1,
          status: 'active',
          claimedAt: null,
          expiresAt: '2026-09-01T12:00:00.000Z',
          members: [{
            handoffId: 41,
            ordinal: 0,
            batchId: 61,
            memberId: 51,
            runId: 71,
            memberVersion: 1,
            inspectionEpoch: 0,
            reconciliationClassification: null,
            reconciliationResultStatus: null,
          }, {
            handoffId: 41,
            ordinal: 1,
            batchId: 62,
            memberId: 52,
            runId: 72,
            memberVersion: 1,
            inspectionEpoch: 0,
            reconciliationClassification: null,
            reconciliationResultStatus: null,
          }],
        }],
      };
      return response;
    });
    await registrations.get('trackly_list_apply_review_handoffs').handler({ executionId: 12 });
    return registrations.get('trackly_claim_apply_review_handoff').handler({
      handoffId: 41,
      idempotencyKey: 'handoff-claim-key-0001',
      members: [
        { memberId: 51, classification: 'detected' },
        { memberId: 52, classification: 'user_confirmed' },
      ],
    });
  };
  const base = {
    success: true,
    handoffId: 41,
    executionId: 12,
    orderedMemberSetHash: 'b'.repeat(64),
    members: [
      { memberId: 51, classification: 'detected' },
      { memberId: 52, classification: 'user_confirmed' },
    ],
    transition: 'claimed',
  };

  await assert.rejects(claim({ ...base, handoffId: 42 }), /does not match/i);
  await assert.rejects(claim({ ...base, executionId: 13 }), /does not match/i);
  await assert.rejects(claim({ ...base, orderedMemberSetHash: 'c'.repeat(64) }), /does not match/i);
  await assert.rejects(claim({ ...base, members: base.members.slice(0, 1) }), /does not match/i);
  await assert.rejects(claim({ ...base, members: [base.members[0], base.members[0]] }), /does not match/i);
  await assert.rejects(claim({
    ...base,
    members: [base.members[0], { memberId: 52, classification: 'contradictory' }],
  }), /does not match/i);
});

test('handoff claim rejects incomplete or foreign request members before the write', async () => {
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (method === 'GET' && route.endsWith('/review-handoffs')) return {
      success: true,
      executionId: 12,
      handoffs: [{
        id: 41,
        executionId: 12,
        orderedMemberSetHash: 'b'.repeat(64),
        generation: 1,
        status: 'active',
        claimedAt: null,
        expiresAt: '2026-09-01T12:00:00.000Z',
        members: [51, 52].map((memberId, ordinal) => ({
          handoffId: 41,
          ordinal,
          batchId: 61 + ordinal,
          memberId,
          runId: 71 + ordinal,
          memberVersion: 1,
          inspectionEpoch: 0,
          reconciliationClassification: null,
          reconciliationResultStatus: null,
        })),
      }],
    };
    throw new Error(`unexpected write ${method} ${route}`);
  });
  const claim = (members) => registrations.get('trackly_claim_apply_review_handoff').handler({
    handoffId: 41,
    idempotencyKey: 'handoff-claim-key-0002',
    members,
  });

  await registrations.get('trackly_list_apply_review_handoffs').handler({ executionId: 12 });
  await assert.rejects(claim([{ memberId: 51, classification: 'detected' }]), /every discovered member/i);
  await assert.rejects(claim([
    { memberId: 51, classification: 'detected' },
    { memberId: 53, classification: 'unresolved' },
  ]), /every discovered member/i);
  assert.equal(calls.length, 1);
});

test('handoff discovery remains claimable across independent executions', async () => {
  const handoffs = new Map([
    [12, { handoffId: 41, memberId: 51 }],
    [13, { handoffId: 42, memberId: 52 }],
  ]);
  const { registrations, calls } = registerRuntimeTools((method, route, body) => {
    const executionMatch = route.match(/^\/api\/jobscout\/apply\/executions\/(\d+)\/review-handoffs$/);
    if (method === 'GET' && executionMatch) {
      const executionId = Number(executionMatch[1]);
      const { handoffId, memberId } = handoffs.get(executionId);
      return {
        success: true,
        executionId,
        handoffs: [{
          id: handoffId,
          executionId,
          orderedMemberSetHash: String(executionId).padStart(64, '0'),
          generation: 1,
          status: 'active',
          claimedAt: null,
          expiresAt: '2026-09-01T12:00:00.000Z',
          members: [{
            handoffId,
            ordinal: 0,
            batchId: memberId + 10,
            memberId,
            runId: memberId + 20,
            memberVersion: 1,
            inspectionEpoch: 0,
            reconciliationClassification: null,
            reconciliationResultStatus: null,
          }],
        }],
      };
    }
    const claimMatch = route.match(/^\/api\/jobscout\/apply\/review-handoffs\/(\d+)\/claim$/);
    if (method === 'POST' && claimMatch) {
      const handoffId = Number(claimMatch[1]);
      const [executionId, handoff] = [...handoffs].find(([, value]) => value.handoffId === handoffId);
      return {
        success: true,
        handoffId,
        executionId,
        orderedMemberSetHash: String(executionId).padStart(64, '0'),
        members: body.members,
        transition: 'claimed',
      };
    }
    throw new Error(`unexpected request ${method} ${route}`);
  });

  await registrations.get('trackly_list_apply_review_handoffs').handler({ executionId: 12 });
  await registrations.get('trackly_list_apply_review_handoffs').handler({ executionId: 13 });
  const result = await registrations.get('trackly_claim_apply_review_handoff').handler({
    handoffId: 41,
    idempotencyKey: 'handoff-claim-key-0003',
    members: [{ memberId: 51, classification: 'detected' }],
  });

  assert.equal(result.handoffId, 41);
  assert.equal(calls.length, 3);
});

test('local tab keep-set tool canonicalizes IDs without making a Trackly API call', async () => {
  const { registrations, calls } = registerRuntimeTools();
  const tool = registrations.get('trackly_validate_apply_tab_keep_set');
  assert.ok(tool);

  const input = tool.schema.parse({
    expectedTabIds: ['101', 'tab-b'],
    keepTabIds: ['101', 'tab-b'],
    controllerInventory: { complete: true, tabIds: ['101', 'unrelated-controller-tab'] },
    userInventory: { complete: true, tabIds: ['tab-b', 'unrelated-user-tab'] },
  });
  const result = await tool.handler(input);

  assert.equal(result.safeToFinalize, true);
  assert.deepEqual(result.canonicalKeepTabIds, ['101', 'tab-b']);
  assert.deepEqual(calls, []);
});

test('profile jurisdiction and office tools validate and forward exact context', async () => {
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

  const officeInput = getProfile.schema.parse({
    includeSensitive: true,
    companyId: ' 42 ',
    office: '42:waltham-ma',
  });
  await getProfile.handler(officeInput);
  assert.deepEqual(calls.at(-1), [
    'GET',
    '/api/jobscout/application-profile?includeSensitive=true&companyId=42&office=42%3Awaltham-ma',
    null,
    false,
    false,
    'trackly-mcp/test',
  ]);
  const officeCallCount = calls.length;
  await assert.rejects(
    getProfile.handler(getProfile.schema.parse({ office: '42:waltham-ma' })),
    /Office scope must match the requested companyId/,
  );
  await assert.rejects(
    getProfile.handler(getProfile.schema.parse({ companyId: '43', office: '42:waltham-ma' })),
    /Office scope must match the requested companyId/,
  );
  assert.equal(calls.length, officeCallCount);
  assert.doesNotThrow(() => updateProfile.schema.parse({
    expectedRevision: 10,
    changes: [{
      key: 'location.commute_willing',
      state: 'answered',
      value: true,
      scope: 'office',
      scopeValue: '42:waltham-ma',
    }],
  }));
  assert.throws(
    () => getProfile.schema.parse({ office: 'waltham-ma' }),
    /invalid_string|Invalid string/i,
  );
});

test('execution tools validate and send the exact HTTP contract', async () => {
  const progress = {
    target: 10,
    achievementCount: 0,
    completed: 0,
    durablyReviewReady: 0,
    submitted: 0,
    reservedReviewSlots: 0,
    currentlyFilling: 0,
    awaitingAnswer: 0,
    authParked: 0,
    excluded: 0,
    conflicted: 0,
    attempted: 0,
    remainingCandidates: 10,
    availableCandidateCount: 10,
    deferredCandidateCount: 0,
    queueExhausted: false,
    targetReached: false,
    nextAction: 'advance',
    historicalProjection: { achievementCount: 0, completed: 0 },
    currentProjection: { durablyReviewReady: 0, submitted: 0 },
  };
  const execution = {
    id: 41,
    userId: 7,
    mode: 'complete_next_n_accessible',
    targetCount: 10,
    orderingVersion: 2,
    queueSnapshotAt: '2026-08-28T12:00:00.000Z',
    originalSnapshotHash: 'a'.repeat(64),
    status: 'running',
    revision: 3,
    expiresAt: '2026-08-29T12:00:00.000Z',
    recoverableUntil: '2026-09-04T12:00:00.000Z',
    sourceExecutionId: null,
    sourceSnapshotHash: null,
    currentWave: null,
    unresolvedWaves: [],
  };
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (route.endsWith('/review-handoffs')) {
      return { success: true, executionId: 41, handoffs: [] };
    }
    if (method === 'GET' && route === '/api/jobscout/apply/executions/41') {
      return { success: true, execution, progress };
    }
    if (method === 'POST' && route.endsWith('/advance')) {
      return {
        success: true,
        executionId: 41,
        createdWave: false,
        revision: 4,
        progress,
      };
    }
    if (method === 'POST' && route === '/api/jobscout/apply/executions') {
      return {
        success: true,
        replay: false,
        execution,
        candidateCount: 10,
        progress,
      };
    }
    if (method === 'GET' && route === '/api/jobscout/apply/executions/active') {
      return { success: true, enabled: true, active: false, preserved: false };
    }
    return { ok: true };
  });
  const idempotencyKey = 'runtime-contract-key-0001';
  const cases = [
    ['trackly_start_apply_execution',
      { mode: 'complete_next_n_accessible', target: 10, idempotencyKey },
      ['POST', '/api/jobscout/apply/executions', { mode: 'complete_next_n_accessible', target: 10 }, false, false, 'trackly-mcp/test', { 'Idempotency-Key': idempotencyKey }]],
    ['trackly_get_active_apply_execution', {},
      ['GET', '/api/jobscout/apply/executions/active', null, false, false, 'trackly-mcp/test', undefined]],
    ['trackly_get_apply_execution', { executionId: 41 },
      ['GET', '/api/jobscout/apply/executions/41', null, false, false, 'trackly-mcp/test', undefined]],
    ['trackly_list_apply_review_handoffs', { executionId: 41 },
      ['GET', '/api/jobscout/apply/executions/41/review-handoffs', null, false, false, 'trackly-mcp/test', undefined]],
    ['trackly_get_apply_execution_snapshot', {
      executionId: 41,
      memberIds: [2, 3],
      profileKeys: ['writing.em_dash_policy'],
      officeProjections: [{
        memberId: 2,
        office: '42:waltham-ma',
        profileKeys: ['location.commute_willing', 'location.commute_days_per_week'],
      }],
      browserSurface: 'codex_in_app',
    }, ['POST', '/api/jobscout/apply/executions/41/snapshot', {
      memberIds: [2, 3],
      profileKeys: ['writing.em_dash_policy'],
      officeProjections: [{
        memberId: 2,
        office: '42:waltham-ma',
        profileKeys: ['location.commute_willing', 'location.commute_days_per_week'],
      }],
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
    ['trackly_record_application_outcome', {
      runId: 372,
      batchId: 19,
      memberId: 4,
      inspectionEpoch: 2,
      leaseToken: 'lease-token',
      outcome: 'submitted',
      confirmation: 'user_confirmation',
      idempotencyKey,
    }, [
      'POST',
      '/api/jobscout/apply/runs/372/outcome',
      {
        batchId: 19,
        memberId: 4,
        inspectionEpoch: 2,
        leaseToken: 'lease-token',
        outcome: 'submitted',
        confirmation: 'user_confirmation',
      },
      false,
      false,
      'trackly-mcp/test',
      { 'Idempotency-Key': idempotencyKey },
    ]],
    ['trackly_record_application_outcomes', {
      idempotencyKey,
      outcomes: [{
        runId: 373,
        batchId: 19,
        memberId: 5,
        inspectionEpoch: 2,
        leaseToken: 'lease-token',
        outcome: 'review_ready',
      }],
    }, [
      'POST',
      '/api/jobscout/apply/outcomes/bulk',
      {
        outcomes: [{
          runId: 373,
          batchId: 19,
          memberId: 5,
          inspectionEpoch: 2,
          leaseToken: 'lease-token',
          outcome: 'review_ready',
        }],
      },
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

test('execution snapshot rejects backend-invalid projection identities and duplicate keys locally', async () => {
  const { registrations, calls } = registerRuntimeTools();
  const tool = registrations.get('trackly_get_apply_execution_snapshot');
  const base = {
    executionId: 41,
    memberIds: [2, 3],
    browserSurface: 'codex_in_app',
  };

  assert.throws(() => tool.schema.parse({ ...base, memberIds: [2, 2] }), /memberIds must be unique/i);
  assert.throws(() => tool.schema.parse({ ...base, profileKeys: ['writing.em_dash_policy', 'writing.em_dash_policy'] }), /profileKeys must be unique/i);
  assert.throws(() => tool.schema.parse({
    ...base,
    officeProjections: [{
      memberId: 2,
      office: '42:waltham-ma',
      profileKeys: ['location.commute_willing', 'location.commute_willing'],
    }],
  }), /office profileKeys must be unique/i);
  assert.throws(() => tool.schema.parse({
    ...base,
    officeProjections: [
      { memberId: 2, office: '42:waltham-ma', profileKeys: ['location.commute_willing'] },
      { memberId: 2, office: '42:new-york-ny', profileKeys: ['location.commute_willing'] },
    ],
  }), /officeProjections must contain unique memberId values/i);

  await assert.rejects(
    tool.handler(tool.schema.parse({
      ...base,
      officeProjections: [{
        memberId: 4,
        office: '42:waltham-ma',
        profileKeys: ['location.commute_willing'],
      }],
    })),
    /must exist in memberIds/i,
  );
  assert.deepEqual(calls, []);
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
  assert.match(contract.tools.trackly_advance_apply_execution, /accessReviewApproval:z\.object/);
  assert.match(contract.tools.trackly_defer_apply_access, /scope:z\.enum\(APPLY_ACCESS_DEFERMENT_SCOPES\)/);
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
      userId: 7,
      mode: 'complete_next_n_accessible',
      targetCount: 10,
      orderingVersion: 3,
      queueSnapshotAt: '2026-08-28T12:00:00.000Z',
      originalSnapshotHash: 'a'.repeat(64),
      status: 'running',
      revision: 1,
      expiresAt: '2026-08-29T12:00:00.000Z',
      recoverableUntil: '2026-09-04T12:00:00.000Z',
      sourceExecutionId: null,
      sourceSnapshotHash: null,
      currentWave: null,
      unresolvedWaves: [],
    },
    candidateCount: 12,
    progress: {
      target: 10,
      achievementCount: 0,
      completed: 0,
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
      availableCandidateCount: 12,
      deferredCandidateCount: 0,
      queueExhausted: false,
      targetReached: false,
      nextAction: 'advance',
      historicalProjection: { achievementCount: 0, completed: 0 },
      currentProjection: { durablyReviewReady: 0, submitted: 0 },
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

  const legacyProgress = { ...response.progress };
  delete legacyProgress.achievementCount;
  delete legacyProgress.completed;
  delete legacyProgress.availableCandidateCount;
  delete legacyProgress.deferredCandidateCount;
  delete legacyProgress.historicalProjection;
  delete legacyProgress.currentProjection;
  const legacyResponse = { ...response, progress: legacyProgress };
  const legacyRegistration = registerRuntimeTools(legacyResponse)
    .registrations.get('trackly_start_apply_execution');
  const legacyResult = await legacyRegistration.handler(legacyRegistration.schema.parse({
    mode: 'complete_next_n_accessible',
    target: 10,
    idempotencyKey: 'legacy-start-compatibility-key',
  }));
  assert.deepEqual(legacyResult.progress, legacyProgress);
});

test('start access-review replays hydrate and cache the detail receipt before approval', async () => {
  const execution = {
    id: 41,
    userId: 7,
    mode: 'complete_next_n_accessible',
    targetCount: 1,
    orderingVersion: 3,
    queueSnapshotAt: '2026-08-28T12:00:00.000Z',
    originalSnapshotHash: 'a'.repeat(64),
    status: 'running',
    revision: 4,
    expiresAt: '2026-08-29T12:00:00.000Z',
    recoverableUntil: '2026-09-04T12:00:00.000Z',
    sourceExecutionId: null,
    sourceSnapshotHash: null,
    currentWave: null,
    unresolvedWaves: [],
  };
  const progress = {
    target: 1,
    achievementCount: 0,
    completed: 0,
    durablyReviewReady: 0,
    submitted: 0,
    reservedReviewSlots: 0,
    currentlyFilling: 0,
    awaitingAnswer: 0,
    authParked: 0,
    excluded: 0,
    conflicted: 0,
    attempted: 0,
    remainingCandidates: 1,
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    queueExhausted: false,
    targetReached: false,
    nextAction: 'access_review',
    historicalProjection: { achievementCount: 0, completed: 0 },
    currentProjection: { durablyReviewReady: 0, submitted: 0 },
  };
  const accessProposal = {
    proposalId: 7,
    approvalHash: 'c'.repeat(64),
    rationaleCode: 'access_review',
    knowledgeRevision: 1,
    evaluatedAt: '2026-08-28T12:00:00.000Z',
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    members: [{
      jobId: 88,
      memberPosition: 0,
      rationaleCode: 'ats_default_open',
      receiptHash: 'd'.repeat(64),
      accessKnowledge: sampleAccessKnowledge,
    }],
  };
  const detail = {
    success: true,
    execution,
    progress,
    proposedWave: [{ jobId: 88, accessKnowledge: sampleAccessKnowledge }],
    accessProposal,
  };
  let startCalls = 0;
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (method === 'POST' && route === '/api/jobscout/apply/executions') {
      startCalls += 1;
      return startCalls === 1
        ? { success: true, replay: true, execution, candidateCount: 1, progress }
        : {
          success: true,
          replay: true,
          execution,
          candidateCount: 1,
          progress: { ...progress, nextAction: 'advance' },
        };
    }
    if (method === 'GET' && route.endsWith('/41')) return detail;
    if (method === 'POST' && route.endsWith('/advance')) {
      return {
        success: true,
        executionId: 41,
        createdWave: true,
        batchId: 91,
        revision: 5,
        progress: { ...progress, remainingCandidates: 0, availableCandidateCount: 0, nextAction: 'continue_current_wave' },
      };
    }
    throw new Error(`unexpected request: ${method} ${route}`);
  });
  const start = registrations.get('trackly_start_apply_execution');
  const result = await start.handler(start.schema.parse({
    mode: 'complete_next_n_accessible',
    target: 1,
    idempotencyKey: 'start-replay-hydration-key',
  }));
  assert.equal(startCalls, 1);
  assert.deepEqual(result.accessProposal, accessProposal);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ['POST', '/api/jobscout/apply/executions'],
    ['GET', '/api/jobscout/apply/executions/41'],
  ]);

  const advance = registrations.get('trackly_advance_apply_execution');
  await assert.doesNotReject(advance.handler(advance.schema.parse({
    executionId: 41,
    expectedRevision: 4,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'start-replay-approval-key',
    accessReviewApproval: { jobIds: [88], approvalHash: accessProposal.approvalHash },
  })));

  // A later idempotent start replay can return ordinary progress after the
  // review wave was consumed. That authoritative state must clear the old
  // approval receipt before another advance is attempted.
  await start.handler(start.schema.parse({
    mode: 'complete_next_n_accessible',
    target: 1,
    idempotencyKey: 'start-ordinary-replay-key',
  }));
  await assert.rejects(advance.handler(advance.schema.parse({
    executionId: 41,
    expectedRevision: 4,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'stale-approval-after-ordinary-key',
    accessReviewApproval: { jobIds: [88], approvalHash: accessProposal.approvalHash },
  })), /exact returned proposal/i);
  assert.equal(startCalls, 2);

  const mismatchedStart = registerRuntimeTools((method, route) => {
    if (method === 'POST' && route === '/api/jobscout/apply/executions') {
      return { success: true, replay: true, execution, candidateCount: 1, progress };
    }
    if (method === 'GET' && route.endsWith('/41')) {
      return { ...detail, execution: { ...execution, revision: execution.revision + 1 } };
    }
    throw new Error(`unexpected request: ${method} ${route}`);
  }).registrations.get('trackly_start_apply_execution');
  await assert.rejects(mismatchedStart.handler(mismatchedStart.schema.parse({
    mode: 'complete_next_n_accessible',
    target: 1,
    idempotencyKey: 'start-revision-race-key',
  })), /did not include its proposal/i);
});

test('active execution validation accepts ordinary envelopes with active-state metadata', async () => {
  const response = {
    success: true,
    enabled: true,
    active: true,
    preserved: false,
    execution: {
      id: 41,
      userId: 7,
      mode: 'complete_next_n_accessible',
      targetCount: 1,
      orderingVersion: 3,
      queueSnapshotAt: '2026-08-28T12:00:00.000Z',
      originalSnapshotHash: 'a'.repeat(64),
      status: 'running',
      revision: 4,
      expiresAt: '2026-08-29T12:00:00.000Z',
      recoverableUntil: '2026-09-04T12:00:00.000Z',
      sourceExecutionId: null,
      sourceSnapshotHash: null,
      currentWave: null,
      unresolvedWaves: [],
    },
    progress: {
      target: 1,
      durablyReviewReady: 0,
      submitted: 0,
      reservedReviewSlots: 0,
      currentlyFilling: 0,
      awaitingAnswer: 0,
      authParked: 0,
      excluded: 0,
      conflicted: 0,
      attempted: 0,
      remainingCandidates: 1,
      queueExhausted: false,
      targetReached: false,
      nextAction: 'advance',
    },
  };
  const registration = registerRuntimeTools(response).registrations.get('trackly_get_active_apply_execution');
  assert.deepEqual(await registration.handler({}), response);

  const preservedTerminal = {
    ...response,
    active: false,
    preserved: true,
    execution: { ...response.execution, status: 'stopped' },
    progress: { ...response.progress, nextAction: 'none' },
  };
  const preservedRegistration = registerRuntimeTools(preservedTerminal)
    .registrations.get('trackly_get_active_apply_execution');
  assert.deepEqual(await preservedRegistration.handler({}), preservedTerminal);

  const contradictoryInactiveReview = {
    ...response,
    active: false,
    progress: { ...response.progress, nextAction: 'access_review' },
  };
  const contradictoryRegistration = registerRuntimeTools(contradictoryInactiveReview)
    .registrations.get('trackly_get_active_apply_execution');
  await assert.rejects(contradictoryRegistration.handler({}), z.ZodError);

  const contradictoryInactiveAdvance = {
    ...response,
    active: false,
    preserved: true,
    progress: { ...response.progress, nextAction: 'advance' },
  };
  const contradictoryAdvanceRegistration = registerRuntimeTools(contradictoryInactiveAdvance)
    .registrations.get('trackly_get_active_apply_execution');
  await assert.rejects(contradictoryAdvanceRegistration.handler({}), z.ZodError);

  const missingProposal = registerRuntimeTools({
    ...response,
    progress: { ...response.progress, nextAction: 'access_review' },
  }).registrations.get('trackly_get_active_apply_execution');
  await assert.rejects(missingProposal.handler({}), z.ZodError);

  const missingDetailProposal = registerRuntimeTools({
    success: true,
    execution: response.execution,
    progress: { ...response.progress, nextAction: 'access_review' },
  }).registrations.get('trackly_get_apply_execution');
  await assert.rejects(
    missingDetailProposal.handler(missingDetailProposal.schema.parse({ executionId: 41 })),
    z.ZodError,
  );
});

test('active access reviews hydrate the compact proposal and reject revision races', async () => {
  const execution = {
    id: 41,
    userId: 7,
    mode: 'complete_next_n_accessible',
    targetCount: 1,
    orderingVersion: 3,
    queueSnapshotAt: '2026-08-28T12:00:00.000Z',
    originalSnapshotHash: 'a'.repeat(64),
    status: 'running',
    revision: 4,
    expiresAt: '2026-08-29T12:00:00.000Z',
    recoverableUntil: '2026-09-04T12:00:00.000Z',
    sourceExecutionId: null,
    sourceSnapshotHash: null,
    currentWave: null,
    unresolvedWaves: [],
  };
  const proposalProgress = {
    target: 1,
    achievementCount: 0,
    completed: 0,
    durablyReviewReady: 0,
    submitted: 0,
    reservedReviewSlots: 0,
    currentlyFilling: 0,
    awaitingAnswer: 0,
    authParked: 0,
    excluded: 0,
    conflicted: 0,
    attempted: 0,
    remainingCandidates: 1,
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    queueExhausted: false,
    targetReached: false,
    nextAction: 'access_review',
    historicalProjection: { achievementCount: 0, completed: 0 },
    currentProjection: { durablyReviewReady: 0, submitted: 0 },
  };
  const proposal = {
    success: true,
    execution,
    progress: proposalProgress,
    proposedWave: [{ jobId: 88, memberPosition: 0, accessKnowledge: sampleAccessKnowledge }],
    accessProposal: {
      proposalId: 7,
      approvalHash: 'c'.repeat(64),
      rationaleCode: 'access_review',
      knowledgeRevision: 1,
      evaluatedAt: '2026-08-28T12:00:00.000Z',
      availableCandidateCount: 1,
      deferredCandidateCount: 0,
      members: [{
        jobId: 88,
        memberPosition: 0,
        rationaleCode: 'ats_default_open',
        receiptHash: 'd'.repeat(64),
        accessKnowledge: sampleAccessKnowledge,
      }],
    },
  };
  const active = {
    success: true,
    enabled: true,
    active: true,
    preserved: false,
    execution,
    progress: proposalProgress,
  };
  let detailRevision = execution.revision;
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (route.endsWith('/active')) return active;
    if (route.endsWith('/41')) {
      return {
        ...proposal,
        execution: { ...execution, revision: detailRevision },
      };
    }
    throw new Error(`unexpected request: ${method} ${route}`);
  });
  const registration = registrations.get('trackly_get_active_apply_execution');
  const result = await registration.handler({});
  assert.deepEqual(result.proposedWave, proposal.proposedWave);
  assert.deepEqual(result.accessProposal, proposal.accessProposal);
  assert.equal(result.enabled, true);
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ['GET', '/api/jobscout/apply/executions/active'],
    ['GET', '/api/jobscout/apply/executions/41'],
  ]);

  detailRevision = execution.revision + 1;
  await assert.rejects(registration.handler({}), /did not include its proposal/i);
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

test('skill 4.8.0 recovers executions before legacy batches and distinguishes complete from inspect requests', () => {
  assert.match(agent, /const SKILL_VERSION = '4\.8\.0'/);
  assert.match(agent, /const MIN_APPLY_PROTOCOL_VERSION = '3\.7\.0'/);
  assert.match(skill, /Skill 4\.8\.0 requires protocol 3\.7\.0 or newer/);
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
    '/apply/access-deferments`',
    '/apply/access-deferments/:defermentId/clear`',
  ]) assert.match(contributorDocs, new RegExp(suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

const sampleAccessKnowledge = {
  observedAccess: {
    classification: 'open',
    detailCode: null,
    wallStage: null,
    matchedScope: 'ats_default',
    source: 'curated_audit',
    lastConfirmedAt: '2026-08-22T12:00:00.000Z',
    freshUntil: '2026-09-21T12:00:00.000Z',
    freshness: 'fresh',
    evidenceCount: 1,
    contradictory: false,
  },
  userPreference: null,
  effectiveSchedulingEffect: 'prefer',
  rationaleCode: 'ats_default_open',
  knowledgeRevision: 1,
  evaluatedAt: '2026-08-28T12:00:00.000Z',
  freshLiveProbeRequired: true,
};

test('advance accepts hash-bound accessReviewApproval and validates proposedWave receipts', async () => {
  const approvalHash = 'c'.repeat(64);
  const frozenIdentity = {
    jobId: 88,
    memberPosition: 0,
    jobTitle: '😀'.repeat(300),
    companyName: '𐐷'.repeat(300),
    provider: 'greenhouse',
    requisitionUrl: 'https://boards.greenhouse.io/example/jobs/88',
  };
  const proposedWave = [{ ...frozenIdentity, accessKnowledge: sampleAccessKnowledge }];
  const accessProposal = {
    proposalId: 7,
    approvalHash,
    rationaleCode: 'access_review',
    knowledgeRevision: 1,
    evaluatedAt: '2026-08-28T12:00:00.000Z',
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    members: [{
      ...frozenIdentity,
      rationaleCode: 'ats_default_open',
      receiptHash: 'd'.repeat(64),
      accessKnowledge: sampleAccessKnowledge,
    }],
  };
  const proposalProgress = {
    target: 1,
    achievementCount: 0,
    completed: 0,
    durablyReviewReady: 0,
    submitted: 0,
    reservedReviewSlots: 0,
    currentlyFilling: 0,
    awaitingAnswer: 0,
    authParked: 0,
    excluded: 0,
    conflicted: 0,
    attempted: 0,
    remainingCandidates: 1,
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    queueExhausted: false,
    targetReached: false,
    nextAction: 'access_review',
    historicalProjection: { achievementCount: 0, completed: 0 },
    currentProjection: { durablyReviewReady: 0, submitted: 0 },
  };
  let requestCount = 0;
  const { registrations, calls } = registerRuntimeTools(() => {
    requestCount += 1;
    if (requestCount === 1) return {
      success: true,
      executionId: 41,
      createdWave: false,
      revision: 4,
      proposedWave,
      accessProposal,
      progress: proposalProgress,
    };
    return {
      success: true,
      executionId: 41,
      createdWave: true,
      batchId: 91,
      revision: 5,
      proposedWave,
      accessProposal,
      progress: { ...proposalProgress, nextAction: 'continue_current_wave' },
    };
  });
  const registration = registrations.get('trackly_advance_apply_execution');
  const idempotencyKey = 'access-review-approval-key-01';
  const proposal = await registration.handler(registration.schema.parse({
    executionId: 41,
    expectedRevision: 3,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'access-review-proposal-key-01',
  }));
  assert.equal(proposal.accessProposal.approvalHash, approvalHash);
  const result = await registration.handler(registration.schema.parse({
    executionId: 41,
    expectedRevision: 4,
    browserSurface: 'codex_in_app',
    idempotencyKey,
    accessReviewApproval: { jobIds: [88], approvalHash },
  }));
  assert.deepEqual(calls.at(-1).slice(0, 3), ['POST', '/api/jobscout/apply/executions/41/advance', {
    expectedRevision: 4,
    browserSurface: 'codex_in_app',
    accessReviewApproval: { jobIds: [88], approvalHash },
  }]);
  assert.deepEqual(result.proposedWave, proposedWave);
  assert.equal(result.progress.nextAction, 'continue_current_wave');
  await registration.handler(registration.schema.parse({
    executionId: 41,
    expectedRevision: 4,
    browserSurface: 'codex_in_app',
    idempotencyKey,
    accessReviewApproval: { jobIds: [88], approvalHash },
  }));
  const replayCallCount = calls.length;
  await assert.rejects(
    registration.handler(registration.schema.parse({
      executionId: 41,
      expectedRevision: 4,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'different-approval-replay-key',
      accessReviewApproval: { jobIds: [88], approvalHash },
    })),
    /exact returned proposal/i,
  );
  assert.equal(calls.length, replayCallCount);
  assert.throws(
    () => registration.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey,
      accessReviewApproval: { jobIds: [88, 88], approvalHash },
    }),
    /unique/i,
  );
  const leaky = registerRuntimeTools({
    success: true,
    proposedWave: [{
      ...frozenIdentity,
      accessKnowledge: sampleAccessKnowledge,
      pageText: 'do not leak',
    }],
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    leaky.handler(leaky.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey,
    })),
    z.ZodError,
  );

  const mismatchedIdentity = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal: {
      ...accessProposal,
      members: [{ ...accessProposal.members[0], companyName: 'Changed Co' }],
    },
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    mismatchedIdentity.handler(mismatchedIdentity.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'access-review-identity-key-01',
    })),
    /exact displayed frozen identities/,
  );

  const mismatchedAccessKnowledge = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal: {
      ...accessProposal,
      members: [{
        ...accessProposal.members[0],
        accessKnowledge: {
          ...sampleAccessKnowledge,
          observedAccess: {
            ...sampleAccessKnowledge.observedAccess,
            classification: 'varies',
          },
        },
      }],
    },
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    mismatchedAccessKnowledge.handler(mismatchedAccessKnowledge.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'access-review-knowledge-key-01',
    })),
    /exact displayed frozen identities/,
  );

  const mismatchedRationale = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal: {
      ...accessProposal,
      members: [{ ...accessProposal.members[0], rationaleCode: 'different_reason' }],
    },
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    mismatchedRationale.handler(mismatchedRationale.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'access-review-rationale-key-01',
    })),
    /exact displayed frozen identities/,
  );

  const duplicateBlockedPair = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal: {
      ...accessProposal,
      blockedJobDeferments: [
        { jobId: 99, defermentId: 12, scope: 'provider' },
        { jobId: 99, defermentId: 12, scope: 'provider' },
      ],
    },
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    duplicateBlockedPair.handler(duplicateBlockedPair.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'access-review-deferment-key-01',
    })),
    /unique job\/deferment pairs/,
  );

  const execution = {
    id: 41,
    userId: 7,
    mode: 'complete_next_n_accessible',
    targetCount: 1,
    orderingVersion: 3,
    queueSnapshotAt: '2026-08-28T12:00:00.000Z',
    originalSnapshotHash: 'e'.repeat(64),
    status: 'running',
    revision: 4,
    expiresAt: '2026-08-29T12:00:00.000Z',
    recoverableUntil: '2026-09-04T12:00:00.000Z',
    sourceExecutionId: null,
    sourceSnapshotHash: null,
    achievementLedgerEnabled: true,
    currentWave: null,
    unresolvedWaves: [],
  };
  const validGet = registerRuntimeTools({
    success: true,
    execution,
    proposedWave,
    accessProposal,
    progress: proposalProgress,
  }).registrations.get('trackly_get_apply_execution');
  assert.deepEqual(
    await validGet.handler(validGet.schema.parse({ executionId: 41 })),
    { success: true, execution, proposedWave, accessProposal, progress: proposalProgress },
  );

  let recoveryRequestCount = 0;
  const recovered = registerRuntimeTools(() => {
    recoveryRequestCount += 1;
    return recoveryRequestCount === 1
      ? { success: true, execution, proposedWave, accessProposal, progress: proposalProgress }
      : {
        success: true,
        executionId: 41,
        createdWave: true,
        batchId: 91,
        revision: 5,
        proposedWave,
        accessProposal,
        progress: { ...proposalProgress, nextAction: 'continue_current_wave' },
      };
  });
  await recovered.registrations.get('trackly_get_apply_execution').handler({ executionId: 41 });
  await recovered.registrations.get('trackly_advance_apply_execution').handler({
    executionId: 41,
    expectedRevision: 4,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'access-review-recovered-key-01',
    accessReviewApproval: { jobIds: [88], approvalHash },
  });
  assert.deepEqual(recovered.calls.at(-1).slice(0, 3), [
    'POST',
    '/api/jobscout/apply/executions/41/advance',
    {
      expectedRevision: 4,
      browserSurface: 'codex_in_app',
      accessReviewApproval: { jobIds: [88], approvalHash },
    },
  ]);

  const mismatchedGet = registerRuntimeTools({
    success: true,
    execution: { ...execution, id: 42 },
    proposedWave,
    accessProposal,
    progress: proposalProgress,
  }).registrations.get('trackly_get_apply_execution');
  await assert.rejects(
    mismatchedGet.handler(mismatchedGet.schema.parse({ executionId: 41 })),
    /requested execution id/,
  );

  const leakyGet = registerRuntimeTools({
    success: true,
    execution,
    proposedWave,
    accessProposal,
    progress: proposalProgress,
    applicantEmail: 'private@example.com',
  }).registrations.get('trackly_get_apply_execution');
  await assert.rejects(
    leakyGet.handler(leakyGet.schema.parse({ executionId: 41 })),
    z.ZodError,
  );

  const leakyOrdinaryGet = registerRuntimeTools({
    success: true,
    execution,
    progress: { ...proposalProgress, nextAction: 'advance' },
    applicantEmail: 'private@example.com',
  }).registrations.get('trackly_get_apply_execution');
  await assert.rejects(
    leakyOrdinaryGet.handler(leakyOrdinaryGet.schema.parse({ executionId: 41 })),
    z.ZodError,
  );

  const missingSimpleProposal = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    accessProposal,
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    missingSimpleProposal.handler(missingSimpleProposal.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'access-review-missing-simple-01',
    })),
    z.ZodError,
  );

  const unobserved = registerRuntimeTools(() => {
    throw new Error('approval write must not be sent');
  });
  await assert.rejects(
    unobserved.registrations.get('trackly_advance_apply_execution').handler({
      executionId: 41,
      expectedRevision: 4,
      browserSurface: 'codex_in_app',
      idempotencyKey,
      accessReviewApproval: { jobIds: [88], approvalHash },
    }),
    /exact returned proposal/i,
  );
  assert.deepEqual(unobserved.calls, []);

  const leakyEnvelope = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal,
    progress: proposalProgress,
    applicantEmail: 'private@example.com',
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    leakyEnvelope.handler(leakyEnvelope.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'access-review-leak-key-001',
    })),
    z.ZodError,
  );

  const leakyOrdinaryEnvelope = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    progress: { ...proposalProgress, nextAction: 'advance' },
    applicantEmail: 'private@example.com',
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    leakyOrdinaryEnvelope.handler(leakyOrdinaryEnvelope.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'ordinary-response-leak-key-01',
    })),
    z.ZodError,
  );

  const invalidArrayEnvelope = registerRuntimeTools([])
    .registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    invalidArrayEnvelope.handler(invalidArrayEnvelope.schema.parse({
      executionId: 41,
      expectedRevision: 3,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'invalid-array-response-key-01',
    })),
    z.ZodError,
  );

  const ordinary = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: true,
    batchId: 91,
    revision: 4,
    proposedWave,
    accessProposal,
    progress: { ...proposalProgress, nextAction: 'continue_current_wave' },
  });
  const ordinaryAdvance = ordinary.registrations.get('trackly_advance_apply_execution');
  await ordinaryAdvance.handler(ordinaryAdvance.schema.parse({
    executionId: 41,
    expectedRevision: 3,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'ordinary-proposal-key-0001',
  }));
  await assert.rejects(
    ordinaryAdvance.handler(ordinaryAdvance.schema.parse({
      executionId: 41,
      expectedRevision: 4,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'ordinary-approval-key-0001',
      accessReviewApproval: { jobIds: [88], approvalHash },
    })),
    /exact returned proposal/i,
  );
  assert.equal(ordinary.calls.length, 1);

  const stopped = registerRuntimeTools((method, route) => {
    if (route.endsWith('/advance')) return {
      success: true,
      executionId: 41,
      createdWave: false,
      revision: 4,
      proposedWave,
      accessProposal,
      progress: proposalProgress,
    };
    if (route.endsWith('/stop')) return { success: true, executionId: 41, status: 'stopped' };
    throw new Error(`unexpected request: ${method} ${route}`);
  });
  const stoppedAdvance = stopped.registrations.get('trackly_advance_apply_execution');
  await stoppedAdvance.handler(stoppedAdvance.schema.parse({
    executionId: 41,
    expectedRevision: 3,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'stopped-proposal-key-0001',
  }));
  const stop = stopped.registrations.get('trackly_stop_apply_execution');
  await stop.handler(stop.schema.parse({
    executionId: 41,
    expectedRevision: 4,
    idempotencyKey: 'stop-execution-key-0001',
  }));
  await assert.rejects(
    stoppedAdvance.handler(stoppedAdvance.schema.parse({
      executionId: 41,
      expectedRevision: 4,
      browserSurface: 'codex_in_app',
      idempotencyKey: 'stopped-approval-key-0001',
      accessReviewApproval: { jobIds: [88], approvalHash },
    })),
    /exact returned proposal/i,
  );
  assert.equal(stopped.calls.length, 2);
});

test('access-review validation bounds all-deferred proposals, ignores key order, and caches follow-up proposals', async () => {
  const frozenIdentity = {
    jobId: 88,
    memberPosition: 0,
    jobTitle: 'Product Manager',
    companyName: 'Example Co',
    provider: 'greenhouse',
    requisitionUrl: 'https://boards.greenhouse.io/example/jobs/88',
  };
  const approvalHash = 'c'.repeat(64);
  const followUpHash = 'e'.repeat(64);
  const proposedWave = [{ ...frozenIdentity, accessKnowledge: sampleAccessKnowledge }];
  const accessProposal = {
    proposalId: 7,
    approvalHash,
    rationaleCode: 'access_review',
    knowledgeRevision: 1,
    evaluatedAt: '2026-08-28T12:00:00.000Z',
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    members: [{
      ...frozenIdentity,
      rationaleCode: 'ats_default_open',
      receiptHash: 'd'.repeat(64),
      accessKnowledge: sampleAccessKnowledge,
    }],
  };
  const proposalProgress = {
    target: 1,
    achievementCount: 0,
    completed: 0,
    durablyReviewReady: 0,
    submitted: 0,
    reservedReviewSlots: 0,
    currentlyFilling: 0,
    awaitingAnswer: 0,
    authParked: 0,
    excluded: 0,
    conflicted: 0,
    attempted: 0,
    remainingCandidates: 1,
    availableCandidateCount: 1,
    deferredCandidateCount: 0,
    queueExhausted: false,
    targetReached: false,
    nextAction: 'access_review',
    historicalProjection: { achievementCount: 0, completed: 0 },
    currentProjection: { durablyReviewReady: 0, submitted: 0 },
  };
  const advanceInput = (overrides = {}) => ({
    executionId: 41,
    expectedRevision: 3,
    browserSurface: 'codex_in_app',
    idempotencyKey: 'access-review-test-key-0001',
    ...overrides,
  });

  const allDeferredProposal = {
    ...accessProposal,
    rationaleCode: 'all_candidates_user_deferred',
    availableCandidateCount: 0,
    deferredCandidateCount: 1,
    blockedJobDeferments: [{ jobId: 88, defermentId: 9, scope: 'job' }],
    members: [],
  };
  const allDeferred = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave: [],
    accessProposal: allDeferredProposal,
    progress: {
      ...proposalProgress,
      remainingCandidates: 1,
      availableCandidateCount: 0,
      deferredCandidateCount: 1,
    },
  }).registrations.get('trackly_advance_apply_execution');
  await assert.doesNotReject(allDeferred.handler(allDeferred.schema.parse(advanceInput())));

  const invalidTerminalMembers = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal: { ...allDeferredProposal, members: accessProposal.members },
    progress: { ...proposalProgress, availableCandidateCount: 0, deferredCandidateCount: 1 },
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(
    invalidTerminalMembers.handler(invalidTerminalMembers.schema.parse(advanceInput())),
    z.ZodError,
  );

  const invalidEmpty = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave: [],
    accessProposal: { ...accessProposal, members: [] },
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.rejects(invalidEmpty.handler(invalidEmpty.schema.parse(advanceInput())), z.ZodError);

  const missingDefermentMapping = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave: [],
    accessProposal: {
      ...allDeferredProposal,
      blockedJobDeferments: undefined,
    },
    progress: {
      ...proposalProgress,
      availableCandidateCount: 0,
      deferredCandidateCount: 1,
    },
  }).registrations.get('trackly_advance_apply_execution');
  await assert.doesNotReject(
    missingDefermentMapping.handler(missingDefermentMapping.schema.parse(advanceInput())),
  );

  const recoveryBlocked = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave: [],
    accessProposal: {
      ...allDeferredProposal,
      rationaleCode: 'recovery_blocked_by_user_deferment',
      availableCandidateCount: 2,
      deferredCandidateCount: 1,
      blockedJobDeferments: [{ jobId: 88, defermentId: 9, scope: 'job' }],
    },
    progress: {
      ...proposalProgress,
      availableCandidateCount: 2,
      deferredCandidateCount: 1,
    },
  }).registrations.get('trackly_advance_apply_execution');
  await assert.doesNotReject(recoveryBlocked.handler(recoveryBlocked.schema.parse(advanceInput())));

  const reorderedAccessKnowledge = {
    freshLiveProbeRequired: sampleAccessKnowledge.freshLiveProbeRequired,
    evaluatedAt: sampleAccessKnowledge.evaluatedAt,
    knowledgeRevision: sampleAccessKnowledge.knowledgeRevision,
    rationaleCode: sampleAccessKnowledge.rationaleCode,
    effectiveSchedulingEffect: sampleAccessKnowledge.effectiveSchedulingEffect,
    userPreference: sampleAccessKnowledge.userPreference,
    observedAccess: sampleAccessKnowledge.observedAccess,
  };
  const reordered = registerRuntimeTools({
    success: true,
    executionId: 41,
    createdWave: false,
    revision: 4,
    proposedWave,
    accessProposal: {
      ...accessProposal,
      members: [{ ...accessProposal.members[0], accessKnowledge: reorderedAccessKnowledge }],
    },
    progress: proposalProgress,
  }).registrations.get('trackly_advance_apply_execution');
  await assert.doesNotReject(reordered.handler(reordered.schema.parse(advanceInput())));

  const followUpProposal = {
    ...accessProposal,
    proposalId: 8,
    approvalHash: followUpHash,
    members: [{ ...accessProposal.members[0], receiptHash: 'f'.repeat(64) }],
  };
  let requestCount = 0;
  const followUp = registerRuntimeTools(() => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        success: true,
        executionId: 41,
        createdWave: false,
        revision: 4,
        proposedWave,
        accessProposal,
        progress: proposalProgress,
      };
    }
    if (requestCount === 2) {
      return {
        success: true,
        executionId: 41,
        createdWave: false,
        revision: 4,
        proposedWave,
        accessProposal: followUpProposal,
        progress: {
          ...proposalProgress,
          nextAction: 'continue_current_wave',
        },
      };
    }
    if (requestCount === 3) {
      return {
        success: true,
        executionId: 41,
        createdWave: false,
        revision: 5,
        proposedWave,
        accessProposal: followUpProposal,
        progress: { ...proposalProgress, nextAction: 'access_review' },
      };
    }
    return {
      success: true,
      executionId: 41,
      createdWave: true,
      batchId: 91,
      revision: 6,
      progress: { ...proposalProgress, nextAction: 'continue_current_wave' },
    };
  }).registrations.get('trackly_advance_apply_execution');
  await followUp.handler(followUp.schema.parse(advanceInput({
    idempotencyKey: 'first-proposal-test-key',
  })));
  await followUp.handler(followUp.schema.parse(advanceInput({
    expectedRevision: 4,
    idempotencyKey: 'first-approval-test-key',
    accessReviewApproval: { jobIds: [88], approvalHash },
  })));
  await followUp.handler(followUp.schema.parse(advanceInput({
    expectedRevision: 5,
    idempotencyKey: 'follow-up-proposal-test-key',
  })));
  await followUp.handler(followUp.schema.parse(advanceInput({
    expectedRevision: 5,
    idempotencyKey: 'follow-up-approval-test-key',
    accessReviewApproval: { jobIds: [88], approvalHash: followUpHash },
  })));
  assert.equal(requestCount, 4);

  const bounded = registerRuntimeTools((method, route) => {
    const executionId = Number(route.match(/\/executions\/(\d+)\/advance$/)?.[1]);
    if (!executionId) throw new Error(`unexpected request: ${method} ${route}`);
    return {
      success: true,
      executionId,
      createdWave: false,
      revision: 4,
      proposedWave,
      accessProposal,
      progress: proposalProgress,
    };
  });
  const boundedAdvance = bounded.registrations.get('trackly_advance_apply_execution');
  for (let executionId = 1; executionId <= 65; executionId += 1) {
    await boundedAdvance.handler(boundedAdvance.schema.parse({
      ...advanceInput({
        executionId,
        idempotencyKey: `bounded-proposal-seed-${executionId}`,
      }),
    }));
  }
  const callsBeforeEvictionCheck = bounded.calls.length;
  await assert.rejects(
    boundedAdvance.handler(boundedAdvance.schema.parse(advanceInput({
      executionId: 1,
      expectedRevision: 4,
      idempotencyKey: 'bounded-evicted-approval-key',
      accessReviewApproval: { jobIds: [88], approvalHash },
    }))),
    /exact returned proposal/i,
  );
  assert.equal(bounded.calls.length, callsBeforeEvictionCheck);
  await assert.doesNotReject(boundedAdvance.handler(boundedAdvance.schema.parse(advanceInput({
    executionId: 65,
    expectedRevision: 4,
    idempotencyKey: 'bounded-retained-approval-key',
    accessReviewApproval: { jobIds: [88], approvalHash },
  }))));

  const boundedReplay = registerRuntimeTools((method, route, body) => {
    const executionId = Number(route.match(/\/executions\/(\d+)\/advance$/)?.[1]);
    if (!executionId) throw new Error(`unexpected request: ${method} ${route}`);
    if (body.accessReviewApproval) {
      return {
        success: true,
        executionId,
        createdWave: true,
        batchId: 1000 + executionId,
        revision: 5,
        progress: { ...proposalProgress, nextAction: 'continue_current_wave' },
      };
    }
    return {
      success: true,
      executionId,
      createdWave: false,
      revision: 4,
      proposedWave,
      accessProposal,
      progress: proposalProgress,
    };
  });
  const boundedReplayAdvance = boundedReplay.registrations.get('trackly_advance_apply_execution');
  for (let executionId = 1; executionId <= 65; executionId += 1) {
    const seed = boundedReplayAdvance.schema.parse(advanceInput({
      executionId,
      idempotencyKey: `bounded-replay-seed-${executionId}`,
    }));
    await boundedReplayAdvance.handler(seed);
    const approval = boundedReplayAdvance.schema.parse(advanceInput({
      executionId,
      expectedRevision: 4,
      idempotencyKey: `bounded-replay-approval-${executionId}`,
      accessReviewApproval: { jobIds: [88], approvalHash },
    }));
    await boundedReplayAdvance.handler(approval);
  }
  const replayCallsBeforeEvictionCheck = boundedReplay.calls.length;
  const evictedReplay = boundedReplayAdvance.schema.parse(advanceInput({
    executionId: 1,
    expectedRevision: 4,
    idempotencyKey: 'bounded-replay-approval-1',
    accessReviewApproval: { jobIds: [88], approvalHash },
  }));
  await assert.rejects(
    boundedReplayAdvance.handler(evictedReplay),
    /exact returned proposal/i,
  );
  assert.equal(boundedReplay.calls.length, replayCallsBeforeEvictionCheck);
  const retainedReplay = boundedReplayAdvance.schema.parse(advanceInput({
    executionId: 65,
    expectedRevision: 4,
    idempotencyKey: 'bounded-replay-approval-65',
    accessReviewApproval: { jobIds: [88], approvalHash },
  }));
  await assert.doesNotReject(boundedReplayAdvance.handler(retainedReplay));
});

test('access deferment tools use jobId-derived scopes and discovered ids', async () => {
  const deferment = {
    id: 9,
    jobId: 88,
    scope: 'company',
    createdAt: '2026-08-28T12:00:00.000Z',
    persistsUntilCleared: true,
  };
  const clearReceipt = {
    ...deferment,
    clearedAt: '2026-08-28T12:05:00.000Z',
    persistsUntilCleared: false,
  };
  let clearCalls = 0;
  const { registrations, calls } = registerRuntimeTools((method, route) => {
    if (method === 'GET') {
      return { success: true, deferments: [deferment] };
    }
    if (route.endsWith('/clear')) {
      clearCalls += 1;
      return { success: true, replay: clearCalls > 1, deferment: clearReceipt };
    }
    return { success: true, replay: false, deferment };
  });
  const idempotencyKey = 'access-deferment-key-0001';
  assert.deepEqual(contract.constants.applyAccessDefermentScopes, [
    'job', 'company', 'provider',
  ]);
  await registrations.get('trackly_list_apply_access_deferments').handler({});
  await registrations.get('trackly_defer_apply_access').handler(
    registrations.get('trackly_defer_apply_access').schema.parse({
      jobId: 88,
      scope: 'company',
      idempotencyKey,
    }),
  );
  const cleared = await registrations.get('trackly_clear_apply_access_deferment').handler(
    registrations.get('trackly_clear_apply_access_deferment').schema.parse({
      defermentId: 9,
      idempotencyKey,
    }),
  );
  assert.deepEqual(cleared.deferment, clearReceipt);
  assert.deepEqual(calls[0].slice(0, 2), ['GET', '/api/jobscout/apply/access-deferments']);
  assert.deepEqual(calls[1].slice(0, 3), ['POST', '/api/jobscout/apply/access-deferments', {
    jobId: 88,
    scope: 'company',
  }]);
  assert.deepEqual(calls[2].slice(0, 3), [
    'POST',
    '/api/jobscout/apply/access-deferments/9/clear',
    {},
  ]);
  const clear = registrations.get('trackly_clear_apply_access_deferment');
  const replayed = await clear.handler(clear.schema.parse({
    defermentId: 9,
    idempotencyKey,
  }));
  assert.equal(replayed.replay, true);
  assert.equal(clearCalls, 2);
  await assert.rejects(
    clear.handler(clear.schema.parse({
      defermentId: 9,
      idempotencyKey: 'new-after-clear-key-0001',
    })),
    /latest list or defer response/,
  );
  assert.equal(clearCalls, 2);
  const providerDefer = registerRuntimeTools({
    success: true,
    replay: false,
    deferment: { ...deferment, scope: 'provider' },
  }).registrations.get('trackly_defer_apply_access');
  await assert.doesNotReject(providerDefer.handler(providerDefer.schema.parse({
    jobId: 88,
    scope: 'provider',
    idempotencyKey: 'provider-deferment-key-0001',
  })));
  const parsedProviderDefer = providerDefer.schema.parse({
    jobId: 88,
    scope: 'provider',
    provider: 'workday',
    idempotencyKey: 'provider-deferment-key-0002',
  });
  assert.equal(Object.hasOwn(parsedProviderDefer, 'provider'), false);
  await providerDefer.handler(parsedProviderDefer);
  const undiscovered = registerRuntimeTools({ success: true, replay: false, deferment });
  await assert.rejects(
    undiscovered.registrations.get('trackly_clear_apply_access_deferment').handler({
      defermentId: 9,
      idempotencyKey,
    }),
    /latest list or defer response/,
  );
  const mismatchedDefer = registerRuntimeTools({
    success: true,
    replay: false,
    deferment: { ...deferment, jobId: 99 },
  }).registrations.get('trackly_defer_apply_access');
  await assert.rejects(
    mismatchedDefer.handler(mismatchedDefer.schema.parse({
      jobId: 88,
      scope: 'company',
      idempotencyKey,
    })),
    /does not match the requested job and scope/,
  );
  const mismatchedClear = registerRuntimeTools((method) => {
    if (method === 'GET') {
      return { success: true, deferments: [deferment] };
    }
    return {
      success: true,
      replay: false,
      deferment: { ...clearReceipt, id: 12 },
    };
  });
  await mismatchedClear.registrations.get('trackly_list_apply_access_deferments').handler({});
  await assert.rejects(
    mismatchedClear.registrations.get('trackly_clear_apply_access_deferment').handler(
      mismatchedClear.registrations.get('trackly_clear_apply_access_deferment').schema.parse({
        defermentId: 9,
        idempotencyKey,
      }),
    ),
    /does not match the requested deferment id/,
  );

  const invalidClear = registerRuntimeTools((method) => (
    method === 'GET'
      ? { success: true, deferments: [deferment] }
      : { success: true, replay: false, deferment }
  ));
  await invalidClear.registrations.get('trackly_list_apply_access_deferments').handler({});
  await assert.rejects(
    invalidClear.registrations.get('trackly_clear_apply_access_deferment').handler(
      invalidClear.registrations.get('trackly_clear_apply_access_deferment').schema.parse({
        defermentId: 9,
        idempotencyKey,
      }),
    ),
    /invalid_literal|Expected false/i,
  );

  const leakyDeferment = registerRuntimeTools({
    success: true,
    replay: false,
    deferment,
    applicantEmail: 'private@example.com',
  }).registrations.get('trackly_defer_apply_access');
  await assert.rejects(
    leakyDeferment.handler(leakyDeferment.schema.parse({
      jobId: 88,
      scope: 'company',
      idempotencyKey: 'access-deferment-leak-0001',
    })),
    z.ZodError,
  );
});

test('access deferment discovery accepts the backend active-deferment limit', async () => {
  const deferments = Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    jobId: 1000 + index,
    scope: 'job',
    createdAt: '2026-09-05T12:00:00.000Z',
    persistsUntilCleared: true,
  }));
  const atLimit = registerRuntimeTools({ success: true, deferments })
    .registrations.get('trackly_list_apply_access_deferments');
  await assert.doesNotReject(atLimit.handler({}));

  const aboveLimit = registerRuntimeTools({
    success: true,
    deferments: [...deferments, { ...deferments[0], id: 21, jobId: 1020 }],
  }).registrations.get('trackly_list_apply_access_deferments');
  await assert.rejects(aboveLimit.handler({}), z.ZodError);
});
