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
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMITTED_CONTROL_FIELDS = [
  'filledExactProfile',
  'filledSafeDerivation',
  'filledSupportedDraft',
  'preservedUserEdit',
];
const EXCEPTION_CONTROL_FIELDS = [
  'missingFact',
  'liveConsent',
  'authenticationBlocker',
  'unobservableCommit',
  'unsupportedControl',
  'notApplicable',
];
const CONTROL_ACCOUNTING_FIELDS = [
  ...COMMITTED_CONTROL_FIELDS,
  ...EXCEPTION_CONTROL_FIELDS,
];
const ANSWER_SCOPE_FIELDS = ['run', 'question', 'office', 'jurisdiction', 'company', 'provider', 'global'];
const HISTORY_FIELDS = [
  'canonicalEducationRecordCount',
  'accountedEducationRecordCount',
  'canonicalEmploymentPositionCount',
  'accountedEmploymentPositionCount',
  'educationOrderVerified',
  'employmentOrderVerified',
  'datePrecisionInvented',
  'educationReconciliationFingerprint',
  'employmentReconciliationFingerprint',
];
const RESUME_AUDIT_FIELDS = [
  'control',
  'mode',
  'approval',
  'preAttachVerification',
  'attachmentCommit',
  'filenameVerification',
  'parserRecheck',
  'finalSweep',
];
const EMPLOYER_APPLICATION_STATES = new Set([
  'not_opened',
  'access_probed',
  'form_reached',
  'partially_filled',
  'needs_answers',
  'review_state_prepared',
  'manually_submitted',
  'ats_success_observed',
  'blocked',
]);
const TRACKLY_MEMBER_STATES = new Set([
  'reserved',
  'inspecting',
  'needs_input',
  'review_ready',
  'awaiting_manual_submit',
  'submitted',
  'blocked',
  'parked',
  'stopped',
]);
const TRACKLY_JOB_STATES = new Set(['new', 'check_later', 'not_interested', 'applied_confirmed', 'unknown']);
const BROWSER_HANDOFF_STATES = new Set([
  'no_known_tab',
  'controller_owned',
  'user_inventory',
  'visible',
  'durable_handoff_proven',
  'missing',
  'closure_unverified',
]);

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
    'profileRevision',
    'visibleControlCount',
    'committedControlCount',
    'typedExceptionCount',
    'controlAccounting',
    'formInventoryFingerprint',
    'knownOmissionCount',
    'knownFieldsFilledBeforeQuestions',
    'answerLookupCompleted',
    'answerLookupScopeCounts',
    'answerLookupFingerprint',
    'parserSensitiveFieldsRechecked',
    'educationAndEmploymentVerified',
    'historyReconciliation',
    'resumeAudit',
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
    'profileRevision',
    'formInventoryFingerprint',
    'finalIntegrityPassed',
    'truthConfirmationRecorded',
    'submitActivated',
    'reviewTabPreserved',
    'userVisibleHandoffProven',
    'checkpointAction',
    'continuationAllowed',
    'resolvedActionCount',
    'resolvedActionIdsFingerprint',
    'checkpointStatus',
    'checkpointMemberVersion',
    'checkpointInspectionEpoch',
    'checkpointLifecycle',
    'checkpointActionCount',
    'checkpointActionIdsFingerprint',
  ]),
  handoff: new Set([
    'workMode',
    'executionId',
    'batchId',
    'memberId',
    'jobId',
    'runId',
    'inspectionEpoch',
    'employerApplicationState',
    'tracklyMemberState',
    'tracklyJobState',
    'browserTabState',
    'handoffVisibility',
    'reviewReadyClaimed',
    'browserBindingHash',
    'handoffEvidenceFingerprint',
    'handoffEvidenceType',
    'checkpointStatus',
    'checkpointMemberVersion',
    'checkpointInspectionEpoch',
    'checkpointLifecycle',
    'checkpointAction',
    'checkpointActionCount',
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

function requireFingerprint(errors, value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    errors.push(`${field} must be a lowercase SHA-256 fingerprint`);
  }
}

function requireExactObject(errors, value, field, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${field} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowedFields.includes(key)) errors.push(`${field} contains an unexpected field`);
  }
  return true;
}

function validateCurrentLineage(
  errors,
  receipt,
  expectedContext,
  jobSetField = 'approvedJobIds',
  additionalExpectedFields = [],
) {
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
  const expectedFields = new Set([...COMMON_LINEAGE_FIELDS, jobSetField, ...additionalExpectedFields]);
  if (receipt.workMode === 'accessible_execution') expectedFields.add('executionId');
  for (const field of Object.keys(expectedContext)) {
    if (!expectedFields.has(field)) errors.push('expectedContext contains an unexpected field');
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
    errors.push(`latestExplicitTarget must be an integer from 1 to ${maximumTarget} for the selected work mode`);
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
    if (!expectedFields.has(field)) errors.push('expectedContext contains an unexpected field');
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
  validateCurrentLineage(errors, receipt, expectedContext, 'approvedJobIds', [
    'profileRevision',
    'canonicalEducationRecordCount',
    'canonicalEmploymentPositionCount',
    'formInventoryFingerprint',
    'resumeControl',
  ]);
  if (expectedContext && typeof expectedContext === 'object' && !Array.isArray(expectedContext)) {
    if (receipt.workMode === 'accessible_execution') {
      requireTracklyId(errors, receipt, 'profileRevision');
      requireTracklyId(errors, expectedContext, 'profileRevision');
    } else {
      requireCount(errors, receipt, 'profileRevision');
      requireCount(errors, expectedContext, 'profileRevision');
    }
    if (receipt.profileRevision !== expectedContext.profileRevision) {
      errors.push('profileRevision must match expectedContext');
    }
    requireCount(errors, expectedContext, 'canonicalEducationRecordCount');
    requireCount(errors, expectedContext, 'canonicalEmploymentPositionCount');
    requireFingerprint(errors, expectedContext.formInventoryFingerprint, 'expectedContext.formInventoryFingerprint');
    if (!['required', 'optional', 'absent'].includes(expectedContext.resumeControl)) {
      errors.push('expectedContext.resumeControl must be required, optional, or absent');
    }
  }
  for (const field of ['visibleControlCount', 'committedControlCount', 'typedExceptionCount', 'knownOmissionCount']) {
    requireCount(errors, receipt, field);
  }
  if (receipt.visibleControlCount === 0) errors.push('visibleControlCount must be at least 1 for a fill checkpoint');
  if (Number.isSafeInteger(receipt.visibleControlCount)
      && Number.isSafeInteger(receipt.committedControlCount)
      && Number.isSafeInteger(receipt.typedExceptionCount)
      && receipt.committedControlCount + receipt.typedExceptionCount !== receipt.visibleControlCount) {
    errors.push('committedControlCount plus typedExceptionCount must equal visibleControlCount');
  }
  if (requireExactObject(errors, receipt.controlAccounting, 'controlAccounting', CONTROL_ACCOUNTING_FIELDS)) {
    for (const field of CONTROL_ACCOUNTING_FIELDS) requireCount(errors, receipt.controlAccounting, field);
    const accountingCount = CONTROL_ACCOUNTING_FIELDS
      .reduce((total, field) => total + (Number.isSafeInteger(receipt.controlAccounting[field]) ? receipt.controlAccounting[field] : 0), 0);
    const committedCount = COMMITTED_CONTROL_FIELDS
      .reduce((total, field) => total + (Number.isSafeInteger(receipt.controlAccounting[field]) ? receipt.controlAccounting[field] : 0), 0);
    const exceptionCount = EXCEPTION_CONTROL_FIELDS
      .reduce((total, field) => total + (Number.isSafeInteger(receipt.controlAccounting[field]) ? receipt.controlAccounting[field] : 0), 0);
    if (Number.isSafeInteger(receipt.visibleControlCount) && accountingCount !== receipt.visibleControlCount) {
      errors.push('controlAccounting counts must equal visibleControlCount');
    }
    if (Number.isSafeInteger(receipt.committedControlCount) && committedCount !== receipt.committedControlCount) {
      errors.push('committed control accounting must equal committedControlCount');
    }
    if (Number.isSafeInteger(receipt.typedExceptionCount) && exceptionCount !== receipt.typedExceptionCount) {
      errors.push('typed exception accounting must equal typedExceptionCount');
    }
  }
  requireFingerprint(errors, receipt.formInventoryFingerprint, 'formInventoryFingerprint');
  if (receipt.formInventoryFingerprint !== expectedContext?.formInventoryFingerprint) {
    errors.push('formInventoryFingerprint must match expectedContext');
  }
  if (receipt.knownOmissionCount !== 0) errors.push('knownOmissionCount must be 0');
  requireTrue(errors, receipt, 'knownFieldsFilledBeforeQuestions');
  requireTrue(errors, receipt, 'answerLookupCompleted');
  if (requireExactObject(errors, receipt.answerLookupScopeCounts, 'answerLookupScopeCounts', ANSWER_SCOPE_FIELDS)) {
    for (const field of ANSWER_SCOPE_FIELDS) requireCount(errors, receipt.answerLookupScopeCounts, field);
  }
  requireFingerprint(errors, receipt.answerLookupFingerprint, 'answerLookupFingerprint');
  requireTrue(errors, receipt, 'parserSensitiveFieldsRechecked');
  requireTrue(errors, receipt, 'educationAndEmploymentVerified');
  if (requireExactObject(errors, receipt.historyReconciliation, 'historyReconciliation', HISTORY_FIELDS)) {
    for (const field of [
      'canonicalEducationRecordCount',
      'accountedEducationRecordCount',
      'canonicalEmploymentPositionCount',
      'accountedEmploymentPositionCount',
    ]) requireCount(errors, receipt.historyReconciliation, field);
    if (receipt.historyReconciliation.canonicalEducationRecordCount
        !== receipt.historyReconciliation.accountedEducationRecordCount) {
      errors.push('education record counts must match');
    }
    if (receipt.historyReconciliation.canonicalEmploymentPositionCount
        !== receipt.historyReconciliation.accountedEmploymentPositionCount) {
      errors.push('employment position counts must match');
    }
    if (receipt.historyReconciliation.canonicalEducationRecordCount
        !== expectedContext?.canonicalEducationRecordCount) {
      errors.push('canonical education record count must match expectedContext');
    }
    if (receipt.historyReconciliation.canonicalEmploymentPositionCount
        !== expectedContext?.canonicalEmploymentPositionCount) {
      errors.push('canonical employment position count must match expectedContext');
    }
    requireTrue(errors, receipt.historyReconciliation, 'educationOrderVerified');
    requireTrue(errors, receipt.historyReconciliation, 'employmentOrderVerified');
    requireFalse(errors, receipt.historyReconciliation, 'datePrecisionInvented');
    requireFingerprint(errors, receipt.historyReconciliation.educationReconciliationFingerprint, 'historyReconciliation.educationReconciliationFingerprint');
    requireFingerprint(errors, receipt.historyReconciliation.employmentReconciliationFingerprint, 'historyReconciliation.employmentReconciliationFingerprint');
  }
  if (requireExactObject(errors, receipt.resumeAudit, 'resumeAudit', RESUME_AUDIT_FIELDS)) {
    if (!['required', 'optional', 'absent'].includes(receipt.resumeAudit.control)) {
      errors.push('resumeAudit.control must be required, optional, or absent');
    }
    if (receipt.resumeAudit.control !== expectedContext?.resumeControl) {
      errors.push('resumeAudit.control must match expectedContext');
    }
    const attachmentExpected = ['required', 'optional'].includes(receipt.resumeAudit.control);
    const allowedModes = attachmentExpected
      ? ['automated_verified', 'manual_unbound']
      : ['not_applicable'];
    if (!allowedModes.includes(receipt.resumeAudit.mode)) {
      errors.push('resumeAudit.mode must match the declared control mode');
    }
    const expectedOutcomes = attachmentExpected
      ? {
        approval: 'passed',
        preAttachVerification: receipt.resumeAudit.mode === 'manual_unbound' ? 'not_applicable' : 'passed',
        attachmentCommit: receipt.resumeAudit.mode === 'manual_unbound' ? 'user_confirmed' : 'passed',
        filenameVerification: 'passed',
        parserRecheck: 'passed',
        finalSweep: 'passed',
      }
      : Object.fromEntries(RESUME_AUDIT_FIELDS.slice(2).map((field) => [field, 'not_applicable']));
    for (const [field, expected] of Object.entries(expectedOutcomes)) {
      if (receipt.resumeAudit[field] !== expected) {
        errors.push(`resumeAudit.${field} must match the declared control mode`);
      }
    }
  }
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

function validateReview(receipt, expectedContext, priorFill) {
  const errors = [];
  const fillBaselineFields = [
    'profileRevision',
    'formInventoryFingerprint',
  ];
  const resolutionFields = [
    'resolvedActionCount',
    'resolvedActionIdsFingerprint',
  ];
  const checkpointFields = [
    'checkpointAction',
    'continuationAllowed',
    'checkpointStatus',
    'checkpointMemberVersion',
    'checkpointInspectionEpoch',
    'checkpointLifecycle',
    'checkpointActionCount',
    'checkpointActionIdsFingerprint',
  ];
  validateCurrentLineage(
    errors,
    receipt,
    expectedContext,
    'approvedJobIds',
    [...fillBaselineFields, ...resolutionFields, ...checkpointFields],
  );
  if (receipt.workMode === 'accessible_execution') {
    requireTracklyId(errors, receipt, 'profileRevision');
  } else {
    requireCount(errors, receipt, 'profileRevision');
  }
  requireFingerprint(errors, receipt.formInventoryFingerprint, 'formInventoryFingerprint');
  if (!priorFill || typeof priorFill !== 'object' || Array.isArray(priorFill)) {
    errors.push('priorFill is required for review');
  } else {
    const priorFillFields = Object.keys(priorFill);
    if (priorFillFields.length !== 2
        || !priorFillFields.includes('receipt')
        || !priorFillFields.includes('expectedContext')) {
      errors.push('priorFill must contain only receipt and expectedContext');
    } else {
      const priorFillErrors = validateCheckpoint(
        'fill',
        priorFill.receipt,
        priorFill.expectedContext,
      );
      errors.push(...priorFillErrors.map((error) => `priorFill: ${error}`));
      if (priorFill.receipt && typeof priorFill.receipt === 'object' && !Array.isArray(priorFill.receipt)) {
        const lineageFields = [...COMMON_LINEAGE_FIELDS];
        if (receipt.workMode === 'accessible_execution') lineageFields.push('executionId');
        for (const field of [...lineageFields, ...fillBaselineFields]) {
          if (receipt[field] !== priorFill.receipt[field]) {
            errors.push(`${field} must match the validated priorFill receipt`);
          }
        }
      }
    }
  }
  requireTrue(errors, receipt, 'finalIntegrityPassed');
  requireTrue(errors, receipt, 'truthConfirmationRecorded');
  requireFalse(errors, receipt, 'submitActivated');
  requireTrue(errors, receipt, 'reviewTabPreserved');
  requireTrue(errors, receipt, 'userVisibleHandoffProven');
  if (receipt.checkpointAction !== 'review/manual_submit') {
    errors.push('checkpointAction must be review/manual_submit');
  }
  if (receipt.continuationAllowed !== false) {
    errors.push('continuationAllowed must be false for review/manual_submit');
  }
  requireCount(errors, receipt, 'resolvedActionCount');
  requireFingerprint(errors, receipt.resolvedActionIdsFingerprint, 'resolvedActionIdsFingerprint');
  if (!['recorded', 'replayed'].includes(receipt.checkpointStatus)) {
    errors.push('checkpointStatus must be recorded or replayed');
  }
  requireTracklyId(errors, receipt, 'checkpointMemberVersion');
  if (!Number.isSafeInteger(receipt.checkpointInspectionEpoch) || receipt.checkpointInspectionEpoch < 0) {
    errors.push('checkpointInspectionEpoch must be a non-negative safe integer');
  }
  if (receipt.checkpointInspectionEpoch !== receipt.inspectionEpoch) {
    errors.push('checkpointInspectionEpoch must equal inspectionEpoch');
  }
  if (receipt.checkpointLifecycle !== 'review_ready') {
    errors.push('checkpointLifecycle must be review_ready');
  }
  requireCount(errors, receipt, 'checkpointActionCount');
  if (receipt.checkpointActionCount !== 1) {
    errors.push('review/manual_submit checkpoint must contain exactly one action');
  }
  requireFingerprint(errors, receipt.checkpointActionIdsFingerprint, 'checkpointActionIdsFingerprint');
  if (expectedContext && typeof expectedContext === 'object' && !Array.isArray(expectedContext)) {
    for (const field of [...fillBaselineFields, ...resolutionFields, ...checkpointFields]) {
      if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
    }
  }
  return errors;
}

function validateHandoff(receipt, expectedContext) {
  const errors = [];
  const evidenceFields = ['browserBindingHash', 'handoffEvidenceFingerprint', 'handoffEvidenceType'];
  const stateAuthorityFields = [
    'employerApplicationState',
    'tracklyMemberState',
    'tracklyJobState',
  ];
  const checkpointAuthorityFields = [
    'checkpointStatus',
    'checkpointMemberVersion',
    'checkpointInspectionEpoch',
    'checkpointLifecycle',
    'checkpointAction',
    'checkpointActionCount',
  ];
  const reviewAuthorityFields = [...stateAuthorityFields, ...checkpointAuthorityFields];
  validateCurrentLineage(
    errors,
    receipt,
    expectedContext,
    'approvedJobIds',
    [...evidenceFields, ...reviewAuthorityFields],
  );
  if (!EMPLOYER_APPLICATION_STATES.has(receipt.employerApplicationState)) {
    errors.push('employerApplicationState is invalid');
  }
  if (!TRACKLY_MEMBER_STATES.has(receipt.tracklyMemberState)) {
    errors.push('tracklyMemberState is invalid');
  }
  if (!TRACKLY_JOB_STATES.has(receipt.tracklyJobState)) {
    errors.push('tracklyJobState is invalid');
  }
  if (expectedContext && typeof expectedContext === 'object' && !Array.isArray(expectedContext)) {
    for (const field of stateAuthorityFields) {
      if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
    }
  }
  if (receipt.browserTabState === 'closed_verified') {
    errors.push('closed_verified is reserved for reconciliation receipts');
  } else if (!BROWSER_HANDOFF_STATES.has(receipt.browserTabState)) {
    errors.push('browserTabState is invalid');
  }
  if (!['verified', 'unverified'].includes(receipt.handoffVisibility)) {
    errors.push('handoffVisibility must be verified or unverified');
  }
  if (typeof receipt.reviewReadyClaimed !== 'boolean') {
    errors.push('reviewReadyClaimed must be a boolean');
  }
  if (receipt.handoffVisibility === 'unverified' && receipt.reviewReadyClaimed !== false) {
    errors.push('reviewReadyClaimed must be false when handoff visibility is unverified');
  }
  if (receipt.browserTabState === 'durable_handoff_proven'
      && receipt.handoffVisibility !== 'verified') {
    errors.push('durable_handoff_proven requires verified visibility');
  }
  if (receipt.handoffVisibility === 'verified'
      && !['visible', 'durable_handoff_proven'].includes(receipt.browserTabState)) {
    errors.push('verified handoff requires a visible or durably handed-off browser tab');
  }
  if (receipt.handoffVisibility === 'verified') {
    requireFingerprint(errors, receipt.browserBindingHash, 'browserBindingHash');
    requireFingerprint(errors, receipt.handoffEvidenceFingerprint, 'handoffEvidenceFingerprint');
    if (![
      'visible_presentation_receipt',
      'user_visible_handoff_receipt',
      'durable_handoff_receipt',
    ].includes(receipt.handoffEvidenceType)) {
      errors.push('handoffEvidenceType must identify visible presentation, a user-visible handoff receipt, or a durable handoff receipt');
    }
    if (receipt.browserTabState === 'visible'
        && !['visible_presentation_receipt', 'user_visible_handoff_receipt'].includes(receipt.handoffEvidenceType)) {
      errors.push('visible browser state requires presentation or exact tab-bound user-visible handoff evidence');
    }
    if (receipt.browserTabState === 'durable_handoff_proven'
        && receipt.handoffEvidenceType !== 'durable_handoff_receipt') {
      errors.push('durable_handoff_proven requires durable_handoff_receipt evidence');
    }
    if (expectedContext && typeof expectedContext === 'object' && !Array.isArray(expectedContext)) {
      for (const field of evidenceFields) {
        if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
      }
    }
  } else if (evidenceFields.some((field) => Object.hasOwn(receipt, field))) {
    errors.push('handoff evidence fields must be omitted when visibility is unverified');
  }
  if (receipt.reviewReadyClaimed === true
      && (receipt.employerApplicationState !== 'review_state_prepared'
        || receipt.tracklyMemberState !== 'awaiting_manual_submit'
        || receipt.tracklyJobState !== 'check_later'
        || receipt.handoffVisibility !== 'verified')) {
    errors.push('reviewReadyClaimed requires prepared employer state, awaiting_manual_submit member state, check_later job state, and verified visibility');
  }
  if (receipt.reviewReadyClaimed === true) {
    if (!['recorded', 'replayed'].includes(receipt.checkpointStatus)) {
      errors.push('reviewReadyClaimed requires a recorded or replayed checkpointStatus');
    }
    requireTracklyId(errors, receipt, 'checkpointMemberVersion');
    if (!Number.isSafeInteger(receipt.checkpointInspectionEpoch) || receipt.checkpointInspectionEpoch < 0) {
      errors.push('checkpointInspectionEpoch must be a non-negative safe integer');
    }
    if (receipt.checkpointInspectionEpoch !== receipt.inspectionEpoch) {
      errors.push('checkpointInspectionEpoch must equal inspectionEpoch');
    }
    if (receipt.checkpointLifecycle !== 'review_ready') {
      errors.push('reviewReadyClaimed requires checkpointLifecycle review_ready');
    }
    if (receipt.checkpointAction !== 'review/manual_submit') {
      errors.push('reviewReadyClaimed requires checkpointAction review/manual_submit');
    }
    if (receipt.checkpointActionCount !== 1) {
      errors.push('reviewReadyClaimed requires checkpointActionCount 1');
    }
    if (expectedContext && typeof expectedContext === 'object' && !Array.isArray(expectedContext)) {
      for (const field of checkpointAuthorityFields) {
        if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
      }
    }
  } else {
    if (checkpointAuthorityFields.some((field) => Object.hasOwn(receipt, field))) {
      errors.push('checkpoint authority fields must be omitted when reviewReadyClaimed is false');
    }
  }
  return errors;
}

function validateReconciliation(receipt, expectedContext) {
  const errors = [];
  const reconciliationAuthorityFields = [
    'positiveSubmissionEvidenceRecorded',
    'memberLifecycle',
    'tracklyJobStatus',
  ];
  validateCurrentLineage(
    errors,
    receipt,
    expectedContext,
    'approvedJobIds',
    reconciliationAuthorityFields,
  );
  requireTrue(errors, receipt, 'positiveSubmissionEvidenceRecorded');
  if (receipt.memberLifecycle !== 'submitted') errors.push('memberLifecycle must be submitted');
  if (receipt.tracklyJobStatus !== 'applied_confirmed') errors.push('tracklyJobStatus must be applied_confirmed');
  if (expectedContext && typeof expectedContext === 'object' && !Array.isArray(expectedContext)) {
    for (const field of reconciliationAuthorityFields) {
      if (receipt[field] !== expectedContext[field]) errors.push(`${field} must match expectedContext`);
    }
  }
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
  handoff: validateHandoff,
  reconciliation: validateReconciliation,
};

function validateCheckpoint(phase, receipt, expectedContext, priorFill) {
  if (!Object.hasOwn(VALIDATORS, phase)) return [`unknown phase: ${phase}`];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['receipt must be a JSON object'];
  if (phase !== 'review' && priorFill !== undefined) return ['priorFill is permitted only for review'];
  const unexpectedFields = Object.keys(receipt)
    .filter((field) => !PHASE_FIELDS[phase].has(field))
    .map(() => 'receipt contains an unexpected field');
  return [...unexpectedFields, ...VALIDATORS[phase](receipt, expectedContext, priorFill)];
}

async function readReceiptInput(stream) {
  const decoder = new StringDecoder('utf8');
  let input = '';
  let inputBytes = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBytes += bytes.length;
    if (inputBytes > MAX_RECEIPT_BYTES) {
      return { input: '', oversized: true };
    }
    input += decoder.write(bytes);
  }
  input += decoder.end();
  return { input, oversized: false };
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
    process.stderr.write('input must be an envelope with receipt, expectedContext, and priorFill for review\n');
    process.exitCode = 1;
    return;
  }
  const unexpectedEnvelopeFields = Object.keys(envelope)
    .filter((field) => !['receipt', 'expectedContext', 'priorFill'].includes(field));
  if (unexpectedEnvelopeFields.length > 0) {
    process.stderr.write(`${unexpectedEnvelopeFields.map((field) => `unexpected envelope field: ${field}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const errors = validateCheckpoint(phase, envelope.receipt, envelope.expectedContext, envelope.priorFill);
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
