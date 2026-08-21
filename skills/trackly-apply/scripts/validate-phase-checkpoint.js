#!/usr/bin/env node
'use strict';

const ACCESS_STATES = new Set([
  'applicant_fields_reached',
  'authentication_required',
  'account_creation_required',
  'otp_required',
  'captcha_before_form',
  'captcha_at_submit',
  'inactive',
  'manual_only',
  'unknown_unobservable',
]);

const CLEANUP_PREFERENCES = new Set([
  'never',
  'submitted_only',
  'submitted_and_probe_blockers',
]);

const TAB_STATES = new Set(['open', 'closure_unverified', 'closed_verified']);
const MAX_RECEIPT_BYTES = 64 * 1024;
const LINEAGE_FIELDS = ['executionId', 'memberId', 'jobId', 'runId', 'inspectionEpoch'];

const PHASE_FIELDS = {
  selection: new Set([
    'latestExplicitTarget',
    'approvedJobIds',
    'approvalRecorded',
    'noFormMutationBeforeApproval',
    'queueExhausted',
  ]),
  access: new Set([
    'memberId',
    'classification',
    'exactRequisitionVerified',
    'originAndTenantVerified',
    'nonMutatingProbe',
    'privateDataEntered',
    'applicantControlsObserved',
  ]),
  fill: new Set([
    'executionId',
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
    'fallbackWritingGateRan',
    'questionPacketTrueGapsOnly',
  ]),
  review: new Set([
    'executionId',
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
    'memberId',
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
  if (!Number.isInteger(receipt[field]) || receipt[field] < 0) {
    errors.push(`${field} must be a non-negative integer`);
  }
}

function validateCurrentLineage(errors, receipt, expectedContext) {
  for (const field of LINEAGE_FIELDS) requireTracklyId(errors, receipt, field);
  if (!expectedContext || typeof expectedContext !== 'object' || Array.isArray(expectedContext)) {
    errors.push('expectedContext is required');
    return;
  }
  for (const field of LINEAGE_FIELDS) {
    if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
  }
  if (!Array.isArray(expectedContext.approvedJobIds)
      || expectedContext.approvedJobIds.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    errors.push('expectedContext.approvedJobIds must contain positive safe integers');
  } else if (!expectedContext.approvedJobIds.includes(receipt.jobId)) {
    errors.push('jobId must belong to expectedContext.approvedJobIds');
  }
}

function validateSelection(receipt) {
  const errors = [];
  if (!Number.isInteger(receipt.latestExplicitTarget)
      || receipt.latestExplicitTarget < 1
      || receipt.latestExplicitTarget > 20) {
    errors.push('latestExplicitTarget must be an integer from 1 to 20');
  }
  if (!Array.isArray(receipt.approvedJobIds)) {
    errors.push('approvedJobIds must be an array');
  } else if (receipt.approvedJobIds.length > receipt.latestExplicitTarget) {
    errors.push('approvedJobIds must not exceed latestExplicitTarget');
  } else {
    const normalized = receipt.approvedJobIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    if (normalized.length !== receipt.approvedJobIds.length) errors.push('approvedJobIds must contain positive safe integers');
    if (new Set(normalized).size !== normalized.length) errors.push('approvedJobIds must be unique');
    if (Number.isInteger(receipt.latestExplicitTarget)
        && normalized.length < receipt.latestExplicitTarget
        && receipt.queueExhausted !== true) {
      errors.push('approvedJobIds may be below latestExplicitTarget only when queueExhausted is true');
    }
  }
  requireTrue(errors, receipt, 'approvalRecorded');
  requireTrue(errors, receipt, 'noFormMutationBeforeApproval');
  if (typeof receipt.queueExhausted !== 'boolean') errors.push('queueExhausted must be a boolean');
  return errors;
}

function validateAccess(receipt) {
  const errors = [];
  requireTracklyId(errors, receipt, 'memberId');
  if (!ACCESS_STATES.has(receipt.classification)) errors.push('classification must be a terminal access state');
  requireTrue(errors, receipt, 'exactRequisitionVerified');
  requireTrue(errors, receipt, 'originAndTenantVerified');
  requireTrue(errors, receipt, 'nonMutatingProbe');
  requireFalse(errors, receipt, 'privateDataEntered');
  if (['applicant_fields_reached', 'captcha_at_submit'].includes(receipt.classification)) {
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
  if (Number.isInteger(receipt.visibleControlCount)
      && Number.isInteger(receipt.committedControlCount)
      && Number.isInteger(receipt.typedExceptionCount)
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
  if (typeof receipt.fallbackWritingGateRan !== 'boolean') errors.push('fallbackWritingGateRan must be a boolean');
  if (receipt.writingPresent === true) {
    if (receipt.localWritingGate !== 'passed') errors.push('localWritingGate must pass when writing is present');
    if (receipt.humanizerAvailability === 'available') {
      requireTrue(errors, receipt, 'humanizerRan');
      requireFalse(errors, receipt, 'fallbackWritingGateRan');
    } else if (receipt.humanizerAvailability === 'unavailable') {
      requireFalse(errors, receipt, 'humanizerRan');
      requireTrue(errors, receipt, 'fallbackWritingGateRan');
    } else {
      errors.push('humanizerAvailability must be available or unavailable when writing is present');
    }
  } else if (receipt.writingPresent === false) {
    if (receipt.localWritingGate !== 'not_applicable') errors.push('localWritingGate must be not_applicable when writing is absent');
    if (receipt.humanizerAvailability !== 'not_applicable') errors.push('humanizerAvailability must be not_applicable when writing is absent');
    requireFalse(errors, receipt, 'humanizerRan');
    requireFalse(errors, receipt, 'fallbackWritingGateRan');
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

function validateReconciliation(receipt) {
  const errors = [];
  requireTracklyId(errors, receipt, 'memberId');
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

async function main() {
  const phase = process.argv[2];
  let input = '';
  let inputBytes = 0;
  for await (const chunk of process.stdin) {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > MAX_RECEIPT_BYTES) {
      process.stderr.write(`receipt must be at most ${MAX_RECEIPT_BYTES} bytes\n`);
      process.exitCode = 1;
      return;
    }
    input += chunk;
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
  const errors = validateCheckpoint(phase, envelope.receipt, envelope.expectedContext);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${phase} checkpoint valid\n`);
}

if (require.main === module) main();

module.exports = { validateCheckpoint };
