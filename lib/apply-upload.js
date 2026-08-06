'use strict';

const APPLY_UPLOAD_STAGES = Object.freeze([
  'semantic_control_discovered',
  'file_chooser_armed',
  'file_chooser_opened',
  'set_files_succeeded',
  'user_facing_filename_committed',
  'parser_fields_rechecked',
]);

const APPLY_UPLOAD_CAPABILITIES = Object.freeze([
  'semanticControlDiscovery',
  'chooserArming',
  'fileAttachment',
  'committedFilenameInspection',
  'parserFieldRecheck',
]);

const APPLY_UPLOAD_FAILURE_CODES = Object.freeze([
  'upload_capability_unavailable',
  'upload_stage_missing',
  'upload_stage_out_of_order',
  'upload_stage_duplicate',
  'control_ambiguous',
  'chooser_timeout',
  'chooser_open_without_commit',
  'file_missing',
  'file_expired',
  'set_files_failed',
  'filename_uncommitted',
  'unexpected_file_navigation',
  'parser_unsettled',
  'parser_field_regression',
]);

function validateApplyResumeUpload({ capabilities, events }) {
  const failureCodes = [];
  const seen = new Set();
  let expectedIndex = 0;
  let lastPassedStage = null;

  for (const capability of APPLY_UPLOAD_CAPABILITIES) {
    if (capabilities[capability] !== true) failureCodes.push('upload_capability_unavailable');
  }

  for (const event of events) {
    if (seen.has(event.stage)) {
      failureCodes.push('upload_stage_duplicate');
      continue;
    }
    seen.add(event.stage);
    const index = APPLY_UPLOAD_STAGES.indexOf(event.stage);
    const isExpectedStage = index === expectedIndex;
    if (!isExpectedStage) failureCodes.push('upload_stage_out_of_order');

    if (event.outcome === 'failed') {
      failureCodes.push(event.failureCode || 'upload_stage_missing');
    } else if (isExpectedStage) {
      expectedIndex += 1;
      lastPassedStage = event.stage;
    }
  }

  if (expectedIndex !== APPLY_UPLOAD_STAGES.length) failureCodes.push('upload_stage_missing');
  const uniqueFailureCodes = [...new Set(failureCodes)];
  return {
    safeToClaimAttachment: uniqueFailureCodes.length === 0,
    failureCodes: uniqueFailureCodes,
    lastPassedStage,
    completedStageCount: expectedIndex,
    requiredStageCount: APPLY_UPLOAD_STAGES.length,
  };
}

module.exports = {
  APPLY_UPLOAD_CAPABILITIES,
  APPLY_UPLOAD_FAILURE_CODES,
  APPLY_UPLOAD_STAGES,
  validateApplyResumeUpload,
};
