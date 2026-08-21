#!/usr/bin/env node
'use strict';

const { StringDecoder } = require('node:string_decoder');

const ACCESS_STATES = new Set([
  'accessible',
  'authentication_required',
  'account_creation_required',
  'otp_required',
  'captcha_before_form',
  'captcha_at_submit',
  'manual_only',
  'unknown_unobservable',
]);

const CLEANUP_PREFERENCES = new Set([
  'never',
  'submitted_only',
  'submitted_and_probe_blockers',
]);

const TAB_STATES = new Set(['open', 'missing', 'closure_unverified', 'closed_verified']);
const MAX_RECEIPT_BYTES = 64 * 1024;
const WORK_MODES = new Set(['accessible_execution', 'fixed_inspection']);
const COMMON_LINEAGE_FIELDS = ['workMode', 'batchId', 'memberId', 'jobId', 'runId', 'inspectionEpoch'];

const PHASE_FIELDS = {
  selection: new Set([
    'workMode',
    'executionId',
    'batchId',
    'latestExplicitTarget',
    'approvedJobIds',
    'approvalRecorded',
    'noFormMutationBeforeApproval',
    'queueExhausted',
  ]),
  access: new Set([
    'workMode',
    'executionId',
    'batchId',
    'memberId',
    'jobId',
    'runId',
    'inspectionEpoch',
    'classification',
    'exactRequisitionVerified',
    'originPolicyVerified',
    'nonMutatingProbe',
    'privateDataEntered',
    'applicantControlsObserved',
  ]),
  fill: new Set([
    'workMode',
    'executionId',
    'batchId',
    'memberId',
    'jobId',
    'runId',
    'inspectionEpoch',
    'visibleControlCount',
    'committedControlCount',
    'typedExceptionCount',
    'knownOmissionCount',
    'knownFieldsFilledBeforeQuestions',
    'parserSensitiveFieldsRechecked',
    'educationAndEmploymentVerified',
    'writingPresent',
    'localWritingGate',
    'humanizerAvailability',
    'humanizerRan',
    'humanizerFallbackUsed',
    'questionPacketTrueGapsOnly',
  ]),
  review: new Set([
    'workMode',
    'executionId',
    'batchId',
    'memberId',
    'jobId',
    'runId',
    'inspectionEpoch',
    'finalIntegrityPassed',
    'truthConfirmationRecorded',
    'submitActivated',
    'reviewTabPreserved',
    'userVisibleHandoffProven',
  ]),
  reconciliation: new Set([
    'workMode',
    'executionId',
    'batchId',
    'memberId',
    'jobId',
    'runId',
    'inspectionEpoch',
    'positiveSubmissionEvidenceRecorded',
    'memberLifecycle',
    'tracklyJobStatus',
    'cleanupPreference',
    'browserTabStatus',
    'completeTabInventoryRecorded',
    'closeReceiptRecorded',
    'postCloseUnionAbsenceProven',
  ]),
};

function requireTrue(errors, receipt, field) {
  if (receipt[field] !== true) errors.push(`${field} must be true`);
}

function requireFalse(errors, receipt, field) {
  if (receipt[field] !== false) errors.push(`${field} must be false`);
}

function requireTracklyId(errors, receipt, field) {
  if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 1) {
    errors.push(`${field} must be a positive safe integer`);
  }
}

function requireCount(errors, receipt, field) {
  if (!Number.isSafeInteger(receipt[field]) || receipt[field] < 0) {
    errors.push(`${field} must be a non-negative safe integer`);
  }
}

function validateCurrentLineage(errors, receipt, expectedContext, jobSetField = 'approvedJobIds') {
  if (!WORK_MODES.has(receipt.workMode)) errors.push('workMode must be accessible_execution or fixed_inspection');
  for (const field of ['batchId', 'memberId', 'jobId', 'runId']) requireTracklyId(errors, receipt, field);
  if (!Number.isSafeInteger(receipt.inspectionEpoch) || receipt.inspectionEpoch < 0) {
    errors.push('inspectionEpoch must be a non-negative safe integer');
  }
  if (receipt.workMode === 'accessible_execution') {
    requireTracklyId(errors, receipt, 'executionId');
  } else if (receipt.workMode === 'fixed_inspection' && Object.hasOwn(receipt, 'executionId')) {
    errors.push('executionId must be omitted for fixed_inspection');
  }
  if (!expectedContext || typeof expectedContext !== 'object' || Array.isArray(expectedContext)) {
    errors.push('expectedContext is required');
    return;
  }
  const expectedFields = new Set([...COMMON_LINEAGE_FIELDS, jobSetField]);
  if (receipt.workMode === 'accessible_execution') expectedFields.add('executionId');
  for (const field of Object.keys(expectedContext)) {
    if (!expectedFields.has(field)) errors.push(`unexpected expectedContext field: ${field}`);
  }
  for (const field of COMMON_LINEAGE_FIELDS) {
    if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
  }
  if (receipt.workMode === 'accessible_execution'
      && receipt.executionId !== expectedContext.executionId) {
    errors.push('executionId must match expectedContext');
  }
  if (receipt.workMode === 'fixed_inspection' && Object.hasOwn(expectedContext, 'executionId')) {
    errors.push('expectedContext.executionId must be omitted for fixed_inspection');
  }
  if (!Array.isArray(expectedContext[jobSetField])
      || expectedContext[jobSetField].some((id) => !Number.isSafeInteger(id) || id < 1)) {
    errors.push(`expectedContext.${jobSetField} must contain positive safe integers`);
  } else if (!expectedContext[jobSetField].includes(receipt.jobId)) {
    errors.push(`jobId must belong to expectedContext.${jobSetField}`);
  }
}

function validateSelection(receipt, expectedContext) {
  const errors = [];
  if (!WORK_MODES.has(receipt.workMode)) {
    errors.push('workMode must be accessible_execution or fixed_inspection');
  }
  requireTracklyId(errors, receipt, 'batchId');
  if (receipt.workMode === 'accessible_execution') {
    requireTracklyId(errors, receipt, 'executionId');
  } else if (receipt.workMode === 'fixed_inspection' && Object.hasOwn(receipt, 'executionId')) {
    errors.push('executionId must be omitted for fixed_inspection');
  }
  const maximumTarget = receipt.workMode === 'fixed_inspection' ? 100 : 20;
  if (!Number.isInteger(receipt.latestExplicitTarget)
      || receipt.latestExplicitTarget < 1
      || receipt.latestExplicitTarget > maximumTarget) {
    errors.push(`latestExplicitTarget must be an integer from 1 to ${maximumTarget} for ${receipt.workMode || 'the selected work mode'}`);
  }
  if (!Array.isArray(receipt.approvedJobIds)) {
    errors.push('approvedJobIds must be an array');
  } else {
    if (Number.isInteger(receipt.latestExplicitTarget)
        && receipt.approvedJobIds.length > receipt.latestExplicitTarget) {
      errors.push('approvedJobIds must not exceed latestExplicitTarget');
    }
    const normalized = receipt.approvedJobIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    if (normalized.length !== receipt.approvedJobIds.length) errors.push('approvedJobIds must contain positive safe integers');
    if (new Set(normalized).size !== normalized.length) errors.push('approvedJobIds must be unique');
    if (receipt.approvedJobIds.length === 0 && receipt.queueExhausted !== true) {
      errors.push('approvedJobIds may be empty only when queueExhausted is true');
    }
  }
  requireTrue(errors, receipt, 'approvalRecorded');
  requireTrue(errors, receipt, 'noFormMutationBeforeApproval');
  if (typeof receipt.queueExhausted !== 'boolean') errors.push('queueExhausted must be a boolean');
  if (!expectedContext || typeof expectedContext !== 'object' || Array.isArray(expectedContext)) {
    errors.push('expectedContext is required');
    return errors;
  }
  const expectedFields = new Set(['workMode', 'batchId', 'latestExplicitTarget', 'selectableJobIds', 'queueExhausted']);
  if (receipt.workMode === 'accessible_execution') expectedFields.add('executionId');
  for (const field of Object.keys(expectedContext)) {
    if (!expectedFields.has(field)) errors.push(`unexpected expectedContext field: ${field}`);
  }
  if (receipt.workMode !== expectedContext.workMode) errors.push('workMode must match expectedContext');
  if (receipt.batchId !== expectedContext.batchId) errors.push('batchId must match expectedContext');
  if (receipt.workMode === 'accessible_execution'
      && receipt.executionId !== expectedContext.executionId) {
    errors.push('executionId must match expectedContext');
  }
  if (receipt.workMode === 'fixed_inspection' && Object.hasOwn(expectedContext, 'executionId')) {
    errors.push('expectedContext.executionId must be omitted for fixed_inspection');
  }
  if (receipt.latestExplicitTarget !== expectedContext.latestExplicitTarget) {
    errors.push('latestExplicitTarget must match expectedContext');
  }
  if (receipt.queueExhausted !== expectedContext.queueExhausted) {
    errors.push('queueExhausted must match expectedContext');
  }
  if (!Array.isArray(expectedContext.selectableJobIds)
      || expectedContext.selectableJobIds.some((id) => !Number.isSafeInteger(id) || id < 1)
      || new Set(expectedContext.selectableJobIds).size !== expectedContext.selectableJobIds.length) {
    errors.push('expectedContext.selectableJobIds must contain unique positive safe integers');
  } else if (Array.isArray(receipt.approvedJobIds)
      && receipt.approvedJobIds.some((id) => !expectedContext.selectableJobIds.includes(id))) {
    errors.push('approvedJobIds must belong to expectedContext.selectableJobIds');
  }
  return errors;
}

function validateAccess(receipt, expectedContext) {
  const errors = [];
  validateCurrentLineage(errors, receipt, expectedContext, 'waveJobIds');
  if (!ACCESS_STATES.has(receipt.classification)) errors.push('classification must be a terminal access state');
  requireTrue(errors, receipt, 'exactRequisitionVerified');
  requireTrue(errors, receipt, 'originPolicyVerified');
  requireTrue(errors, receipt, 'nonMutatingProbe');
  requireFalse(errors, receipt, 'privateDataEntered');
  if (['accessible', 'captcha_at_submit'].includes(receipt.classification)) {
    requireTrue(errors, receipt, 'applicantControlsObserved');
  } else {
    requireFalse(errors, receipt, 'applicantControlsObserved');
  }
  return errors;
}

function validateFill(receipt, expectedContext) {
  const errors = [];
  validateCurrentLineage(errors, receipt, expectedContext);
  for (const field of ['visibleControlCount', 'committedControlCount', 'typedExceptionCount', 'knownOmissionCount']) {
    requireCount(errors, receipt, field);
  }
  if (Number.isSafeInteger(receipt.visibleControlCount)
      && Number.isSafeInteger(receipt.committedControlCount)
      && Number.isSafeInteger(receipt.typedExceptionCount)
      && receipt.committedControlCount + receipt.typedExceptionCount !== receipt.visibleControlCount) {
    errors.push('committedControlCount plus typedExceptionCount must equal visibleControlCount');
  }
  if (receipt.knownOmissionCount !== 0) errors.push('knownOmissionCount must be 0');
  requireTrue(errors, receipt, 'knownFieldsFilledBeforeQuestions');
  requireTrue(errors, receipt, 'parserSensitiveFieldsRechecked');
  requireTrue(errors, receipt, 'educationAndEmploymentVerified');
  if (typeof receipt.writingPresent !== 'boolean') errors.push('writingPresent must be a boolean');
  if (!['passed', 'not_applicable'].includes(receipt.localWritingGate)) {
    errors.push('localWritingGate must be passed or not_applicable');
  }
  if (!['available', 'unavailable', 'not_applicable'].includes(receipt.humanizerAvailability)) {
    errors.push('humanizerAvailability is invalid');
  }
  if (typeof receipt.humanizerRan !== 'boolean') errors.push('humanizerRan must be a boolean');
  if (typeof receipt.humanizerFallbackUsed !== 'boolean') errors.push('humanizerFallbackUsed must be a boolean');
  if (receipt.writingPresent === true) {
    if (receipt.localWritingGate !== 'passed') errors.push('localWritingGate must pass when writing is present');
    if (receipt.humanizerAvailability === 'available') {
      requireTrue(errors, receipt, 'humanizerRan');
      requireFalse(errors, receipt, 'humanizerFallbackUsed');
    } else if (receipt.humanizerAvailability === 'unavailable') {
      requireFalse(errors, receipt, 'humanizerRan');
      requireTrue(errors, receipt, 'humanizerFallbackUsed');
    } else {
      errors.push('humanizerAvailability must be available or unavailable when writing is present');
    }
  } else if (receipt.writingPresent === false) {
    if (receipt.localWritingGate !== 'not_applicable') errors.push('localWritingGate must be not_applicable when writing is absent');
    if (receipt.humanizerAvailability !== 'not_applicable') errors.push('humanizerAvailability must be not_applicable when writing is absent');
    requireFalse(errors, receipt, 'humanizerRan');
    requireFalse(errors, receipt, 'humanizerFallbackUsed');
  }
  requireTrue(errors, receipt, 'questionPacketTrueGapsOnly');
  return errors;
}

function validateReview(receipt, expectedContext) {
  const errors = [];
  validateCurrentLineage(errors, receipt, expectedContext);
  requireTrue(errors, receipt, 'finalIntegrityPassed');
  requireTrue(errors, receipt, 'truthConfirmationRecorded');
  requireFalse(errors, receipt, 'submitActivated');
  requireTrue(errors, receipt, 'reviewTabPreserved');
  requireTrue(errors, receipt, 'userVisibleHandoffProven');
  return errors;
}

function validateReconciliation(receipt, expectedContext) {
  const errors = [];
  validateCurrentLineage(errors, receipt, expectedContext);
  requireTrue(errors, receipt, 'positiveSubmissionEvidenceRecorded');
  if (receipt.memberLifecycle !== 'submitted') errors.push('memberLifecycle must be submitted');
  if (receipt.tracklyJobStatus !== 'applied_confirmed') errors.push('tracklyJobStatus must be applied_confirmed');
  if (!CLEANUP_PREFERENCES.has(receipt.cleanupPreference)) errors.push('cleanupPreference is invalid');
  if (!TAB_STATES.has(receipt.browserTabStatus)) errors.push('browserTabStatus is invalid');
  if (receipt.cleanupPreference === 'never' && receipt.browserTabStatus === 'closed_verified') {
    errors.push('browserTabStatus cannot be closed_verified when cleanupPreference is never');
  }
  if (receipt.browserTabStatus === 'closed_verified') {
    requireTrue(errors, receipt, 'completeTabInventoryRecorded');
    requireTrue(errors, receipt, 'closeReceiptRecorded');
    requireTrue(errors, receipt, 'postCloseUnionAbsenceProven');
  } else {
    for (const field of ['completeTabInventoryRecorded', 'closeReceiptRecorded', 'postCloseUnionAbsenceProven']) {
      if (Object.hasOwn(receipt, field) && receipt[field] !== false) {
        errors.push(`${field} must be false or omitted unless browserTabStatus is closed_verified`);
      }
    }
  }
  return errors;
}

const VALIDATORS = {
  selection: validateSelection,
  access: validateAccess,
  fill: validateFill,
  review: validateReview,
  reconciliation: validateReconciliation,
};

function validateCheckpoint(phase, receipt, expectedContext) {
  if (!Object.hasOwn(VALIDATORS, phase)) return [`unknown phase: ${phase}`];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['receipt must be a JSON object'];
  const unexpectedFields = Object.keys(receipt)
    .filter((field) => !PHASE_FIELDS[phase].has(field))
    .map((field) => `unexpected field: ${field}`);
  return [...unexpectedFields, ...VALIDATORS[phase](receipt, expectedContext)];
}

async function readReceiptInput(stream) {
  const decoder = new StringDecoder('utf8');
  let input = '';
  let inputBytes = 0;
  let oversized = false;
  for await (const chunk of stream) {
    if (oversized) continue;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBytes += bytes.length;
    if (inputBytes > MAX_RECEIPT_BYTES) {
      oversized = true;
      input = '';
      continue;
    }
    input += decoder.write(bytes);
  }
  if (!oversized) input += decoder.end();
  return { input, oversized };
}

async function main() {
  const phase = process.argv[2];
  if (process.stdin.isTTY) {
    process.stderr.write('receipt envelope must be provided on standard input\n');
    process.exitCode = 1;
    return;
  }
  const { input, oversized } = await readReceiptInput(process.stdin);
  if (oversized) {
    process.stderr.write(`receipt must be at most ${MAX_RECEIPT_BYTES} bytes\n`);
    process.exitCode = 1;
    return;
  }
  let envelope;
  try {
    envelope = JSON.parse(input);
  } catch (_) {
    process.stderr.write('receipt must be valid JSON\n');
    process.exitCode = 1;
    return;
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || !Object.hasOwn(envelope, 'receipt')) {
    process.stderr.write('input must be an envelope with receipt and optional expectedContext\n');
    process.exitCode = 1;
    return;
  }
  const unexpectedEnvelopeFields = Object.keys(envelope)
    .filter((field) => !['receipt', 'expectedContext'].includes(field));
  if (unexpectedEnvelopeFields.length > 0) {
    process.stderr.write(`${unexpectedEnvelopeFields.map((field) => `unexpected envelope field: ${field}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const errors = validateCheckpoint(phase, envelope.receipt, envelope.expectedContext);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${phase} checkpoint valid\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('unable to read receipt\n');
    process.exitCode = 1;
  });
}

module.exports = { readReceiptInput, validateCheckpoint };
