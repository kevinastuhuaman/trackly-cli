'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const skill = read('skills/trackly-apply/SKILL.md');

test('skill loads the operational reliability gates before browser work', () => {
  assert.match(skill, /references\/operational-checkpoints\.md/);
  assert.match(skill, /references\/access-probe\.md/);
  assert.match(skill, /references\/performance-telemetry\.md/);
  assert.match(skill, /before selecting, probing, or mutating/i);
});

test('operational checklist preserves target, approval, fill order, and manual submit', () => {
  const checkpoints = read('skills/trackly-apply/references/operational-checkpoints.md');
  assert.match(checkpoints, /latest explicit target/i);
  assert.match(checkpoints, /hard target/i);
  assert.match(checkpoints, /exact jobs[\s\S]*approved[\s\S]*before[\s\S]*form mutation/i);
  assert.match(checkpoints, /fill[\s\S]*known[\s\S]*before[\s\S]*question packet/i);
  assert.match(checkpoints, /Humanizer/i);
  assert.match(checkpoints, /never[\s\S]*Submit/i);
  assert.match(checkpoints, /preserve[\s\S]*review-ready[\s\S]*tabs/i);
  assert.match(checkpoints, /application lifecycle[\s\S]*Trackly job status[\s\S]*browser tab status/i);
});

test('access probe requires actual applicant controls and typed terminal states', () => {
  const probe = read('skills/trackly-apply/references/access-probe.md');
  for (const state of [
    'requisition_loaded',
    'apply_entry_found',
    'intermediate_apply_shell',
    'applicant_fields_reached',
    'authentication_required',
    'account_creation_required',
    'otp_required',
    'captcha_before_form',
    'captcha_at_submit',
    'inactive',
    'manual_only',
    'unknown_unobservable',
  ]) assert.match(probe, new RegExp(`\\b${state}\\b`));

  assert.match(probe, /count[\s\S]*accessible[\s\S]*only after[\s\S]*applicant_fields_reached/i);
  assert.match(probe, /Workday[\s\S]*Create Account[\s\S]*account_creation_required/i);
  assert.match(probe, /Amazon[\s\S]*sign[- ]in[\s\S]*authentication_required/i);
  assert.match(probe, /Adobe|Microsoft/i);
  assert.match(probe, /never[\s\S]*private data[\s\S]*probe/i);
  assert.match(probe, /inactive[\s\S]*contract 3\.7\.3[\s\S]*unknown_unobservable/i);
});

test('phase checkpoint validator accepts complete value-free receipts and rejects unsafe ones', () => {
  const { validateCheckpoint } = require('../skills/trackly-apply/scripts/validate-phase-checkpoint');

  const selection = {
    workMode: 'accessible_execution',
    latestExplicitTarget: 20,
    approvedJobIds: [101, 102],
    approvalRecorded: true,
    noFormMutationBeforeApproval: true,
    queueExhausted: true,
  };
  assert.deepEqual(validateCheckpoint('selection', selection), []);
  assert.deepEqual(validateCheckpoint('selection', {
    ...selection,
    workMode: 'fixed_inspection',
    latestExplicitTarget: 100,
    approvedJobIds: Array.from({ length: 100 }, (_, index) => index + 1),
  }), []);
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      latestExplicitTarget: 21,
    }).join('\n'),
    /1 to 20 for accessible_execution/
  );
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      workMode: 'fixed_inspection',
      latestExplicitTarget: 101,
    }).join('\n'),
    /1 to 100 for fixed_inspection/
  );
  assert.deepEqual(validateCheckpoint('selection', { ...selection, approvedJobIds: [] }), []);
  assert.deepEqual(validateCheckpoint('selection', {
    ...selection,
    latestExplicitTarget: 5,
    approvedJobIds: [101, 102],
    queueExhausted: false,
  }), []);
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      latestExplicitTarget: 1,
      approvedJobIds: [101, 'private@example.com'],
    }).join('\n'),
    /must not exceed latestExplicitTarget/
  );
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      latestExplicitTarget: 1,
      approvedJobIds: [101, 'private@example.com'],
    }).join('\n'),
    /positive safe integers/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, approvedJobIds: [], queueExhausted: false }).join('\n'),
    /queueExhausted/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, noFormMutationBeforeApproval: false }).join('\n'),
    /noFormMutationBeforeApproval/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, email: 'private@example.com' }).join('\n'),
    /unexpected field: email/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, approvedJobIds: ['private@example.com'] }).join('\n'),
    /positive safe integers/
  );
  assert.doesNotMatch(
    validateCheckpoint('selection', {
      ...selection,
      approvedJobIds: ['private@example.com'],
      queueExhausted: false,
    }).join('\n'),
    /may be empty/
  );

  const expectedContext = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    memberId: 201,
    jobId: 101,
    runId: 401,
    inspectionEpoch: 2,
    approvedJobIds: [101, 102],
  };
  const accessContext = {
    ...expectedContext,
    waveJobIds: [101, 103],
  };
  delete accessContext.approvedJobIds;
  const access = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    memberId: 201,
    jobId: 101,
    runId: 401,
    inspectionEpoch: 2,
    classification: 'accessible',
    exactRequisitionVerified: true,
    originAndTenantVerified: true,
    nonMutatingProbe: true,
    privateDataEntered: false,
    applicantControlsObserved: true,
  };
  assert.deepEqual(validateCheckpoint('access', access, accessContext), []);
  assert.match(
    validateCheckpoint('access', { ...access, applicantControlsObserved: false }, accessContext).join('\n'),
    /applicantControlsObserved/
  );
  assert.match(
    validateCheckpoint('access', {
      ...access,
      classification: 'authentication_required',
      applicantControlsObserved: true,
    }, accessContext).join('\n'),
    /applicantControlsObserved/
  );
  assert.deepEqual(validateCheckpoint('access', {
    ...access,
    classification: 'captcha_at_submit',
  }, accessContext), []);
  assert.match(
    validateCheckpoint('access', { ...access, memberId: 'https://private.example/path' }, accessContext).join('\n'),
    /positive safe integer/
  );
  assert.match(
    validateCheckpoint('access', { ...access, jobId: 103 }, accessContext).join('\n'),
    /jobId must match expectedContext/
  );
  assert.match(
    validateCheckpoint('access', access, { ...accessContext, waveJobIds: [103] }).join('\n'),
    /jobId must belong to expectedContext\.waveJobIds/
  );
  assert.match(
    validateCheckpoint('access', {
      ...access,
      classification: 'applicant_fields_reached',
    }, accessContext).join('\n'),
    /classification must be a terminal access state/
  );
  assert.match(
    validateCheckpoint('access', {
      ...access,
      classification: 'inactive',
      applicantControlsObserved: false,
    }, accessContext).join('\n'),
    /classification must be a terminal access state/
  );
  const blockerAccess = {
    ...access,
    memberId: 203,
    jobId: 103,
    runId: 403,
    classification: 'authentication_required',
    applicantControlsObserved: false,
  };
  const blockerContext = {
    ...accessContext,
    memberId: 203,
    jobId: 103,
    runId: 403,
  };
  assert.deepEqual(validateCheckpoint('access', blockerAccess, blockerContext), []);

  const fill = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    memberId: 201,
    jobId: 101,
    runId: 401,
    inspectionEpoch: 2,
    visibleControlCount: 12,
    committedControlCount: 11,
    typedExceptionCount: 1,
    knownOmissionCount: 0,
    knownFieldsFilledBeforeQuestions: true,
    parserSensitiveFieldsRechecked: true,
    educationAndEmploymentVerified: true,
    writingPresent: true,
    localWritingGate: 'passed',
    humanizerAvailability: 'available',
    humanizerRan: true,
    humanizerFallbackUsed: false,
    questionPacketTrueGapsOnly: true,
  };
  assert.deepEqual(validateCheckpoint('fill', fill, expectedContext), []);
  const { executionId: omittedFillExecutionId, ...fixedFill } = fill;
  const { executionId: omittedContextExecutionId, ...fixedExpectedContext } = expectedContext;
  assert.equal(omittedFillExecutionId, 301);
  assert.equal(omittedContextExecutionId, 301);
  assert.deepEqual(validateCheckpoint('fill', {
    ...fixedFill,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
  }, {
    ...fixedExpectedContext,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
  }), []);
  assert.match(
    validateCheckpoint('fill', { ...fill, knownOmissionCount: 1 }, expectedContext).join('\n'),
    /knownOmissionCount/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      visibleControlCount: Number.MAX_SAFE_INTEGER + 1,
    }, expectedContext).join('\n'),
    /visibleControlCount must be a non-negative safe integer/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, inspectionEpoch: 3 }, expectedContext).join('\n'),
    /inspectionEpoch must match expectedContext/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, jobId: 103 }, { ...expectedContext, jobId: 103 }).join('\n'),
    /jobId must belong to expectedContext\.approvedJobIds/
  );
  assert.match(
    validateCheckpoint('fill', fill, { ...expectedContext, email: 'private@example.com' }).join('\n'),
    /unexpected expectedContext field: email/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, humanizerRan: false }, expectedContext).join('\n'),
    /humanizerRan/
  );
  assert.deepEqual(validateCheckpoint('fill', {
    ...fill,
    humanizerAvailability: 'unavailable',
    humanizerRan: false,
    humanizerFallbackUsed: true,
  }, expectedContext), []);
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      humanizerAvailability: 'not_applicable',
      humanizerRan: false,
      humanizerFallbackUsed: false,
    }, expectedContext).join('\n'),
    /must be available or unavailable when writing is present/
  );

  const review = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    memberId: 201,
    jobId: 101,
    runId: 401,
    inspectionEpoch: 2,
    finalIntegrityPassed: true,
    truthConfirmationRecorded: true,
    submitActivated: false,
    reviewTabPreserved: true,
    userVisibleHandoffProven: true,
  };
  assert.deepEqual(validateCheckpoint('review', review, expectedContext), []);
  const { executionId: omittedReviewExecutionId, ...fixedReview } = review;
  assert.equal(omittedReviewExecutionId, 301);
  assert.deepEqual(validateCheckpoint('review', {
    ...fixedReview,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
  }, {
    ...fixedExpectedContext,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
  }), []);
  assert.match(
    validateCheckpoint('review', { ...review, submitActivated: true }, expectedContext).join('\n'),
    /submitActivated/
  );
  assert.match(
    validateCheckpoint('review', { ...review, inspectionEpoch: 3 }, expectedContext).join('\n'),
    /inspectionEpoch must match expectedContext/
  );

  const reconciliation = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    memberId: 201,
    jobId: 101,
    runId: 401,
    inspectionEpoch: 2,
    positiveSubmissionEvidenceRecorded: true,
    memberLifecycle: 'submitted',
    tracklyJobStatus: 'applied_confirmed',
    cleanupPreference: 'submitted_only',
    browserTabStatus: 'closed_verified',
    completeTabInventoryRecorded: true,
    closeReceiptRecorded: true,
    postCloseUnionAbsenceProven: true,
  };
  assert.deepEqual(validateCheckpoint('reconciliation', reconciliation, expectedContext), []);
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, tracklyJobStatus: 'applied' }, expectedContext).join('\n'),
    /tracklyJobStatus/
  );
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, completeTabInventoryRecorded: false }, expectedContext).join('\n'),
    /completeTabInventoryRecorded/
  );
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, cleanupPreference: 'never' }, expectedContext).join('\n'),
    /cannot be closed_verified/
  );
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, runId: 402 }, expectedContext).join('\n'),
    /runId must match expectedContext/
  );
  for (const browserTabStatus of ['open', 'closure_unverified']) {
    const pending = { ...reconciliation, browserTabStatus };
    delete pending.completeTabInventoryRecorded;
    delete pending.closeReceiptRecorded;
    delete pending.postCloseUnionAbsenceProven;
    assert.deepEqual(validateCheckpoint('reconciliation', pending, expectedContext), []);
  }
  assert.match(
    validateCheckpoint('reconciliation', {
      ...reconciliation,
      browserTabStatus: 'open',
      closeReceiptRecorded: 'private text',
    }, expectedContext).join('\n'),
    /closeReceiptRecorded must be false or omitted/
  );
});

test('phase checkpoint CLI rejects oversized receipts before parsing', () => {
  const validator = path.join(root, 'skills/trackly-apply/scripts/validate-phase-checkpoint.js');
  const result = spawnSync(process.execPath, [validator, 'selection'], {
    input: ' '.repeat((64 * 1024) + 1),
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most 65536 bytes/);
});

test('phase checkpoint CLI decodes multi-byte UTF-8 split across writes', async () => {
  const validator = path.join(root, 'skills/trackly-apply/scripts/validate-phase-checkpoint.js');
  const { readReceiptInput } = require('../skills/trackly-apply/scripts/validate-phase-checkpoint');
  const payload = Buffer.from(JSON.stringify({
    receipt: {
      workMode: 'accessible_execution',
      latestExplicitTarget: 1,
      approvedJobIds: [101],
      approvalRecorded: true,
      noFormMutationBeforeApproval: true,
      queueExhausted: false,
      é: true,
    },
  }), 'utf8');
  const marker = Buffer.from('é', 'utf8');
  const markerIndex = payload.indexOf(marker);
  assert.notEqual(markerIndex, -1);

  async function* splitInput() {
    yield payload.subarray(0, markerIndex + 1);
    yield payload.subarray(markerIndex + 1);
  }
  const decoded = await readReceiptInput(splitInput());
  assert.equal(decoded.oversized, false);
  assert.equal(decoded.input, payload.toString('utf8'));

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [validator, 'selection'], { cwd: path.dirname(root) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.write(payload.subarray(0, markerIndex + 1));
    child.stdin.end(payload.subarray(markerIndex + 1));
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected field: é/);
  assert.doesNotMatch(result.stderr, /valid JSON/);
});

test('phase checkpoint CLI validates envelopes from a non-skill working directory', () => {
  const validator = path.join(root, 'skills/trackly-apply/scripts/validate-phase-checkpoint.js');
  const receipt = {
    workMode: 'accessible_execution',
    latestExplicitTarget: 1,
    approvedJobIds: [101],
    approvalRecorded: true,
    noFormMutationBeforeApproval: true,
    queueExhausted: false,
  };
  const valid = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt }),
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /selection checkpoint valid/);

  const invalid = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt: { ...receipt, approvalRecorded: false } }),
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /approvalRecorded/);

  const malformed = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: '{',
    encoding: 'utf8',
  });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /valid JSON/);

  const unknownPhase = spawnSync(process.execPath, [validator, 'audit'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt }),
    encoding: 'utf8',
  });
  assert.equal(unknownPhase.status, 1);
  assert.match(unknownPhase.stderr, /unknown phase: audit/);

  const arrayReceipt = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt: [] }),
    encoding: 'utf8',
  });
  assert.equal(arrayReceipt.status, 1);
  assert.match(arrayReceipt.stderr, /receipt must be a JSON object/);

  const noReceipt = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ expectedContext: {} }),
    encoding: 'utf8',
  });
  assert.equal(noReceipt.status, 1);
  assert.match(noReceipt.stderr, /envelope with receipt/);

  const extraEnvelopeField = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt, rawAnswer: 'private text' }),
    encoding: 'utf8',
  });
  assert.equal(extraEnvelopeField.status, 1);
  assert.match(extraEnvelopeField.stderr, /unexpected envelope field: rawAnswer/);

  const selectionContext = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt, expectedContext: {} }),
    encoding: 'utf8',
  });
  assert.equal(selectionContext.status, 1);
  assert.match(selectionContext.stderr, /expectedContext must be omitted for selection/);
});

test('performance guidance permits value-free schema reuse but forbids answer caching', () => {
  const performance = read('skills/trackly-apply/references/performance-telemetry.md');
  assert.match(performance, /value-free schema cache/i);
  assert.match(performance, /never cache[\s\S]*raw answers/i);
  assert.match(performance, /profile revision[\s\S]*form schema fingerprint[\s\S]*inspection epoch/i);
  assert.match(performance, /identical normalized control fingerprints/i);
  assert.match(performance, /apply_form_schema_cache_hit/);
  assert.match(performance, /apply_known_field_omitted/);
  assert.match(performance, /never[\s\S]*raw labels[\s\S]*answers[\s\S]*URLs/i);
});

test('writing pipeline makes humanization automatic with a self-contained fallback', () => {
  const writing = read('skills/trackly-apply/references/application-writing.md');
  assert.match(writing, /Humanizer[\s\S]*available[\s\S]*must/i);
  assert.match(writing, /self-contained[\s\S]*fallback/i);
  assert.match(writing, /no em dash/i);
  assert.match(writing, /unsupported\s+claim/i);
  assert.match(writing, /After Humanizer[\s\S]*new draft[\s\S]*rebuild[\s\S]*exact final revision/i);
  assert.match(skill, /run Humanizer[\s\S]*new revision[\s\S]*rebuild[\s\S]*then call `trackly_lint_application_text`/i);
});

test('public plugin adaptation preserves the operational reliability gates', () => {
  const pluginSkill = read('plugins/trackly/skills/trackly-apply/SKILL.md');
  const pluginOperations = read('plugins/trackly/skills/trackly-apply/references/operational-checkpoints.md');
  const pluginProbe = read('plugins/trackly/skills/trackly-apply/references/access-probe.md');

  assert.match(pluginSkill, /references\/operational-checkpoints\.md/);
  assert.match(pluginSkill, /references\/access-probe\.md/);
  assert.match(pluginOperations, /latest explicit target/i);
  assert.match(pluginOperations, /exact jobs[\s\S]*approved[\s\S]*before[\s\S]*form mutation/i);
  assert.match(pluginOperations, /fill[\s\S]*known[\s\S]*before[\s\S]*question packet/i);
  assert.match(pluginOperations, /Humanizer/i);
  assert.match(pluginOperations, /submitted[\s\S]*applied_confirmed[\s\S]*closed_verified/i);
  assert.ok(
    pluginOperations.indexOf('**Access:**') < pluginOperations.indexOf('**Selection:**'),
    'access proof must precede accessible-set approval',
  );
  assert.match(pluginProbe, /applicant_fields_reached/);
  assert.match(pluginProbe, /intermediate_apply_shell/);
  assert.match(pluginProbe, /authentication_required/);
  assert.match(pluginProbe, /account_creation_required/);
  assert.match(pluginProbe, /never[\s\S]*private\s+data[\s\S]*probe/i);
});

test('MCP reliability prompt surfaces the new operating gates before execution', () => {
  const tools = read('mcp/apply-tools.js');
  assert.match(tools, /skill 4\.7\.0 reliability gate:[^']*latest explicit target/i);
  assert.match(tools, /skill 4\.7\.0 reliability gate:[^']*genuine applicant fields/i);
  assert.match(tools, /skill 4\.7\.0 reliability gate:[^']*exact accessible jobs[^']*before form mutation/i);
  assert.match(tools, /skill 4\.7\.0 reliability gate:[^']*deterministic fields[^']*question packet/i);
  assert.match(tools, /skill 4\.7\.0 reliability gate:[^']*phase checkpoint/i);
  assert.match(tools, /run the skill 4\.7\.0 deterministic answer resolver/i);
  assert.doesNotMatch(tools, /run the skill 4\.6 deterministic answer resolver/i);
});
