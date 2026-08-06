'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  APPLY_UPLOAD_CAPABILITIES,
  APPLY_UPLOAD_STAGES,
  validateApplyResumeUpload,
} = require('../lib/apply-upload');

const capabilities = Object.fromEntries(APPLY_UPLOAD_CAPABILITIES.map((name) => [name, true]));
const passedEvents = APPLY_UPLOAD_STAGES.map((stage) => ({ stage, outcome: 'passed' }));

test('exact upload proof sequence is safe', () => {
  assert.deepEqual(validateApplyResumeUpload({ capabilities, events: passedEvents }), {
    safeToClaimAttachment: true,
    failureCodes: [],
    lastPassedStage: 'parser_fields_rechecked',
    completedStageCount: 6,
    requiredStageCount: 6,
  });
});

test('missing capability fails closed without browser work', () => {
  const result = validateApplyResumeUpload({
    capabilities: { ...capabilities, chooserArming: false },
    events: passedEvents,
  });
  assert.equal(result.safeToClaimAttachment, false);
  assert.deepEqual(result.failureCodes, ['upload_capability_unavailable']);
});

test('out-of-order and duplicate upload events fail closed', () => {
  const events = [passedEvents[0], passedEvents[2], passedEvents[2], ...passedEvents.slice(3)];
  const result = validateApplyResumeUpload({ capabilities, events });
  assert.equal(result.safeToClaimAttachment, false);
  assert.ok(result.failureCodes.includes('upload_stage_out_of_order'));
  assert.ok(result.failureCodes.includes('upload_stage_duplicate'));
  assert.ok(result.failureCodes.includes('upload_stage_missing'));
});

test('stable browser failure code is preserved', () => {
  const events = passedEvents.map((event) => (
    event.stage === 'set_files_succeeded'
      ? { stage: event.stage, outcome: 'failed', failureCode: 'set_files_failed' }
      : event
  ));
  const result = validateApplyResumeUpload({ capabilities, events });
  assert.equal(result.safeToClaimAttachment, false);
  assert.ok(result.failureCodes.includes('set_files_failed'));
  assert.equal(result.lastPassedStage, 'file_chooser_opened');
  assert.equal(result.completedStageCount, 3);
});
