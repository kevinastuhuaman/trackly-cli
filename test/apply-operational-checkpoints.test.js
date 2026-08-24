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

test('operational checkpoints require audited whole-form, history, resume, lookup, and handoff receipts', () => {
  const checkpoints = read('skills/trackly-apply/references/operational-checkpoints.md');
  const resolver = read('skills/trackly-apply/references/answer-resolution.md');
  const integrity = read('skills/trackly-apply/references/form-integrity.md');
  const upload = read('skills/trackly-apply/references/browser-upload.md');
  const handoff = read('skills/trackly-apply/references/review-handoff.md');

  assert.match(checkpoints, /controlAccounting[\s\S]*formInventoryFingerprint/);
  assert.match(checkpoints, /canonicalEducationRecordCount[\s\S]*canonicalEmploymentPositionCount/);
  assert.match(checkpoints, /same `profileRevision`[\s\S]*receipt and `expectedContext`/i);
  assert.match(checkpoints, /browser-surface fields[\s\S]*independently captured[\s\S]*browser baseline/i);
  assert.match(checkpoints, /resumeAudit/i);
  assert.match(checkpoints, /preAttachVerification/);
  assert.match(checkpoints, /finalSweep/);
  assert.match(checkpoints, /review\/manual_submit[\s\S]*checkpointStatus/);
  assert.match(checkpoints, /continuationAllowed[\s\S]*false[\s\S]*review\/manual_submit|review\/manual_submit[\s\S]*continuationAllowed[\s\S]*false/i);
  assert.match(checkpoints, /handoff[\s\S]*visibility[\s\S]*unverified/i);
  assert.match(checkpoints, /tracklyJobState[\s\S]*match[\s\S]*expectedContext[\s\S]*every handoff/i);
  assert.match(resolver, /run-only[\s\S]*exact question[\s\S]*office[\s\S]*jurisdiction[\s\S]*company[\s\S]*provider[\s\S]*global/i);
  assert.match(resolver, /before asking[\s\S]*query every applicable scope/i);
  assert.match(resolver, /frozen profile revision[\s\S]*current bounded snapshot projection/i);
  assert.match(integrity, /one accounting row[\s\S]*every visible control/i);
  assert.match(integrity, /position-level[\s\S]*reverse chronological[\s\S]*date\s+precision/i);
  assert.match(upload, /final sweep[\s\S]*attachment is still committed/i);
  assert.match(upload, /only chooser arming[\s\S]*file attachment[\s\S]*hand the upload to the user/i);
  assert.match(upload, /verification capabilities is unavailable[\s\S]*do not route it into `manual_unbound`/i);
  assert.match(handoff, /Employer application state[\s\S]*Trackly state[\s\S]*Browser state/);
  assert.match(handoff, /No state in one[\s\S]*implies[\s\S]*another/i);
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
  assert.match(probe, /trackly_employer_source_exact_origin[\s\S]*exact listed origin[\s\S]*do not invent or require an ATS tenant/i);
});

test('phase checkpoint validator accepts complete value-free receipts and rejects unsafe ones', () => {
  const { validateCheckpoint } = require('../skills/trackly-apply/scripts/validate-phase-checkpoint');

  const selection = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    latestExplicitTarget: 20,
    approvedJobIds: [101, 102],
    approvalRecorded: true,
    noFormMutationBeforeApproval: true,
    queueExhausted: true,
  };
  const selectionContext = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    latestExplicitTarget: 20,
    selectableJobIds: [101, 102],
    queueExhausted: true,
  };
  assert.deepEqual(validateCheckpoint('selection', selection, selectionContext), []);
  const fixedSelection = {
    ...selection,
    workMode: 'fixed_inspection',
    latestExplicitTarget: 100,
    approvedJobIds: Array.from({ length: 100 }, (_, index) => index + 1),
  };
  delete fixedSelection.executionId;
  const fixedSelectionContext = {
    workMode: 'fixed_inspection',
    batchId: 501,
    latestExplicitTarget: 100,
    selectableJobIds: fixedSelection.approvedJobIds,
    queueExhausted: true,
  };
  assert.deepEqual(validateCheckpoint('selection', fixedSelection, fixedSelectionContext), []);
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      latestExplicitTarget: 21,
    }, { ...selectionContext, latestExplicitTarget: 21 }).join('\n'),
    /1 to 20 for the selected work mode/
  );
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      workMode: 'fixed_inspection',
      latestExplicitTarget: 101,
    }, { ...fixedSelectionContext, latestExplicitTarget: 101 }).join('\n'),
    /1 to 100 for the selected work mode/
  );
  assert.deepEqual(validateCheckpoint('selection', { ...selection, approvedJobIds: [] }, selectionContext), []);
  assert.deepEqual(validateCheckpoint('selection', {
    ...selection,
    latestExplicitTarget: 5,
    approvedJobIds: [101, 102],
    queueExhausted: false,
  }, { ...selectionContext, latestExplicitTarget: 5, queueExhausted: false }), []);
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      latestExplicitTarget: 1,
      approvedJobIds: [101, 'private@example.com'],
    }, { ...selectionContext, latestExplicitTarget: 1 }).join('\n'),
    /must not exceed latestExplicitTarget/
  );
  assert.match(
    validateCheckpoint('selection', {
      ...selection,
      latestExplicitTarget: 1,
      approvedJobIds: [101, 'private@example.com'],
    }, { ...selectionContext, latestExplicitTarget: 1 }).join('\n'),
    /positive safe integers/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, approvedJobIds: [], queueExhausted: false }, selectionContext).join('\n'),
    /queueExhausted/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, noFormMutationBeforeApproval: false }, selectionContext).join('\n'),
    /noFormMutationBeforeApproval/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, email: 'private@example.com' }, selectionContext).join('\n'),
    /receipt contains an unexpected field/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, approvedJobIds: ['private@example.com'] }, selectionContext).join('\n'),
    /positive safe integers/
  );
  assert.doesNotMatch(
    validateCheckpoint('selection', {
      ...selection,
      approvedJobIds: ['private@example.com'],
      queueExhausted: false,
    }, selectionContext).join('\n'),
    /may be empty/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, approvedJobIds: [999] }, selectionContext).join('\n'),
    /must belong to expectedContext\.selectableJobIds/
  );
  assert.match(
    validateCheckpoint('selection', { ...selection, latestExplicitTarget: 1 }, selectionContext).join('\n'),
    /latestExplicitTarget must match expectedContext/
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
    originPolicyVerified: true,
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
    profileRevision: 7,
    visibleControlCount: 12,
    committedControlCount: 11,
    typedExceptionCount: 1,
    controlAccounting: {
      filledExactProfile: 8,
      filledSafeDerivation: 1,
      filledSupportedDraft: 1,
      preservedUserEdit: 1,
      missingFact: 1,
      liveConsent: 0,
      authenticationBlocker: 0,
      unobservableCommit: 0,
      unsupportedControl: 0,
      notApplicable: 0,
    },
    formInventoryFingerprint: 'a'.repeat(64),
    knownOmissionCount: 0,
    knownFieldsFilledBeforeQuestions: true,
    answerLookupCompleted: true,
    answerLookupScopeCounts: {
      run: 0,
      question: 1,
      office: 0,
      jurisdiction: 1,
      company: 2,
      provider: 0,
      global: 7,
    },
    answerLookupFingerprint: 'b'.repeat(64),
    parserSensitiveFieldsRechecked: true,
    educationAndEmploymentVerified: true,
    historyReconciliation: {
      canonicalEducationRecordCount: 2,
      accountedEducationRecordCount: 2,
      canonicalEmploymentPositionCount: 6,
      accountedEmploymentPositionCount: 6,
      educationOrderVerified: true,
      employmentOrderVerified: true,
      datePrecisionInvented: false,
      educationReconciliationFingerprint: 'c'.repeat(64),
      employmentReconciliationFingerprint: 'd'.repeat(64),
    },
    resumeAudit: {
      control: 'required',
      mode: 'automated_verified',
      approval: 'passed',
      preAttachVerification: 'passed',
      attachmentCommit: 'passed',
      filenameVerification: 'passed',
      parserRecheck: 'passed',
      finalSweep: 'passed',
    },
    writingPresent: true,
    localWritingGate: 'passed',
    humanizerAvailability: 'available',
    humanizerRan: true,
    humanizerFallbackUsed: false,
    questionPacketTrueGapsOnly: true,
  };
  const fillContext = {
    ...expectedContext,
    profileRevision: 7,
    canonicalEducationRecordCount: 2,
    canonicalEmploymentPositionCount: 6,
    formInventoryFingerprint: fill.formInventoryFingerprint,
    resumeControl: 'required',
  };
  assert.deepEqual(validateCheckpoint('fill', fill, fillContext), []);
  assert.match(
    validateCheckpoint('fill', { ...fill, profileRevision: 6 }, fillContext).join('\n'),
    /profileRevision must match expectedContext/
  );
  assert.match(
    validateCheckpoint('fill', fill, { ...fillContext, profileRevision: 0 }).join('\n'),
    /profileRevision must be a positive safe integer/
  );
  assert.match(
    validateCheckpoint('fill', fill, { ...fillContext, profileRevision: -1 }).join('\n'),
    /profileRevision must be a positive safe integer/
  );
  const { executionId: omittedFillExecutionId, ...fixedFill } = fill;
  const { executionId: omittedContextExecutionId, ...fixedExpectedContext } = expectedContext;
  assert.equal(omittedFillExecutionId, 301);
  assert.equal(omittedContextExecutionId, 301);
  assert.deepEqual(validateCheckpoint('fill', {
    ...fixedFill,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
    profileRevision: 0,
  }, {
    ...fixedExpectedContext,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
    profileRevision: 0,
    canonicalEducationRecordCount: 2,
    canonicalEmploymentPositionCount: 6,
    formInventoryFingerprint: fill.formInventoryFingerprint,
    resumeControl: 'required',
  }), []);
  assert.match(
    validateCheckpoint('fill', {
      ...fixedFill,
      workMode: 'fixed_inspection',
      inspectionEpoch: 0,
      profileRevision: 0,
    }, {
      ...fixedExpectedContext,
      workMode: 'fixed_inspection',
      inspectionEpoch: 0,
      profileRevision: -1,
      canonicalEducationRecordCount: 2,
      canonicalEmploymentPositionCount: 6,
      formInventoryFingerprint: fill.formInventoryFingerprint,
      resumeControl: 'required',
    }).join('\n'),
    /profileRevision must be a non-negative safe integer/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, knownOmissionCount: 1 }, fillContext).join('\n'),
    /knownOmissionCount/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      visibleControlCount: 0,
      committedControlCount: 0,
      typedExceptionCount: 0,
      controlAccounting: Object.fromEntries(Object.keys(fill.controlAccounting).map((field) => [field, 0])),
    }, fillContext).join('\n'),
    /visibleControlCount must be at least 1/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      controlAccounting: { ...fill.controlAccounting, missingFact: 0 },
    }, fillContext).join('\n'),
    /controlAccounting counts must equal visibleControlCount/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      controlAccounting: { ...fill.controlAccounting, rawLabel: 'private text' },
    }, fillContext).join('\n'),
    /controlAccounting contains an unexpected field/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, formInventoryFingerprint: 'not-a-hash' }, fillContext).join('\n'),
    /formInventoryFingerprint must be a lowercase SHA-256 fingerprint/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, answerLookupCompleted: false }, fillContext).join('\n'),
    /answerLookupCompleted/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      answerLookupScopeCounts: { ...fill.answerLookupScopeCounts, employerQuestion: 1 },
    }, fillContext).join('\n'),
    /answerLookupScopeCounts contains an unexpected field/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      historyReconciliation: {
        ...fill.historyReconciliation,
        accountedEmploymentPositionCount: 5,
      },
    }, fillContext).join('\n'),
    /employment position counts must match/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      historyReconciliation: { ...fill.historyReconciliation, datePrecisionInvented: true },
    }, fillContext).join('\n'),
    /datePrecisionInvented must be false/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      resumeAudit: { ...fill.resumeAudit, parserRecheck: 'not_applicable' },
    }, fillContext).join('\n'),
    /resumeAudit\.parserRecheck must match the declared control mode/
  );
  assert.deepEqual(validateCheckpoint('fill', {
    ...fill,
    resumeAudit: {
      control: 'required',
      mode: 'manual_unbound',
      approval: 'passed',
      preAttachVerification: 'not_applicable',
      attachmentCommit: 'user_confirmed',
      filenameVerification: 'passed',
      parserRecheck: 'passed',
      finalSweep: 'passed',
    },
  }, fillContext), []);
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      resumeAudit: {
        control: 'required',
        mode: 'manual_unbound',
        approval: 'passed',
        preAttachVerification: 'not_applicable',
        attachmentCommit: 'passed',
        filenameVerification: 'passed',
        parserRecheck: 'passed',
        finalSweep: 'passed',
      },
    }, fillContext).join('\n'),
    /resumeAudit\.attachmentCommit must match the declared control mode/
  );
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      resumeAudit: {
        control: 'required',
        mode: 'manual_unbound',
        approval: 'passed',
        preAttachVerification: 'not_applicable',
        attachmentCommit: 'user_confirmed',
        filenameVerification: 'passed',
        parserRecheck: 'not_applicable',
        finalSweep: 'passed',
      },
    }, fillContext).join('\n'),
    /resumeAudit\.parserRecheck must match the declared control mode/
  );
  assert.deepEqual(validateCheckpoint('fill', {
    ...fill,
    resumeAudit: {
      control: 'absent',
      mode: 'not_applicable',
      approval: 'not_applicable',
      preAttachVerification: 'not_applicable',
      attachmentCommit: 'not_applicable',
      filenameVerification: 'not_applicable',
      parserRecheck: 'not_applicable',
      finalSweep: 'not_applicable',
    },
  }, { ...fillContext, resumeControl: 'absent' }), []);
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      visibleControlCount: Number.MAX_SAFE_INTEGER + 1,
    }, fillContext).join('\n'),
    /visibleControlCount must be a non-negative safe integer/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, inspectionEpoch: 3 }, fillContext).join('\n'),
    /inspectionEpoch must match expectedContext/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, jobId: 103 }, { ...fillContext, jobId: 103 }).join('\n'),
    /jobId must belong to expectedContext\.approvedJobIds/
  );
  assert.match(
    validateCheckpoint('fill', fill, { ...fillContext, email: 'private@example.com' }).join('\n'),
    /expectedContext contains an unexpected field/
  );
  assert.match(
    validateCheckpoint('fill', { ...fill, humanizerRan: false }, fillContext).join('\n'),
    /humanizerRan/
  );
  assert.deepEqual(validateCheckpoint('fill', {
    ...fill,
    humanizerAvailability: 'unavailable',
    humanizerRan: false,
    humanizerFallbackUsed: true,
  }, fillContext), []);
  assert.match(
    validateCheckpoint('fill', {
      ...fill,
      humanizerAvailability: 'not_applicable',
      humanizerRan: false,
      humanizerFallbackUsed: false,
    }, fillContext).join('\n'),
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
    checkpointAction: 'review/manual_submit',
    continuationAllowed: false,
    resolvedActionCount: 2,
    resolvedActionIdsFingerprint: 'e'.repeat(64),
    checkpointStatus: 'recorded',
    checkpointMemberVersion: 8,
    checkpointInspectionEpoch: 2,
    checkpointLifecycle: 'review_ready',
    checkpointActionCount: 2,
    checkpointActionIdsFingerprint: 'e'.repeat(64),
  };
  const reviewContext = {
    ...expectedContext,
    checkpointAction: 'review/manual_submit',
    continuationAllowed: false,
    resolvedActionCount: 2,
    resolvedActionIdsFingerprint: 'e'.repeat(64),
    checkpointStatus: 'recorded',
    checkpointMemberVersion: 8,
    checkpointInspectionEpoch: 2,
    checkpointLifecycle: 'review_ready',
    checkpointActionCount: 2,
    checkpointActionIdsFingerprint: 'e'.repeat(64),
  };
  assert.deepEqual(validateCheckpoint('review', review, reviewContext), []);
  const { executionId: omittedReviewExecutionId, ...fixedReview } = review;
  assert.equal(omittedReviewExecutionId, 301);
  assert.deepEqual(validateCheckpoint('review', {
    ...fixedReview,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
    checkpointInspectionEpoch: 0,
  }, {
    ...fixedExpectedContext,
    workMode: 'fixed_inspection',
    inspectionEpoch: 0,
    ...Object.fromEntries(Object.entries(reviewContext).filter(([field]) => (
      field.startsWith('checkpoint')
      || field.startsWith('resolvedAction')
      || field === 'continuationAllowed'
    ))),
    checkpointInspectionEpoch: 0,
  }), []);
  assert.match(
    validateCheckpoint('review', { ...review, submitActivated: true }, reviewContext).join('\n'),
    /submitActivated/
  );
  assert.match(
    validateCheckpoint('review', { ...review, inspectionEpoch: 3 }, reviewContext).join('\n'),
    /inspectionEpoch must match expectedContext/
  );
  assert.match(
    validateCheckpoint('review', { ...review, checkpointStatus: 'fabricated' }, reviewContext).join('\n'),
    /checkpointStatus/
  );
  assert.match(
    validateCheckpoint('review', {
      ...review,
      checkpointInspectionEpoch: 3,
    }, {
      ...reviewContext,
      checkpointInspectionEpoch: 3,
    }).join('\n'),
    /checkpointInspectionEpoch must equal inspectionEpoch/
  );
  assert.deepEqual(validateCheckpoint('review', {
    ...review,
    checkpointActionCount: 1,
    checkpointActionIdsFingerprint: 'f'.repeat(64),
  }, {
    ...reviewContext,
    checkpointActionCount: 1,
    checkpointActionIdsFingerprint: 'f'.repeat(64),
  }), []);
  assert.match(
    validateCheckpoint('review', review, {
      ...reviewContext,
      resolvedActionCount: 1,
    }).join('\n'),
    /resolvedActionCount must match expectedContext/
  );
  assert.match(
    validateCheckpoint('review', { ...review, continuationAllowed: true }, reviewContext).join('\n'),
    /continuationAllowed must be false for review\/manual_submit/
  );
  assert.match(
    validateCheckpoint('review', review, {
      ...reviewContext,
      checkpointAction: 'captcha/at_submit',
    }).join('\n'),
    /checkpointAction must match expectedContext/
  );
  assert.match(
    validateCheckpoint('review', review, {
      ...reviewContext,
      continuationAllowed: true,
    }).join('\n'),
    /continuationAllowed must match expectedContext/
  );
  assert.match(
    validateCheckpoint('review', {
      ...review,
      resolvedActionIds: ['private-action-id'],
    }, reviewContext).join('\n'),
    /receipt contains an unexpected field/
  );

  const handoff = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    memberId: 201,
    jobId: 101,
    runId: 401,
    inspectionEpoch: 2,
    employerApplicationState: 'review_state_prepared',
    tracklyMemberState: 'review_ready',
    tracklyJobState: 'check_later',
    browserTabState: 'controller_owned',
    handoffVisibility: 'unverified',
    reviewReadyClaimed: false,
  };
  const handoffContext = {
    ...expectedContext,
    employerApplicationState: handoff.employerApplicationState,
    tracklyMemberState: handoff.tracklyMemberState,
    tracklyJobState: handoff.tracklyJobState,
  };
  assert.deepEqual(validateCheckpoint('handoff', handoff, handoffContext), []);
  assert.match(
    validateCheckpoint('handoff', {
      ...handoff,
      employerApplicationState: 'manually_submitted',
      tracklyMemberState: 'submitted',
      tracklyJobState: 'applied_confirmed',
    }, handoffContext).join('\n'),
    /employerApplicationState must match expectedContext[\s\S]*tracklyMemberState must match expectedContext[\s\S]*tracklyJobState must match expectedContext/
  );
  assert.match(
    validateCheckpoint('handoff', { ...handoff, reviewReadyClaimed: true }, handoffContext).join('\n'),
    /reviewReadyClaimed must be false when handoff visibility is unverified/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...handoff,
      browserBindingHash: 'f'.repeat(64),
      handoffEvidenceFingerprint: '1'.repeat(64),
      handoffEvidenceType: 'visible_tab_inventory',
    }, handoffContext).join('\n'),
    /handoff evidence fields must be omitted when visibility is unverified/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...handoff,
      checkpointStatus: 'recorded',
      checkpointMemberVersion: 8,
      checkpointInspectionEpoch: 2,
      checkpointLifecycle: 'review_ready',
    }, handoffContext).join('\n'),
    /checkpoint authority fields must be omitted when reviewReadyClaimed is false/
  );
  const visibleHandoff = {
    ...handoff,
    tracklyMemberState: 'awaiting_manual_submit',
    browserTabState: 'visible',
    handoffVisibility: 'verified',
    reviewReadyClaimed: true,
    browserBindingHash: 'f'.repeat(64),
    handoffEvidenceFingerprint: '1'.repeat(64),
    handoffEvidenceType: 'visible_presentation_receipt',
    checkpointStatus: 'recorded',
    checkpointMemberVersion: 8,
    checkpointInspectionEpoch: 2,
    checkpointLifecycle: 'review_ready',
  };
  const visibleHandoffContext = {
    ...expectedContext,
    employerApplicationState: visibleHandoff.employerApplicationState,
    tracklyMemberState: visibleHandoff.tracklyMemberState,
    tracklyJobState: visibleHandoff.tracklyJobState,
    browserBindingHash: visibleHandoff.browserBindingHash,
    handoffEvidenceFingerprint: visibleHandoff.handoffEvidenceFingerprint,
    handoffEvidenceType: visibleHandoff.handoffEvidenceType,
    checkpointStatus: visibleHandoff.checkpointStatus,
    checkpointMemberVersion: visibleHandoff.checkpointMemberVersion,
    checkpointInspectionEpoch: visibleHandoff.checkpointInspectionEpoch,
    checkpointLifecycle: visibleHandoff.checkpointLifecycle,
  };
  assert.deepEqual(validateCheckpoint('handoff', visibleHandoff, visibleHandoffContext), []);
  assert.deepEqual(validateCheckpoint('handoff', {
    ...visibleHandoff,
    handoffEvidenceType: 'user_visible_handoff_receipt',
  }, {
    ...visibleHandoffContext,
    handoffEvidenceType: 'user_visible_handoff_receipt',
  }), []);
  assert.match(
    validateCheckpoint('handoff', {
      ...visibleHandoff,
      handoffEvidenceType: 'visible_tab_inventory',
    }, {
      ...visibleHandoffContext,
      handoffEvidenceType: 'visible_tab_inventory',
    }).join('\n'),
    /handoffEvidenceType must identify visible presentation/
  );
  const durableHandoff = {
    ...visibleHandoff,
    tracklyMemberState: 'review_ready',
    browserTabState: 'durable_handoff_proven',
    handoffVisibility: 'verified',
    reviewReadyClaimed: true,
    browserBindingHash: '2'.repeat(64),
    handoffEvidenceFingerprint: '3'.repeat(64),
    handoffEvidenceType: 'durable_handoff_receipt',
  };
  assert.deepEqual(validateCheckpoint('handoff', durableHandoff, {
    ...expectedContext,
    employerApplicationState: durableHandoff.employerApplicationState,
    tracklyMemberState: durableHandoff.tracklyMemberState,
    tracklyJobState: durableHandoff.tracklyJobState,
    browserBindingHash: durableHandoff.browserBindingHash,
    handoffEvidenceFingerprint: durableHandoff.handoffEvidenceFingerprint,
    handoffEvidenceType: durableHandoff.handoffEvidenceType,
    checkpointStatus: durableHandoff.checkpointStatus,
    checkpointMemberVersion: durableHandoff.checkpointMemberVersion,
    checkpointInspectionEpoch: durableHandoff.checkpointInspectionEpoch,
    checkpointLifecycle: durableHandoff.checkpointLifecycle,
  }), []);
  assert.match(
    validateCheckpoint('handoff', {
      ...durableHandoff,
      handoffEvidenceType: 'visible_presentation_receipt',
    }, {
      ...expectedContext,
      employerApplicationState: durableHandoff.employerApplicationState,
      tracklyMemberState: durableHandoff.tracklyMemberState,
      tracklyJobState: durableHandoff.tracklyJobState,
      browserBindingHash: durableHandoff.browserBindingHash,
      handoffEvidenceFingerprint: durableHandoff.handoffEvidenceFingerprint,
      handoffEvidenceType: 'visible_presentation_receipt',
      checkpointStatus: durableHandoff.checkpointStatus,
      checkpointMemberVersion: durableHandoff.checkpointMemberVersion,
      checkpointInspectionEpoch: durableHandoff.checkpointInspectionEpoch,
      checkpointLifecycle: durableHandoff.checkpointLifecycle,
    }).join('\n'),
    /durable_handoff_proven requires durable_handoff_receipt evidence/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...handoff,
      browserTabState: 'durable_handoff_proven',
      handoffVisibility: 'unverified',
      reviewReadyClaimed: false,
    }, {
      ...expectedContext,
      employerApplicationState: handoff.employerApplicationState,
      tracklyMemberState: handoff.tracklyMemberState,
      tracklyJobState: handoff.tracklyJobState,
    }).join('\n'),
    /durable_handoff_proven requires verified visibility/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...handoff,
      browserTabState: 'closed_verified',
      handoffVisibility: 'verified',
      reviewReadyClaimed: true,
      browserBindingHash: '4'.repeat(64),
      handoffEvidenceFingerprint: '5'.repeat(64),
      handoffEvidenceType: 'visible_presentation_receipt',
      checkpointStatus: 'recorded',
      checkpointMemberVersion: 8,
      checkpointInspectionEpoch: 2,
      checkpointLifecycle: 'review_ready',
    }, {
      ...expectedContext,
      employerApplicationState: 'review_state_prepared',
      tracklyMemberState: 'review_ready',
      tracklyJobState: 'check_later',
      browserBindingHash: '4'.repeat(64),
      handoffEvidenceFingerprint: '5'.repeat(64),
      handoffEvidenceType: 'visible_presentation_receipt',
      checkpointStatus: 'recorded',
      checkpointMemberVersion: 8,
      checkpointInspectionEpoch: 2,
      checkpointLifecycle: 'review_ready',
    }).join('\n'),
    /verified handoff requires a visible or durably handed-off browser tab/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...visibleHandoff,
      employerApplicationState: 'partially_filled',
    }, visibleHandoffContext).join('\n'),
    /reviewReadyClaimed requires prepared employer state/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...visibleHandoff,
      tracklyMemberState: 'needs_input',
    }, visibleHandoffContext).join('\n'),
    /reviewReadyClaimed requires prepared employer state/
  );
  assert.match(
    validateCheckpoint('handoff', visibleHandoff, {
      ...visibleHandoffContext,
      tracklyMemberState: 'needs_input',
      checkpointLifecycle: 'needs_input',
    }).join('\n'),
    /tracklyMemberState must match expectedContext/
  );
  assert.match(
    validateCheckpoint('handoff', visibleHandoff, {
      ...visibleHandoffContext,
      checkpointMemberVersion: 9,
    }).join('\n'),
    /checkpointMemberVersion must match expectedContext/
  );
  assert.match(
    validateCheckpoint('handoff', {
      ...visibleHandoff,
      checkpointInspectionEpoch: 3,
    }, {
      ...visibleHandoffContext,
      checkpointInspectionEpoch: 3,
    }).join('\n'),
    /checkpointInspectionEpoch must equal inspectionEpoch/
  );
  assert.match(
    validateCheckpoint('handoff', visibleHandoff, {
      ...visibleHandoffContext,
      tracklyJobState: 'applied_confirmed',
    }).join('\n'),
    /tracklyJobState must match expectedContext/
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
  const reconciliationContext = {
    ...expectedContext,
    positiveSubmissionEvidenceRecorded: true,
    memberLifecycle: 'submitted',
    tracklyJobStatus: 'applied_confirmed',
  };
  assert.deepEqual(validateCheckpoint('reconciliation', reconciliation, reconciliationContext), []);
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, tracklyJobStatus: 'applied' }, reconciliationContext).join('\n'),
    /tracklyJobStatus/
  );
  assert.match(
    validateCheckpoint('reconciliation', reconciliation, {
      ...reconciliationContext,
      memberLifecycle: 'awaiting_manual_submit',
      tracklyJobStatus: 'check_later',
    }).join('\n'),
    /memberLifecycle must match expectedContext[\s\S]*tracklyJobStatus must match expectedContext/
  );
  assert.match(
    validateCheckpoint('reconciliation', reconciliation, {
      ...reconciliationContext,
      positiveSubmissionEvidenceRecorded: false,
    }).join('\n'),
    /positiveSubmissionEvidenceRecorded must match expectedContext/
  );
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, completeTabInventoryRecorded: false }, reconciliationContext).join('\n'),
    /completeTabInventoryRecorded/
  );
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, cleanupPreference: 'never' }, reconciliationContext).join('\n'),
    /cannot be closed_verified/
  );
  assert.match(
    validateCheckpoint('reconciliation', { ...reconciliation, runId: 402 }, reconciliationContext).join('\n'),
    /runId must match expectedContext/
  );
  for (const browserTabStatus of ['open', 'missing', 'closure_unverified']) {
    const pending = { ...reconciliation, browserTabStatus };
    delete pending.completeTabInventoryRecorded;
    delete pending.closeReceiptRecorded;
    delete pending.postCloseUnionAbsenceProven;
    assert.deepEqual(validateCheckpoint('reconciliation', pending, reconciliationContext), []);
  }
  assert.match(
    validateCheckpoint('reconciliation', {
      ...reconciliation,
      browserTabStatus: 'open',
      closeReceiptRecorded: 'private text',
    }, reconciliationContext).join('\n'),
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

test('phase checkpoint input stops reading as soon as the byte limit is exceeded', async () => {
  const { readReceiptInput } = require('../skills/trackly-apply/scripts/validate-phase-checkpoint');
  let readPastLimit = false;
  let iteratorClosed = false;
  async function* oversizedInput() {
    try {
      yield Buffer.alloc((64 * 1024) + 1);
      readPastLimit = true;
      yield Buffer.alloc(1);
    } finally {
      iteratorClosed = true;
    }
  }

  assert.deepEqual(await readReceiptInput(oversizedInput()), { input: '', oversized: true });
  assert.equal(readPastLimit, false);
  assert.equal(iteratorClosed, true);
});

test('phase checkpoint CLI decodes multi-byte UTF-8 split across writes', async () => {
  const validator = path.join(root, 'skills/trackly-apply/scripts/validate-phase-checkpoint.js');
  const { readReceiptInput } = require('../skills/trackly-apply/scripts/validate-phase-checkpoint');
  const payload = Buffer.from(JSON.stringify({
    receipt: {
      workMode: 'accessible_execution',
      executionId: 301,
      batchId: 501,
      latestExplicitTarget: 1,
      approvedJobIds: [101],
      approvalRecorded: true,
      noFormMutationBeforeApproval: true,
      queueExhausted: false,
      é: true,
    },
    expectedContext: {
      workMode: 'accessible_execution',
      executionId: 301,
      batchId: 501,
      latestExplicitTarget: 1,
      selectableJobIds: [101],
      queueExhausted: false,
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
  assert.match(result.stderr, /receipt contains an unexpected field/);
  assert.doesNotMatch(result.stderr, /é/);
  assert.doesNotMatch(result.stderr, /valid JSON/);
});

test('phase checkpoint CLI never echoes secret-shaped or terminal-control receipt data', () => {
  const validator = path.join(root, 'skills/trackly-apply/scripts/validate-phase-checkpoint.js');
  const secret = 'sk-test-private-value';
  const terminalControl = '\u001b[31mprivate-field\u001b[0m';
  const result = spawnSync(process.execPath, [validator, 'selection'], {
    input: JSON.stringify({
      receipt: {
        workMode: 'accessible_execution',
        executionId: 301,
        batchId: 501,
        latestExplicitTarget: 1,
        approvedJobIds: [101],
        approvalRecorded: true,
        noFormMutationBeforeApproval: true,
        queueExhausted: false,
        [secret]: terminalControl,
      },
      expectedContext: {
        workMode: 'accessible_execution',
        executionId: 301,
        batchId: 501,
        latestExplicitTarget: 1,
        selectableJobIds: [101],
        queueExhausted: false,
      },
    }),
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /receipt contains an unexpected field/);
  assert.doesNotMatch(result.stderr, /sk-test-private-value/);
  assert.doesNotMatch(result.stderr, /private-field|\u001b/);
});

test('phase checkpoint CLI validates envelopes from a non-skill working directory', () => {
  const validator = path.join(root, 'skills/trackly-apply/scripts/validate-phase-checkpoint.js');
  const receipt = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    latestExplicitTarget: 1,
    approvedJobIds: [101],
    approvalRecorded: true,
    noFormMutationBeforeApproval: true,
    queueExhausted: false,
  };
  const expectedContext = {
    workMode: 'accessible_execution',
    executionId: 301,
    batchId: 501,
    latestExplicitTarget: 1,
    selectableJobIds: [101],
    queueExhausted: false,
  };
  const valid = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt, expectedContext }),
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /selection checkpoint valid/);

  const invalid = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt: { ...receipt, approvalRecorded: false }, expectedContext }),
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
    input: JSON.stringify({ receipt, expectedContext, rawAnswer: 'private text' }),
    encoding: 'utf8',
  });
  assert.equal(extraEnvelopeField.status, 1);
  assert.match(extraEnvelopeField.stderr, /unexpected envelope field: rawAnswer/);

  const missingSelectionContext = spawnSync(process.execPath, [validator, 'selection'], {
    cwd: path.dirname(root),
    input: JSON.stringify({ receipt }),
    encoding: 'utf8',
  });
  assert.equal(missingSelectionContext.status, 1);
  assert.match(missingSelectionContext.stderr, /expectedContext is required/);
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
  assert.match(pluginOperations, /whole-form[\s\S]*control accounting/i);
  assert.match(pluginOperations, /resume[\s\S]*pre-attach[\s\S]*parser[\s\S]*final sweep/i);
  assert.match(pluginOperations, /position-level[\s\S]*date precision/i);
  assert.match(pluginOperations, /visibility unverified/i);
  assert.ok(
    pluginOperations.indexOf('**Access:**') < pluginOperations.indexOf('**Selection:**'),
    'access proof must precede accessible-set approval',
  );
  assert.match(pluginProbe, /applicant_fields_reached/);
  assert.match(pluginProbe, /intermediate_apply_shell/);
  assert.match(pluginProbe, /authentication_required/);
  assert.match(pluginProbe, /account_creation_required/);
  assert.match(pluginProbe, /never[\s\S]*private\s+data[\s\S]*probe/i);

  const pluginResolver = read('plugins/trackly/skills/trackly-apply/references/answer-resolution.md');
  assert.match(pluginResolver, /run-only[\s\S]*exact question[\s\S]*office[\s\S]*jurisdiction[\s\S]*company[\s\S]*provider[\s\S]*global/i);
  assert.match(pluginResolver, /before asking/i);
});

test('MCP reliability prompt surfaces the new operating gates before execution', () => {
  const tools = read('mcp/apply-tools.js');
  assert.match(tools, /skill 4\.7\.1 reliability gate:[^']*latest explicit target/i);
  assert.match(tools, /skill 4\.7\.1 reliability gate:[^']*genuine applicant fields/i);
  assert.match(tools, /skill 4\.7\.1 reliability gate:[^']*exact accessible jobs[^']*before form mutation/i);
  assert.match(tools, /skill 4\.7\.1 reliability gate:[^']*deterministic fields[^']*question packet/i);
  assert.match(tools, /skill 4\.7\.1 reliability gate:[^']*phase checkpoint/i);
  assert.match(tools, /run the skill 4\.7\.1 deterministic answer resolver/i);
  assert.doesNotMatch(tools, /run the skill 4\.6 deterministic answer resolver/i);
});
