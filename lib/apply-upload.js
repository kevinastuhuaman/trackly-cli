'use strict';

const APPLY_CONTRACT = require('../contracts/trackly-apply-tools.json');

const APPLY_UPLOAD_STAGES = Object.freeze([...APPLY_CONTRACT.constants.applyUploadStages]);
const APPLY_UPLOAD_FAILURE_CODES = Object.freeze([
  ...APPLY_CONTRACT.constants.applyUploadFailureCodes,
]);
const APPLY_UPLOAD_CAPABILITIES = Object.freeze([
  'semanticControlDiscovery',
  'chooserArming',
  'fileAttachment',
  'committedFilenameInspection',
  'parserFieldRecheck',
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

    const hasFailureCode = Boolean(event.failureCode);
    if (hasFailureCode) {
      failureCodes.push(event.failureCode);
    }

    if (event.outcome === 'failed' || hasFailureCode) {
      if (!event.failureCode) failureCodes.push('upload_stage_missing');
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
